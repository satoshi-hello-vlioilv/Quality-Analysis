# -*- coding: utf-8 -*-
"""異常ロット一覧の「正しい答え」を出す係（デスクトップ版の Rust との突き合わせ・desktop/tests/lotlist_parity.rs が呼ぶ）。

    python tests/lotlist_oracle.py 作業フォルダ [行数]

作業フォルダに試験用の品質データ（lotlist_fixture.make）を作り、問い合わせの組（lotlist_fixture.CASES）を
Python の lot_list.query（slicer の組は lot_list.slicer）で引いた答えを、標準出力に JSON で出す:
    {"db": DB の場所, "today": "YYYY-MM-DD", "cases": [...], "expected": [{"ok": 答え} | {"error": 理由}, ...]}
引数の渡し方は /api/lotlist（routes/lotlist.py）と同じ（ページ・件数は文字、group は "1" か）。毎回変わる timing は除く。
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import lot_list  # noqa: E402
from tests import lotlist_fixture  # noqa: E402


def args_of(case):
    """問い合わせの組 → 画面が送る問い合わせ文字の形（/api/lotlist の引数）。"""
    out = {}
    for k, v in case.items():
        out[k] = "1" if (k == "group" and v) else str(v)
    return out


def answer(db, case, today):
    a = args_of(case)
    if "slicer" in a:                    # スライサーに並べる値（/api/lotlist/slicer。列が無いときは 400 と理由）
        try:
            out = lot_list.slicer(db, column=a["slicer"], key=a.get("key", ""), table=a.get("table", ""), preferred_table="",
                                  search=a.get("search", ""), filters=a.get("filters", ""), today=today)
        except Exception as e:
            return {"error": str(e)}
        out.pop("timing", None)
        return {"ok": out}
    try:
        out = lot_list.query(db, table=a.get("table", ""), preferred_table="", page=a.get("page", 1),
                             page_size=a.get("page_size", 500), search=a.get("search", ""), filters=a.get("filters", ""),
                             sorts=a.get("sorts", ""), today=today, group=a.get("group") == "1")
    except Exception as e:               # /api/lotlist は 503 と理由を返す
        return {"error": str(e)}
    out.pop("timing", None)
    return {"ok": out}


def main():
    work = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 3000
    work.mkdir(parents=True, exist_ok=True)
    db = str(work / "lotlist_fixture.sqlite3")
    if not os.path.exists(db):
        lotlist_fixture.make(db, n)
    today = lotlist_fixture.TODAY
    cases = [args_of(c) for c in lotlist_fixture.CASES]
    expected = [answer(db, c, today) for c in lotlist_fixture.CASES]
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump({"db": db, "today": today.isoformat(), "cases": cases, "expected": expected}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
