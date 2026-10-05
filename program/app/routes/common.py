# -*- coding: utf-8 -*-
"""ルートが共通で使う部品（Blueprint・マスタの窓口・失敗の返し方・この PC の名乗りと権限）。"""
import time

from ..web import Blueprint, current_app, jsonify, request

import app_env

from .. import effective_settings
from ..repositories.master_repository import MasterRepository
from ..repositories.master_store import MasterError
from ..services import access, identity, lotdsp_api, presence
from ..services.calculator import Calculator

bp = Blueprint("main", __name__)


def master_repo():
    return MasterRepository(current_app.config["MASTER_STORE"])


def calculator():
    return Calculator(current_app.config["APP_SETTINGS"], master_repo())


def api_settings():
    """LotDsp の API の設定（参照先マスタで変えた値を重ねる）。"""
    return lotdsp_api.settings_of(effective_settings(current_app).get("lotdsp_import"))


def api_map():
    """LotDsp の API の項目名の対応（この PC の作業場所。アプリで1つ）。"""
    km = current_app.config.get("LOTDSP_API_MAP")
    if km is None:
        km = current_app.config["LOTDSP_API_MAP"] = lotdsp_api.KeyMap(app_env.local_root() / "lotdsp_api_map.json")
    return km


def error(message, status, kind=None, **extra):
    """画面が読める失敗の形 {error, kind?, ...}。kind は画面が理由を見分けるための短い名前。"""
    body = {"error": message, **({"kind": kind} if kind else {}), **extra}
    return jsonify(body), status


def exception_error(e, status=400, **extra):
    """思いがけない失敗（例外の種類も返す。画面は error を出す）。"""
    return error(str(e), status, type=type(e).__name__, **extra)


class Forbidden(MasterError):
    """権限の決まり（services/access.py）で断る。"""
    kind, status = "forbidden", 403


def base_rev():
    """画面が開いたときの行の版（無ければ確かめない）。PUT は本文の base_rev、DELETE は ?rev=。"""
    body = request.get_json(silent=True) or {}
    v = body.get("base_rev", request.args.get("rev"))
    try:
        return None if v in (None, "") else int(v)
    except (TypeError, ValueError):
        return None


def master_call(fn, ok_status=200):
    """マスタの読み書きの失敗を、画面が読める形（kind と理由）で返す。"""
    try:
        return jsonify(fn()), ok_status
    except MasterError as e:
        return jsonify(e.payload()), e.status
    except Exception as e:
        return exception_error(e, kind="error")


def find_row(rows, item_id):
    return next((r for r in rows if r.get("id") == item_id), None)


# ---------------- この PC の名乗りと権限（services/access.py が答える。ここは渡すだけ） ----------------
_REVOKE_CACHE = {"at": 0.0, "key": "", "value": None}


def me():
    """この PC・このログインの名乗りと権限。{login, pc, pcSource, key, rows, flags, caps, revoked}"""
    who = identity.current()
    rows = master_repo().access_permissions()
    f = access.flags(rows, who["login"], who["pc"])
    key = presence.terminal_key(who["login"], who["pc"])
    # 切断の指示は 5 秒だけ覚える（読めなければ切断されていないものとして続ける＝止めない）
    now = time.monotonic()
    if _REVOKE_CACHE["key"] != key or now - _REVOKE_CACHE["at"] > 5:
        try:
            _REVOKE_CACHE.update(value=presence.revocation(key))
        except Exception:
            _REVOKE_CACHE.update(value=None)
        _REVOKE_CACHE.update(at=now, key=key)
    return {**who, "key": key, "rows": rows, "flags": f, "caps": access.capabilities(f), "revoked": _REVOKE_CACHE["value"]}


def roles_from(rows):
    """(ログインID, PC名) の組 → 登録上の区分、を答える関数（読み終えた権限の行を使う。表を何度も読みに行かない）。"""
    return lambda pairs: access.registered_roles(rows, pairs)
