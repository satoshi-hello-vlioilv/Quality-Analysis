# -*- coding: utf-8 -*-
"""版の管理（app/version.py・app_build.release_digest）。

版を上げずにプログラムを変えて配ることを止める。失敗したら、表示された手順で版を上げて記録し直す。
"""
import re
import unittest
from datetime import date

import app_build
from app.version import APP_VERSION, CHANGELOG, RELEASE, version_key


class Changelog(unittest.TestCase):
    def test_head_is_the_app_version(self):
        self.assertRegex(APP_VERSION, r"^\d+\.\d+\.\d+$")
        self.assertEqual(CHANGELOG[0]["version"], APP_VERSION, "CHANGELOG の先頭にいまの版の1件を足してください")

    def test_newest_first_and_filled(self):
        keys = [version_key(e["version"]) for e in CHANGELOG]
        self.assertEqual(keys, sorted(keys, reverse=True), "新しい版を上に")
        self.assertEqual(len(keys), len(set(keys)), "同じ版が2つある")
        dates = [date.fromisoformat(e["date"]) for e in CHANGELOG]
        self.assertEqual(dates, sorted(dates, reverse=True))
        for e in CHANGELOG:
            self.assertTrue(e["notes"] and all(n.strip() for n in e["notes"]), e["version"])

    def test_versions_compare_as_numbers(self):
        self.assertGreater(version_key("1.10.0"), version_key("1.9.3"))
        self.assertEqual(version_key("1.0"), (1, 0, 0))


class Release(unittest.TestCase):
    def test_program_matches_the_recorded_release(self):
        digest = app_build.release_digest()
        how = ("APP_VERSION を上げて CHANGELOG の先頭に1件足し、`python app_build.py --release` で記録してください"
               "（まだ配っていない版を直しただけなら `python app_build.py --amend`）。")
        self.assertEqual(RELEASE["version"], APP_VERSION, f"版 {APP_VERSION} がまだ記録されていません。{how}")
        self.assertEqual(RELEASE["digest"], digest, f"版 {APP_VERSION} を記録したあとにプログラムが変わっています。{how}")

    def test_digest_ignores_line_endings_and_version_file(self):
        files = app_build.release_files()
        self.assertNotIn("app/version.py", files, "RELEASE を書くと要約が変わってしまう")
        self.assertIn("app/static/js/app.js", files)
        self.assertIn("sidecar.py", files, "窓とのつなぎも配る物（入口の exe は desktop/ で作り、版は Desktop で比べる）")
        self.assertFalse(any(k.endswith(".vbs") for k in files), "入口は exe だけ（版 3.1.0）")
        self.assertFalse(any(k.startswith(("tests/", "docs/")) or k.endswith(".md") for k in files), "説明とテストは含めない")


if __name__ == "__main__":
    unittest.main()


class Desktop(unittest.TestCase):
    """デスクトップ版（desktop/）の版は、アプリの版と同じ（窓の版と中身の版がずれない）。配る ZIP には desktop が無いので、そのときは比べない。"""

    def test_same_version(self):
        import json
        from pathlib import Path
        root = Path(app_build.BASE).parent / "desktop"
        if not root.is_dir():
            self.skipTest("desktop フォルダが無い（配った形）")
        cargo = re.search(r'^version\s*=\s*"([^"]+)"', (root / "Cargo.toml").read_text(encoding="utf-8"), re.M).group(1)
        conf = json.loads((root / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
        self.assertEqual((cargo, conf), (APP_VERSION, APP_VERSION), "desktop/Cargo.toml と tauri.conf.json の version をアプリの版に合わせてください")
