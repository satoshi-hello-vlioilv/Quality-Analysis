# -*- coding: utf-8 -*-
"""ロット一覧（品質データ SQLite の写し）を引く。

絞り込み・並べ替え・ページの組み立ては WaveLog の /api/table（backend/routes/tables.py）と同じ:
    search  … どの列の字でも LIKE（列ごとに OR）
    filters … [{column, op, value}] を AND（最大 20 件）。op は WaveLog と同じ 12 種＋starts_any
    sorts   … [{column, dir}]（最大 4 キー）。実在する列だけを通す
    page / page_size … LIMIT / OFFSET
    group   … ロット番号でまとめる（grouped_rows）。並べ替えは効いたまま、ページの境目でロットを切らない
列名は実在するものだけを SQL へ入れ（qi で括る）、値はすべてパラメータで渡す。
"""
import json
import os
import re
import sqlite3
import time
from datetime import date, datetime, timedelta

from .sqlite_ro import connect_ro, numeric_value, qi, to_date

ALLOWED_OPS = {"contains", "not_contains", "eq", "neq", "starts", "starts_any", "ends",
               "gt", "gte", "lt", "lte", "empty", "not_empty",
               # 今日から数えて N 日（週・か月・年）以内。日付と読める値だけが当たる（ToDate(列) >= 今日−N）
               "within_days", "within_weeks", "within_months", "within_years"}
RELATIVE_OPS = {"within_days": "days", "within_weeks": "weeks", "within_months": "months", "within_years": "years"}
DATE_SAMPLE = 60          # 日付の列か見分けるときに読む値の数
DATE_RATIO = 0.8          # そのうち日付と読める割合がこれ以上なら日付の列
MAX_FILTERS = 20
MAX_SORTS = 4
PAGE_SIZE_MAX = 5000
PAGE_SIZE_DEFAULT = 500
# 表の既定（WaveLog の品質データの「既定テーブル」＝仕掛、品質情報の読み方の候補）
TABLE_CANDIDATES = ["仕掛", "品質情報", "品質", "保留"]
LOT_COLUMN_CANDIDATES = ["ロット番号", "ﾛｯﾄ番号", "ロット№", "LTNO"]


def tables(conn):
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') "
                        "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    return [r[0] for r in rows]


def pick_table(names, preferred="", candidates=TABLE_CANDIDATES):
    """設定の表 → 候補の完全一致 → 候補を含む名前 → 最初の表。"""
    if preferred and preferred in names:
        return preferred
    for c in candidates:
        if c in names:
            return c
    for c in candidates:
        for n in names:
            if c in n:
                return n
    return names[0] if names else ""


def raw_columns(conn, table):
    """表の列名を表の並びのまま（同じ名前が2つあってもそのまま。行の値と位置を合わせるため）。"""
    return [r[1] for r in conn.execute(f"PRAGMA table_info({qi(table)})").fetchall()]


def columns(conn, table, raw=None):
    """列名を1つずつ（行は dict なので同名を2つ持てない）。raw があれば表を読み直さない。"""
    return list(dict.fromkeys(raw if raw is not None else raw_columns(conn, table)))


def lot_column(cs, candidates=LOT_COLUMN_CANDIDATES):
    for c in candidates:
        if c in cs:
            return c
    for c in cs:
        if "ロット" in c or "ﾛｯﾄ" in c:
            return c
    return ""


def safe_filters(text, cs):
    if not text:
        return []
    try:
        items = json.loads(text) if isinstance(text, str) else text
    except ValueError:
        return []
    if not isinstance(items, list):
        return []
    out = []
    for it in items[:MAX_FILTERS]:
        if not isinstance(it, dict):
            continue
        col = str(it.get("column") or "").strip()
        op = str(it.get("op") or "contains").strip()
        val = str(it.get("value") or "").strip()
        if col in cs and op in ALLOWED_OPS:
            out.append({"column": col, "op": op, "value": val})
    return out


def cutoff_date(op, value, today=None):
    """「今日から N 単位前」の日付（'YYYY-MM-DD'）。N は 0 以上の整数（0＝今日から）。"""
    today = today or date.today()
    try:
        n = max(0, int(float(str(value).strip())))
    except ValueError:
        n = 0
    unit = RELATIVE_OPS[op]
    if unit == "days":
        d = today - timedelta(days=n)
    elif unit == "weeks":
        d = today - timedelta(weeks=n)
    else:
        months = n * (12 if unit == "years" else 1)
        y, m = divmod(today.year * 12 + today.month - 1 - months, 12)
        m += 1
        last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
        d = date(y, m, min(today.day, last))
    return d.isoformat()


def date_columns(conn, table, cs):
    """値の大半（8 割以上）が日付と読める列。空欄は数えない。"""
    out = []
    for col in cs:
        vals = [r[0] for r in conn.execute(
            f"SELECT {qi(col)} FROM {qi(table)} WHERE {qi(col)} IS NOT NULL AND CStr({qi(col)})<>'' LIMIT {DATE_SAMPLE}")]
        if vals and sum(1 for v in vals if to_date(v)) / len(vals) >= DATE_RATIO:
            out.append(col)
    return out


_DATE_CACHE = {}


def _date_columns_cached(path, conn, table, cs):
    """写しは世代ごとに別のファイルなので、(ファイル, 更新時刻, 表, 列) が同じなら前の答えを使う。"""
    try:
        st = os.stat(path)
        key = (str(path), st.st_mtime_ns, table, tuple(cs))
    except OSError:
        return date_columns(conn, table, cs)
    if key not in _DATE_CACHE:
        if len(_DATE_CACHE) > 32:
            _DATE_CACHE.clear()
        _DATE_CACHE[key] = date_columns(conn, table, cs)
    return _DATE_CACHE[key]


def date_hints(conn, table, filters, today=None):
    """0件のとき、「以内」の条件ごとに、なぜ当たらないかを言うための材料（表全体・ほかの条件は外して数える）。

    dated        … その列で日付と読めた行の数
    newest/raw   … いちばん新しい日付（読んだ日付と元の値。和暦の2桁の年などの読み違いがここで分かる）
    oldest       … いちばん古い日付
    cutoff       … この日付から後ろを探した（今日−N）
    alone        … この条件だけなら何件当たるか（0 でなければ、ほかの条件と重なって 0 件になっている）
    """
    out = []
    for f in filters:
        if f["op"] not in RELATIVE_OPS:
            continue
        col = qi(f["column"])
        cut = cutoff_date(f["op"], f["value"], today)
        dated, newest, oldest = conn.execute(
            f"SELECT COUNT(*), MAX(ToDate({col})), MIN(ToDate({col})) FROM {qi(table)} WHERE ToDate({col}) IS NOT NULL").fetchone()
        raw = None
        if newest:
            r = conn.execute(f"SELECT {col} FROM {qi(table)} WHERE ToDate({col}) = ? LIMIT 1", (newest,)).fetchone()
            raw = None if r is None else _json_value(r[0])
        alone = conn.execute(f"SELECT COUNT(*) FROM {qi(table)} WHERE ToDate({col}) >= ?", (cut,)).fetchone()[0]
        total = conn.execute(f"SELECT COUNT(*) FROM {qi(table)} WHERE {col} IS NOT NULL AND CStr({col})<>''").fetchone()[0]
        out.append({"column": f["column"], "op": f["op"], "value": f["value"], "cutoff": cut, "dated": int(dated or 0),
                    "filled": int(total or 0), "newest": newest, "newestRaw": raw, "oldest": oldest, "alone": int(alone or 0)})
    return out


def build_filter_where(filters, today=None):
    parts, params = [], []
    for f in filters:
        col, op, value = qi(f["column"]), f["op"], f["value"]
        if op == "contains":
            parts.append(f"CStr({col}) LIKE ?")
            params.append(f"%{value}%")
        elif op == "not_contains":
            parts.append(f"(CStr({col}) NOT LIKE ? OR {col} IS NULL)")
            params.append(f"%{value}%")
        elif op == "eq":
            parts.append(f"CStr({col})=?")
            params.append(value)
        elif op == "neq":
            parts.append(f"(CStr({col})<>? OR {col} IS NULL)")
            params.append(value)
        elif op == "starts":
            parts.append(f"CStr({col}) LIKE ?")
            params.append(f"{value}%")
        elif op == "starts_any":
            vals = [x for x in (value.split(",") if value else []) if x][:60]
            if not vals:
                parts.append("0=1")
            else:
                parts.append("(" + " OR ".join(f"CStr({col}) LIKE ?" for _ in vals) + ")")
                params += [f"{v}%" for v in vals]
        elif op == "ends":
            parts.append(f"CStr({col}) LIKE ?")
            params.append(f"%{value}")
        elif op == "empty":
            parts.append(f"({col} IS NULL OR CStr({col})='')")
        elif op == "not_empty":
            parts.append(f"({col} IS NOT NULL AND CStr({col})<>'')")
        elif op in RELATIVE_OPS:
            parts.append(f"ToDate({col}) >= ?")
            params.append(cutoff_date(op, value, today))
        elif op in ("gt", "gte", "lt", "lte"):
            sign = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            parts.append(f"Val(CStr({col})) {sign} ?")
            params.append(numeric_value(value))
    return parts, params


SORT_KEYS = ("date", "month", "year")      # 並べ替えの鍵の形（画面の書式に合わせる。round:N は小数 N 桁で丸めた数）


def sort_key_kind(v):
    """並べ替えの鍵の形（画面が列の書式から決める）。日付だけ・年月・年・丸めた数。分からなければ ''（そのままの値）。"""
    k = str(v or "").strip().lower()
    if k in SORT_KEYS:
        return k
    m = re.fullmatch(r"round:([0-9]{1,2})", k)
    return f"round:{min(int(m.group(1)), 10)}" if m else ""


def safe_sorts(text, cs):
    """並べ替え → [(列, ASC|DESC, 鍵の形)]。実在する列だけ・同じ列は最初の1つ・最大4つ。"""
    try:
        items = json.loads(text) if isinstance(text, str) and text else (text or [])
    except ValueError:
        items = []
    out = []
    for it in (items if isinstance(items, list) else []):
        if isinstance(it, str):
            it = {"column": it}
        if not isinstance(it, dict):
            continue
        col = str(it.get("column") or "").strip()
        if col not in cs or any(col == c for c, _, _ in out):
            continue
        out.append((col, "DESC" if str(it.get("dir") or "").lower() == "desc" else "ASC", sort_key_kind(it.get("key"))))
        if len(out) >= MAX_SORTS:
            break
    return out


def order_key(col, lot="", key=""):
    """並べ替えに使う式（「並び・まとめ」の見分けと同じ鍵。→ 式の並び）。
    - ふだん: SortKey(列)（空欄は1つ・数に読める字は数・前後の空白を除く）。ロット番号の列は大小を同じに見る
    - 画面がその列を日付だけ（date）・年月（month）・年（year）で見せているとき: ToDate(列) の頭。時刻が違っても同じ日は隣り合う。
      日付と読めない値はその後ろで SortKey（読めた値には効かない＝下の段の並びを崩さない）
    - 小数 N 桁で見せているとき（round:N）: 数は丸めた値、数でない値は SortKey"""
    q = qi(col)
    if key in SORT_KEYS:
        head = {"date": f"ToDate({q})", "month": f"SUBSTR(ToDate({q}), 1, 7)", "year": f"SUBSTR(ToDate({q}), 1, 4)"}[key]
        return [head, f"CASE WHEN ToDate({q}) IS NULL THEN SortKey({q}) END"]
    if key.startswith("round:"):
        n = int(key[6:])
        return [f"CASE WHEN typeof(SortKey({q})) IN ('integer', 'real') THEN ROUND(SortKey({q}), {n}) ELSE SortKey({q}) END"]
    return [f"SortKey(UPPER(CStr({q})))" if col == lot else f"SortKey({q})"]


def order_sql(order_parts, lot):
    """[(列, 向き[, 鍵の形])] → ORDER BY の後ろ（無ければ ''）。"""
    out = []
    for part in order_parts:
        col, d, key = (tuple(part) + ("",))[:3]
        out += [f"{x} {d}" for x in order_key(col, lot, key)]
    return ",".join(out)


def lot_key(col):
    """まとめるときのロットの見分け方（大小・前後の空白は同じロット）。"""
    return f"UPPER(TRIM(CStr({qi(col)})))"


ROWID_NAMES = ("rowid", "_rowid_", "oid")    # SQLite の行番号の呼び名（同じ名前の列があると、その列を指す）


def rowid_name(c, t, raw_cs):
    """行番号を読める呼び名。ビュー（行番号が NULL）・WITHOUT ROWID の表・3つとも列の名前に使われている表は None。"""
    kind = c.execute("SELECT type FROM sqlite_master WHERE name = ?", (t,)).fetchone()
    if not kind or kind[0] != "table":
        return None
    for name in ROWID_NAMES:
        if name.lower() in (x.lower() for x in raw_cs):
            continue
        try:
            c.execute(f"SELECT {name} FROM {qi(t)} LIMIT 0")
            return name
        except sqlite3.Error:
            return None
    return None


def grouped_rows(c, t, raw_cs, lot, where, params, order_parts, page, size):
    """ロット番号でまとめた並びの1ページ分。→ (行, [[そのロットの行数, ロットの中の何行目], ...], 最初の位置, 最後の位置)

    - ロットの順は、並べ替え（無ければ表の順）で「そのロットでいちばん上に来る行」の順。ロットの中も同じ並べ替えの順。
      こうすると並べ替えは、ロットの間でも中でも効いたままになる。
    - ロットは、その先頭の行が入るページに丸ごと入る（ページの境目で切らない。そのぶん1ページが size を少し超える）。
      大きいロットが次の区切りをまたいで、先頭の行が1つも入らない区切りができたら、その区切りは飛ばす（空のページを作らない）。
    - ロット番号が空の行はまとめない（1行ずつ）。
    - 並びは「行番号・並べ替えの順・ロットの見分け」だけで決め、そのページの行だけを後から読む（全部の列を窓関数の段ごとに
      持ち回さない。3 万行 × 40 列で 1.6 秒 → 0.25 秒・答えは同じ）。行番号を読めない表（ビューなど）は全部の列で決める。"""
    if sqlite3.sqlite_version_info < (3, 25):     # 窓関数（ROW_NUMBER など）は SQLite 3.25 から
        raise RuntimeError(f"この PC の SQLite（{sqlite3.sqlite_version}）では「ロット番号でまとめる」を使えません。"
                           "「表の見せ方」の「機能」でまとめるを外してください。")
    got = c.execute(grouped_sql(t, raw_cs, lot, where, order_parts, size, rowid_name(c, t, raw_cs)), list(params) + [page]).fetchall()
    n = len(raw_cs)
    rows = [r[:n] for r in got]
    groups = [[int(r[n]), int(r[n + 1])] for r in got]
    return rows, groups, (int(got[0][n + 2]) if got else 0), (int(got[-1][n + 2]) if got else 0)


def grouped_sql(t, raw_cs, lot, where, order_parts, size, rid=None):
    """まとめた並びの SQL（デスクトップ版の Rust・desktop/src/lotlist.rs も同じ文を作る）。最後の ? はページ。"""
    over = ("ORDER BY " + order_sql(order_parts, lot)) if order_parts else ""
    cols = ", ".join(qi(x) for x in raw_cs)
    steps = """
        k AS (SELECT *, CASE WHEN _tpa_k0 = '' THEN '#' || _tpa_rn ELSE _tpa_k0 END AS _tpa_k FROM b),
        g AS (SELECT *, MIN(_tpa_rn) OVER (PARTITION BY _tpa_k) AS _tpa_first, COUNT(*) OVER (PARTITION BY _tpa_k) AS _tpa_n FROM k),
        p AS (SELECT *, ROW_NUMBER() OVER (ORDER BY _tpa_first, _tpa_rn) AS _tpa_pos FROM g),
        q AS (SELECT *, MIN(_tpa_pos) OVER (PARTITION BY _tpa_k) AS _tpa_head FROM p),"""
    page = f"r AS (SELECT *, DENSE_RANK() OVER (ORDER BY (_tpa_head - 1) / {int(size)}) AS _tpa_page FROM q)"
    if rid:
        tail = ", ".join(f"{qi(t)}.{qi(x)}" for x in raw_cs)
        return (f"WITH b AS (SELECT {rid} AS _tpa_id, ROW_NUMBER() OVER ({over}) AS _tpa_rn, {lot_key(lot)} AS _tpa_k0 FROM {qi(t)}{where}),"
                f"{steps} {page} SELECT {tail}, r._tpa_n, r._tpa_pos - r._tpa_head + 1, r._tpa_pos FROM r "
                f"JOIN {qi(t)} ON {qi(t)}.{rid} = r._tpa_id WHERE r._tpa_page = ? ORDER BY r._tpa_pos")
    return (f"WITH b AS (SELECT *, ROW_NUMBER() OVER ({over}) AS _tpa_rn, {lot_key(lot)} AS _tpa_k0 FROM {qi(t)}{where}),"
            f"{steps} {page} SELECT {cols}, _tpa_n, _tpa_pos - _tpa_head + 1, _tpa_pos FROM r WHERE _tpa_page = ? ORDER BY _tpa_pos")


def group_count(c, t, lot, where, params):
    """まとめたときのロットの数（ロット番号が空の行は1行ずつ数える）。"""
    return int(c.execute(f"SELECT COUNT(DISTINCT NULLIF(k, '')) + COALESCE(SUM(k = ''), 0) FROM "
                         f"(SELECT {lot_key(lot)} AS k FROM {qi(t)}{where})", params).fetchone()[0])


def _json_value(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat(sep=" ") if isinstance(v, datetime) else v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"（バイナリ {len(bytes(v))} バイト）"
    return v


def query(path, *, table="", preferred_table="", page=1, page_size=PAGE_SIZE_DEFAULT, search="",
          filters="", sorts="", today=None, group=False):
    t0 = time.perf_counter()
    page = max(1, int(page or 1))
    size = min(PAGE_SIZE_MAX, max(1, int(page_size or PAGE_SIZE_DEFAULT)))
    q = (search or "").strip()
    with connect_ro(path) as c:
        names = tables(c)
        t = table if table in names else pick_table(names, preferred_table)
        if not t:
            raise RuntimeError("品質データにテーブルが1つもありません。")
        raw_cs = raw_columns(c, t)
        cs = columns(c, t, raw_cs)
        where_parts, params = [], []
        if q:
            where_parts.append("(" + " OR ".join(f"CStr({qi(x)}) LIKE ?" for x in cs) + ")")
            params += [f"%{q}%"] * len(cs)
        fl = safe_filters(filters, cs)
        fp, fpp = build_filter_where(fl, today)
        where_parts += fp
        params += fpp
        where = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""
        lot = lot_column(cs)
        order_parts = safe_sorts(sorts, cs)
        order = (" ORDER BY " + order_sql(order_parts, lot)) if order_parts else ""
        count = int(c.execute(f"SELECT COUNT(*) FROM {qi(t)}" + where, params).fetchone()[0])
        start = (page - 1) * size
        grouped = {}
        if group and lot:
            rows, groups, first, last = grouped_rows(c, t, raw_cs, lot, where, params, order_parts, page, size)
            grouped = {"groups": groups, "groupCount": group_count(c, t, lot, where, params)}
        else:
            rows = c.execute(f"SELECT * FROM {qi(t)}" + where + order + f" LIMIT {size} OFFSET {start}", params).fetchall()
            first, last = (start + 1, start + len(rows)) if rows else (0, 0)
        dcols = _date_columns_cached(path, c, t, cs)
        hints = date_hints(c, t, fl, today) if count == 0 else []
    return {
        "table": t, "tables": names, "columns": cs, "lotColumn": lot, "dateColumns": dcols,
        "today": (today or date.today()).isoformat(), "dateHints": hints,
        "rows": [{col: _json_value(v) for col, v in zip(raw_cs, r)} for r in rows],
        "count": count, "page": page, "page_size": size, "range": [first, last], **grouped,
        "filters_applied": len(fl), "sorts": [{"column": col, "dir": d.lower(), **({"key": k} if k else {})} for col, d, k in order_parts],
        "timing": {"server": round((time.perf_counter() - t0) * 1000)},
    }
