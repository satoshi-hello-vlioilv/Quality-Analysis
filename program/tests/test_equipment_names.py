# -*- coding: utf-8 -*-
"""同一工程の名前（設備名の読み替え）: ANI/ANF＋番号、CAI/CAF/CAL を同じ工程として扱う。"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from app import create_app
from app.repositories.master_repository import InvalidRow, MasterRepository
from app.repositories.master_store import MasterStore
from app.services.equipment_names import EquipmentResolver, check_row, parse_patterns
from app.services.lotdsp_progress import parse_progress_html

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests" / "fixtures" / "lotdsp_progress_L7150C0.html").read_text(encoding="utf-8")


def master(aliases=None):
    rows = json.loads((ROOT / "data" / "equipment_master.json").read_text(encoding="utf-8"))
    rows = [r for r in rows if r["設備名"] != "ANF"]          # ANF は ANI と同じ工程として ANI の行へまとめる
    for r in rows:
        r["同一工程"] = (aliases or {}).get(r["設備名"], "")
    return rows


ALIASES = {"ANI": "ANI*, ANF*", "CAL": "CAI*、CAF* CAL*"}


class Resolver(unittest.TestCase):
    def setUp(self):
        self.r = EquipmentResolver(master(ALIASES))

    def canon(self, n):
        return self.r.canonical(n)

    def test_parse(self):
        self.assertEqual(parse_patterns(" anf,ANI*、 ＣＡＦ１\nANF "), ["ANF", "ANI*", "CAF1"])

    def test_annealing_with_and_without_number(self):
        for n in ("ANI", "ANF", "ANI1", "ANF2", "anf12", "ＡＮＦ３", "ANI 4"):
            self.assertEqual(self.canon(n), "ANI", n)

    def test_cal_family(self):
        for n in ("CAL", "CAI", "CAF", "CAF1", "CAI2", "CAL3"):
            self.assertEqual(self.canon(n), "CAL", n)

    def test_numbers_that_mean_different_equipment_stay_different(self):
        self.assertEqual(self.canon("L-1"), "L-1")
        self.assertEqual(self.canon("L-2"), "L-2")
        self.assertEqual(self.canon("LS3"), "LS3")
        self.assertEqual(self.canon("LS4"), "LS4")
        self.assertIsNone(self.r.resolve("L-4")[0])
        self.assertIsNone(self.r.resolve("CB1")[0])

    def test_how_it_matched(self):
        self.assertEqual(self.r.resolve("CAL")[1], "name")
        self.assertEqual(self.r.resolve("CAF1")[1:], ("pattern", "CAF*"))

    def test_same(self):
        self.assertTrue(self.r.same("CAF", "CAL"))
        self.assertTrue(self.r.same("ANF2", "ANI"))
        self.assertFalse(self.r.same("L-1", "L-2"))

    def test_specific_pattern_wins(self):
        rows = [{"id": 1, "設備名": "AAA", "同一工程": "A*"}, {"id": 2, "設備名": "ABC", "同一工程": "AB*"}]
        r = EquipmentResolver(rows)
        self.assertEqual(r.canonical("AB9"), "ABC")
        self.assertEqual(r.canonical("AX9"), "AAA")


class Validation(unittest.TestCase):
    def test_pattern_that_catches_another_equipment_is_refused(self):
        rows = master()
        rows.append({"id": 99, "設備名": "ANF"})
        msg = check_row(rows, {"設備名": "ANI", "同一工程": "ANF*"}, self_id=next(r["id"] for r in rows if r["設備名"] == "ANI"))
        self.assertIn("ANF", msg)
        self.assertIn("消してから", msg)

    def test_duplicate_plain_alias_is_refused(self):
        rows = master({"CAL": "CAF"})
        self.assertIn("もう設備「CAL」", check_row(rows, {"設備名": "TLV", "同一工程": "CAF"}, self_id=10))

    def test_new_name_caught_by_other_pattern_is_refused(self):
        rows = master(ALIASES)
        self.assertIn("ANI", check_row(rows, {"設備名": "ANF2", "同一工程": ""}))

    def test_l_series_patterns_are_allowed_if_not_capturing(self):
        self.assertIsNone(check_row(master(), {"設備名": "HOT", "同一工程": "HOT*"}, self_id=1))
        self.assertIn("L-2", check_row(master(), {"設備名": "L-1", "同一工程": "L-*"}, self_id=2))


class RepositoryAndApi(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "data").mkdir()
        (self.tmp / "data" / "equipment_master.json").write_text(json.dumps(master(), ensure_ascii=False), encoding="utf-8")
        (self.tmp / "data" / "roll_master.json").write_text("[]", encoding="utf-8")
        self.store = MasterStore(self.tmp, local_root=self.tmp / "local", settings={})
        self.repo = MasterRepository(self.store)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_update_saves_aliases(self):
        cal = next(r for r in self.repo.equipment() if r["設備名"] == "CAL")
        row = self.repo.equipment_update(cal["id"], {"同一工程": "CAI*, CAF*"}, cal["rev"])
        self.assertEqual(row["同一工程"], "CAI*, CAF*")
        self.assertEqual(self.repo.equipment_resolver().canonical("CAF2"), "CAL")

    def test_invalid_is_400_with_reason(self):
        app = create_app({"MASTER_STORE": self.store})
        c = app.test_client()
        cal = next(r for r in self.repo.equipment() if r["設備名"] == "CAL")
        r = c.put(f"/api/masters/equipment/{cal['id']}", json={"設備名": "CAL", "同一工程": "TL*", "base_rev": cal["rev"]})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["kind"], "invalid")
        self.assertIn("TLV", r.get_json()["error"])
        with self.assertRaises(InvalidRow):
            self.repo.equipment_create({"設備名": "X1", "同一工程": "CAL"})


class Import(unittest.TestCase):
    def test_numbered_alias_is_imported_as_master_equipment(self):
        html = FIXTURE.replace(">CAL<", ">CAF1<")
        lot, rep = parse_progress_html(html, master(ALIASES), expect_lot="L7150C0")
        eqs = [p["equipment"] for p in lot["processes"]]
        self.assertIn("CAL", eqs)
        self.assertNotIn("CAF1", eqs)
        self.assertEqual(rep["skipped"], [])
        self.assertEqual([(x["from"], x["to"]) for x in rep["renamed"]], [("CAF1", "CAL")])

    def test_without_alias_it_is_skipped(self):
        html = FIXTURE.replace(">CAL<", ">CAF1<")
        lot, rep = parse_progress_html(html, master(), expect_lot="L7150C0")
        self.assertEqual([x["equipment"] for x in rep["skipped"]], ["CAF1"])

    def test_design_caf_actual_cal_is_not_a_mismatch_when_same_process(self):
        _, rep = parse_progress_html(FIXTURE, master(ALIASES), expect_lot="L7150C0")
        self.assertFalse(any("CAF" in w for w in rep["warnings"]), rep["warnings"])
        _, rep2 = parse_progress_html(FIXTURE, master(), expect_lot="L7150C0")
        self.assertTrue(any("CAF" in w for w in rep2["warnings"]))


if __name__ == "__main__":
    unittest.main()
