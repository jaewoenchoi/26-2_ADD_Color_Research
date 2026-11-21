"""Lossless PNG EXIF GPS writer. Standard library only; no image re-encoding."""
import json
import math
import struct
import zlib
from fractions import Fraction

SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunks(data):
    if not data.startswith(SIGNATURE):
        raise ValueError("PNG 이미지가 아닙니다.")
    position = 8
    ended = False
    while position + 12 <= len(data):
        size = struct.unpack_from(">I", data, position)[0]
        end = position + size + 12
        if end > len(data):
            raise ValueError("PNG 데이터가 잘렸습니다.")
        kind = data[position + 4:position + 8]
        payload = data[position + 8:position + 8 + size]
        checksum = struct.unpack_from(">I", data, position + 8 + size)[0]
        if zlib.crc32(kind + payload) & 0xffffffff != checksum:
            raise ValueError("PNG 검증값이 일치하지 않습니다.")
        yield kind, payload
        position = end
        if kind == b"IEND":
            ended = True
            break
    if not ended or position != len(data):
        raise ValueError("PNG 종료 데이터가 잘못되었습니다.")


def png_size(data):
    entries = list(chunks(data))
    if not entries or entries[0][0] != b"IHDR" or len(entries[0][1]) != 13:
        raise ValueError("PNG 헤더가 잘못되었습니다.")
    return struct.unpack_from(">II", entries[0][1])


def chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff)


def rational(value):
    fraction = Fraction(float(value)).limit_denominator(10_000_000)
    return struct.pack("<II", fraction.numerator, fraction.denominator)


def dms(value):
    absolute = abs(float(value))
    degrees = int(absolute)
    minutes_full = (absolute - degrees) * 60
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60
    return rational(degrees) + rational(minutes) + rational(seconds)


def gps_exif(latitude, longitude, heading):
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("위도가 잘못되었습니다.")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("경도가 잘못되었습니다.")
    if not math.isfinite(heading):
        raise ValueError("방향 값이 잘못되었습니다.")
    # IFD0 contains a single pointer to the GPS IFD. No guessed date or altitude.
    gps_offset = 26
    values = [
        (0x0000, 1, 4, bytes([2, 3, 0, 0])),
        (0x0001, 2, 2, b"N\0" if latitude >= 0 else b"S\0"),
        (0x0002, 5, 3, dms(latitude)),
        (0x0003, 2, 2, b"E\0" if longitude >= 0 else b"W\0"),
        (0x0004, 5, 3, dms(longitude)),
        (0x0010, 2, 2, b"T\0"),
        (0x0011, 5, 1, rational(heading % 360)),
        (0x0012, 2, 7, b"WGS-84\0"),
    ]
    offset = gps_offset + 2 + len(values) * 12 + 4
    directory = bytearray(struct.pack("<H", len(values)))
    extra = bytearray()
    for tag, kind, count, value in values:
        if len(value) <= 4:
            encoded = value.ljust(4, b"\0")
        else:
            encoded = struct.pack("<I", offset + len(extra))
            extra.extend(value)
            if len(extra) % 2:
                extra.append(0)
        directory.extend(struct.pack("<HHI", tag, kind, count) + encoded)
    directory.extend(struct.pack("<I", 0))
    header = b"II" + struct.pack("<HI", 42, 8)
    ifd0 = struct.pack("<H", 1) + struct.pack("<HHII", 0x8825, 4, 1, gps_offset) + struct.pack("<I", 0)
    return header + ifd0 + directory + extra


def add_metadata(data, metadata):
    entries = list(chunks(data))
    width, height = png_size(data)
    if not 16 <= width <= 16384 or not 16 <= height <= 16384 or width * height > 80_000_000:
        raise ValueError("지원하지 않는 이미지 크기입니다.")
    exif = gps_exif(float(metadata["latitude"]), float(metadata["longitude"]), float(metadata["heading"]))
    text = json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # PNG iTXt: keyword, compression flag/method, language, translated keyword, UTF-8.
    itxt = b"StreetCapture\0\0\0\0\0" + text
    result = bytearray(SIGNATURE)
    for kind, payload in entries:
        if kind == b"eXIf" or (kind == b"iTXt" and payload.startswith(b"StreetCapture\0")):
            continue
        result.extend(chunk(kind, payload))
        if kind == b"IHDR":
            result.extend(chunk(b"eXIf", exif))
            result.extend(chunk(b"iTXt", itxt))
    return bytes(result)
