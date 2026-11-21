"""Pixel-weighted analysis of the model's aligned RGB image and class IDs."""
import numpy as np
from PIL import Image, ImageCms
from io import BytesIO


def srgb_pixels(path):
    with Image.open(path) as source:
        profile = source.info.get("icc_profile")
        if profile:
            source = ImageCms.profileToProfile(
                source, ImageCms.getOpenProfile(BytesIO(profile)),
                ImageCms.createProfile("sRGB"), outputMode="RGB",
            )
        return np.array(source, dtype=np.uint8)


def color_view(source, label_map, scope, bins, mode):
    if mode not in {"overlay", "isolate"} or scope not in {"scene", "all", *map(str, range(15))}:
        raise ValueError("사진 표시 설정을 확인하세요.")
    if any(not 0 <= value < 512 for value in bins):
        raise ValueError("색 범위가 잘못되었습니다.")
    rgb = srgb_pixels(source)
    with Image.open(label_map) as mask:
        labels = np.asarray(mask)
    if labels.shape != rgb.shape[:2]:
        raise ValueError("사진과 분류 마스크가 일치하지 않습니다.")

    selected = (np.ones(labels.shape, dtype=bool) if scope == "scene" else
                labels > 0 if scope == "all" else labels == int(scope))
    if bins:
        lookup = np.zeros(512, dtype=bool)
        lookup[bins] = True
        r, g, b = (rgb[:, :, channel].astype(np.uint16) for channel in range(3))
        index = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5)
        selected &= lookup[index]
    if mode == "isolate":
        image = Image.fromarray(np.dstack((rgb, selected.astype(np.uint8) * 255)))
    else:
        rgb[~selected] = (rgb[~selected].astype(np.uint16) * 37 // 100).astype(np.uint8)
        image = Image.fromarray(rgb)
    image.thumbnail((1400, 1000), Image.Resampling.LANCZOS)
    result = BytesIO()
    image.save(result, format="PNG", compress_level=2)
    return result.getvalue()


def mosaic_grid(source, label_map, columns):
    if columns not in {28, 48, 72}:
        raise ValueError("격자 밀도를 확인하세요.")
    rgb = srgb_pixels(source)
    with Image.open(label_map) as mask:
        labels = np.asarray(mask)
    if labels.shape != rgb.shape[:2] or labels.ndim != 2 or labels.min() < 0 or labels.max() > 14:
        raise ValueError("사진과 분류 마스크가 일치하지 않습니다.")

    height, width = labels.shape
    columns = min(columns, width)
    rows = min(height, 96, max(1, round(columns * height / width)))
    x_edges = np.linspace(0, width, columns + 1, dtype=int)
    y_edges = np.linspace(0, height, rows + 1, dtype=int)
    cells = []
    for top, bottom in zip(y_edges, y_edges[1:]):
        for left, right in zip(x_edges, x_edges[1:]):
            region = labels[top:bottom, left:right]
            class_id = int(np.bincount(region.ravel(), minlength=15).argmax())
            colors = rgb[top:bottom, left:right][region == class_id]
            cells.append([class_id, *np.rint(colors.mean(axis=0)).astype(int).tolist()])
    return {"width": width, "height": height, "columns": columns, "rows": rows, "cells": cells}


def accumulate_rgb_bins(histogram, px, ids):
    r, g, b = (px[:, i].astype(np.int32) for i in range(3))
    keys = ids.astype(np.int32) * 512 + (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5)
    histogram[:, 0] += np.bincount(keys, minlength=len(histogram))
    for column, channel in enumerate((r, g, b), 1):
        histogram[:, column] += np.bincount(keys, weights=channel, minlength=len(histogram)).astype(np.int64)


def facade_histograms(source, label_map):
    rgb = srgb_pixels(source)
    with Image.open(label_map) as mask:
        labels = np.asarray(mask)
    if rgb.ndim != 3 or rgb.shape[2] != 3 or labels.shape != rgb.shape[:2] or labels.min() < 0 or labels.max() > 14:
        raise ValueError("사진과 분류 마스크가 일치하지 않습니다.")

    # Mask pixels assign colors to elements within four broad horizontal regions.
    elements = (13, 14, 4, 7, 9, 1)
    width = labels.shape[1]
    edges = [width * region // 4 for region in range(5)]
    regions = []
    for left, right in zip(edges, edges[1:]):
        histogram = np.zeros((15 * 512, 4), dtype=np.int64)
        for top in range(0, labels.shape[0], 128):
            region = labels[top:top + 128, left:right]
            selected = np.isin(region, elements)
            accumulate_rgb_bins(histogram, rgb[top:top + 128, left:right][selected], region[selected])
        classes = []
        for class_id in elements:
            bins = histogram[class_id * 512:(class_id + 1) * 512]
            classes.append({
                "id": class_id,
                "pixels": int(bins[:, 0].sum()),
                "bins": [[int(i), *bins[i].tolist()] for i in np.flatnonzero(bins[:, 0])],
            })
        regions.append(classes)
    return {"regions": regions}


def analyze(bundle, manifest):
    rgb = srgb_pixels(bundle / "source_rgb.png")
    with Image.open(bundle / "label_map.png") as mask:
        labels = np.array(mask)
    if labels.ndim != 2 or labels.shape != rgb.shape[:2] or labels.max() > 14:
        raise ValueError("사진과 분류 마스크가 일치하지 않습니다.")

    # Each channel has eight bins. Keep exact pixel counts and RGB sums in every bin.
    histogram = np.zeros((15 * 512, 4), dtype=np.int64)
    brightness = np.zeros(15)
    saturation = np.zeros(15)
    for start in range(0, len(labels), 128):
        px = rgb[start:start + 128].reshape(-1, 3)
        ids = labels[start:start + 128].reshape(-1)
        accumulate_rgb_bins(histogram, px, ids)

        srgb = px.astype(np.float64) / 255
        linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
        y = linear[:, 0] * .2126 + linear[:, 1] * .7152 + linear[:, 2] * .0722
        lstar = np.where(y > (6 / 29) ** 3, 116 * np.cbrt(y) - 16, (29 / 3) ** 3 * y)
        highest, lowest = srgb.max(axis=1), srgb.min(axis=1)
        hsv_s = np.divide(highest - lowest, highest, out=np.zeros_like(highest), where=highest > 0)
        brightness += np.bincount(ids, weights=lstar, minlength=15)
        saturation += np.bincount(ids, weights=hsv_s, minlength=15)

    classes = []
    expected = {item["id"]: item["pixel_count"] for item in manifest["classes"]}
    for class_id, bins in enumerate(histogram.reshape(15, 512, 4)):
        pixels = int(bins[:, 0].sum())
        if class_id and pixels != expected[class_id]:
            raise ValueError("분류 픽셀 수가 결과 파일과 일치하지 않습니다.")
        classes.append({
            "id": class_id, "pixels": pixels,
            "lightness_sum": float(brightness[class_id]),
            "saturation_sum": float(saturation[class_id]),
            "bins": [[int(i), *bins[i].tolist()] for i in np.flatnonzero(bins[:, 0])],
        })
    return {"total_pixels": int(labels.size), "classes": classes}
