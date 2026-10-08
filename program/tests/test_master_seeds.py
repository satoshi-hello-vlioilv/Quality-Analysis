# -*- coding: utf-8 -*-
"""起動で一度だけ当てるマスタの初期値（services/master_seeds.py）。すでに共有にあるマスタにも届き、2回目は当てない。"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from app.repositories.master_repository import MasterRepository
from app.repositories.master_store import MasterStore
from app.services import access, master_seeds

ROOT = Path(__file__).resolve().parents[1]


class Seeds(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", self.tmp / "app" / "data")
        self.share = self.tmp / "share"
        self.share.mkdir()
        # 共有にはもう前の版の設備マスタがある（検査計の列が無い・NS1 も無い）。権限はまだ無い
        old = [{k: v for k, v in r.items() if k != "検査計"} for r in json.loads((ROOT / "data" / "equipment_master.json").read_text(encoding="utf-8"))
               if r["設備名"] != "NS1"]
        (self.share / "equipment_master.json").write_text(json.dumps({"revision": 3, "rows": old}, ensure_ascii=False), encoding="utf-8")
        (self.share / "access_permissions.json").write_text(json.dumps({"revision": 1, "rows": [
            {"id": 1, "ログインID": "someone", "PC名": "", "権限区分": "一般ユーザー", "マスタ編集": "編集可", "有効": "有"}]}, ensure_ascii=False), encoding="utf-8")
        self.store = MasterStore(self.tmp / "app", local_root=self.tmp / "local", settings={"dir": str(self.share), "refresh_seconds": 0})
        self.repo = MasterRepository(self.store)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def meters(self):
        return sorted(r["設備名"] for r in self.repo.equipment() if r.get("検査計") == "有")

    def test_reaches_the_shared_master_once(self):
        self.assertEqual(self.meters(), [], "前の版の共有マスタには検査計が無い（同梱を直しても届かない）")
        self.assertEqual(len(master_seeds.run(self.store)), 2)
        self.assertEqual(self.meters(), ["DL2", "LS3", "LS4", "NS1", "TLV"], "NS1 が無ければ足す")
        f = access.flags(self.repo.access_permissions(), "Satoshi-Harada", "NLM-NGY-252134")
        self.assertEqual(f["role"], "開発者", "ログインIDは大小を問わず当たる")
        # 人があとで TLV の検査計を外した → 次の起動で戻さない
        tlv = next(r for r in self.repo.equipment() if r["設備名"] == "TLV")
        self.repo.equipment_update(tlv["id"], {"検査計": ""}, tlv["rev"])
        self.assertEqual(master_seeds.run(self.store), [], "2回目は当てない")
        self.assertNotIn("TLV", self.meters())

    def test_does_not_override_existing_login_row(self):
        rows = self.repo.access_permissions()
        self.repo.access_permissions_update(rows[0]["id"], {"ログインID": "satoshi-harada", "権限区分": "メンテナンス者"}, rows[0]["rev"])
        master_seeds.run(self.store)
        got = [r for r in self.repo.access_permissions() if r["ログインID"] == "satoshi-harada"]
        self.assertEqual([r["権限区分"] for r in got], ["メンテナンス者"], "その ID の行がもうあれば足さない・変えない")

    def test_unreachable_share_records_nothing(self):
        store = MasterStore(self.tmp / "app", local_root=self.tmp / "local2", settings={"dir": str(self.tmp / "nowhere"), "refresh_seconds": 0})
        self.assertEqual(master_seeds.run(store), [])
        self.assertFalse((self.tmp / "nowhere").exists())


if __name__ == "__main__":
    unittest.main()
