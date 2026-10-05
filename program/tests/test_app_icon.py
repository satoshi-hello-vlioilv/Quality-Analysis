# -*- coding: utf-8 -*-
"""アプリのアイコン（app/app_icon.py。desktop/build.rs が作るたびに .ico を書き出す）。

評価の物差し: Windows が読める .ico（大きさごとの PNG）・角は透ける・どの大きさでも欠点（赤）とピッチの線（アンバー）が残る。
"""
import struct
import unittest
import zlib

from app import app_icon


def decode(png: bytes):
    """→ (幅, 高さ, RGBA の行)。この形（8bit RGBA・フィルタ 0）だけ読む。"""
    w, h = struct.unpack(">II", png[16:24])
    pos, data = 8, b""
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos:pos + 8])
        if kind == b"IDAT":
            data += png[pos + 8:pos + 8 + n]
        pos += 12 + n
    raw = zlib.decompress(data)
    rows = [raw[1 + y * (w * 4 + 1): (y + 1) * (w * 4 + 1)] for y in range(h)]
    return w, h, rows


def near(px, color, tol=60):
    return px[3] > 200 and sum(abs(a - b) for a, b in zip(px[:3], color)) <= tol


class Icon(unittest.TestCase):
    def test_ico_holds_every_size(self):
        ico = app_icon.build()
        reserved, kind, count = struct.unpack("<HHH", ico[:6])
        self.assertEqual((reserved, kind, count), (0, 1, len(app_icon.SIZES)))
        for i, size in enumerate(app_icon.SIZES):
            w, h, _, _, planes, bits, n, off = struct.unpack("<BBBBHHII", ico[6 + 16 * i: 22 + 16 * i])
            self.assertEqual((w or 256, h or 256, planes, bits), (size, size, 1, 32))
            png = ico[off:off + n]
            self.assertTrue(png.startswith(b"\x89PNG"), "中身は PNG")
            self.assertEqual(decode(png)[:2], (size, size))

    def test_corners_are_clear_and_marks_survive(self):
        red, amber = (0xd6, 0x2c, 0x1a), (0xe6, 0xa5, 0x2e)
        for size in (16, 32, 256):
            _, _, rows = decode(app_icon.png(size))
            px = lambda x, y: tuple(rows[int(y * size)][int(x * size) * 4: int(x * size) * 4 + 4])   # noqa: E731
            self.assertEqual(px(0, 0)[3], 0, f"{size}px: 角は透ける（角丸）")
            self.assertTrue(near(px(.5, .62), red), f"{size}px: 真ん中の欠点は赤 {px(.5, .62)}")
            self.assertTrue(near(px(.5, app_icon.BAR), amber), f"{size}px: ピッチの線はアンバー {px(.5, app_icon.BAR)}")
            self.assertTrue(near(px(app_icon.LEFT, app_icon.BAR - .06), amber), f"{size}px: 寸法線の端もアンバー")


if __name__ == "__main__":
    unittest.main()
