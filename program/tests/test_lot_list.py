# -*- coding: utf-8 -*-
"""ロット一覧: 品質データ SQLite の写し（WaveLog db_mirror と同じ方式）と、絞り込み（WaveLog /api/table と同じ）。"""
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from app import create_app
from app.repositories.master_store import MasterStore
from app.services import lot_list
from app.services.db_mirror import DbMirror

ROWS = [
    # ロット番号, 発生設備, 異常内容, 廃棄重量, コメント
    ("L6183D0", "CAL", "押し疵", "120", "頭 30m"),
    ("L6183D1", "L-2", "汚れ", "8.5", None),
    ("L7150C0", "TLV", "汚れ", "", "尾"),
    ("M0001A0", "HOT", "ロール疵", "1000", "要確認"),
    ("L6183D2", "CAL", "汚れ", "95", ""),
]


def make_db(path, rows=ROWS, table="仕掛"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    c = sqlite3.connect(path)
    c.execute(f"CREATE TABLE [{table}] (ロット番号 TEXT, 発生設備 TEXT, 異常内容 TEXT, 廃棄重量 TEXT, コメント TEXT)")
    c.execute("CREATE TABLE [別表] (x TEXT)")
    c.executemany(f"INSERT INTO [{table}] VALUES (?,?,?,?,?)", rows)
    c.commit()
    c.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.share = self.tmp / "share" / "SIKADEF.sqlite3"
        make_db(self.share)
        self.cache = self.tmp / "cache"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class MirrorTests(Base):
    def test_copies_then_skips_when_unchanged(self):
        m = DbMirror("lot_list", self.share, self.cache)
        r = m.refresh()
        self.assertTrue(r["updated"], r)
        self.assertEqual(r["how"], "backup")
        p = m.read_path()
        self.assertEqual(p.parent, self.cache)
        self.assertTrue(p.name.startswith("lot_list.g1"))
        r2 = m.refresh()
        self.assertFalse(r2["updated"])
        self.assertTrue(r2.get("skipped"))
        self.assertEqual(m.read_path(), p)

    def test_changed_source_makes_new_generation_and_sweeps_old(self):
        m = DbMirror("lot_list", self.share, self.cache)
        m.refresh()
        first = m.read_path()
        time.sleep(0.01)
        make_db(self.share, ROWS + [("Z9999Z9", "KEN", "新", "1", "")])
        os.utime(self.share, ns=(time.time_ns(), time.time_ns() + 10**9))
        r = m.refresh()
        self.assertTrue(r["updated"], r)
        second = m.read_path()
        self.assertNotEqual(first, second)
        self.assertFalse(first.exists(), "古い世代は片付ける")
        out = lot_list.query(second)
        self.assertEqual(out["count"], len(ROWS) + 1)

    def test_corrupt_source_keeps_previous_copy(self):
        m = DbMirror("lot_list", self.share, self.cache)
        m.refresh()
        good = m.read_path()
        self.share.write_bytes(b"not a sqlite file" * 100)
        r = m.refresh(force=True)
        self.assertFalse(r["updated"])
        self.assertEqual(m.read_path(), good)
        self.assertEqual(lot_list.query(good)["count"], len(ROWS))

    def test_unreachable_keeps_copy_and_says_why(self):
        m = DbMirror("lot_list", self.share, self.cache)
        m.refresh()
        good = m.read_path()
        self.share.unlink()
        r = m.refresh()
        self.assertTrue(r["unreachable"])
        self.assertIn("前の写しを使い続けます", r["reason"])
        self.assertEqual(m.read_path(), good)
        info = m.source_info()
        self.assertTrue(info["mirrored"] and info["unreachable"])

    def test_no_copy_yet_reads_source_directly(self):
        m = DbMirror("lot_list", self.share, self.cache)
        self.assertEqual(m.read_path(), self.share)
        self.assertFalse(m.source_info()["mirrored"])

    def test_repointed_source_does_not_use_old_copy(self):
        DbMirror("lot_list", self.share, self.cache).refresh()
        other = self.tmp / "other.sqlite3"
        make_db(other, ROWS[:1])
        m2 = DbMirror("lot_list", other, self.cache)
        self.assertEqual(m2.read_path(), other)
        self.assertFalse(m2.source_info()["mirrored"])

    def test_source_info_does_not_touch_share(self):
        m = DbMirror("lot_list", self.share, self.cache)
        m.refresh()
        mtime = self.share.stat().st_mtime
        self.share.unlink()           # 共有が消えても、写しの時刻は台帳から言える
        info = m.source_info()
        self.assertAlmostEqual(info["at"], mtime, places=3)
        self.assertIsNotNone(info["copiedAt"])


class PassiveMirrorTests(Base):
    """デスクトップ版で写しを Rust が受け持つとき、Python の写しの係は写さず、同じ台帳を読むだけ。"""

    def test_passive_does_not_copy_but_reads_the_ledger(self):
        p = DbMirror("lot_list", self.share, self.cache, passive=True)
        self.assertFalse(p.start(), "背景スレッドを起こさない")
        self.assertFalse(p.reconfigure(remote=str(self.share), interval_sec=30) and p._thread, "設定が変わっても起こさない")
        self.assertEqual(p.read_path(), self.share, "写しが無ければ元を直接（待たない）")
        DbMirror("lot_list", self.share, self.cache).refresh()       # ほかの係（Rust の代わり）が写した
        self.assertEqual(p.read_path().parent, self.cache, "台帳の写しを読む")
        self.assertTrue(p.source_info()["mirrored"])

    def test_external_only_when_the_window_serves_it(self):
        from unittest import mock
        from app import mirror_is_external
        with mock.patch.dict(os.environ, {"TPA_SHELL": "desktop", "TPA_SHELL_SERVES": "x, lotlist"}):
            self.assertTrue(mirror_is_external({}), "窓が受け持つと名乗り、既定は rust")
            self.assertFalse(mirror_is_external({"desktop": {"lotlist_engine": "python"}}))
        with mock.patch.dict(os.environ, {"TPA_SHELL": "desktop", "TPA_SHELL_SERVES": ""}):
            self.assertFalse(mirror_is_external({}), "窓が受け持たない（Rust へ移す前の窓）なら自分で写す")
        with mock.patch.dict(os.environ, {"TPA_SHELL_SERVES": "lotlist"}):
            os.environ.pop("TPA_SHELL", None)
            self.assertFalse(mirror_is_external({}), "窓の外では名乗りを見ない")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TPA_SHELL", None)
            self.assertFalse(mirror_is_external({}), "ブラウザ版は自分で写す")


class StaleTests(Base):
    """毎日更新されるはずの元データが古いとき（元ファイルの更新時刻がしきいを過ぎた）に「古い」と言う。"""
    def age(self, hours):
        t = time.time() - hours * 3600
        os.utime(self.share, (t, t))

    def test_old_source_is_stale(self):
        self.age(50)
        m = DbMirror("lot_list", self.share, self.cache, stale_hours=36)
        m.refresh()
        info = m.source_info()
        self.assertTrue(info["stale"])
        self.assertAlmostEqual(info["ageHours"], 50, delta=0.2)
        self.assertEqual(info["staleHours"], 36)

    def test_recent_source_is_not_stale(self):
        self.age(10)
        m = DbMirror("lot_list", self.share, self.cache, stale_hours=36)
        m.refresh()
        self.assertFalse(m.source_info()["stale"])

    def test_unknown_when_not_copied_yet(self):
        m = DbMirror("lot_list", self.share, self.cache)
        self.assertIsNone(m.source_info()["stale"], "分からないときに「古くない」と言い切らない")

    def test_zero_turns_the_warning_off(self):
        self.age(500)
        m = DbMirror("lot_list", self.share, self.cache, stale_hours=0)
        m.refresh()
        self.assertFalse(m.source_info()["stale"])

    def test_stays_stale_when_share_is_unreachable(self):
        self.age(80)
        m = DbMirror("lot_list", self.share, self.cache, stale_hours=36)
        m.refresh()
        self.share.unlink()
        m.refresh()
        info = m.source_info()
        self.assertTrue(info["unreachable"] and info["stale"])


class QueryTests(Base):
    def q(self, **kw):
        return lot_list.query(self.share, **kw)

    def lots(self, **kw):
        return [r["ロット番号"] for r in self.q(**kw)["rows"]]

    def f(self, *conds, **kw):
        return self.lots(filters=json.dumps([{"column": c, "op": o, "value": v} for c, o, v in conds]), **kw)

    def test_picks_table_and_lot_column(self):
        out = self.q()
        self.assertEqual(out["table"], "仕掛")
        self.assertEqual(out["lotColumn"], "ロット番号")
        self.assertEqual(out["count"], 5)

    def test_ops_same_as_wavelog(self):
        self.assertEqual(self.f(("異常内容", "contains", "汚")), ["L6183D1", "L7150C0", "L6183D2"])
        self.assertEqual(self.f(("異常内容", "not_contains", "汚")), ["L6183D0", "M0001A0"])
        self.assertEqual(self.f(("発生設備", "eq", "CAL")), ["L6183D0", "L6183D2"])
        self.assertEqual(self.f(("コメント", "neq", "尾")), ["L6183D0", "L6183D1", "M0001A0", "L6183D2"],
                         "≠ は空欄（NULL）も含む")
        self.assertEqual(self.f(("ロット番号", "starts", "L6183")), ["L6183D0", "L6183D1", "L6183D2"])
        self.assertEqual(self.f(("ロット番号", "ends", "C0")), ["L7150C0"])
        self.assertEqual(self.f(("ロット番号", "starts_any", "L7,M0")), ["L7150C0", "M0001A0"])
        self.assertEqual(self.f(("コメント", "empty", "")), ["L6183D1", "L6183D2"])
        self.assertEqual(self.f(("コメント", "not_empty", "")), ["L6183D0", "L7150C0", "M0001A0"])

    def test_numeric_compare_uses_val(self):
        # 文字列で入っていても数で比べる（"8.5" < "95" < "120" < "1000"、空は 0）
        self.assertEqual(self.f(("廃棄重量", "gt", "95")), ["L6183D0", "M0001A0"])
        self.assertEqual(self.f(("廃棄重量", "gte", "95")), ["L6183D0", "M0001A0", "L6183D2"])
        self.assertEqual(self.f(("廃棄重量", "lt", "10")), ["L6183D1", "L7150C0"])
        self.assertEqual(self.f(("廃棄重量", "lte", "8.5")), ["L6183D1", "L7150C0"])

    def test_conditions_are_anded_with_search(self):
        self.assertEqual(self.f(("異常内容", "eq", "汚れ"), ("発生設備", "eq", "CAL")), ["L6183D2"])
        self.assertEqual(self.f(("異常内容", "eq", "汚れ"), search="尾"), ["L7150C0"])
        self.assertEqual(self.lots(search="要確認"), ["M0001A0"], "検索はどの列の字でも当たる")

    def test_unknown_column_and_op_are_ignored(self):
        evil = "ロット番号]; DROP TABLE [仕掛"
        out = self.q(filters=json.dumps([{"column": evil, "op": "eq", "value": "x"},
                                         {"column": "発生設備", "op": "exec", "value": "x"}]))
        self.assertEqual(out["count"], 5)
        self.assertEqual(out["filters_applied"], 0)

    def test_sorts_and_paging(self):
        srt = json.dumps([{"column": "発生設備", "dir": "asc"}, {"column": "ロット番号", "dir": "desc"}])
        self.assertEqual(self.lots(sorts=srt), ["L6183D2", "L6183D0", "M0001A0", "L6183D1", "L7150C0"])
        p2 = self.q(sorts=srt, page=2, page_size=2)
        self.assertEqual([r["ロット番号"] for r in p2["rows"]], ["M0001A0", "L6183D1"])
        self.assertEqual(p2["count"], 5)
        self.assertEqual(self.q(sorts=json.dumps([{"column": "無い列"}]))["sorts"], [])


class GroupTests(Base):
    """ロット番号でまとめる: 同じロットの行は続けて並び、ロットの順は「並べ替えでいちばん上に来る行」の順。
    ページの境目でロットを切らない（ロットはその先頭の行が入るページに丸ごと入る）。"""
    ROWS = [
        # ロット番号, 発生設備, 異常内容, 廃棄重量, コメント
        ("A1", "CAL", "汚れ", "10", "1"),
        ("B1", "TLV", "汚れ", "50", "2"),
        ("a1 ", "CAL", "押し疵", "70", "3"),     # 大小・前後の空白は同じロット
        ("C1", "HOT", "汚れ", "30", "4"),
        ("", "CAL", "汚れ", "90", "5"),          # ロット番号が空の行は1行ずつ（まとめない）
        ("B1", "CAL", "汚れ", "20", "6"),
        ("A1", "TLV", "汚れ", "40", "7"),
        ("", "TLV", "汚れ", "05", "8"),       # 重さは字で並ぶので桁をそろえる
    ]

    def setUp(self):
        super().setUp()
        make_db(self.share, rows=self.ROWS)

    def q(self, **kw):
        return lot_list.query(self.share, group=True, **kw)

    def ids(self, out):
        return [r["コメント"] for r in out["rows"]]

    def test_rows_of_a_lot_follow_each_other_in_table_order(self):
        out = self.q()
        self.assertEqual(self.ids(out), ["1", "3", "7", "2", "6", "4", "5", "8"])
        self.assertEqual(out["groups"], [[3, 1], [3, 2], [3, 3], [2, 1], [2, 2], [1, 1], [1, 1], [1, 1]])
        self.assertEqual(out["groupCount"], 5, "A1・B1・C1 と空の2行")
        self.assertEqual(out["count"], 8, "件数は行の数のまま")

    def test_sort_still_works_between_and_inside_lots(self):
        # 重量の大きい順: ロットの順は、そのロットでいちばん重い行の順。ロットの中も重い順
        out = self.q(sorts=json.dumps([{"column": "廃棄重量", "dir": "desc"}]))
        self.assertEqual(self.ids(out), ["5", "3", "7", "1", "2", "6", "4", "8"])
        out = self.q(sorts=json.dumps([{"column": "廃棄重量", "dir": "asc"}]))
        self.assertEqual(self.ids(out), ["8", "1", "7", "3", "6", "2", "4", "5"])

    def test_filters_and_search_apply_before_grouping(self):
        out = self.q(filters=json.dumps([{"column": "発生設備", "op": "eq", "value": "CAL"}]))
        self.assertEqual(self.ids(out), ["1", "3", "5", "6"])
        self.assertEqual(out["groups"], [[2, 1], [2, 2], [1, 1], [1, 1]])
        self.assertEqual(out["groupCount"], 3)

    def test_pages_never_split_a_lot(self):
        import random
        rnd = random.Random(7)
        weights = rnd.sample(range(1000), 300)     # 重さはみな違う（ロットの順が1通りに決まる）。3桁そろえで字の順＝数の順
        rows = [(f"L{rnd.randrange(60):02d}", "CAL", "汚れ", f"{weights[i]:03d}", str(i)) for i in range(300)]
        make_db(self.share, rows=rows)
        srt = json.dumps([{"column": "廃棄重量", "dir": "desc"}])
        seen, page, pages = [], 1, 0
        while True:
            out = self.q(sorts=srt, page=page, page_size=7)
            got = out["rows"]
            self.assertTrue(got, f"{page} ページ目が空")
            self.assertEqual(out["groups"][0][1], 1, "ページはロットの先頭から始まる")
            last_n, last_i = out["groups"][-1]
            self.assertEqual(last_n, last_i, "ページはロットの終わりで終わる")
            self.assertEqual(out["range"], [len(seen) + 1, len(seen) + len(got)])
            seen += got
            pages += 1
            if out["range"][1] >= out["count"]:
                break
            page += 1
        self.assertEqual(sorted(r["コメント"] for r in seen), sorted(str(i) for i in range(300)), "どの行も1回だけ")
        by_page_lots = [r["ロット番号"] for r in seen]
        runs = [k for i, k in enumerate(by_page_lots) if i == 0 or by_page_lots[i - 1] != k]
        self.assertEqual(len(runs), len(set(runs)), "同じロットが2か所に分かれない")
        # ロットの順＝そのロットでいちばん重い行の順
        best = {}
        for lot, _, _, w, _ in rows:
            best[lot] = max(best.get(lot, -1), int(w))
        self.assertEqual(runs, sorted(best, key=lambda k: -best[k]))
        self.assertGreater(pages, 1)

    def test_not_grouped_is_unchanged(self):
        out = lot_list.query(self.share)
        self.assertEqual(self.ids(out), [str(i) for i in range(1, 9)])
        self.assertNotIn("groups", out)
        self.assertEqual(out["range"], [1, 8])

    def test_table_without_lot_column_is_not_grouped(self):
        c = sqlite3.connect(self.share)
        c.execute("CREATE TABLE [番号なし] (設備 TEXT)")
        c.executemany("INSERT INTO [番号なし] VALUES (?)", [("A",), ("B",)])
        c.commit()
        c.close()
        out = self.q(table="番号なし")
        self.assertNotIn("groups", out)
        self.assertEqual(out["count"], 2)


class RelativeDateTests(Base):
    """今日から N 日・週・か月・年以内（日付と読める値だけが当たる）。"""
    def setUp(self):
        super().setUp()
        rows = [("D1", "2026/09/28 10:00"), ("D2", "26/09/20 23:48:54"), ("D3", "2026-08-30"), ("D4", "20260301"),
                ("D5", "2025年9月29日"), ("D6", "日付でない"), ("D7", None), ("D8", "2026/09/30")]
        c = sqlite3.connect(self.share)
        c.execute("CREATE TABLE [日付] (ロット番号 TEXT, 登録日時 TEXT, 数 TEXT)")
        c.executemany("INSERT INTO [日付] VALUES (?,?,'1')", rows)
        c.commit()
        c.close()
        from datetime import date
        self.today = date(2026, 9, 29)

    def lots(self, op, n):
        out = lot_list.query(self.share, table="日付", today=self.today,
                             filters=json.dumps([{"column": "登録日時", "op": op, "value": str(n)}]))
        return [r["ロット番号"] for r in out["rows"]]

    def test_days(self):
        self.assertEqual(self.lots("within_days", 1), ["D1", "D8"], "未来の日付も当たる（今日−N 以降）")
        self.assertEqual(self.lots("within_days", 9), ["D1", "D2", "D8"])
        self.assertEqual(self.lots("within_days", 0), ["D8"])

    def test_weeks_months_years(self):
        self.assertEqual(self.lots("within_weeks", 2), ["D1", "D2", "D8"])
        self.assertEqual(self.lots("within_months", 1), ["D1", "D2", "D3", "D8"])
        self.assertEqual(self.lots("within_months", 7), ["D1", "D2", "D3", "D4", "D8"])
        self.assertEqual(self.lots("within_years", 1), ["D1", "D2", "D3", "D4", "D5", "D8"])

    def test_non_dates_never_match(self):
        self.assertNotIn("D6", self.lots("within_years", 100))
        self.assertNotIn("D7", self.lots("within_years", 100))

    def test_date_columns_are_detected(self):
        out = lot_list.query(self.share, table="日付", today=self.today)
        self.assertEqual(out["dateColumns"], ["登録日時"], "8割以上が日付と読める列だけ")
        self.assertEqual(out["today"], "2026-09-29")

    def test_month_end_is_clamped(self):
        from datetime import date
        self.assertEqual(lot_list.cutoff_date("within_months", 1, date(2026, 3, 31)), "2026-02-28")
        self.assertEqual(lot_list.cutoff_date("within_years", 1, date(2024, 2, 29)), "2023-02-28")


class RelativeDateWholeTableTests(Base):
    """「以内」は表全体に掛かる（表示中の 500 件だけではない）。0 件のときは理由の材料を返す。"""
    def setUp(self):
        super().setUp()
        from datetime import date, timedelta
        self.today = date(2026, 9, 29)
        rows = []
        for i in range(1500):     # 古い順。最近の行は表の後ろ（500 件目より後ろ）にだけある
            d = self.today - timedelta(days=730 - i * 730 // 1500)
            f = ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d", "%Y%m%d")[i % 3]
            rows.append((f"L{i:05d}", d.strftime(f), "CAL" if i % 2 else "TLV"))
        c = sqlite3.connect(self.share)
        c.execute("CREATE TABLE [大きい] (ロット番号 TEXT, 登録日時 TEXT, 発生設備 TEXT)")
        c.executemany("INSERT INTO [大きい] VALUES (?,?,?)", rows)
        c.commit()
        c.close()
        self.rows = rows

    def q(self, *conds, **kw):
        return lot_list.query(self.share, table="大きい", today=self.today, page_size=500,
                              filters=json.dumps([{"column": c, "op": o, "value": v} for c, o, v in conds]), **kw)

    def test_filter_reaches_rows_beyond_the_first_page(self):
        from app.services.sqlite_ro import to_date
        out = self.q(("登録日時", "within_days", "30"))
        cut = lot_list.cutoff_date("within_days", 30, self.today)
        exp = [lot for lot, v, _ in self.rows if to_date(v) >= cut]
        first = next(i for i, (_, v, _) in enumerate(self.rows) if to_date(v) >= cut)
        self.assertGreater(first, 1000, "当たる行は表の後ろにしか無い")
        self.assertEqual(out["count"], len(exp))
        self.assertEqual(sorted(r["ロット番号"] for r in out["rows"]), sorted(exp))
        self.assertEqual(out["dateHints"], [], "当たったときは理由を作らない")

    def test_count_and_paging_beyond_500(self):
        out = self.q(("登録日時", "within_years", "1"))
        self.assertGreater(out["count"], 500)
        p2 = self.q(("登録日時", "within_years", "1"), page=2)
        self.assertEqual(len(p2["rows"]), out["count"] - 500)

    def test_hint_when_data_is_older_than_the_range(self):
        from datetime import date
        out = lot_list.query(self.share, table="大きい", today=date(2027, 6, 1),
                             filters=json.dumps([{"column": "登録日時", "op": "within_days", "value": "7"}]))
        self.assertEqual(out["count"], 0)
        h = out["dateHints"][0]
        self.assertEqual(h["dated"], 1500)
        self.assertEqual(h["alone"], 0)
        self.assertEqual(h["newest"], max(lot_list.to_date(v) for _, v, _ in self.rows))
        self.assertTrue(h["newestRaw"])
        self.assertEqual(h["cutoff"], "2027-05-25")

    def test_hint_when_other_conditions_make_it_zero(self):
        out = self.q(("登録日時", "within_days", "3"), ("発生設備", "eq", "無い設備"))
        self.assertEqual(out["count"], 0)
        self.assertGreater(out["dateHints"][0]["alone"], 0, "この条件だけなら当たる")

    def test_hint_when_column_has_no_dates(self):
        out = self.q(("発生設備", "within_days", "3"))
        h = out["dateHints"][0]
        self.assertEqual((h["dated"], h["filled"]), (0, 1500))


class ApiTests(Base):
    def setUp(self):
        super().setUp()
        app = create_app({"MASTER_STORE": MasterStore(Path(__file__).resolve().parents[1], local_root=self.tmp / "m",
                                                      settings={}),
                          "LOT_MIRROR": DbMirror("lot_list", self.share, self.cache)})
        self.c = app.test_client()

    def test_list_reads_the_local_copy(self):
        r = self.c.get("/api/lotlist?filters=" + json.dumps([{"column": "発生設備", "op": "eq", "value": "CAL"}]))
        d = r.get_json()
        self.assertEqual(r.status_code, 200, d)
        self.assertEqual(d["count"], 2)
        self.assertTrue(d["source"]["mirrored"], "一覧は手元の写しを読む")

    def test_group_is_passed_to_the_query(self):
        d = self.c.get("/api/lotlist?group=1").get_json()
        self.assertEqual(d["groupCount"], 5)
        self.assertEqual(len(d["groups"]), 5)
        self.assertNotIn("groups", self.c.get("/api/lotlist").get_json(), "group=1 のときだけまとめる")

    def test_refresh_and_source(self):
        self.c.get("/api/lotlist")
        d = self.c.post("/api/lotlist/refresh").get_json()
        self.assertTrue(d["result"]["updated"], d)
        s = self.c.get("/api/lotlist/source").get_json()
        self.assertTrue(s["mirrored"])


if __name__ == "__main__":
    unittest.main()


class GroupKeyedSqlTests(unittest.TestCase):
    """まとめる SQL の速い形（行番号・並べ替えの順・ロットの見分けだけで並びを決め、そのページの行を後から読む）が、
    全部の列を持ち回す前の形と同じ答えを返すか。行番号の無い表・ビューは前の形へ戻るか。"""

    @classmethod
    def setUpClass(cls):
        from tests import lotlist_fixture
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "fx.sqlite3")
        cls.cols = lotlist_fixture.make(cls.db, 1500)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_same_answer_as_the_full_form(self):
        from app.services.sqlite_ro import connect_ro
        cases = [([], "", []), ([("重量", "DESC")], "", []), ([("設備", "ASC"), ("発生日", "DESC")], "", []),
                 ([("重量", "ASC")], " WHERE CStr([不良名]) LIKE ?", ["%汚%"])]
        filled = 0
        with connect_ro(self.db) as c:
            raw = lot_list.raw_columns(c, "仕掛")
            self.assertEqual(lot_list.rowid_name(c, "仕掛", raw), "rowid")
            for order, where, params in cases:
                for size, page in ((500, 1), (500, 2), (37, 9), (7, 40)):
                    full = c.execute(lot_list.grouped_sql("仕掛", raw, "ロット番号", where, order, size), params + [page]).fetchall()
                    fast = lot_list.grouped_rows(c, "仕掛", raw, "ロット番号", where, params, order, page, size)
                    n = len(raw)
                    self.assertEqual(fast[0], [r[:n] for r in full], (order, where, size, page))
                    self.assertEqual(fast[1], [[r[n], r[n + 1]] for r in full])
                    filled += bool(full)
        self.assertGreaterEqual(filled, 12, "中身のあるページで比べている（無いページは両方とも空で一致）")

    def test_view_and_without_rowid_use_the_full_form(self):
        from app.services.sqlite_ro import connect_ro
        with connect_ro(self.db) as c:
            self.assertIsNone(lot_list.rowid_name(c, "仕掛_ビュー", lot_list.raw_columns(c, "仕掛_ビュー")), "ビューの行番号は NULL")
            self.assertIsNone(lot_list.rowid_name(c, "保留", lot_list.raw_columns(c, "保留")), "WITHOUT ROWID")
            self.assertEqual(lot_list.rowid_name(c, "仕掛", ["rowid", "x"]), "_rowid_", "rowid という列があれば別の呼び名")
        view = lot_list.query(self.db, table="仕掛_ビュー", group=True, sorts='[{"column":"重量","dir":"desc"}]')
        table = lot_list.query(self.db, table="仕掛", group=True, sorts='[{"column":"重量","dir":"desc"}]')
        self.assertEqual((view["rows"], view["groups"], view["groupCount"]), (table["rows"], table["groups"], table["groupCount"]))


class SortKeyTests(unittest.TestCase):
    """並べ替えの鍵（SortKey）: 「並び・まとめ」で同じ値と見る物は、並べ替えでも隣り合う（版 3.12.0 まで、生の値で並べたため、
    ' 100%' と '100%'・NULL と ''・字の '54' と数の 54 が離れ、2段目からの並びが途中で振り出しに戻った）。"""

    def test_key(self):
        from app.services.sqlite_ro import sort_key
        self.assertEqual([sort_key(v) for v in (None, "", "  ", "　")], [None] * 4, "空欄はまとめる")
        self.assertEqual([sort_key(v) for v in (54, " 54 ", "1e-05", "+.5", "2.")], [54, 54.0, 1e-05, 0.5, 2.0], "数に読める字は数")
        self.assertEqual([sort_key(v) for v in (" 100%", "1-2", "e5", "a]b ", "Ｌ－１")], ["100%", "1-2", "e5", "a]b", "Ｌ－１"])
        self.assertEqual(sort_key(b"\x00\x01"), str(b"\x00\x01"))

    def test_levels_stay_together(self):
        """段の値（画面の見分け）が同じ行は1か所に集まり、その中で下の段が並ぶ。"""
        from app.services.sqlite_ro import sort_key
        from tests import lotlist_fixture
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "fx.sqlite3")
            lotlist_fixture.make(db, 1500)
            for levels in ([("備考", "asc"), ("数量", "desc")], [("客先", "desc"), ("板厚", "asc"), ("不良名", "asc")],
                           [("ロット番号", "asc"), ("備考", "desc")]):
                for group in ((False, True) if levels[0][0] == "ロット番号" else (False,)):   # 画面は先頭の段がロット番号のときだけ group
                    with self.subTest(levels=levels, group=group):
                        r = lot_list.query(db, page_size=2000, group=group,
                                           sorts=json.dumps([{"column": c, "dir": d} for c, d in levels], ensure_ascii=False))
                        def key(row, c):
                            return sort_key(str(row[c] or "").upper()) if c == "ロット番号" else sort_key(row[c])
                        for k in range(len(levels)):
                            seen, prev = set(), object()
                            for row in r["rows"]:
                                path = tuple(key(row, c) for c, _ in levels[:k + 1])
                                if path != prev:
                                    self.assertNotIn(path, seen, f"段{k + 1} {levels[k][0]} の {path} が2か所に分かれた")
                                    seen.add(path)
                                    prev = path


class ShownKeyTests(unittest.TestCase):
    """見えている値でまとめる（版 3.13.0）: 日付だけ・年月・丸めた数で見せる段は、サーバーも同じ丸め方で並べる。
    3.12.0 までは元の値で並べたので、時刻の違う同じ日付が別々になり、下の段の並びもそこで振り出しに戻った。"""

    def test_kind(self):
        k = lot_list.sort_key_kind
        self.assertEqual([k("date"), k("MONTH"), k(" year "), k("round:2"), k("Round:12"), k("round:x"), k(3), k(None), k("round:٣")],
                         ["date", "month", "year", "round:2", "round:10", "", "", "", ""])

    def test_same_shown_value_stays_together_and_inner_level_is_sorted(self):
        from app.services.sqlite_ro import sort_key, to_date
        from tests import lotlist_fixture

        def order(v):      # SQLite の並び: NULL → 数 → 字（設備は字か空欄）
            k = sort_key(v)
            return (0, "") if k is None else (1, k) if isinstance(k, (int, float)) else (2, k)
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "fx.sqlite3")
            lotlist_fixture.make(db, 1500)
            cases = [("date", lambda v: to_date(v) or str(v or "").strip()), ("month", lambda v: (to_date(v) or "")[:7] or str(v or "").strip())]
            for key, shown in cases:
                with self.subTest(key=key):
                    r = lot_list.query(db, page_size=2000, sorts=json.dumps(
                        [{"column": "発生日", "dir": "asc", "key": key}, {"column": "設備", "dir": "asc"}], ensure_ascii=False))
                    self.assertEqual(r["sorts"][0], {"column": "発生日", "dir": "asc", "key": key})
                    seen, prev, inner = set(), object(), []
                    for row in r["rows"]:
                        v = shown(row["発生日"])
                        if v != prev:
                            self.assertNotIn(v, seen, f"{key}: {v} が2か所に分かれた")
                            seen.add(v)
                            prev, inner = v, []
                        inner.append(order(row["設備"]))
                        self.assertEqual(inner, sorted(inner), f"{key}: {v} の中の設備が並んでいない")
