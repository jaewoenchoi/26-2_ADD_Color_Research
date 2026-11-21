"""Connect capture runs and capture ZIPs to the supplied local segmentation model."""
import hashlib
from functools import lru_cache
import importlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import threading
import uuid
import zipfile

MAX_ARCHIVE = 512 * 1024**2
MAX_IMAGE = 64 * 1024**2
SAFE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}")
JOB_ID = re.compile(r"[a-f0-9]{32}")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}
MODEL_ENV_ERROR = "분석 실행 환경을 불러오지 못했습니다. ZIP 전체를 압축 해제한 폴더에서 색채연구.exe를 실행하세요."


@lru_cache(maxsize=1)
def model_availability():
    """Probe actual imports, including native libraries, once per app process."""
    try:
        for name in ("torch", "torchvision", "numpy", "PIL.ImageCms"):
            importlib.import_module(name)
    except Exception as error:
        return False, f"{type(error).__name__}: {error}"
    return True, None


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temp.replace(path)


def id_ok(value):
    return isinstance(value, str) and SAFE_ID.fullmatch(value) and value.upper() not in {
        "CON", "PRN", "AUX", "NUL", *(f"{prefix}{i}" for prefix in ("COM", "LPT") for i in range(1, 10))
    }


def adapt(photo):
    """Preserve capture metadata and add the model's canonical fields."""
    image_id = photo.get("photo_id")
    if not id_ok(image_id):
        raise ValueError("사진 ID가 올바르지 않습니다.")
    lat, lon = photo.get("latitude"), photo.get("longitude")
    if any(type(v) not in (float, int) for v in (lat, lon)) or not (-85 <= lat <= 85 and -180 <= lon <= 180):
        raise ValueError(f"{image_id}의 촬영 좌표가 올바르지 않습니다.")
    if photo.get("crs", "EPSG:4326") != "EPSG:4326":
        raise ValueError("촬영 좌표계는 EPSG:4326이어야 합니다.")
    sequence = photo.get("sequence")
    if sequence is not None and (type(sequence) is not int or sequence < 0):
        raise ValueError("사진 순번이 올바르지 않습니다.")
    return {
        **photo, "image_id": image_id, "route_id": photo.get("run_id"),
        "sequence_index": photo.get("sequence"), "distance_from_start_m": photo.get("actual_route_distance_m"),
        "location": {"latitude": lat, "longitude": lon, "heading_deg": photo.get("heading"),
                     "crs": "EPSG:4326", "role": "camera_position"},
    }


def capture_scope(run):
    vertices = run.get("route")
    if not isinstance(vertices, list) or not 2 <= len(vertices) <= 1000:
        return None
    for point in vertices:
        if not isinstance(point, dict):
            return None
        lat, lon = point.get("lat"), point.get("lon")
        if type(lat) not in (int, float) or type(lon) not in (int, float) or not (-85 <= lat <= 85 and -180 <= lon <= 180):
            return None
    label = run.get("label")
    folder = run.get("capture_folder")
    return {"run_id": run.get("run_id"), "label": label if isinstance(label, str) else "",
            "vertices": [{"lat": point["lat"], "lon": point["lon"]} for point in vertices],
            "capture_folder": folder if isinstance(folder, str) and re.fullmatch(
                r"\d{4}-\d{2}-\d{2}_\d{6}(?:_\d{2,})?", folder) else None,
            "planned_points": len(run["samples"]) if isinstance(run.get("samples"), list) else None}


def capture_zip(path, destination):
    """Pair sidecars with their own images and recover the recorded route if available."""
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len(entries) > 12_000 or sum(entry.file_size for entry in entries) > 768 * 1024**2:
            raise ValueError("압축을 푼 파일이 너무 큽니다. ZIP을 나눠 주세요.")
        files = {}
        for entry in entries:
            relative = PurePosixPath(entry.filename)
            if relative.is_absolute() or ".." in relative.parts or "\\" in entry.filename:
                raise ValueError("ZIP 안에 사용할 수 없는 경로가 있습니다.")
            if relative in files:
                raise ValueError("ZIP 안에 이름이 같은 파일이 있습니다.")
            files[relative] = entry
        items, seen = [], set()
        for relative, entry in files.items():
            if relative.suffix.lower() != ".json" or relative.name in {"run.json", "collection.json"}:
                continue
            if entry.file_size > 1024**2:
                continue
            sidecar = archive.read(entry)
            photo = json.loads(sidecar.decode("utf-8-sig"))
            if not isinstance(photo, dict) or "photo_id" not in photo:
                continue
            metadata = adapt(photo)
            image_id = metadata["image_id"]
            name = PurePosixPath(str(photo.get("file_path", ""))).name
            sibling = relative.with_name(name) if name else relative.with_suffix(".png")
            if sibling.suffix.lower() not in IMAGE_EXTENSIONS or sibling.stem != relative.stem or sibling not in files:
                raise ValueError(f"{relative.name}에 대응하는 사진이 없습니다.")
            if image_id.casefold() in seen:
                raise ValueError(f"사진 ID가 중복되었습니다. {image_id}")
            seen.add(image_id.casefold())
            if files[sibling].file_size > MAX_IMAGE:
                raise ValueError(f"{image_id} 사진 파일이 너무 큽니다.")
            target = destination / (image_id + sibling.suffix.lower())
            with archive.open(files[sibling]) as source, target.open("xb") as out:
                shutil.copyfileobj(source, out)
            (destination / (image_id + ".json")).write_bytes(sidecar)
            items.append({"path": str(target), "metadata": metadata})
        if not items:
            raise ValueError("사진과 사진별 위치 JSON이 있는 수집 ZIP을 선택하세요.")
        scope = None
        run_ids = {item["metadata"]["route_id"] for item in items
                   if isinstance(item["metadata"]["route_id"], str)}
        run_id = next(iter(run_ids)) if len(run_ids) == 1 else None
        if run_id and all(item["metadata"]["route_id"] == run_id for item in items):
            candidates = [entry for relative, entry in files.items()
                          if relative.name in {"collection.json", "run.json"} and entry.file_size <= 16 * 1024**2]
            for entry in candidates:
                try:
                    run = json.loads(archive.read(entry).decode("utf-8-sig"))
                    if isinstance(run, dict) and run.get("run_id") == run_id:
                        scope = capture_scope(run)
                        if scope:
                            break
                except (ValueError, OSError):
                    continue
        return items, scope


def prepare_image(path, target, metadata):
    from PIL import Image, ImageOps
    with Image.open(path) as image:
        if image.format not in {"JPEG", "PNG"} or image.width * image.height > 25_000_000:
            raise ValueError("25메가픽셀 이하의 JPG·PNG를 사용하세요.")
        if metadata.get("sha256") and hashlib.sha256(path.read_bytes()).hexdigest() != metadata["sha256"]:
            raise ValueError("수집 당시 사진과 현재 파일이 일치하지 않습니다.")
        width, height = image.size
        scene = metadata.get("scene_rect")
        if scene is None and "scene_height" in metadata:
            scene = {"x": 0, "y": 0, "width": width, "height": metadata["scene_height"]}
        if scene is not None:
            x, y, w, h = (scene.get(k) for k in ("x", "y", "width", "height"))
            if any(type(v) is not int for v in (x, y, w, h)) or not (
                0 <= x < x + w <= width and 0 <= y < y + h <= height
            ):
                raise ValueError("사진 안의 장면 범위가 올바르지 않습니다.")
            # Capture scene coordinates refer to the stored PNG, before EXIF orientation.
            if image.getexif().get(274, 1) != 1:
                raise ValueError("회전 정보가 있는 사진의 장면 범위를 확인하세요.")
            working = image.crop((x, y, x + w, y + h))
        else:
            working = ImageOps.exif_transpose(image)
        if working.mode == "RGBA":
            if working.getchannel("A").getextrema() != (255, 255):
                raise ValueError("투명 영역이 있는 사진은 색채 분석에 사용할 수 없습니다.")
            working = working.convert("RGB")
        if working.mode != "RGB":
            raise ValueError("RGB 사진이 필요합니다.")
        icc = image.info.get("icc_profile")
        if shutil.disk_usage(target.parent).free < max(128 * 1024**2, working.width * working.height * 85):
            raise ValueError("분류 결과를 저장할 디스크 공간이 부족합니다.")
        working.save(target, **({"icc_profile": icc} if icc else {}))
    return {
        **metadata, "analysis_frame": {"source_size": [width, height],
                                      "scene_rect": scene, "working_size": list(working.size)},
    }


class Workflow:
    def __init__(self, store):
        self.store = store
        self.root = store.root / "analysis_jobs"
        self.root.mkdir(exist_ok=True)
        self.lock = threading.Lock()
        self.engine = None
        for path in self.root.glob("*/status.json"):
            try:
                status = read_json(path)
                if status["state"] in ("queued", "running"):
                    status.update(state="partial" if status["ready"] else "failed",
                                  error="프로그램이 종료되어 이 작업이 중단되었습니다.")
                    save_json(path, status)
            except (ValueError, OSError, KeyError):
                continue

    def info(self):
        ready, error = model_availability()
        return {
            "dependencies": ready,
            "dependency_error": error,
            "classes": read_json(self.store.root / "class_registry.json")["classes"],
        }

    def job_path(self, job_id):
        if not JOB_ID.fullmatch(job_id):
            raise ValueError("작업 번호를 확인하세요.")
        return self.root / job_id

    def status(self, job_id):
        job = self.job_path(job_id)
        status = read_json(job / "status.json")
        if "capture_scope" not in status and status.get("photos"):
            # Earlier jobs retained the source run ID in each photo manifest.
            first_id = status["photos"][0]["id"]
            try:
                metadata = read_json(self.asset(job_id, first_id, "manifest.json")).get("upstream_metadata") or {}
                run = self.store.read_run(metadata.get("run_id"))
                source_ids = {photo["photo_id"] for photo in run["photos"]}
                if all(photo["id"] in source_ids for photo in status["photos"]):
                    status["capture_scope"] = capture_scope(run)
            except (OSError, ValueError, KeyError, TypeError):
                pass
        return status

    def history(self):
        jobs = []
        for path in self.root.glob("*/status.json"):
            try:
                job = read_json(path)
                jobs.append({k: job[k] for k in ("id", "name", "state", "total", "ready")})
            except (OSError, ValueError, KeyError):
                continue
        return sorted(jobs, key=lambda job: (self.job_path(job["id"]) / "status.json").stat().st_mtime, reverse=True)

    def create(self, name, items, job, scope=None):
        if not items:
            raise ValueError("수집한 사진이 없습니다.")
        if not self.info()["dependencies"]:
            raise ValueError(MODEL_ENV_ERROR)
        items.sort(key=lambda item: (item["metadata"].get("sequence_index") or 0, item["metadata"]["image_id"]))
        status = {"id": job.name, "name": name, "state": "queued", "total": len(items), "capture_scope": scope,
                  "ready": 0, "done": 0, "photos": [], "failures": []}
        save_json(job / "status.json", status)
        accepted = {**status, "photos": [], "failures": []}
        threading.Thread(target=self.run, args=(job, items, status), daemon=True).start()
        return accepted

    def from_run(self, run_id):
        run = self.store.read_run(run_id)
        if run["status"] == "running":
            raise ValueError("수집을 마치거나 중단한 뒤 분석하세요.")
        items = []
        for photo in run["photos"]:
            path = (self.store.root / photo["file_path"]).resolve()
            if not path.is_relative_to(self.store.captures) or not path.is_file():
                raise ValueError("저장된 수집 사진을 찾을 수 없습니다.")
            items.append({"path": str(path), "metadata": adapt(photo)})
        if not items:
            raise ValueError("수집한 사진이 없습니다.")
        if not self.info()["dependencies"]:
            raise ValueError(MODEL_ENV_ERROR)
        job = self.job_path(uuid.uuid4().hex)
        job.mkdir()
        name = " · ".join(part for part in (run.get("label"), run.get("capture_folder")) if part) or "거리뷰 수집"
        return self.create(name, items, job, capture_scope(run))

    def from_zip(self, stream, length):
        if not 0 < length <= MAX_ARCHIVE:
            raise ValueError("512MB 이하의 ZIP을 선택하세요.")
        if not self.info()["dependencies"]:
            raise ValueError(MODEL_ENV_ERROR)
        job = self.job_path(uuid.uuid4().hex)
        incoming = job / "input"
        incoming.mkdir(parents=True)
        archive = job / "upload.zip"
        try:
            with archive.open("xb") as out:
                while length:
                    block = stream.read(min(length, 1024**2))
                    if not block:
                        raise ValueError("ZIP 전송이 중단되었습니다.")
                    length -= len(block)
                    out.write(block)
            items, scope = capture_zip(archive, incoming)
            return self.create(scope["label"] if scope and scope["label"] else "수집 ZIP", items, job, scope)
        except BaseException:
            shutil.rmtree(job)
            raise
        finally:
            archive.unlink(missing_ok=True)

    def run(self, job, items, status):
        with self.lock:
            try:
                from urban_color import Segmenter
                from color_analysis import analyze
                status["state"] = "running"
                save_json(job / "status.json", status)
                if self.engine is None:
                    self.engine = Segmenter(model="baseline", device="auto")
                bundles = job / "bundles"
                bundles.mkdir()
                for item in items:
                    metadata = item["metadata"]
                    image_id = metadata["image_id"]
                    bundle = bundles / image_id
                    working = job / (image_id + "-scene.png")
                    try:
                        metadata = prepare_image(Path(item["path"]), working, metadata)
                        manifest = self.engine.segment(working, bundle, image_id, metadata=metadata)
                        result = analyze(bundle, manifest)
                        save_json(bundle / "analysis.json", result)
                        status["photos"].append({
                            "id": image_id, "road": metadata.get("road_name") or "도로명 미확인",
                            "location": metadata["location"], "sequence": metadata.get("sequence_index"),
                            "overlays": bool(metadata.get("dom_overlays_included")),
                            "pixels": result["total_pixels"],
                            "counts": [item["pixels"] for item in result["classes"]],
                        })
                        status["ready"] += 1
                    except Exception as exc:
                        status["failures"].append({"id": image_id, "message": str(exc)})
                    finally:
                        working.unlink(missing_ok=True)
                    status["done"] += 1
                    save_json(job / "status.json", status)
                status["state"] = ("ready" if status["ready"] == status["total"]
                                   else "partial" if status["ready"] else "failed")
            except Exception as exc:
                status.update(state="failed", error=str(exc))
            save_json(job / "status.json", status)

    def asset(self, job_id, image_id, relative):
        if not id_ok(image_id) or not re.fullmatch(
            r"(?:manifest\.json|analysis\.json|source_rgb\.png|label_map\.png|preview_overlay\.jpg|"
            r"(?:masks|clips)/[0-9]{2}_[a-z_]+\.png)", relative
        ):
            raise ValueError("결과 파일 경로를 확인하세요.")
        job = self.job_path(job_id)
        path = (job / "bundles" / image_id / relative).resolve()
        if not path.is_relative_to(job) or not path.is_file():
            raise ValueError("결과 파일을 찾을 수 없습니다.")
        return path
