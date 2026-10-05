# -*- coding: utf-8 -*-
"""この PC とログインの名乗り（WaveLog backend/access_mode.py の取り方を移したもの）。

ログインID: os.getlogin() → getpass.getuser() → 環境変数 USERNAME → USER → LOGNAME の最初の空でない値。
    **設定では書き換えられない**（権限の判定に使うため）。
PC名: 設定（appsettings.json の identity.pc_name・「この端末の名前」）→ socket.gethostname() → COMPUTERNAME →
    platform.node() → HOSTNAME → FQDN の頭 → /etc/hostname の最初の使える値。localhost などの使えない名前は飛ばし、
    80 文字で切る。どこから取ったか（source）と試した順（tried）も持つ（起動の記録・画面で「なぜこの名前か」を言える）。
名乗れないときは空（空どうしを「同じ人」とは見なさない）。
"""
import getpass
import os
import platform
import socket
import threading
import unicodedata

USELESS_PC_NAMES = {"", "localhost", "localhost.localdomain", "127.0.0.1", "::1", "0.0.0.0", "unknown", "(none)"}
_LOCK = threading.Lock()
_CACHE = {}          # override -> {name, source, tried}
_OVERRIDE = {"pc": ""}   # 設定の「この端末の名前」（create_app が置く）


def set_override(pc_name):
    _OVERRIDE["pc"] = str(pc_name or "").strip()


def normalize_part(v):
    """比べるための形（NFKC・前後の空白を除く・大文字）。表示には使わない。"""
    return unicodedata.normalize("NFKC", str(v or "")).strip().upper()


def current_login_id():
    for get in (os.getlogin, getpass.getuser, lambda: os.environ.get("USERNAME"),
                lambda: os.environ.get("USER"), lambda: os.environ.get("LOGNAME")):
        try:
            v = str(get() or "").strip()
        except Exception:
            v = ""
        if v:
            return v
    return ""


def _usable(v):
    v = str(v or "").strip()
    return v[:80] if v.lower() not in USELESS_PC_NAMES else ""


def _candidates(override):
    def etc():
        try:
            with open("/etc/hostname", encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def fqdn():
        try:
            return socket.getfqdn().split(".")[0]
        except Exception:
            return ""
    return [("設定（この端末の名前）", lambda: override), ("ホスト名", socket.gethostname),
            ("COMPUTERNAME", lambda: os.environ.get("COMPUTERNAME")), ("platform.node", platform.node),
            ("HOSTNAME", lambda: os.environ.get("HOSTNAME")), ("FQDN", fqdn), ("/etc/hostname", etc)]


def resolve_pc_name(override="", force=False):
    """{name, source, tried} 。結果は覚える（設定の値が変われば取り直す）。"""
    key = str(override or "").strip()
    with _LOCK:
        if not force and key in _CACHE:
            return dict(_CACHE[key])
        tried, name, source = [], "", ""
        for label, get in _candidates(key):
            try:
                v = _usable(get())
            except Exception:
                v = ""
            tried.append({"source": label, "value": v})
            if v:
                name, source = v, label
                break
        _CACHE[key] = {"name": name, "source": source, "tried": tried}
        return dict(_CACHE[key])


def current():
    """{login, pc, pcSource}（PC名は設定の「この端末の名前」があればそれ）"""
    pc = resolve_pc_name(_OVERRIDE["pc"])
    return {"login": current_login_id(), "pc": pc["name"], "pcSource": pc["source"]}
