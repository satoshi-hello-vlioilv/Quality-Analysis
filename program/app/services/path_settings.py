# -*- coding: utf-8 -*-
"""参照先マスタ（アプリが読みに行く場所・その扱い）。

置き場は設備マスタ・ロールマスタと同じ MasterStore のマスタ `path_settings`（共有フォルダがあれば共有）。
1 台で直すと全員の PC に効き、書き込みの錠・行の版（ほかの PC と同時に直したとき）もほかのマスタと同じ。

  行: {id, 項目, 値, rev, updated_at, updated_by}   項目は下の ITEMS のキー（例 "lot_list.source"）
  値が空・行が無い項目は、配った設定ファイル（config/appsettings.json）の値を使う（＝既定）。

マスタの共有フォルダの場所（master_share.dir）だけはここに置かない。マスタそのものの置き場なので、
ここで変えるとこのマスタ自体が別の場所を見てしまう（設定ファイルで変える）。
"""
import copy
import os
import sqlite3
import time
from pathlib import Path

from ..brand import BRAND
from ..fsio import unquote_path

NAME = "path_settings"

ITEMS = [
    {"key": "lot_list.source", "label": "異常ロット一覧の元ファイル（品質データ）", "kind": "sqlite",
     "hint": "共有の .sqlite3 ファイル。WaveLog の品質データと同じファイルを指します（例: \\\\Nlmsrvngy03\\Read\\【New】仕掛\\台帳\\SIKADEF.sqlite3）。"
             "保存するとすぐ、このファイルを手元へ写し直して一覧に使います。"},
    {"key": "lot_list.table", "label": "異常ロット一覧の表", "kind": "text",
     "hint": "元ファイルの中の表の名前。空なら 仕掛 → 品質情報 → 品質 → 保留 の順に探します。"},
    {"key": "lot_list.refresh_seconds", "label": "元ファイルを確かめる間隔（秒）", "kind": "int", "min": 10, "max": 3600,
     "hint": "この間隔で元ファイルが変わったかを見て、変わったときだけ写し直します（10〜3600 秒）。"},
    {"key": "lot_list.stale_hours", "label": "元データが古いと警告するまで（時間）", "kind": "number", "min": 0, "max": 24 * 60,
     "hint": "元ファイルの最後の更新からこの時間を過ぎたら、一覧の上で警告します。0 にすると警告しません。土日に更新しない運用なら 72 など。"},
    {"key": "lotdsp_import.url", "label": "ロット問い合わせ（LotDsp）の URL", "kind": "url",
     "hint": "「検索」で読みに行く LotDsp の場所。社内（ログイン不要）ではこのアプリだけで読み、VPN でログインが要るときは"
             " LotDsp の窓が開きます（ログインはその窓で利用者が行う）。貼り付けで取り込むときの「LotDsp を開く」もここを開きます。"},
    {"key": "update.source", "label": "更新の置き場（新しい版を置くフォルダ）", "kind": "release",
     "check_url": "/__desktop/update/probe",
     "hint": f"版ごとのフォルダ（例 …\\90_Releases\\{BRAND['name']}\\3.2.0）に release.json と配る ZIP を置く、その上のフォルダ。"
             "下のフォルダをたどって、このアプリの版（release.json の目印）を探すので、アプリやフォルダの名前が変わっても構いません。"
             "BOX の権限で人ごとに見え方が違っても（上の階層が見えない人がいても）、この PC で見える場所を探し直します。"
             "「;」で区切って候補を複数書けます（%USERPROFILE% なども使えます）。空なら更新を確かめません。"},
    {"key": "lotdsp_import.direct.browser", "label": "LotDsp を裏で読むブラウザ（空なら Edge を自動で探す）", "kind": "exe",
     "hint": "このアプリだけで LotDsp を読むとき、画面に出さずに動かすブラウザの実行ファイル。ふつうは空のままで、"
             "Edge（C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe）を自動で使います。"},
]
BY_KEY = {i["key"]: i for i in ITEMS}


def _get(d, dotted):
    cur = d
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def default_of(settings, key):
    """配った設定（config/appsettings.json）でのその項目の値。"""
    return _get(settings, key)


def _set(d, dotted, value):
    parts = dotted.split(".")
    cur = d
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def parse(item, raw):
    """画面から来た字を、その項目の値へ（空は None＝既定へ戻す）。合わなければ ValueError（理由つき）。"""
    s = "" if raw is None else str(raw).strip()
    if s == "":
        return None
    kind = item["kind"]
    if kind in ("int", "number"):
        try:
            n = float(s)
        except ValueError:
            raise ValueError(f"「{item['label']}」は数で入れてください。") from None
        if kind == "int":
            if n != int(n):
                raise ValueError(f"「{item['label']}」は整数で入れてください。")
            n = int(n)
        lo, hi = item.get("min"), item.get("max")
        if (lo is not None and n < lo) or (hi is not None and n > hi):
            raise ValueError(f"「{item['label']}」は {lo}〜{hi} で入れてください。")
        return n
    if kind == "url" and not (s.startswith("http://") or s.startswith("https://")):
        raise ValueError(f"「{item['label']}」は http:// か https:// で始まる URL を入れてください。")
    if kind in ("sqlite", "exe"):
        s = unquote_path(s)
    if kind == "release":           # 候補を「;」で区切れる（それぞれの " を外す。探すのはデスクトップ版: desktop/src/release.rs）
        s = ";".join(x for x in (unquote_path(p.strip()) for p in s.replace("\n", ";").split(";")) if x)
    return s


def effective(settings, rows):
    """配った設定に、マスタで変えた値を重ねた設定（複製）と、項目ごとの答え。"""
    eff = copy.deepcopy(settings)
    by_key = {str(r.get("項目") or ""): r for r in rows or []}
    items = []
    for it in ITEMS:
        default = _get(settings, it["key"])
        row = by_key.get(it["key"])
        value = None
        if row is not None:
            try:
                value = parse(it, row.get("値"))
            except ValueError:
                value = None       # 壊れた値は使わない（既定で動く）
        if value is not None:
            _set(eff, it["key"], value)
        items.append({**it, "default": default, "value": value, "effective": value if value is not None else default,
                      "source": "master" if value is not None else "default",
                      "id": row.get("id") if row else None, "rev": row.get("rev") if row else None,
                      "updated_at": row.get("updated_at") if row else None, "updated_by": row.get("updated_by") if row else None})
    return eff, items


def check(item, value):
    """「確かめる」: その値で本当に読めるか（保存の前に）。-> {ok, message, detail}"""
    fn = _CHECKS.get(item["kind"])
    return fn(item, value) if fn else {"ok": True, "message": "値の形は正しいです。"}


def _check_sqlite(item, value):
    """ファイルに届くか・SQLite として開けるか・一覧に使う表と行数・ロット番号の列・最後の更新。"""
    p = unquote_path(value)
    if not p:
        return {"ok": False, "message": "ファイルの場所を入れてください。"}
    t0 = time.perf_counter()
    try:
        st = os.stat(p)
    except OSError as e:
        return {"ok": False, "message": f"ファイルに届きません（{getattr(e, 'strerror', None) or e}）。場所・名前・共有フォルダへの接続を確かめてください。"}
    from . import lot_list
    from .sqlite_ro import connect_ro, qi
    try:
        with connect_ro(Path(p), timeout=5) as c:
            names = lot_list.tables(c)
            t = lot_list.pick_table(names, "")
            n = c.execute(f"SELECT COUNT(*) FROM {qi(t)}").fetchone()[0] if t else 0
            cs = lot_list.columns(c, t) if t else []
    except (sqlite3.Error, RuntimeError, FileNotFoundError) as e:
        return {"ok": False, "message": f"SQLite のファイルとして開けません（{e}）。"}
    age_h = (time.time() - st.st_mtime) / 3600
    lot = lot_list.lot_column(cs)
    msg = (f"開けました。表 {len(names)} 個（一覧に使う表: {t or 'なし'}・{n:,}行）・"
           f"最後の更新 {time.strftime('%Y/%m/%d %H:%M', time.localtime(st.st_mtime))}（{age_h:.0f}時間前）・"
           f"{st.st_size / 1024 / 1024:.1f} MB・{(time.perf_counter() - t0) * 1000:.0f} ms")
    warn = []
    if not lot:
        warn.append("ロット番号の列が見つかりません（ロット番号・ﾛｯﾄ番号・ロット№・LTNO）。")
    if age_h > 36:
        warn.append("最後の更新が古いファイルです。名前の違う別のファイルではないか確かめてください。")
    return {"ok": bool(t) and bool(lot), "message": msg + ("" if not warn else " " + " ".join(warn)),
            "detail": {"tables": names, "table": t, "rows": n, "lotColumn": lot, "mtime": st.st_mtime}}


def _check_url(item, value):
    from .lotdsp_direct import reachable
    if item["key"] == "lotdsp_import.url":
        ok = reachable(str(value), 4)
        return {"ok": ok, "message": "LotDsp に届きました（ログインが要るかは「検索」で分かります）。" if ok
                else "LotDsp に届きません（社外・VPN 未接続・場所の間違い）。"}
    return {"ok": True, "message": "URL の形は正しいです（つながるかは LotDsp を開いて確かめてください）。"}


def _check_exe(item, value):
    from .lotdsp_direct import find_browser
    found = find_browser(str(value or ""))
    if found:
        return {"ok": True, "message": f"使えます: {found}" + ("" if value else "（自動で見つけた場所）")}
    return {"ok": False, "message": "そのファイルがありません。" if value else
            "Edge が見つかりません。msedge.exe の場所を入れてください。"}


_CHECKS = {"sqlite": _check_sqlite, "url": _check_url, "exe": _check_exe}
