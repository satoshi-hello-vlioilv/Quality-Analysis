# -*- coding: utf-8 -*-
"""異常ロット一覧の試験用の品質データ（SQLite）と、問い合わせの組。

乱数の種を固定して、毎回同じ中身を作る。本物に近い「ゆれ」を入れる:
日本語・半角カナ・全角英数・空欄と NULL・いろいろな日付の書き方（2桁の年・和文・8桁・ISO・時刻つき・読めない字）・
数と数の字・同じロット番号の複数行（まとめ）・ロット番号が空の行・ビュー（行番号が無い）・WITHOUT ROWID の表。

Python の試験（test_lot_list.py）と、デスクトップ版の Rust との突き合わせ（desktop/tests/lotlist_parity.rs が
lotlist_oracle.py を通して使う）が同じものを使う。

    python tests/lotlist_fixture.py 出力.sqlite3 [行数]
"""
import json
import random
import sqlite3
import sys
from datetime import date, timedelta

TODAY = date(2026, 10, 2)      # 「〜日以内」の基準日（問い合わせに today として渡す）
EQUIPMENT = ["L-1", "L-2", "TLV", "LS3", "DL2", "CR1", "ＣＲ２", "ﾛｰﾙ1"]
DEFECTS = ["汚れ", "キズ", "ロール跡", "異物", "ﾍｺﾐ", "打痕", "", None]
COLUMNS = ["ロット番号", "発生日", "設備", "不良名", "重量", "板厚", "板幅", "合金", "調質", "客先", "検査日", "入力日時",
           "数量", "備考", "工程", "担当", "長さ", "比重", "鋳造番号", "検査番号"]


def _date_text(d, kind):
    return [d.strftime("%Y/%m/%d"), d.isoformat() + " 10:00", d.strftime("%Y%m%d"), d.strftime("%y/%m/%d 23:48:54"),
            f"{d.year}年{d.month}月{d.day}日", "", None, "不明", f"{d.year}.{d.month}.{d.day}"][kind]


def make(path, n=3000, extra_columns=20, seed=7):
    """n 行 ×（20＋extra_columns）列の表「仕掛」と、ビュー「仕掛_ビュー」・WITHOUT ROWID の表「保留」を作る。"""
    r = random.Random(seed)
    cols = COLUMNS + [f"項目{i:02d}" for i in range(1, extra_columns + 1)]
    c = sqlite3.connect(path)
    c.executescript("DROP VIEW IF EXISTS 仕掛_ビュー; DROP TABLE IF EXISTS 仕掛; DROP TABLE IF EXISTS 保留;")
    c.execute("CREATE TABLE 仕掛 (" + ",".join(f"[{x}]" for x in cols) + ")")
    rows, lot = [], 0
    for _ in range(n):
        if r.random() < 0.6:
            lot += 1                                # 4 割の行は前の行と同じロット
        d = TODAY - timedelta(days=r.randint(0, 900))
        lot_no = f"L{lot:04d}C{lot % 10}"
        if r.random() < 0.02:
            lot_no = r.choice(["", None, " " + lot_no.lower() + " "])   # 空・NULL・大小と前後の空白（まとめでは同じロット）
        row = [lot_no, _date_text(d, r.choices(range(9), [55, 10, 10, 10, 5, 2, 2, 1, 5])[0]), r.choice(EQUIPMENT), r.choice(DEFECTS),
               round(r.uniform(500, 6000), 1), r.choice(["0.300", "0.5", "1", "2.73", "1e-05", "abc"]), r.randint(800, 1600),
               r.choice(["A1100", "A5052", "A3004"]), r.choice(["H14", "O", "H24"]), r.choice(["客先A", "客先Ｂ", "ｷｬｸｻｷC", None]),
               _date_text(d + timedelta(days=1), 0), d.isoformat() + "T08:15:00", str(r.randint(1, 99)),
               r.choice(["", "要確認", "再検査 済", None, "100%", "a]b"]), r.choice(["圧延", "焼鈍", "スリット"]), r.choice(["担当1", "担当2"]),
               r.uniform(10, 9000), r.choice([2.73, 2.7, 1e16, 1.0, 0.1 + 0.2, -0.0, 12345678901234567, 3]),
               f"J{r.randint(10, 99)}G{r.randint(10, 99)}A", f"N{r.randint(100000, 999999)}"]
        row += [r.choice([None, "", str(r.randint(0, 999)), f"文字{r.randint(0, 99)}", r.random(), r.randint(-5, 5), b"\x00\x01"])
                for _ in range(extra_columns)]
        rows.append(row)
    c.executemany("INSERT INTO 仕掛 VALUES (" + ",".join("?" * len(cols)) + ")", rows)
    c.execute("CREATE VIEW 仕掛_ビュー AS SELECT * FROM 仕掛")
    c.execute("CREATE TABLE 保留 ([ロット番号] TEXT PRIMARY KEY, [発生日], [重量]) WITHOUT ROWID")
    c.executemany("INSERT INTO 保留 VALUES (?,?,?)", [(f"H{i:03d}", _date_text(TODAY - timedelta(days=i), i % 9), i * 1.5) for i in range(60)])
    c.commit()
    c.close()
    return cols


def _f(*items):
    return json.dumps([{"column": c, "op": o, "value": v} for c, o, v in items], ensure_ascii=False)


def _in(column, values, key=None, raw=None):
    """スライサーの絞り込み（in）1 つ。values は値の並び（raw を渡せば、その字をそのまま value に）。"""
    f = {"column": column, "op": "in", "value": raw if raw is not None else json.dumps(values, ensure_ascii=False)}
    if key is not None:
        f["key"] = key
    return f


def _fl(*filters):
    return json.dumps(list(filters), ensure_ascii=False)


def _s(*items):
    return json.dumps([{"column": c, "dir": d} for c, d in items], ensure_ascii=False)


# 問い合わせの組（lot_list.query の引数）。画面が送る形のまま（filters・sorts は JSON の文字）
CASES = [
    {},
    {"page": 3},
    {"page": 999},
    {"page_size": 50, "page": 2},
    {"search": "汚れ"},
    {"search": "ｷｬｸｻｷ"},
    {"search": "2.73"},
    {"search": "%"},
    {"search": "a]b"},
    {"filters": _f(("不良名", "eq", "汚れ"), ("発生日", "within_days", "90"))},
    {"filters": _f(("不良名", "contains", "ロール"))},
    {"filters": _f(("不良名", "not_contains", "汚"))},
    {"filters": _f(("設備", "neq", "L-1"))},
    {"filters": _f(("設備", "starts_any", "L-,ＣＲ"))},
    {"filters": _f(("設備", "starts_any", ""))},
    {"filters": _f(("ロット番号", "ends", "C3"))},
    {"filters": _f(("客先", "empty", ""))},
    {"filters": _f(("客先", "not_empty", ""))},
    {"filters": _f(("重量", "gte", "3000"), ("板厚", "lt", "1"))},
    {"filters": _f(("板厚", "gt", "abc"))},
    {"filters": _f(("発生日", "within_weeks", "3"))},
    {"filters": _f(("発生日", "within_months", "13"))},
    {"filters": _f(("発生日", "within_years", "1"))},
    {"filters": _f(("発生日", "within_days", "x"))},
    {"filters": _f(("無い列", "eq", "x"), ("設備", "bad_op", "x"))},
    {"filters": "壊れた JSON"},
    {"sorts": _s(("重量", "desc"), ("発生日", "asc"))},
    {"sorts": json.dumps(["設備", {"column": "設備", "dir": "desc"}, {"column": "無い列"}, {"column": "比重", "dir": "DESC"}], ensure_ascii=False)},
    {"group": True},
    {"group": True, "page": 4},
    {"group": True, "sorts": _s(("重量", "desc"))},
    {"group": True, "sorts": _s(("設備", "asc"), ("発生日", "desc")), "page": 2, "page_size": 100},
    {"group": True, "search": "汚れ", "filters": _f(("発生日", "within_months", "6"))},
    {"group": True, "page_size": 7, "page": 5},
    {"filters": _f(("発生日", "within_days", "0"), ("設備", "eq", "無い"))},
    {"filters": _f(("発生日", "within_days", "0"), ("入力日時", "within_years", "0"))},
    {"filters": _f(("発生日", "within_days", "0"), ("不良名", "eq", "無い"), ("入力日時", "within_weeks", "1"))},
    {"table": "仕掛_ビュー", "group": True, "sorts": _s(("重量", "desc"))},
    {"table": "保留", "group": True},
    {"table": "保留"},
    {"table": "無い表"},
    # Rust へ移すときに足した: N が小数（切り捨て）・指数で書く小数（1e+16）を字で探す・全角の数字で数を比べる
    {"filters": _f(("発生日", "within_weeks", "2.9"))},
    {"search": "e+16"},
    {"filters": _f(("重量", "lt", "　１０００"))},
    # 並び・まとめ（版 3.12.0）: 並べ替えは SortKey（空欄をまとめ・数に読める字は数・前後の空白を除く・ロット番号は大小を同じに）
    {"sorts": _s(("数量", "asc"), ("備考", "desc"), ("客先", "asc"))},
    {"sorts": _s(("板厚", "desc"), ("比重", "asc"))},
    {"sorts": _s(("ロット番号", "desc"), ("不良名", "asc"))},
    {"group": True, "sorts": _s(("ロット番号", "asc"), ("備考", "asc"), ("数量", "desc"))},
    {"group": True, "sorts": _s(("不良名", "asc"), ("ロット番号", "desc")), "page": 2, "page_size": 120},
    # 見せ方に合わせた鍵（版 3.13.0）: 日付だけ・年月・年・丸めた数。分からない鍵はそのままの値
    {"sorts": json.dumps([{"column": "発生日", "dir": "asc", "key": "date"}, {"column": "設備", "dir": "asc"}], ensure_ascii=False)},
    {"sorts": json.dumps([{"column": "発生日", "dir": "desc", "key": "month"}, {"column": "不良名", "dir": "asc"},
                          {"column": "入力日時", "dir": "asc", "key": "YEAR"}], ensure_ascii=False)},
    {"sorts": json.dumps([{"column": "比重", "dir": "asc", "key": "round:0"}, {"column": "長さ", "dir": "desc", "key": "Round:12"},
                          {"column": "重量", "dir": "asc", "key": "round:x"}, {"column": "板厚", "dir": "asc", "key": 3}], ensure_ascii=False)},
    {"group": True, "page": 2, "page_size": 90,
     "sorts": json.dumps([{"column": "ロット番号", "dir": "asc"}, {"column": "検査日", "dir": "desc", "key": "date"}], ensure_ascii=False)},
    # スライサー（版 3.15.0）: 選んだ値のどれか（in）。空欄も選べる。見せ方の鍵（日付だけ・年月・年）があれば見えている値で比べる
    {"filters": _fl(_in("設備", ["CR1", "L-1"]))},
    {"filters": _fl(_in("客先", ["", "客先A"]), _in("不良名", ["キズ", "汚れ", "無い値"]))},
    {"filters": _fl(_in("発生日", ["2025-03", "2024-12", ""], key="month"))},
    {"filters": _fl(_in("発生日", ["2025"], key="YEAR"), _in("入力日時", ["2025-09-17"], key="date"))},
    {"filters": _fl(_in("重量", ["5828", "1"], key="round:0"))},
    {"filters": _fl(_in("設備", [], raw="[]"))},
    {"filters": _fl(_in("設備", [], raw="壊れた"))},
    {"filters": _fl(_in("設備", [], raw='[1, "CR1", null]'))},
    {"group": True, "filters": _fl(_in("設備", ["DL2"])), "sorts": _s(("重量", "desc"))},
    # スライサーに並べる値（slicer）: 列の重複なしの値・ほかの絞り込みのもとでの件数・空欄は最後・1000 を超えたら truncated
    {"slicer": "設備"},
    {"slicer": "客先"},
    {"slicer": "発生日", "key": "date"},
    {"slicer": "入力日時", "key": "month"},
    {"slicer": "発生日", "key": "round:2"},
    {"slicer": "不良名", "search": "客先", "filters": _fl(_in("設備", ["CR1", ""]), {"column": "重量", "op": "gte", "value": "3000"})},
    {"slicer": "重量"},
    {"slicer": "設備", "table": "保留"},
    {"slicer": "無い列"},
]


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "lotlist_fixture.sqlite3"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    print(out, n, len(make(out, n)))
