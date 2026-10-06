# -*- coding: utf-8 -*-
"""SQLite を読み取り専用で開く（WaveLog の backend/sqlite_io.py と同じ作法）。

- 開く前に stat しない。共有越しでは「開けるのに stat だけ失敗する」ことがあり、
  確認のつもりの1行が唯一の失敗原因になる。開けなかったときだけ理由を切り分ける。
- UNC（\\\\server\\share\\…）は 4 スラッシュの file:////server/share/… にする
  （2 スラッシュだと server を URI の authority と読まれ、標準の sqlite3 は拒否する）。
- WaveLog の SQL と同じ方言で書けるよう、Access 風の CStr / Val / Nz を登録する（ほかに ToDate・SortKey）。
- `with connect_ro(...) as c:` を抜けたら閉じる（標準の sqlite3 は with で閉じないので、閉じるのが
  ガベージコレクション任せになり、Windows では写しの古い世代を消せないことがある）。
"""
import datetime as _dt
import re
import sqlite3
from pathlib import Path
from urllib.parse import quote


def qi(name):
    """識別子を [ ] で括る（WaveLog と同じ）。"""
    return "[" + str(name).replace("]", "]]") + "]"


def _cstr(v):
    return "" if v is None else str(v)


def _val(v):
    m = re.match(r"^\s*[+-]?\d+(\.\d+)?", str(v or ""))
    return float(m.group(0)) if m else 0.0


def _nz(v, default):
    return default if v is None else v


_NUM_CHARS = frozenset("0123456789.eE+-")


def sort_key(v):
    """並べ替えの鍵（SQL では SortKey(列)）。一覧の「並び・まとめ」で同じ値と見る物を、並べ替えでも隣へ寄せる:
    空欄（NULL・空白だけ）は NULL、数と数に読める字（' 54'・'1e-05'）は数、ほかは前後の空白を除いた字。
    画面（lotlist.js の sortKey）とデスクトップ版（desktop/src/lotlist.rs の sort_key）も同じ見分け。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = _cstr(v).strip()
    if not s:
        return None
    if set(s) <= _NUM_CHARS and any(ch.isdigit() for ch in s):
        try:
            return float(s)
        except ValueError:
            pass
    return s


_DATE_PATTERNS = (
    # 2026/09/28 10:00・2026-9-5・2026.09.28・2026-09-28T10:00
    re.compile(r"^\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ T].*)?$"),
    # 2026年9月28日
    re.compile(r"^\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日.*$"),
    # 20260928（8桁）
    re.compile(r"^\s*(\d{4})(\d{2})(\d{2})(?:\s.*)?$"),
    # 26/09/28 23:48:54（LotDsp などの2桁の年＝2000年代）
    re.compile(r"^\s*(\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ T].*)?$"),
)


def to_date(v):
    """値を日付として読めれば 'YYYY-MM-DD'、読めなければ None（SQL では ToDate(列)）。"""
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    for rx in _DATE_PATTERNS:
        m = rx.match(s)
        if m:
            y, mo, d = (int(x) for x in m.groups())
            if y < 100:
                y += 2000
            try:
                return _dt.date(y, mo, d).isoformat()
            except ValueError:
                return None
    return None


def numeric_value(v):
    """Val(?) 相当。SQLite は型優先で比べるので、パラメータ側も数にして渡す。"""
    return _val(v)


def ro_uri(path):
    p = Path(path)
    target = p if p.is_absolute() else p.resolve()
    posix = target.as_posix()
    if posix.startswith("//"):
        return "file://" + quote(posix) + "?mode=ro"
    return target.as_uri() + "?mode=ro"


class _ClosingConnection(sqlite3.Connection):
    """with を抜けたら閉じる接続（読み取り専用なので、確定・取り消しは要らない）。"""

    def __exit__(self, *exc):
        self.close()
        return False


def connect_ro(path, timeout=10):
    try:
        c = sqlite3.connect(ro_uri(path), uri=True, timeout=timeout, factory=_ClosingConnection)
    except sqlite3.Error as e:
        try:
            found = Path(path).exists()
        except OSError:
            found = None
        if found is False:
            raise FileNotFoundError(f"データベースが見つかりません: {path}") from e
        raise RuntimeError(f"データベースを開けませんでした: {path}（SQLite: {e}）") from e
    c.create_function("CStr", 1, _cstr)
    c.create_function("Val", 1, _val)
    c.create_function("Nz", 2, _nz)
    c.create_function("ToDate", 1, to_date, deterministic=True)
    c.create_function("SortKey", 1, sort_key, deterministic=True)
    return c
