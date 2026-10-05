# -*- coding: utf-8 -*-
"""画面の設定の控え（app/services/ui_state.py・/api/ui-state・画面への埋め込み）。

ブラウザ版とデスクトップ版は localStorage が別になるため、控えを通して設定を引き継ぐ。

    python -m unittest discover -s tests
"""
import json
import os
import tempfile
import unittest

from app import create_app
from app.services import ui_state


class UiState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = dict(os.environ)
        os.environ["TRANSFER_LOCAL_ROOT"] = self.tmp.name
        self.c = create_app().test_client()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env)
        self.tmp.cleanup()

    def post(self, **body):
        return self.c.post("/api/ui-state", json=body)

    def test_empty_at_first(self):
        self.assertEqual(self.c.get("/api/ui-state").get_json(), {"rev": 0, "keys": {}})

    def test_merge_only_app_keys_and_count_revisions(self):
        r = self.post(changed={"tpa.lotlist.rules.v1": "[1]", "other": "x", "tpa.n": 5})
        self.assertEqual(r.get_json(), {"rev": 1})
        self.assertEqual(self.c.get("/api/ui-state").get_json(), {"rev": 1, "keys": {"tpa.lotlist.rules.v1": "[1]"}})
        self.assertEqual(self.post(changed={"tpa.b": "2"}).get_json(), {"rev": 2})

    def test_two_windows_do_not_erase_each_other(self):
        """窓 A と窓 D が同時に開いていて、それぞれ別の名前を直す → 両方残る（丸ごと置き換えない）。"""
        self.post(changed={"tpa.a": "1", "tpa.d": "1"})
        self.post(changed={}, removed=["tpa.d"])          # 窓 D が消した
        self.post(changed={"tpa.a": "2"})                 # 窓 A が別の名前を直した（tpa.d は送らない）
        self.assertEqual(ui_state.load()["keys"], {"tpa.a": "2"})

    def test_beacon_without_content_type(self):
        r = self.c.post("/api/ui-state", data=json.dumps({"changed": {"tpa.a": "1"}}), content_type="text/plain")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(ui_state.load()["keys"], {"tpa.a": "1"})

    def test_bad_and_too_big(self):
        self.assertEqual(self.post(removed=["tpa.a"]).status_code, 400)
        self.assertEqual(self.post(changed={}, removed="tpa.a").status_code, 400)
        big = {"tpa.big": "x" * (ui_state.MAX_BYTES + 1)}
        self.assertEqual(self.post(changed=big).status_code, 400)
        self.assertEqual(ui_state.load(), {"rev": 0, "keys": {}}, "受け取らなかった控えは残さない")

    def test_broken_file_reads_as_empty(self):
        ui_state.path().write_text("{壊れ", encoding="utf-8")
        self.assertEqual(ui_state.load(), {"rev": 0, "keys": {}})

    def test_page_carries_the_snapshot_before_the_scripts(self):
        self.post(changed={"tpa.x": "</script><b>"})
        html = self.c.get("/").get_data(as_text=True)
        at = html.index("window.TPA_UI_STATE")
        self.assertLess(at, html.index("js/shared.js"), "部品が設定を読む前に戻せる")
        self.assertNotIn("</script><b>", html, "値は script を閉じられない形で埋める")


if __name__ == "__main__":
    unittest.main()
