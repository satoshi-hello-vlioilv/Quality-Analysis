# -*- coding: utf-8 -*-
"""配布の置き場を変える（services/release_place.py と /api/release/place/*）。"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import release_place as rp


def make_place(root: Path, versions=("3.6.0", "3.7.0")):
    """窓が作る置き場に似た形（版のフォルダ・release.json・ZIP・配る版の覚え・入口の exe）。"""
    root.mkdir(parents=True, exist_ok=True)
    for v in versions:
        (root / v).mkdir()
        (root / v / "release.json").write_text(json.dumps({"version": v}), encoding="utf-8")
        (root / v / f"Defect-Analyzer-{v}-windows.zip").write_bytes(b"z" * 1000)
    (root / "distribute.json").write_text(json.dumps({"version": versions[-1]}), encoding="utf-8")
    (root / "Defect-Analyzer.exe").write_bytes(b"MZ" + b"0" * 200)
    return root


class NameTests(unittest.TestCase):
    def test_names_windows_accepts(self):
        for ok in ("Defect-Analyzer", "配布 2026", "TPA.releases"):
            self.assertEqual(rp.check_name(f"  {ok} "), ok)

    def test_names_windows_rejects(self):
        for bad in ("", "a/b", "a\\b", "a:b", "a*", "a?", 'a"', "a<", "a|", "end.", "CON", "com1.txt", "x" * 121, "\x01"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                rp.check_name(bad)


class PlanAndMoveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = make_place(self.tmp / "90_Releases" / "TransferPitchAnalyzer")

    def test_copy_plan_counts_what_to_copy(self):
        p = rp.plan(self.src, self.tmp / "90_Releases", "Defect-Analyzer")
        self.assertTrue(p["ok"], p)
        self.assertEqual(p["mode"], "copy")
        self.assertEqual(p["files"], 6)
        self.assertEqual(Path(p["dest"]), self.tmp / "90_Releases" / "Defect-Analyzer")

    def test_rejects_same_inside_and_missing_parent(self):
        self.assertIn("同じ", rp.plan(self.src, self.src.parent, self.src.name)["problem"])
        self.assertIn("中には", rp.plan(self.src, self.src, "sub")["problem"])
        self.assertIn("届きません", rp.plan(self.src, self.tmp / "無い", "x")["problem"])
        self.assertIn("使えない字", rp.plan(self.src, self.tmp, "a:b")["problem"])

    def test_existing_place_switches_without_copy(self):
        make_place(self.tmp / "other", ("3.7.0",))
        p = rp.plan(self.src, self.tmp, "other")
        self.assertEqual((p["ok"], p["mode"]), (True, "switch"))

    def test_folder_with_unrelated_files_is_refused(self):
        (self.tmp / "busy").mkdir()
        (self.tmp / "busy" / "memo.txt").write_text("x", encoding="utf-8")
        p = rp.plan(self.src, self.tmp, "busy")
        self.assertFalse(p["ok"])
        self.assertIn("関係の無い物", p["problem"])

    def test_no_copy_or_unreachable_source(self):
        self.assertEqual(rp.plan(self.src, self.tmp, "new", copy=False)["mode"], "empty")
        p = rp.plan(self.tmp / "届かない", self.tmp, "new")
        self.assertFalse(p["ok"])
        self.assertIn("写さずに切り替える", p["problem"])

    def test_move_copies_everything_and_keeps_the_old_place(self):
        dest = self.tmp / "90_Releases" / "Defect-Analyzer"
        (dest).mkdir()                                       # 空のフォルダは置き換えてよい
        out = rp.Mover().run_sync(str(self.src), str(dest))
        self.assertEqual(out["state"], "done", out)
        got = sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file())
        want = sorted(str(p.relative_to(self.src)) for p in self.src.rglob("*") if p.is_file())
        self.assertEqual(got, want)
        self.assertTrue(rp.has_release(dest))
        self.assertTrue((self.src / "distribute.json").exists(), "前の置き場は消さない")
        self.assertEqual([p.name for p in dest.parent.iterdir() if p.name.startswith(".")], [], "一時フォルダを残さない")

    def test_failed_copy_leaves_nothing_half_done(self):
        dest = self.tmp / "90_Releases" / "Defect-Analyzer"
        with mock.patch.object(rp.shutil, "copy2", side_effect=OSError("容量が足りません")):
            out = rp.Mover().run_sync(str(self.src), str(dest))
        self.assertEqual(out["state"], "failed")
        self.assertIn("容量", out["error"])
        self.assertFalse(dest.exists())
        self.assertEqual([p.name for p in dest.parent.iterdir()], ["TransferPitchAnalyzer"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        from app import create_app
        from app.repositories.master_store import MasterStore
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = make_place(self.tmp / "rel" / "Old")
        app = create_app({"MASTER_STORE": MasterStore(Path(__file__).resolve().parents[1], local_root=self.tmp / "m", settings={})})
        self.app, self.c = app, app.test_client()

    def body(self, **kw):
        return {"from": str(self.src), "parent": str(self.tmp / "rel"), "name": "New", **kw}

    def gate(self, can_release, edit="編集可"):
        me = {"login": "u", "pc": "pc", "revoked": None, "caps": {"canRelease": can_release},
              "flags": {"role": "開発者" if can_release else "一般ユーザー", "masterEdit": edit}}
        return mock.patch("app.routes.settings.me", return_value=me)

    def test_check_answers_without_permission(self):
        d = self.c.post("/api/release/place/check", json=self.body()).get_json()
        self.assertEqual((d["ok"], d["mode"]), (True, "copy"))

    def test_move_needs_release_and_admin_master_rights(self):
        with self.gate(False):
            self.assertEqual(self.c.post("/api/release/place/move", json=self.body()).status_code, 403)
        with self.gate(True, edit="部分的編集可"):
            r = self.c.post("/api/release/place/move", json=self.body())
            self.assertEqual(r.status_code, 403)
            self.assertIn("参照先", r.get_json()["error"])

    def test_move_copies_then_reports_done(self):
        with self.gate(True):
            d = self.c.post("/api/release/place/move", json=self.body()).get_json()
        self.assertEqual((d["mode"], d["started"]), ("copy", True))
        import time
        for _ in range(100):
            p = self.c.get("/api/release/place/progress").get_json()
            if p["state"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(p["state"], "done", p)
        self.assertTrue(rp.has_release(self.tmp / "rel" / "New"))

    def test_move_refuses_bad_plan(self):
        with self.gate(True):
            r = self.c.post("/api/release/place/move", json=self.body(name="a:b"))
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
