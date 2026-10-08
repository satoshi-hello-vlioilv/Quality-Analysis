# -*- coding: utf-8 -*-
"""LotDsp「進度情報」の HTML 取込（app/services/lotdsp_progress.py・/api/lots/import-lotdsp）。

見本は Edge で保存した実物（tests/fixtures/lotdsp_progress_L7150C0.html・10 BOX）。
BOX 数が変わっても読めることは、見本の行を増やした HTML（25 BOX）と減らした HTML（3 BOX）で確かめる。

    python -m unittest discover -s tests
"""
import json
import re
import unittest
from pathlib import Path

from app import create_app
from app.models import Process
from app.services.lotdsp_progress import inner_tables, parse_progress_html

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests" / "fixtures" / "lotdsp_progress_L7150C0.html").read_text(encoding="utf-8")
MASTER = json.loads((ROOT / "data" / "equipment_master.json").read_text(encoding="utf-8"))
MASTER_CAF = [dict(m, 同一工程="CAF*, CAI*") if m["設備名"] == "CAL" else m for m in MASTER]
ACTUAL_ROW = re.compile(r'<tr ng-repeat="meisaiInfo in staffProgressJBoxInfos[^"]*"[^>]*>.*?</tr>', re.S)


def with_actual_rows(n):
    """実績の BOX を n 行にした HTML（足りない分は最後の行を№を振り直して写す）。"""
    rows = ACTUAL_ROW.findall(FIXTURE)
    out = []
    for i in range(n):
        src = rows[min(i, len(rows) - 1)]
        out.append(re.sub(r'(<span class="prog-boxno ng-binding">)\s*\d+\s*(</span>)', rf"\g<1>{i + 1}\g<2>", src, count=1))
    first = FIXTURE.index(rows[0])
    last = FIXTURE.index(rows[-1]) + len(rows[-1])
    return FIXTURE[:first] + "\n".join(out) + FIXTURE[last:]


class ParseFixture(unittest.TestCase):
    def setUp(self):
        self.lot, self.report = parse_progress_html(FIXTURE, MASTER, expect_lot="L7150C0")

    def test_lot_header(self):
        lot = self.lot
        self.assertEqual(lot["lot_no"], "L7150C0")
        self.assertEqual(lot["casting_no"], "J66G16A")
        self.assertEqual(lot["inspection_no"], "N690979")
        self.assertEqual(lot["order_no"], "66508532")
        self.assertEqual(lot["use_code"], "H537")
        self.assertEqual(lot["use_name"], "ﾌｳｺｳｾﾞﾝﾕｳ")          # 値は正規化しない
        self.assertAlmostEqual(lot["density"], 2.73)
        self.assertEqual((lot["material"], lot["temper"]), ("MFX2", "O"))
        # 製品寸法は「製造」行（オーダー行 0.500×40.00 ではない）
        self.assertAlmostEqual(lot["product_thickness"], 0.505)
        self.assertAlmostEqual(lot["product_width"], 39.9)

    def test_all_actual_rows_in_order(self):
        eqs = [p["equipment"] for p in self.lot["processes"]]
        self.assertEqual(eqs, ["HOT", "L-1", "L-1", "L-1", "L-2", "L-2", "CAL", "TLV", "LS4", "KEN"])
        self.assertEqual([p["no"] for p in self.lot["processes"]], list(range(1, 11)))

    def test_actual_values(self):
        p = {x["lotdsp_no"]: x for x in self.lot["processes"]}
        self.assertEqual((p[1]["thickness"], p[1]["width"], p[1]["weight"]), (7.0, 1200.0, 6220.0))
        self.assertEqual(p[1]["work_date"], "26/09/17 17:16:31")
        # 前ｵﾌ・後ｵﾌ（見出しの class は列とずれているが、見出しの文字で読む）
        self.assertEqual((p[8]["off_front_m"], p[8]["off_back_m"]), (0, 74.0))
        self.assertEqual((p[9]["off_front_m"], p[9]["off_back_m"]), (90.0, 141.0))
        self.assertEqual((p[9]["thickness"], p[9]["width"], p[9]["weight"]), (0.505, 39.88, 5133.9))

    def test_splits_from_design(self):
        p = {x["lotdsp_no"]: x for x in self.lot["processes"]}
        self.assertEqual((p[9]["design_split"], p[9]["horizontal_split"], p[9]["vertical_split"]), (58, 29, 2))
        self.assertEqual((p[2]["design_split"], p[2]["horizontal_split"], p[2]["vertical_split"]), (1, 1, 1))

    def test_unwind_defaults_to_up(self):
        """巻出し方向は設備マスタ（巻取方向）ではなく初期値「上」。"""
        self.assertEqual({p["unwind"] for p in self.lot["processes"]}, {"上"})
        self.assertEqual(self.report["default_unwind"], "上")

    def test_design_actual_mismatch_is_reported(self):
        self.assertTrue(any("CAF" in w and "CAL" in w for w in self.report["warnings"]))


class ParseVariants(unittest.TestCase):
    def test_box_count_is_variable(self):
        # 実績の行数は変わりうる。設計（10 行）より少なければ、残りは設計の設備名だけの行で足す
        for n, total in ((3, 10), (25, 25)):
            lot, rep = parse_progress_html(with_actual_rows(n), MASTER_CAF)
            self.assertEqual(len(lot["processes"]), total, n)
            self.assertEqual(rep["actual_rows"], n)

    def test_rows_without_actual_get_only_the_design_equipment_name(self):
        """実績の無い工程は、設計の設備名だけを入れる（値は空欄＝まだ実績が無いと見て分かる）。"""
        lot, rep = parse_progress_html(with_actual_rows(6), MASTER_CAF)
        ps = lot["processes"]
        self.assertEqual(len(ps), 10)
        self.assertEqual([x["no"] for x in rep["planned"]], [7, 8, 9, 10])
        # 設計の №7 は CAF。設備マスタで CAL の同一工程にしてあるので CAL として入る
        self.assertEqual(ps[6]["equipment"], "CAL")
        self.assertIn(("CAF", "CAL"), [(x["from"], x["to"]) for x in rep["renamed"]])
        for p in ps[6:]:
            self.assertTrue(p["equipment"])
            self.assertIsNone(p["thickness"])
            self.assertIsNone(p["weight"])
            self.assertIsNone(p["width"])
            self.assertEqual(p["work_date"], "")
            self.assertIsNone(p["design_split"])
        for p in ps[:6]:
            self.assertGreater(p["thickness"], 0)

    def test_row_without_actual_not_in_master_is_skipped_and_reported(self):
        lot, rep = parse_progress_html(with_actual_rows(6), MASTER)     # CAF を登録していないマスタ
        self.assertEqual(len(lot["processes"]), 9)
        self.assertIn({"no": 7, "equipment": "CAF", "reason": "設備マスタに無い設備（実績なし）"}, rep["skipped"])

    def test_blank_equipment_in_actual_row_takes_design_name(self):
        """実績の行に値はあるが設備名が空欄 → 設計の設備名を使う。"""
        rows = ACTUAL_ROW.findall(FIXTURE)
        blank = re.sub(r">TLV<", "><", rows[7], count=1)
        self.assertNotEqual(blank, rows[7])
        lot, _ = parse_progress_html(FIXTURE.replace(rows[7], blank), MASTER)
        p8 = next(p for p in lot["processes"] if p["lotdsp_no"] == 8)
        self.assertEqual(p8["equipment"], "TLV")
        self.assertGreater(p8["thickness"], 0)

    def test_equipment_not_in_master_is_skipped_and_reported(self):
        master = [m for m in MASTER if m["設備名"] != "TLV"]
        lot, rep = parse_progress_html(FIXTURE, master)
        self.assertNotIn("TLV", [p["equipment"] for p in lot["processes"]])
        self.assertEqual(rep["skipped"], [{"no": 8, "equipment": "TLV", "reason": "設備マスタに無い設備"}])
        self.assertEqual([p["no"] for p in lot["processes"]], list(range(1, 10)))

    def test_keep_all_equipment_when_configured(self):
        master = [m for m in MASTER if m["設備名"] != "TLV"]
        lot, rep = parse_progress_html(FIXTURE, master, {"only_master_equipment": False})
        self.assertEqual(len(lot["processes"]), 10)
        self.assertEqual(rep["skipped"], [])

    def test_wrong_lot_is_rejected(self):
        with self.assertRaises(ValueError):
            parse_progress_html(FIXTURE, MASTER, expect_lot="L0000A0")

    def test_other_tab_is_rejected(self):
        with self.assertRaises(LookupError):
            parse_progress_html("<html><body><table><tr><td>ICAS情報</td></tr></table></body></html>", MASTER)

    def test_copied_table_fragment(self):
        """表だけをコピーしたクリップボードの HTML（外側の枠・属性なし）でも読める。"""
        tables = inner_tables(FIXTURE)
        actual = next(t for t in tables if "前ｵﾌ" in t[0])
        frag = "<table>" + "".join(
            "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in actual) + "</table>"
        lot, rep = parse_progress_html(frag, MASTER, expect_lot="L7150C0")
        self.assertEqual(len(lot["processes"]), 10)
        self.assertEqual(lot["lot_no"], "L7150C0")          # 画面に無ければ頼んだ番号


class ImportApi(unittest.TestCase):
    def setUp(self):
        self.client = create_app().test_client()

    def test_import_then_calculate(self):
        r = self.client.post("/api/lots/import-lotdsp", json={"html": FIXTURE, "lot_no": "L7150C0"})
        self.assertEqual(r.status_code, 200, r.get_json())
        d = r.get_json()
        self.assertEqual(d["lot"]["lot_no"], "L7150C0")
        self.assertEqual(len(d["lot"]["processes"]), 10)
        # 工程の形は models.Process（LotDsp の番号は report だけ。無い項目は既定で埋まる）
        self.assertNotIn("lotdsp_no", d["lot"]["processes"][0])
        self.assertEqual(set(d["lot"]["processes"][0]), set(Process.__dataclass_fields__))
        inputs = {"found_equipment": "10:KEN", "found_pitch_mm": 610, "soil_a_m": 660,
                  "soil_b_m": 663.73, "tolerance_percent": 2}
        c = self.client.post("/api/calculate", json={"lot": d["lot"], "inputs": inputs})
        self.assertEqual(c.status_code, 200, c.get_json())

    def test_error_is_400(self):
        r = self.client.post("/api/lots/import-lotdsp", json={"html": ""})
        self.assertEqual(r.status_code, 400)
        self.assertIn("空", r.get_json()["error"])

    def test_calculate_needs_the_lot(self):
        # ロットの中身が無ければ理由つきの 400（以前はロット番号で旧来の検索〈見本の1ロット〉へ回っていた）
        r = self.client.post("/api/calculate", json={"query": "L237F51", "inputs": {}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ロット", r.get_json()["error"])

    def test_old_lookup_is_gone(self):
        self.assertEqual(self.client.get("/api/lots/L237F51").status_code, 404)


if __name__ == "__main__":
    unittest.main()
