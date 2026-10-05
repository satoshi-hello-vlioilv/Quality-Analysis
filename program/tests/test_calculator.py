# -*- coding: utf-8 -*-
"""転写距離計算（app/services/calculator.py）と設備マスタ（巻取方向）の評価。

見本は画面で確かめたロット L6183D0（10 工程・発見設備 8:TLV）。

    python -m unittest discover -s tests
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from app.repositories.master_repository import MasterRepository
from app.services.calculator import Calculator

ROOT = Path(__file__).resolve().parents[1]

# 利用者から受け取った正しい設備マスタ（設備名, 巻取方向, ライン方向）
CORRECT_EQUIPMENT = [
    ("HOT", "下", "←"), ("L-1", "下", "←"), ("L-2", "下", "←"), ("L-3", "下", "→"),
    ("LS3", "上", "←"), ("LS4", "上", "→"), ("CAL", "下", "←"), ("NS1", "上", "←"),
    ("DL2", "上", "→"), ("TLV", "上", "←"), ("FS4", "-", "←"), ("AP3", "-", "←"),
    ("FS3", "-", "←"), ("ANF", "-", "-"), ("ANI", "-", "-"), ("KEN", "-", "-"),
    ("APC(№4CCL)", "下", "→"),
]


def lot_l6183d0(unwind="上"):
    rows = [
        ("HOT", 7, 1200, 6214, 1, 0, 0), ("L-1", 3.6, 1200, 6214, 1, 0, 0),
        ("L-1", 2.2, 1200, 6214, 1, 0, 0), ("L-1", 1.3, 1200, 6214, 1, 0, 0),
        ("L-2", 0.8, 1200, 6149.7, 1, 0, 0), ("L-2", 0.508, 1200, 6031.9, 1, 0, 0),
        ("CAL", 0.505, 1200, 5854.9, 1, 0, 0), ("TLV", 0.505, 1179.8, 5511.5, 1, 85, 121),
        ("LS4", 0.505, 49.87, 5121.3, 69, 60, 68), ("KEN", 0.505, 49.9, 4935, 69, 0, 0),
    ]
    return {"lot_no": "L6183D0", "density": 2.73, "processes": [
        {"no": i + 1, "equipment": eq, "unwind": unwind, "thickness": t, "width": w, "weight": kg,
         "design_split": sp, "horizontal_split": 1, "vertical_split": 1, "off_front_m": f, "off_back_m": b}
        for i, (eq, t, w, kg, sp, f, b) in enumerate(rows)]}


def inputs(found="8:TLV", a=1610.70, b=1613.70):
    return {"found_equipment": found, "found_pitch_mm": 610, "soil_a_m": a, "soil_b_m": b,
            "tolerance_percent": 2}


class TempMaster:
    """実データを汚さないよう data/ を一時フォルダへ写して使う。"""

    def __enter__(self):
        self.dir = Path(tempfile.mkdtemp())
        shutil.copytree(ROOT / "data", self.dir / "data")
        return MasterRepository(self.dir)

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)


class FoundEquipmentTransfer(unittest.TestCase):
    """発見設備の転写距離 = 汚れ位置 A・B（表裏の位置）の差分。"""

    def calc(self, **kw):
        return Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(), inputs(**kw))

    def test_found_row_equals_position_difference(self):
        res = self.calc()
        found = next(p for p in res["processes"] if p["no"] == 8)
        self.assertAlmostEqual(res["actual_transfer_distance_m"], 3.0, places=6)
        self.assertAlmostEqual(found["transfer_distance_m"], 3.0, places=6)
        self.assertAlmostEqual(found["agreement_percent"], 100.0, places=6)

    def test_any_found_equipment(self):
        for no, eq in ((5, "L-2"), (7, "CAL"), (9, "LS4")):
            res = self.calc(found=f"{no}:{eq}", a=500, b=502.5)
            found = next(p for p in res["processes"] if p["no"] == no)
            self.assertAlmostEqual(found["transfer_distance_m"], 2.5, places=6, msg=eq)

    def test_order_of_a_b_does_not_matter(self):
        res = self.calc(a=1613.70, b=1610.70)
        found = next(p for p in res["processes"] if p["no"] == 8)
        self.assertAlmostEqual(found["transfer_distance_m"], 3.0, places=6)

    def test_upstream_rows_are_still_coil_model(self):
        """上流工程は従来どおり巻きの周長から換算（発見設備の修正が波及しない）。"""
        res = self.calc()
        up = next(p for p in res["processes"] if p["no"] == 7)
        self.assertNotAlmostEqual(up["transfer_distance_m"], 3.0, places=3)
        self.assertGreater(up["transfer_distance_m"], 0)


class SoilPositionsNotEntered(unittest.TestCase):
    """汚れ位置 A・B は既定で未入力。A が無ければ転写距離は計算しない（0 m 扱いで「対象外」を並べない）。
    **計算に使うのは A だけ**。A だけでも各設備の予測（発見設備でのラップ長さ）は出し、判定（一致）は B が入ってから。"""

    def calc(self, a, b):
        return Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(), inputs(a=a, b=b))

    def test_blank_a(self):
        for a, b in (("", ""), (None, None), ("", 1613.7)):
            res = self.calc(a, b)
            self.assertFalse(res["soil_positions_ready"], (a, b))
            self.assertFalse(res["soil_a_ready"], (a, b))
            self.assertIsNone(res["actual_transfer_distance_m"])
            for p in res["processes"]:
                self.assertNotIn("transfer_distance_m", p)
                self.assertNotIn("transfer_match", p)
                self.assertGreater(p["after_length_m"], 0)    # 転写に関係しない列は計算する

    def test_a_only_predicts_without_judging(self):
        res = self.calc(1610.7, "")
        self.assertTrue(res["soil_a_ready"])
        self.assertFalse(res["soil_positions_ready"])
        up = next(p for p in res["processes"] if p["no"] == 7)
        self.assertGreater(up["transfer_distance_m"], 0)
        self.assertIsNone(up["transfer_match"])
        self.assertIsNone(up["agreement_percent"])
        self.assertIsNone(res["likely_origin_no"])
        both = self.calc(1610.7, 1613.7)
        self.assertAlmostEqual(next(p for p in both["processes"] if p["no"] == 7)["transfer_distance_m"],
                               up["transfer_distance_m"], msg="予測は B に左右されない（使うのは A だけ）")

    def test_zero_is_a_value(self):
        res = self.calc(0, 3)
        self.assertTrue(res["soil_positions_ready"])
        self.assertAlmostEqual(res["actual_transfer_distance_m"], 3)

    def test_default_tolerance_is_5(self):
        i = inputs(); del i["tolerance_percent"]
        res = Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(), dict(i, soil_b_m=1614.54))
        self.assertTrue(next(p for p in res["processes"] if p["no"] == 6)["transfer_match"])   # 97.4 %


class Trace(unittest.TestCase):
    """説明パネル（3D）に渡す遡りの途中値が、計算と食い違わないこと。"""

    def test_trace_reproduces_positions(self):
        res = Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(), inputs())
        ps = sorted((p for p in res["processes"] if "trace" in p), key=lambda p: -p["no"])
        self.assertEqual([p["no"] for p in ps], list(range(8, 0, -1)))
        found = ps[0]
        self.assertAlmostEqual(found["position_from_a_m"], found["trace"]["prev_pos_m"] + found["trace"]["off_m"])
        for down, p in zip(ps, ps[1:]):
            t = p["trace"]
            self.assertAlmostEqual(t["prev_pos_m"], down["position_from_a_m"])
            self.assertAlmostEqual(p["position_from_a_m"], t["prev_pos_m"] * t["ratio"] + t["off_m"])
            self.assertAlmostEqual(t["ratio"], down["thickness"] / p["thickness"])   # 1 つ下流の工程の板厚 ÷ その工程の板厚
            self.assertAlmostEqual(p["transfer_distance_m"], t["circumference_m"] * p["thickness"] / res["found_thickness_mm"])
            self.assertEqual(t["off_side"], "頭" if p["head_tail"] == 1 else "尾")


class EquipmentMasterRewind(unittest.TestCase):
    """設備マスタの列は「巻取方向」（巻出し方向ではない）で、値は利用者の正しいデータどおり。"""

    def test_master_file_matches_correct_data(self):
        rows = json.loads((ROOT / "data" / "equipment_master.json").read_text(encoding="utf-8"))
        got = [(r["設備名"], r.get("巻取方向"), r["ライン方向"]) for r in rows]
        self.assertEqual(got, CORRECT_EQUIPMENT)
        self.assertFalse(any("巻出し方向" in r for r in rows))

    def test_equipment_map_exposes_rewind(self):
        m = MasterRepository(ROOT).equipment_map()
        self.assertEqual(m["HOT"]["rewind"], "下")
        self.assertEqual(m["TLV"]["rewind"], "上")

    def test_old_column_name_is_migrated(self):
        """旧名「巻出し方向」で保存された利用者のマスタも、読むときに巻取方向へ読み替える。
        **読む側はファイルを書かない**（共有に置いたとき、読むだけの PC が共有を書き換えないため）。
        書き直すのは次に保存したとき。"""
        with TempMaster() as repo:
            path = repo.store.base / "data" / "equipment_master.json"
            path.write_text(json.dumps([{"id": 1, "設備名": "HOT", "巻出し方向": "下", "ライン方向": "←"}],
                                       ensure_ascii=False), encoding="utf-8")
            row = repo.equipment()[0]
            self.assertEqual((row["設備名"], row["巻取方向"], row["ライン方向"]), ("HOT", "下", "←"))
            self.assertNotIn("巻出し方向", row)
            self.assertIn("巻出し方向", json.loads(path.read_text(encoding="utf-8"))[0])   # 読んだだけでは書かない
            repo.equipment_create({"設備名": "L-9"})
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved[0].get("巻取方向"), "下")
            self.assertNotIn("巻出し方向", saved[0])


class FaceFlip(unittest.TestCase):
    """面の反転: 巻出し方向（実績）と巻取方向（マスタ）が違う工程で表裏が入れ替わる。"""

    def faces(self, unwind):
        res = Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(unwind), inputs())
        return [p["face_state"] for p in res["processes"]]

    def test_unwind_up_flips_on_down_rewind_equipment(self):
        # 2:L-1(下) 3:L-1(下) 4:L-1(下) 5:L-2(下) 6:L-2(下) 7:CAL(下) で反転。KEN(-) は反転しない。
        self.assertEqual(self.faces("上"), [0, 1, 0, 1, 0, 1, 0, 0, 0, 0])

    def test_no_direction_equipment_never_flips(self):
        self.assertEqual(self.faces("下")[-1], self.faces("下")[-2])   # KEN（巻取 -）


class RewindOverride(unittest.TestCase):
    """巻取方向: 表で工程ごとに直せる。空欄なら設備マスタの値（自動）。面の反転と 3D の向きは直した値で決まる。"""

    def calc(self, lot):
        return Calculator({}, MasterRepository(ROOT)).calculate(lot, inputs())

    def test_blank_uses_master(self):
        ps = self.calc(lot_l6183d0())["processes"]
        self.assertEqual((ps[1]["rewind_master"], ps[1]["rewind_source"], ps[1]["auto_rewind_master"]), ("下", "auto", "下"))
        self.assertEqual(ps[9]["rewind_source"], "auto", "マスタの値が「-」でも自動")

    def test_row_input_wins_and_changes_face(self):
        lot = lot_l6183d0()
        lot["processes"][1]["rewind_master"] = "上"          # L-1（マスタは下）を上に
        p = self.calc(lot)["processes"][1]
        self.assertEqual((p["rewind_master"], p["rewind_source"], p["auto_rewind_master"]), ("上", "input", "下"))
        faces = [x["face_state"] for x in self.calc(lot)["processes"]]
        self.assertEqual(faces[:3], [0, 0, 1], "巻出し上・巻取り上なら L-1 では面が入れ替わらない")

    def test_unknown_value_is_auto(self):
        lot = lot_l6183d0()
        lot["processes"][1]["rewind_master"] = "斜め"
        self.assertEqual(self.calc(lot)["processes"][1]["rewind_source"], "auto")


if __name__ == "__main__":
    unittest.main()


def lot_rows(rows):
    return {"lot_no": "T", "density": 2.73, "processes": [
        {"no": i + 1, "equipment": eq, "unwind": "上", "thickness": t, "width": w, "weight": kg,
         "design_split": 1, "horizontal_split": 1, "vertical_split": 1, "off_front_m": 0, "off_back_m": ob}
        for i, (eq, t, w, kg, ob) in enumerate(rows)]}


class VolumeConservation(unittest.TestCase):
    """さかのぼりの板厚比は 1 つ下流の工程との比。体積が保たれるので、オフの無い工程では
    同じ汚れの「全長に対する位置の割合」が一定になる。以前の式（発見板厚との比）は上流ほど内側へ寄っていた。"""

    def ratios(self, mode):
        s = {"calculation": {"trace_ratio": mode}} if mode else {}
        res = Calculator(s, MasterRepository(ROOT)).calculate(lot_l6183d0(), inputs())
        ps = [p for p in res["processes"] if "trace" in p and p["no"] <= 6]   # 6 L-2 より上流はオフが無い
        return [p["position_from_a_m"] / p["after_length_m"] for p in ps]

    def test_fraction_is_constant(self):
        r = self.ratios(None)
        self.assertLess(max(r) - min(r), 0.02, r)

    def test_old_formula_is_selectable(self):
        r = self.ratios("found")
        self.assertLess(min(r), 0.01, "以前の式は HOT で全長の 1 % 未満まで内側へ寄る（移植元と突き合わせる用）")


class EndBack(unittest.TestCase):
    """冷延設備（L-）で重量が減っていたら、その重量から後オフ（エンドバック）を自動で入れる。"""

    def calc(self, rows, settings=None):
        return Calculator(settings or {}, MasterRepository(ROOT)).calculate(lot_rows(rows), inputs(found="3:CAL", a=100, b=103))

    def test_auto_from_weight_drop(self):
        res = self.calc([("HOT", 3.0, 1200, 6000, 0), ("L-1", 1.0, 1200, 5900, None), ("CAL", 1.0, 1200, 5800, None)])
        l1, cal = res["processes"][1], res["processes"][2]
        expect = 100 * 1000 / (2.73 * 1.0 * 1200)          # 100 kg を L-1 の板厚・板幅で長さへ
        self.assertAlmostEqual(l1["auto_off_back_m"], expect, places=6)
        self.assertEqual(l1["off_back_source"], "auto")
        self.assertAlmostEqual(l1["total_off_back_m"], expect, places=6, msg="自動の値が計算に使われる")
        self.assertIsNone(cal["auto_off_back_m"], "冷延設備でなければ自動にしない")
        self.assertEqual(cal["off_back_m"], 0.0)

    def test_input_wins_including_zero(self):
        res = self.calc([("HOT", 3.0, 1200, 6000, 0), ("L-1", 1.0, 1200, 5900, 0), ("CAL", 1.0, 1200, 5900, None)])
        l1 = res["processes"][1]
        self.assertEqual((l1["off_back_source"], l1["off_back_m"]), ("input", 0))
        self.assertGreater(l1["auto_off_back_m"], 0, "自動の値は比べられるよう返す")

    def test_no_drop_no_auto_and_edge_trim_excluded(self):
        res = self.calc([("HOT", 3.0, 1200, 6000, 0), ("L-1", 1.0, 1200, 6000, None), ("L-2", 0.5, 1100, 5400, None)])
        self.assertIsNone(res["processes"][1]["auto_off_back_m"])
        l2 = res["processes"][2]
        length = 5400 * 1000 / (1100 * 0.5 * 2.73)
        edge_kg = 100 * 0.5 * 2.73 * length / 1000          # 幅 1200→1100 で落とした両エッジ
        self.assertAlmostEqual(l2["auto_off_back_m"], (600 - edge_kg) * 1000 / (2.73 * 0.5 * 1100), places=6)

    def test_prefix_is_configurable(self):
        res = self.calc([("HOT", 3.0, 1200, 6000, 0), ("CAL", 1.0, 1200, 5900, None), ("TLV", 1.0, 1200, 5800, None)],
                        {"calculation": {"end_back_equipment": ["CAL"]}})
        self.assertGreater(res["processes"][1]["auto_off_back_m"], 0)


class InnerDiameter(unittest.TestCase):
    """内径: 表で入れた値があればそれ、空欄なら自動（設定の設備ごとの値 → HOT → 既定）。検入時内径は使わない。"""

    def calc(self, lot=None, settings=None, **kw):
        return Calculator(settings or {}, MasterRepository(ROOT)).calculate(lot or lot_l6183d0(), inputs(**kw))

    def test_auto_when_blank(self):
        ps = self.calc()["processes"]
        self.assertEqual([p["inner_diameter_mm"] for p in ps[:2]], [610.0, 558.0])     # HOT・それ以外
        self.assertTrue(all(p["inner_diameter_source"] == "auto" for p in ps))
        self.assertEqual(ps[7]["inner_diameter_mm"], 558.0, "発見設備も自動の値（検入時内径は使わない）")

    def test_row_input_wins_and_is_used(self):
        lot = lot_l6183d0()
        lot["processes"][6]["inner_diameter_mm"] = 508
        base, res = self.calc()["processes"][6], self.calc(lot)["processes"][6]
        self.assertEqual((res["inner_diameter_mm"], res["inner_diameter_source"], res["auto_inner_diameter_mm"]), (508.0, "input", 558.0))
        self.assertNotEqual(res["inner_thickness_mm"], base["inner_thickness_mm"], "入れた内径で肉厚・1 周を計算し直す")

    def test_blank_zero_or_text_is_auto(self):
        for v in ("", None, 0, "abc"):
            lot = lot_l6183d0()
            lot["processes"][0]["inner_diameter_mm"] = v
            self.assertEqual(self.calc(lot)["processes"][0]["inner_diameter_source"], "auto", v)

    def test_defaults_come_from_settings(self):
        cfg = {"calculation": {"default_inner_diameter_mm": 500, "hot_inner_diameter_mm": 600,
                               "equipment_inner_diameter_mm": {"CAL": 620}}}
        ps = self.calc(settings=cfg)["processes"]
        self.assertEqual([ps[0]["inner_diameter_mm"], ps[1]["inner_diameter_mm"], ps[6]["inner_diameter_mm"]], [600.0, 500.0, 620.0])


class Density(unittest.TestCase):
    """比重: 取り込んだロットの比重を使う（画面では入れない）。無い・0 なら設定の既定（2.7）。"""

    def calc(self, density, settings=None):
        lot = lot_l6183d0()
        lot["density"] = density
        return Calculator(settings or {}, MasterRepository(ROOT)).calculate(lot, inputs())

    def test_lot_density_is_used(self):
        res = self.calc(2.70)
        self.assertEqual((res["density"], res["density_source"]), (2.70, "lot"))
        self.assertAlmostEqual(res["processes"][0]["after_length_m"], 6214 * 1000 / (1200 * 7 * 2.70), places=6)

    def test_missing_falls_back_to_default(self):
        for v in (0, None, ""):
            res = self.calc(v)
            self.assertEqual((res["density"], res["density_source"]), (2.7, "default"), v)
        self.assertEqual(self.calc(0, {"calculation": {"default_density": 2.71}})["density"], 2.71)

    def test_distributed_setting_is_2_7(self):
        # 実際に使われるのは配った設定の値（コードの 2.7 は設定に項目が無いときの予備）。両方とも 2.7
        for name in ("appsettings.json", "appsettings.example.json"):
            cfg = json.loads((ROOT / "config" / name).read_text(encoding="utf-8"))
            self.assertEqual(cfg["calculation"]["default_density"], 2.7, name)
            res = Calculator(cfg, MasterRepository(ROOT)).calculate(dict(lot_l6183d0(), density=0), inputs())
            self.assertEqual((res["density"], res["density_source"]), (2.7, "default"), name)

    def test_lot_without_density_key_uses_default(self):
        lot = lot_l6183d0()
        del lot["density"]
        self.assertEqual(Calculator({}, MasterRepository(ROOT)).calculate(lot, inputs())["density"], 2.7)

    def test_inputs_density_is_ignored(self):
        lot = lot_l6183d0()
        res = Calculator({}, MasterRepository(ROOT)).calculate(lot, dict(inputs(), density=9.9))
        self.assertEqual(res["density"], 2.73)


class Origins(unittest.TestCase):
    """仮の発生設備から下流へたどり直した結果（3D が描く値）は、表の計算と同じになる。"""

    def setUp(self):
        self.res = Calculator({}, MasterRepository(ROOT)).calculate(lot_l6183d0(), inputs())
        self.by = {p["no"]: p for p in self.res["processes"]}

    def test_prediction_equals_table(self):
        self.assertTrue(self.res["origins"])
        for key, o in self.res["origins"].items():
            x = self.by[o["no"]]
            self.assertAlmostEqual(o["predicted_m"], x["transfer_distance_m"], places=9, msg=key)
            self.assertAlmostEqual(o["steps"][0]["spacing_m"], o["circumference_m"], places=9)
            self.assertAlmostEqual(o["inner_thickness_mm"], x["inner_thickness_mm"], places=9)
            self.assertTrue(o["steps"][-1]["is_found"])

    def test_head_tail_alternates_and_marks_follow(self):
        o = self.res["origins"]["2"]
        ends = [s["a_end"] for s in o["steps"]]
        self.assertTrue(all(a != b for a, b in zip(ends, ends[1:])), ends)   # 巻き替えのたびに入れ替わる（AN なし）
        for s in o["steps"]:
            p = self.by[s["no"]]
            pos = p["position_from_a_m"]
            head = pos if s["a_end"] == "頭" else p["after_length_m"] - pos
            self.assertAlmostEqual(s["marks"][0]["from_head_m"], head, places=9)
            self.assertAlmostEqual(abs(s["marks"][1]["from_head_m"] - s["marks"][0]["from_head_m"]), s["spacing_m"], places=9)
            self.assertAlmostEqual(s["marks"][0]["inner_length_m"], s["marks"][0]["from_head_m"], places=9, msg="頭が内側")

    def test_second_mark_is_one_wrap_outward_at_origin(self):
        for o in self.res["origins"].values():
            m1, m2 = o["steps"][0]["marks"]
            self.assertAlmostEqual(m2["inner_length_m"] - m1["inner_length_m"], o["circumference_m"], places=9)
            self.assertGreater(m2["wall_mm"], m1["wall_mm"])

    def test_likely_origin_is_best_agreement(self):
        best = max(self.res["origins"].values(), key=lambda o: o["agreement_percent"])
        self.assertEqual(self.res["likely_origin_no"], best["no"])
