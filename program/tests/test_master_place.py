"""マスタの置き場を画面から変える（services/master_place.py・MasterStore.retarget / follow_moved）。"""
import shutil
import tempfile
import unittest
from pathlib import Path

from app.repositories.master_store import MOVED_FILENAME, MasterStore
from app.services import master_place

PROGRAM = Path(__file__).resolve().parents[1]


class MasterPlaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.base = self.tmp / "base"          # 同梱の data/（手元のみのマスタ）を写した物。リポジトリを汚さない
        shutil.copytree(PROGRAM / "data", self.base / "data")
        (self.tmp / "nas").mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def store(self, pc, share=""):
        return MasterStore(self.base, local_root=self.tmp / pc, settings={"dir": share, "refresh_seconds": 0}, who={"pc": pc, "login": "u"})

    def test_local_to_shared_copies_and_remembers(self):
        a = self.store("pcA")
        rows = len(a.read("equipment_master"))
        pl = master_place.plan(a, self.tmp / "nas", "Masters")
        self.assertTrue(pl["ok"], pl)
        self.assertEqual(pl["mode"], "copy")
        master_place.move(a, self.tmp / "nas", "Masters")
        dest = self.tmp / "nas" / "Masters"
        self.assertTrue((dest / "equipment_master.json").is_file(), "マスタを写した")
        self.assertEqual(a.status()["dir"], str(dest))
        self.assertEqual(len(a.read("equipment_master")), rows, "写した後も同じ行")
        self.assertFalse(any(p.name.startswith(".Masters.tmp") for p in (self.tmp / "nas").iterdir()), "一時フォルダを残さない")
        again = self.store("pcA")                        # 開き直しても、覚えた置き場を使う
        self.assertEqual(again.status()["dir"], str(dest))

    def test_other_pcs_follow_the_moved_marker(self):
        old = self.tmp / "nas" / "Old"
        a = self.store("pcA")
        master_place.move(a, self.tmp / "nas", "Old")
        b = self.store("pcB", share=str(old))           # 設定ファイルで古い置き場を見ている PC
        self.assertEqual(b.status()["dir"], str(old))
        master_place.move(a, self.tmp / "nas", "New")
        self.assertTrue((old / MOVED_FILENAME).is_file(), "前の置き場に引っ越し先の印")
        b.read("equipment_master")                      # 読みに行くついでに印を見て移る
        self.assertEqual(b.status()["dir"], str(self.tmp / "nas" / "New"))
        self.assertEqual(self.store("pcB", share=str(old)).status()["dir"], str(self.tmp / "nas" / "New"), "移った先を覚える")
        c = self.store("pcC", share=str(old))           # 新しく入れた PC も、古い置き場から印をたどる
        c.read("roll_master")
        self.assertEqual(c.status()["dir"], str(self.tmp / "nas" / "New"))

    def test_history_lists_previous_places_newest_first(self):
        a = self.store("pcA")
        self.assertEqual(a.history(), [])
        master_place.move(a, self.tmp / "nas", "M1")
        master_place.move(a, self.tmp / "nas", "M2")
        h = self.store("pcA").history()                 # 開き直しても残る
        self.assertEqual([x["dir"] for x in h], [str(self.tmp / "nas" / "M1"), ""], "新しい順。空は手元のみ")
        self.assertTrue(all(x["until"] and x["by"]["pc"] == "pcA" for x in h))

    def test_switch_to_existing_place_and_refusals(self):
        a = self.store("pcA")
        master_place.move(a, self.tmp / "nas", "M1")
        b = self.store("pcB")
        pl = master_place.plan(b, self.tmp / "nas", "M1")
        self.assertEqual((pl["ok"], pl["mode"]), (True, "switch"), "既にマスタがある置き場は写さずに切り替える")
        (self.tmp / "nas" / "junk").mkdir()
        (self.tmp / "nas" / "junk" / "x.txt").write_text("x")
        cases = {"junk": "空ではなく", "M1": "いまの置き場と同じ", "a:b": "使えない字"}
        for name, why in cases.items():
            r = master_place.plan(a, self.tmp / "nas", name)
            self.assertFalse(r["ok"], name)
            self.assertIn(why, r["problem"], name)
        self.assertIn("届きません", master_place.plan(a, self.tmp / "無い", "X")["problem"])


if __name__ == "__main__":
    unittest.main()
