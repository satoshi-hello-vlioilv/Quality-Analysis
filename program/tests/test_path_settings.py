# -*- coding: utf-8 -*-
"""参照先マスタ: 読みに行く場所を画面から変える（共有フォルダのマスタ・1台で直せば全員に効く・起動し直さずに切り替わる）。"""
import shutil
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from app import create_app
from app.repositories.master_store import MasterStore
from app.services import path_settings
from app.services.db_mirror import DbMirror

ROOT = Path(__file__).resolve().parents[1]


def make_db(path, lots):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE [仕掛] (ロット番号 TEXT, 登録日時 TEXT)")
    c.executemany("INSERT INTO [仕掛] VALUES (?, '2026/09/29')", [(x,) for x in lots])
    c.commit(); c.close()


class Effective(unittest.TestCase):
    BASE = {"lot_list": {"source": "\\\\srv\\a\\SIKADEF.sqlite3", "refresh_seconds": 60, "stale_hours": 36},
            "lotdsp_import": {"url": "http://old/"}}

    def test_default_when_no_rows(self):
        eff, items = path_settings.effective(self.BASE, [])
        self.assertEqual(eff["lot_list"]["source"], "\\\\srv\\a\\SIKADEF.sqlite3")
        it = next(i for i in items if i["key"] == "lot_list.source")
        self.assertEqual((it["source"], it["value"]), ("default", None))

    def test_master_overrides_default_and_keeps_the_rest(self):
        rows = [{"id": 1, "項目": "lot_list.source", "値": "\\\\srv\\b\\X.sqlite3", "rev": 3},
                {"id": 2, "項目": "lot_list.stale_hours", "値": "72", "rev": 1}]
        eff, items = path_settings.effective(self.BASE, rows)
        self.assertEqual(eff["lot_list"]["source"], "\\\\srv\\b\\X.sqlite3")
        self.assertEqual(eff["lot_list"]["stale_hours"], 72)
        self.assertEqual(eff["lot_list"]["refresh_seconds"], 60)
        self.assertEqual(self.BASE["lot_list"]["source"], "\\\\srv\\a\\SIKADEF.sqlite3", "配った設定は書き換えない")
        it = next(i for i in items if i["key"] == "lot_list.source")
        self.assertEqual((it["source"], it["rev"]), ("master", 3))

    def test_broken_stored_value_falls_back_to_default(self):
        eff, _ = path_settings.effective(self.BASE, [{"id": 1, "項目": "lot_list.refresh_seconds", "値": "abc"}])
        self.assertEqual(eff["lot_list"]["refresh_seconds"], 60)

    def test_parse_rules(self):
        by = path_settings.BY_KEY
        self.assertIsNone(path_settings.parse(by["lot_list.source"], "  "))
        self.assertEqual(path_settings.parse(by["lot_list.source"], '"\\\\srv\\x.sqlite3"'), "\\\\srv\\x.sqlite3", "パスのコピーの引用符を外す")
        self.assertEqual(path_settings.parse(by["lot_list.refresh_seconds"], "30"), 30)
        for bad in ("5", "1.5", "x"):
            with self.assertRaises(ValueError):
                path_settings.parse(by["lot_list.refresh_seconds"], bad)
        with self.assertRaises(ValueError):
            path_settings.parse(by["lotdsp_import.url"], "nlmfangyweb1a/LotDspWeb/")
        self.assertEqual(path_settings.parse(by["lot_list.stale_hours"], "0"), 0)
        self.assertEqual(path_settings.parse(by["update.source"], ' "C:\\a\\R" ;\n"%USERPROFILE%\\Box\\R";; '), "C:\\a\\R;%USERPROFILE%\\Box\\R",
                         "更新の置き場は候補を「;」で区切れる（それぞれの \" を外す）")
        self.assertEqual(path_settings.BY_KEY["update.source"]["check_url"], "/__desktop/update/probe", "確かめるのは探す本人（デスクトップ版）")


class Api(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.share = self.tmp / "share"; self.share.mkdir()
        self.a = self.tmp / "src" / "SIKALOTDEF.sqlite3"; make_db(self.a, ["A0001"])
        self.b = self.tmp / "src" / "SIKADEF.sqlite3"; make_db(self.b, ["B0001", "B0002"])
        (self.tmp / "app" / "data").mkdir(parents=True)
        for n in ("equipment_master", "roll_master", "path_settings"):
            shutil.copy(ROOT / "data" / f"{n}.json", self.tmp / "app" / "data" / f"{n}.json")
        self.apps = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def pc(self, name):
        store = MasterStore(self.tmp / "app", local_root=self.tmp / name, settings={"dir": str(self.share), "refresh_seconds": 0},
                            who={"pc": name, "login": name.lower()})
        app = create_app({"MASTER_STORE": store, "LOT_MIRROR": DbMirror("lot_list", self.a, self.tmp / name / "cache", 3600)})
        return app.test_client()

    def item(self, c, key):
        return next(i for i in c.get("/api/settings").get_json()["items"] if i["key"] == key)

    def lots(self, c):
        r = c.get("/api/lotlist").get_json()
        return sorted(x["ロット番号"] for x in r["rows"])

    def test_save_switches_the_lot_list_without_restart(self):
        c = self.pc("PC-A")
        self.assertEqual(self.lots(c), ["A0001"])
        r = c.put("/api/settings/lot_list.source", json={"value": str(self.b), "base_rev": 0})
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(self.item(c, "lot_list.source")["source"], "master")
        for _ in range(40):          # 背景の写し直しを待つ（写すまでは元を直接読む）
            if self.lots(c) == ["B0001", "B0002"]:
                break
            time.sleep(0.1)
        self.assertEqual(self.lots(c), ["B0001", "B0002"])
        self.assertEqual(c.get("/api/lotlist/source").get_json()["remote"], str(self.b))

    def test_other_pc_sees_the_change(self):
        a, b = self.pc("PC-A"), self.pc("PC-B")
        a.put("/api/settings/lotdsp_import.url", json={"value": "http://new/LotDspWeb/", "base_rev": 0})
        self.assertEqual(b.get("/api/config").get_json()["lotdsp_url"], "http://new/LotDspWeb/")
        a.put("/api/settings/lot_list.source", json={"value": str(self.b), "base_rev": 0})
        for _ in range(40):
            if self.lots(b) == ["B0001", "B0002"]:
                break
            time.sleep(0.1)
        self.assertEqual(self.lots(b), ["B0001", "B0002"], "ほかの PC で直した参照先も、次の問い合わせで切り替わる")
        it = self.item(b, "lot_list.source")
        self.assertEqual(it["updated_by"]["pc"], "PC-A")

    def test_empty_goes_back_to_default(self):
        c = self.pc("PC-A")
        c.put("/api/settings/lot_list.stale_hours", json={"value": "72", "base_rev": 0})
        it = self.item(c, "lot_list.stale_hours")
        self.assertEqual((it["effective"], it["rev"]), (72, 1))
        c.put("/api/settings/lot_list.stale_hours", json={"value": "", "base_rev": 1})
        it = self.item(c, "lot_list.stale_hours")
        self.assertEqual((it["source"], it["effective"]), ("default", 36))

    def test_concurrent_edit_is_refused(self):
        a, b = self.pc("PC-A"), self.pc("PC-B")
        a.put("/api/settings/lot_list.stale_hours", json={"value": "48", "base_rev": 0})
        r = b.put("/api/settings/lot_list.stale_hours", json={"value": "72", "base_rev": 0})   # B は古い版を見て直した
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.get_json()["kind"], "conflict")
        self.assertEqual(self.item(a, "lot_list.stale_hours")["effective"], 48, "相手の変更を踏み潰さない")

    def test_broken_base_rev_is_answered_as_json(self):
        # 版の数が壊れていても（ほかのマスタと同じく）版を確かめずに保存し、HTML の 500 を返さない
        c = self.pc("PC-A")
        r = c.put("/api/settings/lot_list.stale_hours", json={"value": "48", "base_rev": "abc"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.item(c, "lot_list.stale_hours")["effective"], 48)

    def test_invalid_is_400_with_reason(self):
        c = self.pc("PC-A")
        r = c.put("/api/settings/lot_list.refresh_seconds", json={"value": "3"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (400, "invalid"))
        self.assertIn("10〜3600", r.get_json()["error"])
        self.assertEqual(c.put("/api/settings/unknown.key", json={"value": "x"}).status_code, 400)

    def test_check(self):
        c = self.pc("PC-A")
        ok = c.post("/api/settings/check", json={"key": "lot_list.source", "value": str(self.b)}).get_json()
        self.assertTrue(ok["ok"], ok)
        self.assertIn("2行", ok["message"])
        miss = c.post("/api/settings/check", json={"key": "lot_list.source", "value": str(self.tmp / "無い.sqlite3")}).get_json()
        self.assertFalse(miss["ok"]); self.assertIn("届きません", miss["message"])
        junk = self.tmp / "junk.sqlite3"; junk.write_bytes(b"not sqlite" * 50)
        bad = c.post("/api/settings/check", json={"key": "lot_list.source", "value": str(junk)}).get_json()
        self.assertFalse(bad["ok"]); self.assertIn("開けません", bad["message"])
        url = c.post("/api/settings/check", json={"key": "lotdsp_import.url", "value": "ftp://x"}).get_json()
        self.assertFalse(url["ok"])

    def test_update_source_is_shared_and_told_to_the_window(self):
        """更新の置き場: 1台で保存すると全員の窓（Rust・desktop/src/update.rs）が /api/update/settings で読む。"""
        a, b = self.pc("PC-A"), self.pc("PC-B")
        # 配った設定（ファイルそのもの）の既定は BOX の置き場。動いている設定は CI では空に差し替える（TRANSFER_APP_CONFIG）ので、ファイルで見る
        import json
        for name in ("appsettings.json", "appsettings.example.json"):
            shipped = json.loads((ROOT / "config" / name).read_text(encoding="utf-8"))["update"]["source"]
            self.assertTrue(shipped.endswith("\\90_アプリ開発\\90_Releases"), f"{name}: {shipped}")
        drop = self.tmp / "更新"; drop.mkdir()
        r = a.put("/api/settings/update.source", json={"value": f'"{drop}"', "base_rev": 0})
        self.assertEqual(r.status_code, 200, r.get_json())
        got = b.get("/api/update/settings").get_json()
        self.assertEqual(got["source"], str(drop), "パスのコピーの引用符を外し、ほかの PC にも効く")
        self.assertEqual(set(got["who"]), {"login", "pc", "role", "canRelease"}, "だれが（版を置く・配ってよいか）も窓へ伝える")

    def test_listing_says_where_it_is_kept(self):
        c = self.pc("PC-A")
        d = c.get("/api/settings").get_json()
        self.assertTrue(d["shared"])
        self.assertEqual(d["share_dir"], str(self.share))
        self.assertEqual([i["key"] for i in d["items"]], [i["key"] for i in path_settings.ITEMS])


if __name__ == "__main__":
    unittest.main()
