# -*- coding: utf-8 -*-
"""画面・版・画面の設定・心拍（利用状況）。"""
from flask import current_app, jsonify, render_template, request

from .. import effective_settings
from ..brand import BRAND
from ..models import DEFAULT_UNWIND
from ..services import lotdsp_api, lotdsp_direct, presence, ui_state
from ..version import APP_VERSION, CHANGELOG
from .common import api_map, api_settings, bp, me, roles_from


@bp.get("/")
def index():
    # 画面の設定の控え（services/ui_state.py）を画面に埋めておく。画面の部品が設定を読む前に戻せる（読み直しが要らない）
    resp = current_app.make_response(render_template("index.html", app_version=APP_VERSION, build=current_app.config.get("BUILD", ""),
                                                     ui_state=ui_state.load()))
    resp.headers["Cache-Control"] = "no-store"      # 画面はいつもサーバーから（古い画面を使い回さない）
    return resp


@bp.get("/api/ui-state")
def ui_state_get():
    return jsonify(ui_state.load())


@bp.post("/api/ui-state")
def ui_state_put():
    """画面の設定の控えに、変わった名前を重ねる（閉じる瞬間は sendBeacon で来るので、種類を問わず JSON として読む）。"""
    body = request.get_json(silent=True, force=True) or {}
    try:
        return jsonify(ui_state.merge(body.get("changed"), body.get("removed") or []))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.get("/api/build")
def build():
    return jsonify(version=APP_VERSION)


@bp.get("/api/changelog")
def changelog():
    return jsonify(version=APP_VERSION, entries=CHANGELOG)


@bp.get("/api/health")
def health():
    return jsonify(status="ok")


@bp.get("/api/config")
def config():
    s = effective_settings(current_app)          # 参照先マスタで変えた値（LotDsp の URL など）を重ねる
    beat = s.get("presence", {})
    return jsonify(
        lotdsp_url=(s.get("lotdsp_import") or {}).get("url", ""),
        lotdsp_direct=lotdsp_direct.settings_of(s.get("lotdsp_import"))["enabled"],
        lotdsp_login_window=all(lotdsp_direct.settings_of(s.get("lotdsp_import"))[k] for k in ("enabled", "login_window")),
        lotdsp_api=lotdsp_api.status(api_map(), api_settings()),
        default_unwind=DEFAULT_UNWIND,
        defaults=s.get("ui_defaults", {}),
        max_rows=int(s.get("ui_defaults", {}).get("max_rows", 25)),
        heartbeat_interval_seconds=float(beat.get("heartbeat_interval_seconds", 3)),
        app={"name": BRAND["name"], "subtitle": BRAND["subtitle"]},
    )


# ---------------- 心拍（利用状況） ----------------
@bp.post("/api/heartbeat")
def heartbeat():
    """画面が数秒ごとに送る。利用状況を書き（20 秒ごと・裏で）、古い版か・切断されているかを返す（見出しの札）。
    画面は答えが来るかで「接続 ●」も決める。終了は窓（デスクトップ版の Rust）が答える（/api/shutdown は Python に来ない）。"""
    return jsonify(_presence_beat())


def _presence_beat():
    try:
        m = me()
        # 最新版の数え直しは裏の糸で走る（Flask の current_app は使えない）。権限の行はここで読み終えたものを渡す
        presence.touch_async(m["login"], m["pc"], m["flags"]["role"], roles_from(m["rows"]))
        return {"version": presence.version_notice(m["flags"]["role"]), "revoked": m["revoked"]}
    except Exception:
        return {"version": None, "revoked": None}
