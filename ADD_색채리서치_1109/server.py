"""Local-only street photograph collector. No AI calls or third-party Python packages."""
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
import argparse
import base64
import binascii
import csv
import hashlib
import io
import json
import math
import mimetypes
import os
import re
import secrets
import struct
import threading
import uuid
import webbrowser
import zipfile

from geotag import add_metadata, png_size
from workflow import Workflow

ROOT = Path(__file__).resolve().parent
CSV_FIELDS = [
    "photo_id", "point_id", "file_path", "road_name", "road_name_source", "sequence",
    "latitude", "longitude", "crs", "requested_latitude", "requested_longitude",
    "requested_distance_m", "actual_route_distance_m", "match_distance_m", "route_offset_m",
    "heading", "tilt", "fov", "source", "pano_id", "photo_date_raw", "collected_at",
    "capture_method", "width", "height", "scene_height", "sha256", "review_status",
]
FRAME_TIMEOUT = "탭 캡처 화면의 새 프레임을 읽지 못했습니다."
SEOUL = timezone(timedelta(hours=9))
SOURCE_NOTE = (
    "Source: NAVER Maps panorama.\n원본 제공자와 촬영 정보는 사진별 JSON에 기록됩니다.\n"
    "이용·보관·발표 범위는 적용되는 네이버 Maps 이용 조건을 확인하세요.\n"
    "사진 하단의 출처 띠는 scene_height 밖에 있으며 색채 분석 대상에서 제외할 수 있습니다.\n"
)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_name(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .\t")[:90]
    if not name or name in (".", ".."):
        name = "도로명미확인"
    if name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}:
        name = "도로_" + name
    return name


def finite(value, label, minimum=-1e12, maximum=1e12):
    if isinstance(value, bool):
        raise ValueError(label + " 값이 잘못되었습니다.")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(label + " 값이 잘못되었습니다.") from None
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(label + " 값의 범위를 확인하세요.")
    return result


def coordinate(value):
    if not isinstance(value, dict):
        raise ValueError("좌표 형식이 잘못되었습니다.")
    return {"lat": finite(value.get("lat"), "위도", -85, 85), "lon": finite(value.get("lon"), "경도", -180, 180)}


def point_distance(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    delta_lat = lat2 - lat1
    delta_lon = math.radians(b["lon"] - a["lon"])
    h = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.captures = self.root / "captures"
        self.runs = self.root / "runs"
        self.exports = self.root / "exports"
        for directory in (self.captures, self.runs, self.exports):
            directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def read_run(self, run_id):
        if not re.fullmatch(r"[a-f0-9]{32}", str(run_id)):
            raise ValueError("실행 ID가 잘못되었습니다.")
        path = self.runs / (run_id + ".json")
        if not path.is_file():
            raise FileNotFoundError("실행 기록을 찾을 수 없습니다.")
        return load_json(path)

    def create_run(self, payload):
        route = payload.get("route")
        samples = payload.get("samples")
        if not isinstance(route, list) or not 2 <= len(route) <= 1000:
            raise ValueError("시작과 끝을 포함한 경로가 필요합니다.")
        vertices = [coordinate(p) for p in route]
        if not isinstance(samples, list) or not 1 <= len(samples) <= 2001:
            raise ValueError("경로 표본 수를 확인하세요.")
        normalized = []
        for index, sample in enumerate(samples):
            p = coordinate(sample)
            distance = finite(sample.get("distance_m"), "경로 거리", 0, 20000.001)
            if abs(distance - index * 10) > .001:
                raise ValueError("추출 지점은 10m 간격이어야 합니다.")
            normalized.append({**p, "index": index, "distance_m": distance,
                               "heading": finite(sample.get("heading"), "방향", 0, 360)})
        supplied = payload.get("settings", {})
        settings = {
            "interval_m": 10, "views_per_point": 1, "view": "forward", "tilt": 0,
            "fov": finite(supplied.get("fov", 90), "화각", 50, 100),
            "offset": finite(supplied.get("offset", 0), "방향 보정", -45, 45),
            "snap": finite(supplied.get("snap", 15), "위치 허용 거리", 2, 40),
            "settle": finite(supplied.get("settle", 2200), "대기 시간", 1000, 15000),
        }
        run_id = payload.get("run_id", uuid.uuid4().hex)
        if not isinstance(run_id, str) or not re.fullmatch(r"[a-f0-9]{32}", run_id):
            raise ValueError("실행 ID가 잘못되었습니다.")
        run = {
            "run_id": run_id, "tool_version": "1.0.0", "created_at": now(), "updated_at": now(),
            "status": "running", "settings": settings, "route": vertices, "samples": normalized,
            "length_m": finite(payload.get("length_m"), "경로 길이", 1, 20000.01),
            "label": str(payload.get("label", "")).strip()[:100],
            "road_folders": {}, "photos": [], "events": [], "next_index": 0,
            "ai_calls": 0, "coordinate_reference_system": "EPSG:4326",
        }
        with self.lock:
            if (self.runs / (run_id + ".json")).is_file():
                previous = self.read_run(run_id)
                fields = ("route", "samples", "settings", "length_m", "label")
                if any(previous[key] != run[key] for key in fields):
                    raise ValueError("이 실행 ID에는 다른 경로가 저장되어 있습니다.")
                return previous
            folder = self.allocate_capture_folder(datetime.now(SEOUL).strftime("%Y-%m-%d_%H%M%S"))
            run["capture_folder"] = folder.name
            write_json(self.runs / (run_id + ".json"), run)
            self.write_manifests(run)
        return run

    def allocate_capture_folder(self, stamp):
        number = 1
        while True:
            folder = self.captures / (stamp if number == 1 else f"{stamp}_{number:02d}")
            try:
                folder.mkdir()
                break
            except FileExistsError:
                number += 1
        (folder / "출처.txt").write_text(SOURCE_NOTE, encoding="utf-8")
        return folder

    def existing_capture_folder(self, name):
        if not isinstance(name, str) or not name or Path(name).name != name:
            raise ValueError("저장 폴더가 변경되었습니다.")
        folder = self.captures / name
        if not folder.is_dir() or folder.resolve().parent != self.captures.resolve():
            raise ValueError("저장 폴더가 변경되었습니다.")
        return folder

    def run_capture_folders(self, run):
        if run.get("capture_folder"):
            return [run["capture_folder"]]
        return list(run["road_folders"].values())

    def folder(self, run, road):
        if run.get("capture_folder"):
            return self.existing_capture_folder(run["capture_folder"])
        # Legacy runs resume in their original per-road directories.
        base = safe_name(road)
        if base in run["road_folders"]:
            return self.existing_capture_folder(run["road_folders"][base])
        existing = []
        for entry in self.captures.iterdir():
            match = re.fullmatch(re.escape(base) + r"_(\d+)", entry.name)
            if match:
                existing.append(int(match.group(1)))
        number = max(existing, default=0) + 1
        while True:
            folder = self.captures / f"{base}_{number:03d}"
            try:
                folder.mkdir()
                break
            except FileExistsError:
                number += 1
        run["road_folders"][base] = folder.name
        (folder / "출처.txt").write_text(SOURCE_NOTE, encoding="utf-8")
        return folder

    def save_photo(self, payload):
        with self.lock:
            run = self.read_run(payload.get("run_id"))
            if run["status"] == "complete":
                raise ValueError("완료된 실행에는 사진을 추가할 수 없습니다.")
            index = payload.get("index")
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(run["samples"]):
                raise ValueError("표본 번호가 잘못되었습니다.")
            for photo in run["photos"]:
                if photo["sample_index"] == index:
                    return {"saved": True, "already_saved": True, "photo": photo, "run": run}
            supplied = payload.get("metadata", {})
            actual = coordinate({"lat": supplied.get("latitude"), "lon": supplied.get("longitude")})
            pano_id = str(supplied.get("pano_id", "")).strip()
            if not pano_id or len(pano_id) > 500:
                raise ValueError("실제 파노라마 ID가 필요합니다.")
            requested = run["samples"][index]
            match_distance = point_distance(requested, actual)
            if match_distance > run["settings"]["snap"] * 1.02 + .05:
                raise ValueError("실제 촬영 위치가 요청 지점에서 너무 멉니다.")
            for photo in run["photos"]:
                previous = {"lat": photo["latitude"], "lon": photo["longitude"]}
                if photo["pano_id"] == pano_id or point_distance(previous, actual) < .5:
                    return {"saved": False, "duplicate": True, "duplicate_photo_id": photo["photo_id"]}
            encoded = payload.get("png")
            if not isinstance(encoded, str) or not encoded.startswith("data:image/png;base64,"):
                raise ValueError("PNG 캡처가 필요합니다.")
            try:
                image = base64.b64decode(encoded.split(",", 1)[1], validate=True)
            except (ValueError, binascii.Error):
                raise ValueError("이미지 데이터가 잘못되었습니다.") from None
            width, height = png_size(image)
            scene_height = int(finite(supplied.get("scene_height"), "사진 영역 높이", 16, height))
            if width * height > 80_000_000:
                raise ValueError("이미지 해상도가 너무 큽니다.")
            method = supplied.get("capture_method")
            if method not in ("canvas_scene", "shared_tab_viewport"):
                raise ValueError("지원하지 않는 캡처 방식입니다.")
            raw_road = str(supplied.get("road_name", "")).strip()[:200]
            fallback = run["label"]
            road = raw_road or fallback or "도로명미확인"
            folder = self.folder(run, road)
            photo_id = run["run_id"][:8] + f"_{index + 1:04d}"
            filename = f"lat_{actual['lat']:.6f}_lon_{actual['lon']:.6f}__{index + 1:04d}.png"
            path = folder / filename
            if path.exists():
                raise ValueError("같은 이름의 파일이 이미 있습니다. 새 실행으로 저장하세요.")
            metadata = {
                "photo_id": photo_id, "point_id": pano_id, "run_id": run["run_id"], "sample_index": index,
                "sequence": index + 1, "file_path": path.relative_to(self.root).as_posix(),
                "road_name": road, "road_name_raw": raw_road,
                "road_name_source": "panorama_metadata" if raw_road else ("operator_fallback" if fallback else "unknown"),
                "address": str(supplied.get("address", ""))[:500],
                "latitude": actual["lat"], "longitude": actual["lon"], "crs": "EPSG:4326",
                "requested_latitude": requested["lat"], "requested_longitude": requested["lon"],
                "requested_distance_m": requested["distance_m"],
                "actual_route_distance_m": finite(supplied.get("actual_route_distance_m"), "실제 경로 위치", 0, run["length_m"] + .1),
                "match_distance_m": finite(supplied.get("match_distance_m"), "일치 거리", 0, 100),
                "route_offset_m": finite(supplied.get("route_offset_m"), "경로 이격 거리", 0, 100),
                "heading": finite(supplied.get("heading"), "실제 시야 방향", 0, 360) % 360,
                "tilt": finite(supplied.get("tilt", 0), "기울기", -1, 1),
                "fov": finite(supplied.get("fov"), "실제 화각", 20, 100),
                "view": "forward", "source": "naver_panorama", "location_source": "provider_panorama_metadata",
                "pano_id": pano_id, "photo_date_raw": str(supplied.get("photo_date_raw", ""))[:100],
                "collected_at": now(), "capture_method": method, "width": width, "height": height,
                "scene_height": scene_height, "scene_rect": {"x": 0, "y": 0, "width": width, "height": scene_height},
                "dom_overlays_included": method == "shared_tab_viewport",
                "scene_sha256": str(supplied.get("scene_sha256", ""))[:64],
                "review_status": "unreviewed", "attribution": "NAVER Maps", "ai_calls": 0,
            }
            tagged = add_metadata(image, metadata)
            temporary = path.with_suffix(".png.part")
            temporary.write_bytes(tagged)
            temporary.replace(path)
            metadata["sha256"] = hashlib.sha256(tagged).hexdigest()
            write_json(path.with_suffix(".json"), metadata)
            run["photos"].append(metadata)
            run["photos"].sort(key=lambda photo: photo["sample_index"])
            run["next_index"] = max(run["next_index"], index + 1)
            run["updated_at"] = now()
            write_json(self.runs / (run["run_id"] + ".json"), run)
            self.write_manifests(run)
            return {"saved": True, "photo": metadata, "run": run}

    def event(self, payload):
        with self.lock:
            run = self.read_run(payload.get("run_id"))
            index = payload.get("index")
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(run["samples"]):
                raise ValueError("표본 번호가 잘못되었습니다.")
            run["events"].append({"index": index, "at": now(), "status": str(payload.get("status", "error"))[:80],
                                  "reason": str(payload.get("reason", ""))[:1500]})
            run["next_index"] = max(run["next_index"], index + 1)
            run["updated_at"] = now()
            write_json(self.runs / (run["run_id"] + ".json"), run)
            self.write_manifests(run)
            return run

    def finish(self, payload):
        with self.lock:
            run = self.read_run(payload.get("run_id"))
            status = payload.get("status")
            if status not in ("complete", "paused", "error"):
                raise ValueError("실행 상태가 잘못되었습니다.")
            run["status"] = status
            if status == "complete":
                run["next_index"] = len(run["samples"])
            run["updated_at"] = now()
            run["finished_at"] = now() if status == "complete" else None
            write_json(self.runs / (run["run_id"] + ".json"), run)
            self.write_manifests(run)
            return run

    def retry_capture(self, payload):
        with self.lock:
            run = self.read_run(payload.get("run_id"))
            if run["status"] not in ("complete", "paused", "error"):
                raise ValueError("진행 중인 수집을 먼저 멈춰 주세요.")
            saved = {photo["sample_index"] for photo in run["photos"]}
            retry = [event for event in run["events"] if event["status"] == "error"
                     and event["reason"] == FRAME_TIMEOUT and event["index"] not in saved]
            if not retry:
                raise ValueError("화면을 받지 못해 누락된 지점이 없습니다.")
            run.setdefault("retried_events", []).extend(retry)
            run["events"] = [event for event in run["events"] if event not in retry]
            run["next_index"] = min(run["next_index"], *(event["index"] for event in retry))
            run["status"] = "paused"
            run["updated_at"] = now()
            run["finished_at"] = None
            write_json(self.runs / (run["run_id"] + ".json"), run)
            self.write_manifests(run)
            return run

    def write_manifests(self, run):
        for folder_name in self.run_capture_folders(run):
            folder = self.existing_capture_folder(folder_name)
            prefix = folder.relative_to(self.root).as_posix() + "/"
            photos = [p for p in run["photos"] if p["file_path"].startswith(prefix)]
            manifest = folder / "manifest.csv"
            temp = manifest.with_suffix(".csv.tmp")
            with temp.open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS, extrasaction="ignore")
                writer.writeheader()
                writer.writerows(photos)
            temp.replace(manifest)
            features = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [p["longitude"], p["latitude"]]},
                         "properties": {key: p[key] for key in ("photo_id", "road_name", "heading", "photo_date_raw", "file_path", "requested_distance_m")}} for p in photos]
            write_json(folder / "points.geojson", {"type": "FeatureCollection", "features": features})
            write_json(folder / "route.geojson", {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"interval_m": 10},
                "geometry": {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in run["route"]]}}]})
            write_json(folder / "run.json", {**run, "photos": photos})

    def history(self):
        history = []
        for path in self.runs.glob("*.json"):
            try:
                run = load_json(path)
                history.append({"run_id": run["run_id"], "created_at": run["created_at"], "status": run["status"],
                                "saved": len(run["photos"]), "planned": len(run["samples"]), "label": run["label"],
                                "folders": self.run_capture_folders(run), "next_index": run["next_index"]})
            except (OSError, ValueError, KeyError):
                continue
        return sorted(history, key=lambda h: h["created_at"], reverse=True)

    def export(self, run_id):
        with self.lock:
            run = self.read_run(run_id)
            if not run["photos"]:
                raise ValueError("저장한 사진이 없습니다.")
            destination = self.exports / (run_id + ".zip")
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.write(self.runs / (run_id + ".json"), "collection.json")
                for name in self.run_capture_folders(run):
                    for path in sorted(self.existing_capture_folder(name).iterdir()):
                        if path.is_file() and path.suffix not in (".tmp", ".part"):
                            archive.write(path, name + "/" + path.name)
            return destination


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # API keys never reach this server. Avoid logging GPS request bodies as well.
        pass

    def trusted(self, mutation=False):
        if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            return False
        origin = self.headers.get("Origin")
        allowed = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if origin and origin not in allowed:
            return False
        return not mutation or secrets.compare_digest(self.headers.get("X-Capture-Token", ""), self.server.token)

    def send_json(self, value, code=200):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # A disconnected browser can read the committed state after reconnecting.
            pass

    def send_file(self, path, download=False):
        size = path.stat().st_size
        self.send_response(200)
        mime = {".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8"}.get(path.suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="street_capture_{path.stem[:8]}.zip"')
        self.end_headers()
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                self.wfile.write(block)

    def do_GET(self):
        if not self.trusted():
            self.send_json({"error": "이 컴퓨터의 실행 주소로 접속하세요."}, 403)
            return
        path = unquote(urlsplit(self.path).path)
        try:
            if path == "/api/info":
                self.send_json({"token": self.server.token, "output_path": str(self.server.store.captures), "version": "1.3.0", "mosaic_grid": True, "facade_palettes": True, "ai_calls": 0})
            elif path == "/api/history":
                self.send_json(self.server.store.history())
            elif re.fullmatch(r"/api/run/[a-f0-9]{32}", path):
                self.send_json(self.server.store.read_run(path.rsplit("/", 1)[-1]))
            elif re.fullmatch(r"/api/export/[a-f0-9]{32}", path):
                self.send_file(self.server.store.export(path.rsplit("/", 1)[-1]), download=True)
            elif path == "/api/analysis/info":
                self.send_json(self.server.workflow.info())
            elif path == "/api/analysis/history":
                self.send_json(self.server.workflow.history())
            elif re.fullmatch(r"/api/analysis/[a-f0-9]{32}", path):
                self.send_json(self.server.workflow.status(path.rsplit("/", 1)[-1]))
            elif re.fullmatch(r"/api/analysis/[a-f0-9]{32}/[^/]+/.+", path):
                _, _, _, job, image, relative = path.split("/", 5)
                if relative == "color-view.png":
                    self.send_color_view(job, image)
                elif relative == "facade.json":
                    from color_analysis import facade_histograms
                    source = self.server.workflow.asset(job, image, "source_rgb.png")
                    mask = self.server.workflow.asset(job, image, "label_map.png")
                    self.send_json(facade_histograms(source, mask))
                elif relative == "mosaic.json":
                    from color_analysis import mosaic_grid
                    query = parse_qs(urlsplit(self.path).query)
                    columns = int(query.get("columns", ["48"])[0])
                    source = self.server.workflow.asset(job, image, "source_rgb.png")
                    mask = self.server.workflow.asset(job, image, "label_map.png")
                    self.send_json(mosaic_grid(source, mask, columns))
                else:
                    self.send_file(self.server.workflow.asset(job, image, relative))
            elif path in ("/", "/index.html", "/app.js", "/geo.js", "/app.css", "/research.js", "/research.css", "/road-map.js"):
                self.send_file(ROOT / ("index.html" if path == "/" else path[1:]))
            elif path.startswith("/captures/"):
                target = (self.server.store.root / path.lstrip("/")).resolve()
                if not target.is_relative_to(self.server.store.captures.resolve()) or not target.is_file():
                    raise ValueError("저장 파일을 찾을 수 없습니다.")
                self.send_file(target)
            else:
                self.send_json({"error": "페이지를 찾을 수 없습니다."}, 404)
        except FileNotFoundError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, OSError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def send_color_view(self, job, image):
        from color_analysis import color_view

        query = parse_qs(urlsplit(self.path).query)
        scope = query.get("class", ["scene"])[0]
        mode = query.get("mode", ["overlay"])[0]
        raw_bins = query.get("bins", [""])[0]
        if len(raw_bins) > 2048:
            raise ValueError("색 범위가 너무 깁니다.")
        bins = [int(value) for value in raw_bins.split(",")] if raw_bins else []
        source = self.server.workflow.asset(job, image, "source_rgb.png")
        mask = self.server.workflow.asset(job, image, "label_map.png")
        payload = color_view(source, mask, scope, bins, mode)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        if not self.trusted(mutation=True):
            self.send_json({"error": "실행 연결이 만료되었습니다. 페이지를 새로고침하세요."}, 403)
            return
        try:
            path = urlsplit(self.path).path
            length = int(self.headers.get("Content-Length", 0))
            if path == "/api/analysis/import":
                if self.headers.get_content_type() != "application/zip":
                    raise ValueError("거리뷰 수집 ZIP을 선택하세요.")
                self.send_json(self.server.workflow.from_zip(self.rfile, length), 202)
                return
            if self.headers.get_content_type() != "application/json":
                raise ValueError("JSON 요청이 필요합니다.")
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 64 * 1024 * 1024:
                raise ValueError("요청 크기를 확인하세요.")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("요청 형식이 잘못되었습니다.")
            path = urlsplit(self.path).path
            if path == "/api/run":
                result = self.server.store.create_run(payload)
            elif path == "/api/photo":
                result = self.server.store.save_photo(payload)
            elif path == "/api/event":
                result = self.server.store.event(payload)
            elif path == "/api/finish":
                result = self.server.store.finish(payload)
            elif path == "/api/retry-capture":
                result = self.server.store.retry_capture(payload)
            elif path == "/api/analysis/run":
                self.send_json(self.server.workflow.from_run(payload.get("run_id")), 202)
                return
            elif path == "/api/open-output":
                output = self.server.store.captures
                if payload.get("run_id"):
                    run = self.server.store.read_run(payload["run_id"])
                    if run.get("capture_folder"):
                        output = self.server.store.existing_capture_folder(run["capture_folder"])
                if os.name == "nt":
                    os.startfile(str(output))
                result = {"path": str(output)}
            else:
                self.send_json({"error": "지원하지 않는 요청입니다."}, 404)
                return
            self.send_json(result)
        except FileNotFoundError as exc:
            self.send_json({"error": str(exc)}, 404)
        except OSError as exc:
            self.send_json({"error": f"저장 폴더에 접근하지 못했습니다. 폴더를 확인한 뒤 다시 연결하세요. ({exc.strerror or type(exc).__name__})"}, 503)
        except (ValueError, KeyError, TypeError, struct.error, zipfile.BadZipFile, RuntimeError) as exc:
            self.send_json({"error": str(exc)}, 400)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--fallback-port", action="store_true")
    args = parser.parse_args()
    for filename in ("index.html", "app.css", "app.js", "geo.js", "research.js", "research.css", "road-map.js"):
        if not (ROOT / filename).is_file():
            print("Missing app file:", filename, flush=True)
            return 1
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        if args.port == 0:
            raise
        if not args.fallback_port:
            print("Port is in use. Close the previous Color Lab window or select another port.", flush=True)
            return 1
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.token = secrets.token_urlsafe(32)
    server.store = Store(ROOT)
    server.workflow = Workflow(server.store)
    url = f"http://127.0.0.1:{server.server_port}/"
    print("SONGJEONG / STREET COLOR LAB", flush=True)
    print(url, flush=True)
    print("Segmentation runs locally. NAVER Maps Key ID is required for new captures.", flush=True)
    print("Keep this window open. Ctrl+C stops the local service.", flush=True)
    if not args.no_open:
        threading.Timer(.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
