# -*- coding: utf-8 -*-
"""アプリのアイコン（exe・窓・タスクバー）を描く。標準ライブラリだけで書く（作るとき desktop/build.rs が呼ぶ）。

絵: 藍の地に、等間隔に並ぶ欠点（赤い点）と、その間隔（ピッチ）を示す寸法線（アンバー）。
「繰り返す欠点の間隔からロールを突き止める」というアプリの仕事を表す。色は画面と同じ（見出しの藍・発見設備の赤・強調のアンバー）。
5 案（棒グラフ・ロール・寸法線・虫めがね・頭文字）と組み合わせ 3 案を 256〜16px で描いて比べ、16px でも点と線が読める形を選んだ。

形は「中心からの距離」（SDF）で書き、縁は 1px の幅でぼかす（どの大きさでも同じ式で描け、縮めて潰れない）。
"""
from __future__ import annotations

import math
import struct
import zlib

SIZES = (16, 20, 24, 32, 40, 48, 64, 256)      # .ico に入れる大きさ（Windows が表示の倍率で選ぶ）


def _hex(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


NAVY, BLUE, RED, AMBER, STRIP = _hex("#1c3550"), _hex("#2b5f79"), _hex("#d62c1a"), _hex("#e6a52e"), _hex("#e8f1f4")


def _clamp(x, lo=0.0, hi=1.0):
    return lo if x < lo else hi if x > hi else x


def _rrect(cx, cy, hw, hh, r):
    def d(x, y):
        qx, qy = abs(x - cx) - hw + r, abs(y - cy) - hh + r
        return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
    return d


def _circle(cx, cy, r):
    return lambda x, y: math.hypot(x - cx, y - cy) - r


def _segment(ax, ay, bx, by, r):
    dx, dy = bx - ax, by - ay
    ll = dx * dx + dy * dy

    def d(x, y):
        h = _clamp(((x - ax) * dx + (y - ay) * dy) / ll)
        return math.hypot(x - ax - dx * h, y - ay - dy * h) - r
    return d


def _ground(x, y):
    t = _clamp((x + y) / 2)
    return tuple(NAVY[i] + (BLUE[i] - NAVY[i]) * t for i in range(3))


# 描く順（後ろほど上）。座標は 0〜1。細い線（太さ約 1/14）は 16px の画素の中心に置く（4.5/16・5.5/16・11.5/16）。
# 画素の境に置くと 16px で 2 画素に割れて濁り、アンバーに見えなかった（試験 test_app_icon が見張る）
LEFT, RIGHT, BAR = 4.5 / 16, 11.5 / 16, 5.5 / 16
SHAPES = [
    (_rrect(.5, .5, .44, .44, .13), _ground),
    (_rrect(.5, .62, .36, .13, .05), STRIP),
    *[(_circle(cx, .62, .075), RED) for cx in (LEFT, .5, RIGHT)],
    (_segment(LEFT, BAR, RIGHT, BAR, .035), AMBER),
    (_segment(LEFT, BAR - .08, LEFT, BAR + .08, .035), AMBER),
    (_segment(RIGHT, BAR - .08, RIGHT, BAR + .08, .035), AMBER),
]


def rgba(size: int) -> list[bytes]:
    """size×size の RGBA（行ごと）。"""
    px, rows = 1.0 / size, []
    for j in range(size):
        y, row = (j + .5) / size, bytearray()
        for i in range(size):
            x, r, g, b, a = (i + .5) / size, 0.0, 0.0, 0.0, 0.0
            for dist, color in SHAPES:
                cov = _clamp(.5 - dist(x, y) / px)
                if cov <= 0:
                    continue
                c = color(x, y) if callable(color) else color
                r, g, b, a = c[0] * cov + r * (1 - cov), c[1] * cov + g * (1 - cov), c[2] * cov + b * (1 - cov), cov + a * (1 - cov)
            row += bytes((round(_clamp(r / a) * 255), round(_clamp(g / a) * 255), round(_clamp(b / a) * 255), round(a * 255))) if a else b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(size: int) -> bytes:
    rows = rgba(size)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\0" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def build() -> bytes:
    """.ico（中身は大きさごとの PNG。Windows Vista 以降が読む形）。"""
    images = [png(s) for s in SIZES]
    head = struct.pack("<HHH", 0, 1, len(images))
    offset, entries = 6 + 16 * len(images), b""
    for s, data in zip(SIZES, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return head + entries + b"".join(images)
