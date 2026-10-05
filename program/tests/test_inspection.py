# -*- coding: utf-8 -*-
"""設備マスタの「検査計」: 発見設備の自動選択の候補（/api/equipment/inspection）。同一工程の名前も読み替えて引く。"""
import shutil
import tempfile
import unittest
from pathlib import Path

from app import create_app
from app.repositories.master_store import MasterStore

ROOT = Path(__file__).resolve().parents[1]


class Inspection(unittest.TestCase):
    def setUp(self):
        # 書き込む試験なので、マスタは一時フォルダへ写して使う（共有が無い MasterStore は base の data/ へ書く）
        tmp = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", tmp / "data")
        self.app = create_app({"TESTING": True, "MASTER_STORE": MasterStore(tmp, local_root=tmp / "local", settings={})})
        self.c = self.app.test_client()
        rows = {r["設備名"]: r for r in self.c.get("/api/masters/equipment").get_json()}
        for name, extra in (("TLV", {}), ("CAL", {"同一工程": "CAF*, CAI*"})):
            r = rows[name]
            res = self.c.put(f"/api/masters/equipment/{r['id']}", json={**r, **extra, "検査計": "有", "base_rev": r.get("rev")})
            self.assertEqual(res.status_code, 200, res.get_json())

    def ask(self, *names):
        return self.c.post("/api/equipment/inspection", json={"names": list(names)}).get_json()["inspection"]

    def test_marked_equipment_only(self):
        self.assertEqual(self.ask("TLV", "L-1", "KEN"), {"TLV": True, "L-1": False, "KEN": False})

    def test_alias_names_are_read_as_the_master_row(self):
        self.assertEqual(self.ask("CAF1", "cai2"), {"CAF1": True, "cai2": True}, "同一工程の名前（番号付き・大小）も検査計ありの設備として引く")

    def test_unknown_equipment_is_false(self):
        self.assertEqual(self.ask("XYZ"), {"XYZ": False})

    def test_field_is_listed_and_editable(self):
        tlv = next(r for r in self.c.get("/api/masters/equipment").get_json() if r["設備名"] == "TLV")
        self.assertEqual(tlv["検査計"], "有")


if __name__ == "__main__":
    unittest.main()
