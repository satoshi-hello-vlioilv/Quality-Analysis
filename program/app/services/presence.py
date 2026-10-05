# -*- coding: utf-8 -*-
"""利用状況（だれが・どの PC で・どの版を使っているか）。WaveLog backend/presence.py を移したもの。

置き場: マスタの共有フォルダの下の `presence_tpa/`（共有が無ければこの PC の中だけ）。WaveLog の presence とは分ける。
    <key>.json          … いま使っている（心拍で at を更新。TTL を過ぎたら使っていない）
    <key>.revoke.json   … 管理する人が書いた切断の指示（REVOKE_COOLDOWN のあいだ効く）
    history/<key>.json  … 使った記録の要約（初めて・最後・回数・使った時間・版の移り変わり）
    sessions/<key>/<年-月>.json … 使用の履歴（起動ごとに 始め・終わり・使った時間・版・権限区分。版 3.3.0）
    settings.json       … 履歴を残す日数（管理する人が書く。無ければ DEFAULT_HISTORY_DAYS）
    key = 「PC名@ログインID」（ファイル名に使えない字は _、変えたら sha1 の頭を付ける）
**1つのファイルを書くのはその PC だけ**（ほかの PC とぶつからない）。書くときは一時ファイル → 置き換え。
読めないファイルは「無い」ではなく「読めない」（消さない）。

「最新版」は、使っている人たち（開発者を除く）の版のうちいちばん新しいもの（version.version_key で数で比べる）。
"""
import hashlib
import json
import re
import shutil
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from ..fsio import now_iso, write_json_atomic
from ..version import APP_VERSION, version_key

TTL_SEC = 75                 # 心拍がこれより古ければ「使っていない」
WRITE_INTERVAL_SEC = 20      # いまの状態を書く間隔（心拍は 3 秒ごとでも書くのはこの間隔）
HISTORY_WRITE_SEC = 60
REVOKE_COOLDOWN_SEC = 300    # 切断の指示が効く長さ
SWEEP_INTERVAL_SEC = 300
NEWEST_INTERVAL_SEC = 300
HISTORY_VERSIONS = 10
REVOKE_SUFFIX = ".revoke.json"
LATEST_EXCLUDED_ROLES = ("開発者",)   # 開発者の PC は試しの版を使うので「最新版」に数えない
SESSIONS_DIR = "sessions"
SETTINGS_FILE = "settings.json"
DEFAULT_HISTORY_DAYS = 365           # 使用の履歴を残す日数（管理する人が 30〜3650 日で変えられる）
HISTORY_DAYS_RANGE = (30, 3650)

_lock = threading.Lock()
_state = {"dir": None, "last_write": 0.0, "last_history": 0.0, "last_sweep": 0.0, "since": None,
          "session_key": None, "newest": None, "newest_at": 0.0, "busy": False, "left": False,
          "session_start": None, "session_sec": 0, "role": ""}


def _now():
    return datetime.now()


def configure(dir_path):
    with _lock:
        _state["dir"] = Path(dir_path) if dir_path else None


def presence_dir():
    return _state["dir"]


def terminal_key(login, pc):
    raw = f"{pc or '?'}@{login or '?'}"
    safe = re.sub(r'[\\/:*?"<>|\s]', "_", raw)[:100]
    if safe != raw:
        safe += "-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]
    return safe


def _age_sec(data):
    try:
        return (datetime.now() - datetime.fromisoformat(str(data.get("at")))).total_seconds()
    except Exception:
        return None


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except Exception:
        return {"_unreadable": True}


def _write_json(path, data):
    # 置き場の親（共有フォルダ・この PC の作業フォルダ）が無ければ書かない（共有の置き場そのものは作らない）
    root = presence_dir()
    if root is None or not root.parent.exists():
        return False
    try:
        write_json_atomic(path, data, indent=1, retry_budget=1.0)
        return True
    except OSError:
        return False


def _hist_path(key):
    return presence_dir() / "history" / f"{key}.json"


def _revoke_path(key):
    return presence_dir() / f"{key}{REVOKE_SUFFIX}"


# ------------------------------------------------------------------ 書く（この PC の分だけ）
def _record(key, login, pc, now, final=False, role=None):
    """使った記録を足す（要約と使用の履歴）。新しい使い始めは、key が変わった・前から TTL より空いたとき。"""
    if role is not None:
        _state["role"] = role
    path = _hist_path(key)
    h = _read_json(path)
    if not h or h.get("_unreadable"):
        h = {"key": key, "login": login, "pc": pc, "firstAt": now, "sessions": 0, "totalSec": 0, "versions": {}}
    last = h.get("lastAt")
    gap = None
    try:
        gap = (datetime.fromisoformat(now) - datetime.fromisoformat(last)).total_seconds() if last else None
    except Exception:
        gap = None
    new_session = _state["session_key"] != key or gap is None or gap > TTL_SEC
    if new_session:
        h["sessions"] = int(h.get("sessions") or 0) + 1
        h["sessionAt"] = now
        _state["session_key"] = key
    elif gap:
        h["totalSec"] = int(h.get("totalSec") or 0) + int(min(gap, TTL_SEC))
    h.update(login=login, pc=pc, lastAt=now, version=APP_VERSION)
    vers = dict(h.get("versions") or {})
    vers[APP_VERSION] = now
    h["versions"] = dict(sorted(vers.items(), key=lambda kv: kv[1])[-HISTORY_VERSIONS:])
    write = final or new_session or time.time() - _state["last_history"] >= HISTORY_WRITE_SEC
    _log_session(key, login, pc, now, new_session, gap, write)
    if write:
        _write_json(path, h)
        _state["last_history"] = time.time()


# ------------------------------------------------------------------ 使用の履歴（起動ごと。その PC だけが書く）
def _session_file(key, start):
    return presence_dir() / SESSIONS_DIR / key / f"{str(start)[:7]}.json"


def _log_session(key, login, pc, now, new, gap, write):
    """いまの使い始めの行を足す・伸ばす（始め・終わり・使った時間・版・権限区分）。終わりは最後に書いた心拍の時刻
    （落ちた・電源が切れたときも、そこで終わったことにする）。使った時間は心拍の間（TTL まで）を足したもの。"""
    if new or not _state["session_start"]:
        _state["session_start"], _state["session_sec"] = now, 0
    elif gap:
        _state["session_sec"] += int(min(gap, TTL_SEC))
    if not write:
        return
    start = _state["session_start"]
    path = _session_file(key, start)
    doc = _read_json(path)
    if not doc or doc.get("_unreadable"):
        doc = {"key": key, "login": login, "pc": pc, "sessions": []}
    rows = doc.setdefault("sessions", [])
    row = next((r for r in reversed(rows) if r.get("start") == start), None)
    if row is None:
        row = {"start": start}
        rows.append(row)
    row.update(end=now, sec=_state["session_sec"], version=APP_VERSION, role=_state["role"] or row.get("role", ""))
    doc.update(login=login, pc=pc)
    _write_json(path, doc)
    if new:
        _prune_own(key, now)


def _month_after(month):
    """"2026-09" → その次の月の初め（datetime）。読めなければ None。"""
    try:
        y, m = (int(x) for x in month.split("-"))
    except ValueError:
        return None
    return datetime(y + (m == 12), m % 12 + 1, 1)


def _cutoff(now=None):
    return (now or _now()) - timedelta(days=history_days())


def _prune_own(key, now):
    """この PC の履歴のうち、残す日数より古いものを消す（月ごとのファイルごと・月の中の古い行）。"""
    try:
        cutoff = _cutoff(datetime.fromisoformat(now))
    except ValueError:
        return
    d = presence_dir() / SESSIONS_DIR / key
    for p in d.glob("*.json") if d.exists() else []:
        nxt = _month_after(p.stem)
        if nxt is None:
            continue
        if nxt <= cutoff:
            p.unlink(missing_ok=True)
        elif p.stem == f"{cutoff:%Y-%m}":
            doc = _read_json(p)
            if doc and not doc.get("_unreadable"):
                keep = [r for r in doc.get("sessions", []) if str(r.get("end") or r.get("start") or "") >= cutoff.isoformat(timespec="seconds")]
                if len(keep) != len(doc.get("sessions", [])):
                    doc["sessions"] = keep
                    _write_json(p, doc)


def load_settings():
    data = _read_json(presence_dir() / SETTINGS_FILE) if presence_dir() else None
    return data if data and not data.get("_unreadable") else {}


def history_days():
    lo, hi = HISTORY_DAYS_RANGE
    try:
        return min(hi, max(lo, int(load_settings().get("historyDays") or DEFAULT_HISTORY_DAYS)))
    except (TypeError, ValueError):
        return DEFAULT_HISTORY_DAYS


def parse_history_days(value):
    """画面から来た日数 → 整数。合わなければ ValueError（理由つき）。"""
    lo, hi = HISTORY_DAYS_RANGE
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        raise ValueError("日数は整数で入れてください。") from None
    if not lo <= n <= hi:
        raise ValueError(f"日数は {lo}〜{hi} で入れてください。")
    return n


def save_settings(values, by="", by_pc=""):
    """履歴を残す日数などを書く（権限の判定はルートの access.role_can で）。"""
    return _write_json(presence_dir() / SETTINGS_FILE, {**load_settings(), **values, "by": by, "byPc": by_pc, "at": now_iso()})


def prune_all(now=None):
    """管理する人の「古い記録を整理」: どの PC の履歴も、残す日数より古い月のファイルを消す。
    いま書かれている月（各 PC が書く）は消さない（残す日数は 30 日以上なので、古い月だけを消せば足りる）。→ {files, sessions}"""
    cutoff, files, rows = _cutoff(now), 0, 0
    root = presence_dir() / SESSIONS_DIR if presence_dir() else None
    for d in root.iterdir() if root and root.exists() else []:
        if not d.is_dir():
            continue
        for p in d.glob("*.json"):
            nxt = _month_after(p.stem)
            if nxt is not None and nxt <= cutoff:
                doc = _read_json(p) or {}
                rows += len(doc.get("sessions", []) or [])
                p.unlink(missing_ok=True)
                files += 1
        if not any(d.iterdir()):
            d.rmdir()
    return {"files": files, "sessions": rows, "cutoff": cutoff.isoformat(timespec="seconds")}


def sessions(key=None, limit=300):
    """使用の履歴（新しい順）。版が前の使い始めから変わったものには changedFrom。いま使っている行には live。
    新しい月から読み、limit を超えたらそこまで（共有フォルダを読み過ぎない）。→ {items, more}"""
    root = presence_dir() / SESSIONS_DIR if presence_dir() else None
    if not root or not root.exists():
        return {"items": [], "more": False}
    dirs = [root / key] if key else [d for d in root.iterdir() if d.is_dir()]
    files = sorted(((p.stem, p) for d in dirs if d.exists() for p in d.glob("*.json")), key=lambda x: x[0], reverse=True)
    rows, month = [], None
    for m, p in files:
        if month and m != month and len(rows) > limit:
            break
        month = m
        doc = _read_json(p)
        if not doc or doc.get("_unreadable"):
            continue
        for r in doc.get("sessions", []) or []:
            rows.append({**r, "key": doc.get("key") or p.parent.name, "login": doc.get("login", ""), "pc": doc.get("pc", "")})
    rows.sort(key=lambda r: str(r.get("start") or ""))
    prev = {}
    for r in rows:                                  # 古い順に見て、同じ PC の前の使い始めと版を比べる
        before = prev.get(r["key"])
        if before and before != r.get("version"):
            r["changedFrom"] = before
        prev[r["key"]] = r.get("version")
    online = {o["key"] for o in _online()}
    last = {}
    for r in rows:
        last[r["key"]] = r
    for k, r in last.items():
        r["live"] = k in online
    rows.reverse()
    return {"items": rows[:limit], "more": len(rows) > limit}


def touch(login, pc, role, force=False):
    """いま使っていることを書く（WRITE_INTERVAL ごと）。記録・掃除・最新版の数え直しもここで。"""
    if presence_dir() is None:
        return False
    t = time.time()
    if not force and t - _state["last_write"] < WRITE_INTERVAL_SEC:
        return False
    key = terminal_key(login, pc)
    now = now_iso()
    if _state["since"] is None or _state["session_key"] != key:
        _state["since"] = now
    ok = _write_json(presence_dir() / f"{key}.json", {"key": key, "login": login, "pc": pc, "role": role,
                                                       "version": APP_VERSION, "since": _state["since"], "at": now})
    _state["last_write"] = t
    _state["left"] = False
    _record(key, login, pc, now, role=role)
    if t - _state["last_sweep"] >= SWEEP_INTERVAL_SEC:
        _sweep()
        _state["last_sweep"] = t
    return ok


def touch_async(login, pc, role, roles_of=None):
    """心拍から呼ぶ。書くのは裏の1本の糸（共有が遅くても心拍を待たせない）。書いている最中の頼みは捨てる。"""
    if presence_dir() is None or time.time() - _state["last_write"] < WRITE_INTERVAL_SEC:
        return
    with _lock:
        if _state["busy"]:
            return
        _state["busy"] = True

    def run():
        try:
            touch(login, pc, role)
            if roles_of and time.time() - _state["newest_at"] >= NEWEST_INTERVAL_SEC:
                refresh_newest(roles_of)
        except Exception:
            pass
        finally:
            _state["busy"] = False
    threading.Thread(target=run, name="presence", daemon=True).start()


def leave(login, pc):
    """使い終わり（アプリの終了）。いまのファイルを消し、記録を最後まで書く。"""
    if presence_dir() is None or _state["left"]:
        return
    key = terminal_key(login, pc)
    try:
        _record(key, login, pc, now_iso(), final=True)
        (presence_dir() / f"{key}.json").unlink(missing_ok=True)
    except OSError:
        pass
    _state["left"] = True


def _pc_files(d):
    """置き場の直下の、PC ごとのファイル（いま使っている・切断の指示）。保存日数のファイル（settings.json）は PC ではない。"""
    return [p for p in d.glob("*.json") if p.name != SETTINGS_FILE]


def _sweep():
    """古い「いま使っている」（TTL の4倍）と切断の指示（冷却の4倍）を消す。読めないものは消さない。記録・設定は消さない。"""
    d = presence_dir()
    try:
        for p in _pc_files(d):
            data = _read_json(p)
            if not data or data.get("_unreadable"):
                continue
            limit = REVOKE_COOLDOWN_SEC if p.name.endswith(REVOKE_SUFFIX) else TTL_SEC
            age = _age_sec(data)
            if age is not None and age > limit * 4:
                p.unlink(missing_ok=True)
    except OSError:
        pass


# ------------------------------------------------------------------ 読む
def _online():
    d = presence_dir()
    out = []
    if d is None or not d.exists():
        return out
    for p in _pc_files(d):
        if p.name.endswith(REVOKE_SUFFIX):
            continue
        data = _read_json(p)
        if not data or data.get("_unreadable"):
            continue
        age = _age_sec(data)
        if age is not None and age <= TTL_SEC:
            out.append(dict(data, idleSec=int(age)))
    return out


def _history():
    d = presence_dir()
    out = []
    if d is None or not (d / "history").exists():
        return out
    for p in (d / "history").glob("*.json"):
        data = _read_json(p)
        if data and not data.get("_unreadable"):
            out.append(data)
    return out


# 配る版（版 3.4.0）: デスクトップ版の窓（desktop/src/update.rs）が、置き場の distribute.json を確かめて作業場所に覚える。
# 決まっていれば「最新版」はその版（前の版へ戻したときも）。名前は update.rs の WANT と同じ。
WANT_FILE = "want.json"


def distributed_version():
    """この PC が確かめた配る版（無ければ None＝配る版が決まっていない・窓の外）。"""
    import app_env
    data = _read_json(app_env.local_root() / WANT_FILE)
    v = str((data or {}).get("version") or "").strip()
    return v or None


def behind(latest, ver, distributed):
    """その版は「要更新」か: 配る版が決まっていれば、それと違う版（新しすぎる版も戻す）。決まっていなければ、より古い版。"""
    if not (latest and ver):
        return False
    return ver != latest if distributed else version_key(latest) > version_key(ver)


def latest_version(roles_of):
    """配る版。決まっていなければ、使っている人たち（開発者を除く）の版のうちいちばん新しいもの。数えられなければ None。"""
    v = distributed_version()
    if v:
        return v
    recs = {}
    for r in _history() + _online():
        recs.setdefault((r.get("login", ""), r.get("pc", "")), []).append(str(r.get("version") or ""))
    roles = roles_of(list(recs.keys())) if roles_of else {}
    vers = [v for pair, vs in recs.items() if roles.get(pair) not in LATEST_EXCLUDED_ROLES for v in vs if v]
    return max(vers, key=version_key) if vers else None


def refresh_newest(roles_of):
    try:
        v = latest_version(roles_of)
        if v:
            _state["newest"] = v
    except Exception:
        pass            # 読めなければ前の答えのまま
    _state["newest_at"] = time.time()


def version_notice(role):
    """{latestVersion, myVersion, outdated}（まだ数えていなければ None）。開発者には「古い」と言わない。"""
    latest = _state["newest"]
    if not latest:
        return None
    mine, dist = APP_VERSION, distributed_version() == latest
    return {"latestVersion": latest, "myVersion": mine, "distributed": dist,
            "outdated": role not in LATEST_EXCLUDED_ROLES and behind(latest, mine, dist)}


def fleet(roles_of):
    """利用状況の画面の中身: PC ごとの記録（いま使っているか・版・最新か）と数。"""
    online = {r["key"]: r for r in _online()}
    hist = {h.get("key"): h for h in _history() if h.get("key")}
    keys = set(online) | set(hist)
    pairs = [((online.get(k) or hist.get(k) or {}).get("login", ""), (online.get(k) or hist.get(k) or {}).get("pc", "")) for k in keys]
    roles = roles_of(pairs) if roles_of else {}
    latest = latest_version(roles_of)
    dist = bool(latest) and distributed_version() == latest
    items = []
    for k in keys:
        o, h = online.get(k), hist.get(k) or {}
        login, pc = (o or h).get("login", ""), (o or h).get("pc", "")
        role = roles.get((login, pc), "")
        ver = (o or {}).get("version") or h.get("version") or ""
        counted = role not in LATEST_EXCLUDED_ROLES
        rv = revocation(k)
        items.append({"key": k, "login": login, "pc": pc, "role": role, "version": ver,
                      "online": bool(o), "idleSec": o.get("idleSec") if o else None, "since": (o or {}).get("since"),
                      "firstAt": h.get("firstAt"), "lastAt": (o or {}).get("at") or h.get("lastAt"),
                      "sessions": h.get("sessions", 0), "totalSec": h.get("totalSec", 0),
                      "versions": h.get("versions", {}), "counted": counted,
                      "outdated": counted and behind(latest, ver, dist),
                      "revoked": rv})
    items.sort(key=lambda x: (not x["outdated"], not x["online"], x["pc"], x["login"]))
    return {"items": items, "latest": latest, "distributed": dist, "online": sum(1 for x in items if x["online"]),
            "outdated": sum(1 for x in items if x["outdated"]), "total": len(items)}


# ------------------------------------------------------------------ 切断
def revocation(key):
    """その PC に効いている切断の指示（無ければ None）。冷却が切れたら効かない。"""
    if presence_dir() is None:
        return None
    data = _read_json(_revoke_path(key))
    if not data or data.get("_unreadable"):
        return None
    age = _age_sec(data)
    if age is None or age > REVOKE_COOLDOWN_SEC:
        return None
    return {"by": data.get("by", ""), "byPc": data.get("byPc", ""), "reason": data.get("reason", ""),
            "at": data.get("at", ""), "remainingSec": max(0, int(REVOKE_COOLDOWN_SEC - age))}


def disconnect(key, by_login="", by_pc="", reason=""):
    """切断の指示を書く。**権限の判定はここではしない**（ルートが access.role_can の1箇所で判定する）。"""
    return _write_json(_revoke_path(key), {"key": key, "by": by_login, "byPc": by_pc,
                                           "reason": str(reason or "")[:200], "at": now_iso()})


def clear_revocation(key):
    try:
        _revoke_path(key).unlink(missing_ok=True)
        return True
    except OSError:
        return False


def forget(key):
    """使わなくなった PC の記録（要約・使用の履歴）を消す（いま使っていれば消さない＝ルートが 409）。"""
    try:
        _hist_path(key).unlink(missing_ok=True)
        (presence_dir() / f"{key}.json").unlink(missing_ok=True)
        shutil.rmtree(presence_dir() / SESSIONS_DIR / key, ignore_errors=True)
        clear_revocation(key)
        return True
    except OSError:
        return False
