# -*- coding: utf-8 -*-
"""LotDsp（ロット問い合わせ）の裏の API から、ログインなしでロットを読む（LotSearch と同じ道）。

経緯
    LotSearch（別リポジトリ）は、LotDsp の画面が裏で呼んでいる
    `POST {LotDsp}/service/lotdsp/search//searchAction`（JSON: {lotNo, kensaNo, nowPage}）を、
    Cookie もパスワードも付けずに呼んで基本情報（entity.staffCommonBean）を読んでいる。
    社内でも VPN でもログインなしで読めると報告があった。進度情報（設備の実績・設計）の表は、検索のあとに最初から
    選ばれているタブで、画面のひな形は staffProgressJBoxInfos（実績）・staffProgressBoxInfos（設計）を並べている
    ＝同じ検索の応答に入っていると見られる。ただし**応答の項目名（JSON のキー）は確かめられていない**
    （画面の class 名は列とずれている所がある: 前ｵﾌ・後ｵﾌ・長さ・肉厚）。

だから「学ぶ」
    項目名を決め打ちしない。画面（HTML: 見えない Edge・LotDsp の窓・貼り付け）でロットを読めたら、同じロットを
    API でも引き、画面の値と同じ値を持つキーを列ごとに探す（learn）。候補は読むたびに絞る（積み重ね）。
    取込に要る列がすべて1つのキーに決まったら「使える」（ready）になり、以後の検索は API が先に読む。
    決まるまでは今までの道のまま（API は使わない）。食い違う値が出たら、その列を決め直す（使えないに戻る）。
    取込に要る列の値は、画面から読んだときと同じ道（lotdsp_progress.build_lot）で工程にする。

約束
    - ログインはしない（ID・パスワード・Cookie を送らない。LotSearch と同じ）。社内のプロキシは通さない。
    - 学んだ対応はこの PC の作業場所（lotdsp_api_map.json）に置く。中身はキーの名前と、いつどのロット番号で学んだかだけ
      （寸法・重量などの値は置かない）。
"""
import json
import re
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime

from ..fsio import now_iso, write_json_atomic
from . import lotdsp_progress as lp

_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 社内のサイトはプロキシへ回すと届かない
_LOCK = threading.Lock()

# 基本情報（entity.staffCommonBean）の項目名は LotSearch の config.json（実際に読めている）から。学ぶときも確かめる
KNOWN_LOT_KEYS = {
    "lot_no": "ltno", "casting_no": "cyno", "inspection_no": "knno", "order_no": "juno",
    "material": "lta", "temper": "ltb", "product_thickness": "ltx", "product_width": "lty", "product_length": "ltz",
}
# 画面のひな形の class 名から見た「たぶんこのキー」。同点のときの目安にだけ使う（決め手は値の一致）
HINTS = {
    "actual": {"list": "staffProgressJBoxInfos", "equipment": "jbsm", "work_date": "jbedate", "thickness": "jbx",
               "width": "jby", "weight": "jbrw", "pieces": "jbrmh"},
    "design": {"list": "staffProgressBoxInfos", "equipment": "sbsm", "horizontal_split": "sbyky",
               "vertical_split": "sbtty", "pieces": "sbmh"},
}
# 取込に要る列（これがすべて決まるまで API は使わない）
REQUIRED = {
    "actual": ("equipment", "work_date", "thickness", "width", "weight", "off_front_m", "off_back_m"),
    "design": ("equipment", "horizontal_split", "vertical_split"),
    "lot": ("lot_no",),
}
LOT_COLUMNS = tuple(lp.DEFAULT_LOT_LABELS) + tuple(lp.DEFAULT_PRODUCT_COLUMNS)
# 値の手がかりがこの回数（行×ロット）そろうまでは、キーを1つに決めない（1回の偶然の一致で決めると、値が静かに間違う）。
# LotSearch が実際に読めている基本情報の項目（KNOWN_LOT_KEYS）だけは、最初から信頼する（trusted）
MIN_SEEN = 2
# 基本情報（ロットごとに1つの値）は、応答の中に同じ内容が複数の場所にあることがある（元データの bean と表示用の bean など）。
# どのロットでも同じ値（比重 2.73 など）だと、複数の場所が画面と一致し続けて見分けがつかない。そこで、これだけのロットで
# 一致し続けた複数の候補は、どれも画面と同じ値だった＝どれを読んでも同じ、として先頭の候補に決める（行の表の列では決めない）
TIE_SEEN = 3


class ApiError(Exception):
    """kind: disabled／not_ready（まだ学んでいない）／unreachable／timeout／http／invalid（JSON でない・形が違う）／
    business（LotDsp がエラーを返した）／not_found（該当なし）／mismatch（頼んだロットと違う）"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


# ------------------------------------------------------------------ 設定
def settings_of(lotdsp_import):
    li = lotdsp_import or {}
    a = li.get("api") or {}
    url = str(li.get("url") or "").strip()
    return {
        "enabled": bool(a.get("enabled", True)) and bool(url or a.get("search_url")),
        "search_url": str(a.get("search_url") or (url.rstrip("/") + "/service/lotdsp/search//searchAction" if url else "")),
        "timeout_seconds": float(a.get("timeout_seconds", 15)),
        "fields": dict({"lotNo": "lotNo", "inspectionNo": "kensaNo", "page": "nowPage"}, **(a.get("request_fields") or {})),
        "entity": str(a.get("entity_path", "entity")),
        "candidates": str(a.get("candidates_path", "searchKeyInfos")),
        "detail": str(a.get("detail_path", "staffCommonBean")),
    }


# ------------------------------------------------------------------ 問い合わせ
def get_path(data, path, default=None):
    cur = data
    for part in [p for p in str(path or "").split(".") if p]:
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def call(lot_no, cfg):
    """searchAction を1回呼ぶ → 応答（JSON の dict そのまま）。Cookie・パスワードは送らない。"""
    if not cfg["enabled"]:
        raise ApiError("disabled", "LotDsp の API を使わない設定です。")
    f = cfg["fields"]
    body = json.dumps({f["lotNo"]: lot_no, f["inspectionNo"]: "", f["page"]: 0}).encode("utf-8")
    req = urllib.request.Request(cfg["search_url"], data=body, method="POST", headers={
        "Accept": "application/json, text/plain, */*", "Content-Type": "application/json;charset=UTF-8"})
    try:
        with _LOCAL.open(req, timeout=cfg["timeout_seconds"]) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        raise ApiError("http", f"LotDsp の API が HTTP {e.code} を返しました。") from e
    except (TimeoutError, socket.timeout) as e:
        raise ApiError("timeout", f"LotDsp の API から {cfg['timeout_seconds']:g} 秒たっても応答がありません。") from e
    except (urllib.error.URLError, OSError) as e:
        raise ApiError("unreachable", f"LotDsp の API（{cfg['search_url']}）に届きません（社外・VPN 未接続・サイトの停止）。") from e
    try:
        result = json.loads(raw.decode("utf-8-sig"))
    except ValueError as e:
        raise ApiError("invalid", "LotDsp の API の応答を JSON として読めませんでした（ログインの画面が返った可能性があります）。") from e
    if not isinstance(result, dict):
        raise ApiError("invalid", "LotDsp の API の応答の形が想定と違います。")
    if result.get("status") == "ERROR":
        raise ApiError("business", "LotDsp の API がエラーを返しました: " + str(result.get("errorMessage") or "（理由なし）"))
    return result


def entity_of(result, cfg, lot_no):
    """応答 → 検索結果の本体（entity）。該当なしは ApiError(not_found)。"""
    entity = get_path(result, cfg["entity"], result)
    if not isinstance(entity, dict):
        raise ApiError("invalid", "LotDsp の API の応答に検索結果（entity）がありません。")
    hits = get_path(entity, cfg["candidates"], [])
    if not isinstance(hits, list) or not hits:
        raise ApiError("not_found", f"ロット問い合わせに {lot_no} が見つかりません（検索結果 0件）。")
    return entity


def search(lot_no, cfg):
    """searchAction を1回呼ぶ → entity（dict）。"""
    return entity_of(call(lot_no, cfg), cfg, lot_no)


# ------------------------------------------------------------------ 値の照らし合わせ
def _nfkc(v):
    return unicodedata.normalize("NFKC", str(v)).strip()


_NUM_TEXT = re.compile(r"^[+-]?[\d,]*\.?\d+$")


def informative(display):
    """画面の値が、キーを見分ける手がかりになるか（空・0 は多くのキーと一致してしまうので手がかりにしない）。"""
    d = _nfkc(display or "")
    if not d:
        return False
    return not (_NUM_TEXT.match(d) and float(d.replace(",", "")) == 0)


def moment(raw):
    """API の日時の値 → この PC の時刻の datetime（読めなければ None）。
    数なら 1970 年からの経過ミリ秒（13桁前後）か秒（10桁前後）、字なら ISO 形式（Z・+0900 などのずれつきもよい。ずれつきはこの PC の時刻へ）。"""
    try:
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            if raw >= 1e11:
                return datetime.fromtimestamp(raw / 1000)
            return datetime.fromtimestamp(raw) if raw >= 1e9 else None
        t = str(raw or "").strip().replace("Z", "+00:00").replace("/", "-")
        t = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", t)
        if not re.match(r"^\d{4}-\d{2}-\d{2}", t):
            return None
        dt = datetime.fromisoformat(t.replace(" ", "T", 1))
        return dt.astimezone().replace(tzinfo=None) if dt.tzinfo else dt
    except (ValueError, OverflowError, OSError):
        return None


def same(display, raw):
    """画面に出た字（display）と API の値（raw）が同じものか。画面は数を桁そろえ・日付を短く書くので、その違いは許す。
    画面が空なら None（手がかりなし）。"""
    d = _nfkc(display or "")
    if not d:
        return None
    if raw is None:
        return False
    r = _nfkc(raw)
    if d == r or d.replace(" ", "") == r.replace(" ", ""):
        return True
    if _NUM_TEXT.match(d):
        try:
            rv = float(str(raw).replace(",", "")) if not isinstance(raw, bool) else None
        except ValueError:
            return False
        if rv is None:
            return False
        dv = float(d.replace(",", ""))
        dec = len(d.split(".")[1]) if "." in d else 0
        return abs(dv - rv) <= 0.5 * 10 ** -dec + 1e-9
    dd, rd = re.sub(r"\D", "", d), re.sub(r"\D", "", r)
    if len(dd) >= 6 and re.search(r"[/:\-年]", d):          # 日付・時刻: 26/09/17 17:16:31 ↔ 2026-09-17T17:16:31 など
        if dd in rd:
            return True
        m = moment(raw)                                       # 経過ミリ秒・タイムゾーンつき（この PC の時刻にして比べる）
        return bool(m) and dd in m.strftime("%Y%m%d%H%M%S")
    return False


def leaves(entity, depth=3, prefix=""):
    """entity の中の値（並びの中は見ない）→ {道すじ: 値}。基本情報は staffCommonBean 以外の場所にあることもあるので全体から探す。"""
    out = {}
    if not isinstance(entity, dict) or depth < 0:
        return out
    for k, v in entity.items():
        path = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(leaves(v, depth - 1, path + "."))
        elif not isinstance(v, list):
            out[path] = v
    return out


def lists_in(entity, depth=2, prefix=""):
    """entity の中の「dict の並び」→ {場所: 並び}（2段まで）。"""
    out = {}
    if not isinstance(entity, dict) or depth < 0:
        return out
    for k, v in entity.items():
        path = f"{prefix}{k}"
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            out[path] = v
        elif isinstance(v, dict):
            out.update(lists_in(v, depth - 1, path + "."))
    return out


def align(items, rows):
    """並びの要素と画面の行（BOX の№）の対応 → {№: 要素}。要素に№のキーがあればそれで、無ければ並びの順（1 始まり）。"""
    nos = {r["no"] for r in rows}
    keys = set().union(*(x.keys() for x in items)) if items else set()
    for k in sorted(keys):
        vals = [x.get(k) for x in items]
        try:
            ints = [int(float(str(v))) for v in vals]
        except (TypeError, ValueError):
            continue
        if len(set(ints)) == len(ints) and nos <= set(ints) and not all(i == j + 1 for j, i in enumerate(ints)):
            return {i: x for i, x in zip(ints, items)}, k
    return {i + 1: x for i, x in enumerate(items)}, None


# ------------------------------------------------------------------ 学んだ対応（この PC）
class KeyMap:
    """{section: {"list": 場所, "box": №のキー, "cols": {列: {"cands": [キー…] | None, "seen": 手がかりの数}}}, "log": [...]}"""

    def __init__(self, path):
        self.path = path
        self.data = self._load()

    def _load(self):
        try:
            d = json.loads(self.path.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def save(self):
        write_json_atomic(self.path, self.data, indent=1, retry_budget=1.0)

    def section(self, name):
        return self.data.setdefault(name, {"list": None, "box": None, "cols": {}})

    def key(self, name, col):
        c = (self.data.get(name) or {}).get("cols", {}).get(col) or {}
        cands = c.get("cands")
        if not cands:
            return None
        if len(cands) > 1:
            return cands[0] if name == "lot" and c.get("seen", 0) >= TIE_SEEN else None
        return cands[0] if c.get("trusted") or c.get("seen", 0) >= MIN_SEEN else None

    def missing(self):
        """取込に要るのに、まだ1つのキーに決まっていない列 → [(section, 列)]。"""
        out = []
        for name, cols in REQUIRED.items():
            sec = self.data.get(name) or {}
            if name != "lot" and not sec.get("list"):
                out.append((name, "（並び）"))
                continue
            out += [(name, c) for c in cols if not self.key(name, c)]
        lot = (self.data.get("lot") or {}).get("cols", {})
        # 比重は、画面に値が出たことがあるなら要る（無い画面なら API でも既定の 2.7 になり、同じ）
        if (lot.get("density") or {}).get("seen") and not self.key("lot", "density"):
            out.append(("lot", "density"))
        return out

    def ready(self):
        return bool(self.data) and not self.missing()


def _narrow(col_state, consistent, informative_seen):
    """候補を絞る。手がかりが無ければそのまま。候補が尽きたら（食い違い）決め直し（None）。"""
    if not informative_seen:
        return col_state
    prev = col_state.get("cands")
    now = sorted(consistent) if prev is None else sorted(set(prev) & consistent)
    # 手がかりの数は「いまの候補を支えている回数」。食い違って候補が尽きたら、数え直す（古い一致を引きずって、
    # 決め直したあとの1回の一致で決めてしまわない）
    col_state["seen"] = (col_state.get("seen", 0) if prev is not None else 0) + informative_seen if now else 0
    col_state["cands"] = now or None
    if not now:
        col_state["conflict"] = now_iso()
    return col_state


def _learn_rows(km, name, entity, rows, columns):
    """工程の表（実績／設計）の対応を学ぶ。並びの場所は、列が多く一致するものを選ぶ（同点はひな形の名前）。"""
    if not rows:
        return
    best = None
    for path, items in lists_in(entity).items():
        by_no, box = align(items, rows)
        keys = set().union(*(x.keys() for x in items))
        score, per_col = 0, {}
        for col in columns:
            ok_keys, seen = set(keys), 0
            for r in rows:
                if not informative(r.get(col, "")):
                    continue
                item = by_no.get(r["no"])
                if item is None:
                    ok_keys = set()
                    break
                seen += 1
                ok_keys = {k for k in ok_keys if same(r.get(col, ""), item.get(k))}
            per_col[col] = (ok_keys, seen)
            if seen and ok_keys:
                score += 1
        hint = 1 if path.split(".")[-1] == HINTS.get(name, {}).get("list") else 0
        if per_col.get("equipment", (set(), 0))[0] and (best is None or (score, hint) > best[0]):
            best = ((score, hint), path, box, per_col)
    if best is None:
        return
    _, path, box, per_col = best
    sec = km.section(name)
    if sec.get("list") != path:                 # 並びが替わったら学び直し
        sec.update({"list": path, "box": box, "cols": {}})
    sec["box"] = box
    for col, (ok_keys, seen) in per_col.items():
        st = sec["cols"].setdefault(col, {"cands": None, "seen": 0})
        _narrow(st, ok_keys, seen)
        hint = HINTS.get(name, {}).get(col)
        # 取込に要らない列（分割の枚本など）だけ、値で見分けがつかないキーが残ったら、ひな形の名前を目安に採る。
        # 取込に要る列は決めない（ほかのロットで食い違うまで待つ。名前の目安で決めて値が静かに間違うことを避ける）
        if st.get("cands") and len(st["cands"]) > 1 and hint in st["cands"] and col not in REQUIRED.get(name, ()):
            st["cands"] = [hint]
            st["seen"] = max(st.get("seen", 0), MIN_SEEN)


def lot_path(cfg, key):
    """基本情報の項目の道すじ。以前の版は項目名だけ（staffCommonBean の中）で覚えていたので、道すじに直す。"""
    return key if "." in key else f"{cfg['detail']}.{key}"


def _learn_lot(km, entity, cfg, lot_fields):
    sec = km.section("lot")
    sec["list"] = "entity"
    found = leaves(entity)
    for col in LOT_COLUMNS:
        st = sec["cols"].setdefault(col, {"cands": [lot_path(cfg, KNOWN_LOT_KEYS[col])], "seen": 0, "trusted": True} if col in KNOWN_LOT_KEYS
                                    else {"cands": None, "seen": 0})
        if st.get("cands"):
            st["cands"] = [lot_path(cfg, c) for c in st["cands"]]
        v = lot_fields.get(col, "")
        if not informative(v):
            continue
        _narrow(st, {k for k, x in found.items() if same(v, x)}, 1)


def shape(v):
    """値の形だけ（数字→9・英字→a・かな漢字→あ・型の名前つき）。値そのものは残さない。決まらない列の原因を人が見分けるため。"""
    t = "".join("9" if c.isdigit() else "a" if c.isascii() and c.isalpha() else "あ" if not c.isascii() and c.isalpha() else c
                for c in str(v)[:40])
    return f"{type(v).__name__}:{t}"


def probe(km, entity, cfg, html_tables, actual_rows, design_rows):
    """まだ決まらない列ごとに、画面の値の形と、応答の候補の形を覚える（次に人が見て、何が違うかを知るため。値は置かない）。"""
    out = {}
    lot_fields = lp.lot_fields(html_tables, {})
    found = leaves(entity)
    for sec_name, col in km.missing():
        if col.startswith("（"):
            continue
        name = f"{sec_name}.{col}"
        st = ((km.data.get(sec_name) or {}).get("cols") or {}).get(col) or {}
        held = {"cands": st.get("cands"), "seen": st.get("seen", 0)}        # いま持っている候補と、それを支えている回数
        if sec_name == "lot":
            v = lot_fields.get(col, "")
            if informative(v):
                numeric = bool(_NUM_TEXT.match(_nfkc(v)))
                api_shapes = {k: shape(x) for k, x in found.items()
                              if not numeric or (isinstance(x, (int, float)) and not isinstance(x, bool))}
                out[name] = {"screen": shape(v), **held, "api": dict(list(api_shapes.items())[:80])}
            else:
                out[name] = {"screen": "（画面の値がまだ空）", **held}
            continue
        rows = actual_rows if sec_name == "actual" else design_rows
        hit = next((r for r in rows if informative(r.get(col, ""))), None)
        if hit is None:
            out[name] = {"screen": "（画面の値がまだ空）", **held}
            continue
        path = (km.data.get(sec_name) or {}).get("list")
        items = get_path(entity, path, []) if path else []
        by_no, _ = align(items, rows) if isinstance(items, list) and items else ({}, None)
        item = by_no.get(hit["no"]) or {}
        out[name] = {"screen": shape(hit[col]), **held, "api": {k: shape(x) for k, x in item.items()}}
    km.data["probe"] = out


def learn(km, entity, cfg, html_tables, actual_rows, design_rows, lot_no):
    """画面で読めたロットと、同じロットの API の応答を照らし合わせて、対応を学ぶ（候補を絞る）。"""
    _learn_rows(km, "actual", entity, actual_rows, tuple(lp.DEFAULT_ACTUAL_COLUMNS)[1:])
    _learn_rows(km, "design", entity, design_rows, tuple(lp.DEFAULT_DESIGN_COLUMNS)[1:])
    _learn_lot(km, entity, cfg, lp.lot_fields(html_tables, {}))
    probe(km, entity, cfg, html_tables, actual_rows, design_rows)
    km.data.setdefault("log", []).append({"at": now_iso(), "lot": lot_no, "ready": km.ready(),
                                          "missing": [f"{s}.{c}" for s, c in km.missing()]})
    km.data["log"] = km.data["log"][-20:]
    km.data["login_free"] = {"at": now_iso(), "lot": lot_no}   # ログインなしで、このロットの応答が返った（確かめた記録）


def learn_from_html(km, cfg, html, lot_no, read_cfg=None):
    """画面（HTML）で読めたあと: 同じロットを API で引いて学ぶ。失敗は記録だけして投げない（取込は済んでいる）。"""
    try:
        tables, actual_rows, design_rows = lp.progress_tables(html, read_cfg)
        entity = search(lot_no, cfg)
        with _LOCK:
            learn(km, entity, cfg, tables, actual_rows, design_rows, lot_no)
            km.save()
        return None
    except ApiError as e:
        with _LOCK:
            km.data["last_error"] = {"at": now_iso(), "lot": lot_no, "kind": e.kind, "message": str(e)}
            km.save()
        return e
    except Exception as e:                       # 学べなくても取込は済んでいる
        with _LOCK:
            km.data["last_error"] = {"at": now_iso(), "lot": lot_no, "kind": "learn", "message": str(e)}
            km.save()
        return e


def learn_later(km, cfg, html, lot_no, read_cfg=None):
    """learn_from_html を裏で（取込の応答を待たせない）。"""
    if not cfg["enabled"] or not lot_no:
        return None
    t = threading.Thread(target=learn_from_html, args=(km, cfg, html, lot_no, read_cfg), daemon=True)
    t.start()
    return t


# ------------------------------------------------------------------ API で読む
def _date_text(raw):
    """日付・時刻を画面と同じ書き方（YY/MM/DD hh:mm:ss）に。読めない形はそのまま。"""
    m = moment(raw)
    if m:
        return m.strftime("%y/%m/%d %H:%M:%S")
    d = re.sub(r"\D", "", str(raw or ""))
    if len(d) == 14:
        return f"{d[2:4]}/{d[4:6]}/{d[6:8]} {d[8:10]}:{d[10:12]}:{d[12:14]}"
    if len(d) == 8:
        return f"{d[2:4]}/{d[4:6]}/{d[6:8]}"
    return str(raw or "").strip()


def _rows(km, name, entity, columns):
    sec = km.data.get(name) or {}
    items = get_path(entity, sec.get("list"), None) if sec.get("list") else None
    if not isinstance(items, list):
        return []
    box = sec.get("box")
    out = []
    for i, x in enumerate(items):
        try:
            no = int(float(str(x.get(box)))) if box else i + 1
        except (TypeError, ValueError):
            continue
        row = {"no": no}
        for col in columns:
            k = km.key(name, col)
            if k is None:
                continue
            v = x.get(k)
            row[col] = "" if v is None else (_date_text(v) if col == "work_date" else str(v).strip())
        equipment = row.get("equipment", "")
        row["equipment"] = equipment
        if not equipment and not any(lp.to_number(row.get(k)) for k in ("thickness", "width", "weight")):
            continue
        out.append(row)
    return out


def read_lot(km, cfg, lot_no, equipment_master, read_cfg=None):
    """API でロットを読む → (Lot, report)。学び終わっていなければ ApiError(not_ready)。"""
    if not km.ready():
        miss = "、".join(f"{s}.{c}" for s, c in km.missing()[:6])
        raise ApiError("not_ready", f"LotDsp の API の項目名をまだ学び終えていません（{miss}）。")
    t0 = time.perf_counter()
    entity = search(lot_no, cfg)
    actual = _rows(km, "actual", entity, tuple(lp.DEFAULT_ACTUAL_COLUMNS)[1:])
    design = _rows(km, "design", entity, tuple(lp.DEFAULT_DESIGN_COLUMNS)[1:])
    if not actual:
        raise ApiError("invalid", "LotDsp の API の応答に、学んだ場所の実績の並びがありません（応答の形が変わった可能性）。")
    fields = {}
    for col in LOT_COLUMNS:
        k = km.key("lot", col)
        v = get_path(entity, lot_path(cfg, k)) if k is not None else None
        if v is not None:
            fields[col] = str(v).strip()
    try:
        lot = lp.check_lot(fields, lot_no)
    except ValueError as e:
        raise ApiError("mismatch", str(e)) from e
    data, report = lp.build_lot(lot, actual, design, equipment_master, read_cfg, source="LotDsp API（ログインなし）")
    report["seconds"] = round(time.perf_counter() - t0, 2)
    return lp.to_models(data, report, lot_no)


# ------------------------------------------------------------------ 応答の全項目の調査
def _survey_walk(node, path, stats, arrays):
    """応答の中を全部たどり、項目（道すじ）ごとに型・空でない件数・形を集める。並びは `道すじ[]` として、要素の項目を合わせて数える。"""
    if isinstance(node, dict):
        for k, v in node.items():
            _survey_walk(v, f"{path}.{k}" if path else str(k), stats, arrays)
    elif isinstance(node, list):
        arrays[path] = max(arrays.get(path, 0), len(node))
        for item in node:
            if isinstance(item, (dict, list)):
                _survey_walk(item, path + "[]", stats, arrays)
            else:
                _survey_leaf(item, path + "[]", stats)
    else:
        _survey_leaf(node, path, stats)


def _survey_leaf(v, path, stats):
    st = stats.setdefault(path, {"types": set(), "of": 0, "nonnull": 0, "shape": None, "value": None})
    st["of"] += 1
    st["types"].add(type(v).__name__)
    if v is not None and v != "":
        st["nonnull"] += 1
        if st["shape"] is None:
            st["shape"], st["value"] = shape(v), v


def used_paths(km, cfg):
    """このアプリが使っている応答の項目 → 用途（学んだ対応から）。道すじは応答全体からの道すじ（学んだものは検索結果の本体 entity の中からの相対）。"""
    head = (cfg["entity"] + ".") if cfg.get("entity") else ""
    used = {}
    for sec_name in ("lot", "actual", "design"):
        sec = km.data.get(sec_name) or {}
        base = sec.get("list")
        for col in (sec.get("cols") or {}):
            k = km.key(sec_name, col)
            if k is None:
                continue
            path = head + (k if sec_name == "lot" else f"{base}[].{k}")
            used.setdefault(path, []).append(f"{sec_name}.{col}")
    return used


def survey(result, km, cfg, values=False):
    """LotDsp の API の応答に入っている項目をすべて一覧にする（調査用。何も覚えず、何も書き換えない）。

    fields: 道すじ・型・形・空でない件数（of 件中）・アプリが使っている用途（used_for）。値は values=True のときだけ。
    形は数字→9・英字→a（shape）。実際の製造・検査・受注データは外へ出さない決まりなので、既定は形だけ。"""
    stats, arrays = {}, {}
    _survey_walk(result, "", stats, arrays)
    used = used_paths(km, cfg)
    fields = []
    for path, st in stats.items():
        row = {"path": path, "type": "/".join(sorted(st["types"])), "shape": st["shape"], "nonnull": st["nonnull"], "of": st["of"],
               "used_for": used.get(path)}
        if values and st["nonnull"]:
            row["value"] = str(st["value"])[:80]
        fields.append(row)
    return {
        "values_included": bool(values),
        "note": ("値を含みます。この PC の画面で見るだけにしてください（実際の製造・検査・受注データは外部へ渡さない）。" if values
                 else "形だけです（数字→9・英字→a）。値は含みません。"),
        "summary": {"fields": len(fields), "non_empty": sum(1 for f in fields if f["nonnull"]),
                    "used_by_app": sum(1 for f in fields if f["used_for"]),
                    "arrays": [{"path": p, "length": n} for p, n in arrays.items()]},
        "unused_non_empty": [f["path"] for f in fields if f["nonnull"] and not f["used_for"]],
        "fields": fields,
    }


def status(km, cfg):
    """画面に出す状態: 使えるか・学び終えていない列・最後に確かめた時刻。"""
    return {
        "enabled": cfg["enabled"],
        "ready": km.ready(),
        "missing": [f"{s}.{c}" for s, c in km.missing()],
        "login_free": km.data.get("login_free"),
        "last_error": km.data.get("last_error"),
        "probe": km.data.get("probe") or {},       # まだ決まらない列: 画面の値の形と応答の候補の形（値は含まない）
        "learned": sum(1 for s in ("actual", "design", "lot") for c in (km.data.get(s) or {}).get("cols", {}) if km.key(s, c)),
    }
