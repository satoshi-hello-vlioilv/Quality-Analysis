# -*- coding: utf-8 -*-
"""異常ロット一覧の速さを測る（Python）。desktop/examples/lotbench.rs（Rust）と同じ問い合わせ・同じ回数（各 5 回の中央値・JSON にするまで）。

    python tests/lotlist_bench.py 品質データ.sqlite3
"""
import json
import statistics
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import lot_list  # noqa: E402

CASES = [
    ("1ページ目（500行）", {}),
    ("検索「汚れ」（全列）", {"search": "汚れ"}),
    ("条件2つ（等しい・90日以内）", {"filters": json.dumps([{"column": "不良名", "op": "eq", "value": "汚れ"},
                                                    {"column": "発生日", "op": "within_days", "value": "90"}], ensure_ascii=False)}),
    ("並べ替え", {"sorts": json.dumps([{"column": "重量", "dir": "desc"}], ensure_ascii=False)}),
    ("ロット番号でまとめる＋並べ替え", {"group": True, "sorts": json.dumps([{"column": "重量", "dir": "desc"}], ensure_ascii=False)}),
    ("数で絞る", {"filters": json.dumps([{"column": "重量", "op": "gte", "value": "3000"}], ensure_ascii=False)}),
    ("0件（日付の手がかり）", {"filters": json.dumps([{"column": "発生日", "op": "within_days", "value": "0"},
                                              {"column": "設備", "op": "eq", "value": "無い"}], ensure_ascii=False)}),
]


def main():
    db, today = sys.argv[1], date(2026, 10, 2)
    for name, kw in CASES:
        lot_list.query(db, today=today, **kw)
        ms = []
        for _ in range(5):
            t = time.perf_counter()
            json.dumps(lot_list.query(db, today=today, **kw), ensure_ascii=True, sort_keys=True)
            ms.append((time.perf_counter() - t) * 1000)
        print(f"{name}\t{statistics.median(ms):.0f}")


if __name__ == "__main__":
    main()
