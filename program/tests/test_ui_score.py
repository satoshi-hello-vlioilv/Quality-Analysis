"""画面の改良案の評価関数（tools/ui_score.py）: 決め方（CLAUDE.md の「UI/UX を変えるときは…」）どおりに判定するか。"""
import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("ui_score", Path(__file__).resolve().parents[1] / "tools" / "ui_score.py")
ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ui)


def scores(n):
    return [n] * len(ui.WEIGHTS)


class UiScore(unittest.TestCase):
    def test_weights_and_margin(self):
        self.assertEqual(len(ui.CRITERIA), 7)
        self.assertEqual(sum(ui.WEIGHTS), 100, "100 点満点")
        self.assertAlmostEqual(ui.MARGIN, 10.95, places=2)   # CLAUDE.md の「僅差の幅 11 点」
        self.assertEqual(ui.total(scores(10)), 100)
        with self.assertRaises(ValueError):
            ui.total([5, 5])

    def test_clear_winner_is_chosen(self):
        rnd = {"name": "1 回目", "proposals": {"A": scores(9), "B": scores(7), "C": scores(6), "D": scores(5), "E": scores(4)}}
        kind, who, _ = ui.decide([rnd])
        self.assertEqual((kind, who), ("選ぶ", "A"))

    def test_close_call_asks_for_composites_then_the_user(self):
        first = {"name": "1 回目", "proposals": {"A": scores(8), "B": [8, 8, 8, 8, 8, 8, 7], "C": scores(5), "D": scores(4), "E": scores(3)}}
        kind, who, _ = ui.decide([first])
        self.assertEqual((kind, who), ("比べ直す", ["A", "B"]), "僅差なら上位 2 案を残して比べ直す")
        second = {"name": "2 回目", "proposals": {"A": scores(8), "B": [8, 8, 8, 8, 8, 8, 7], "AB1": scores(7), "AB2": scores(6), "AB3": scores(5)}}
        kind, who, _ = ui.decide([first, second])
        self.assertEqual((kind, who), ("確かめる", ["A", "B"]), "選び直しても僅差なら利用者に確かめる")

    def test_rounds_must_follow_the_rule(self):
        with self.assertRaisesRegex(ValueError, "最低 5 案"):
            ui.decide([{"name": "1 回目", "proposals": {"A": scores(9), "B": scores(1)}}])
        first = {"name": "1 回目", "proposals": {"A": scores(8), "B": [8, 8, 8, 8, 8, 8, 7], "C": scores(5), "D": scores(4), "E": scores(3)}}
        with self.assertRaisesRegex(ValueError, "上位 2 案"):
            ui.decide([first, {"name": "2 回目", "proposals": {"A": scores(8), "X": scores(7), "Y": scores(6), "Z": scores(5), "W": scores(4)}}])
        with self.assertRaisesRegex(ValueError, "複合案は 3 つ"):
            ui.decide([first, {"name": "2 回目", "proposals": {"A": scores(8), "B": scores(7), "X": scores(6), "C": scores(5), "D": scores(4)}}])


if __name__ == "__main__":
    unittest.main()
