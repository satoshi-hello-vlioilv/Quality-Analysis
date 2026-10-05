# -*- coding: utf-8 -*-
"""参照先マスタ（読みに行く場所: LotDsp の URL・ロット一覧の元ファイルなど）。"""
from flask import current_app, jsonify, request

import app_env

from .. import effective_settings
from ..services import path_settings
from .common import base_rev, bp, error, master_call, master_repo, me
from .lotlist import lot_mirror


@bp.get("/api/settings")
def settings_get():
    """項目ごとに: 既定（配った設定）・マスタで変えた値・いま効いている値・行の版。マスタの共有フォルダは見るだけ。"""
    st = current_app.config["MASTER_STORE"]
    _, items = path_settings.effective(current_app.config["APP_SETTINGS"], master_repo().path_settings())
    return jsonify(items=items, shared=st.is_shared(path_settings.NAME), share_dir=str(st.share_dir or ""),
                   config_file=str(app_env.config_path(current_app.config["BASE_DIR"])),
                   revision=st.revision(path_settings.NAME))


@bp.post("/api/settings/check")
def settings_check():
    """「確かめる」: 保存の前に、その値で本当に読めるか。"""
    body = request.get_json(silent=True) or {}
    item = path_settings.BY_KEY.get(str(body.get("key") or ""))
    if not item:
        return error("知らない項目です。", 400)
    try:
        value = path_settings.parse(item, body.get("value"))
    except ValueError as e:
        return jsonify(ok=False, message=str(e))
    if value is None:
        value = path_settings.default_of(current_app.config["APP_SETTINGS"], item["key"])
    return jsonify(path_settings.check(item, value))


@bp.put("/api/settings/<path:key>")
def settings_put(key):
    """値を置く（空なら既定へ戻す）。base_rev は開いたときの行の版（行が無かったときは 0）。保存したらすぐ効かせる。"""
    item = path_settings.BY_KEY.get(key)
    if not item:
        return error("知らない項目です。", 400, "error")
    body = request.get_json(silent=True) or {}
    try:
        value = path_settings.parse(item, body.get("value"))
    except ValueError as e:
        return error(str(e), 400, "invalid")
    base = base_rev()

    def run():
        row = master_repo().path_setting_put(key, value, base)
        if key.startswith("lot_list."):
            lot_mirror()       # 元ファイル・間隔・しきいを、起動し直さずに切り替える
        return {"row": row}
    return master_call(run)


@bp.get("/api/update/settings")
def update_settings():
    """デスクトップ版の Rust が尋ねる、更新の置き場（参照先マスタで変えた値を重ねたもの。取り込みは desktop/src/update.rs）と、
    だれが（版を置く・配る版を決めてよいか。決めるのは services/access.py。置く・配るのは desktop/src/distribute.rs）。"""
    up = effective_settings(current_app).get("update") or {}
    try:
        m = me()
        who = {"login": m["login"], "pc": m["pc"], "role": m["flags"]["role"],
               "canRelease": m["caps"]["canRelease"] and not m["revoked"]}
    except Exception as e:      # 権限を読めないときは置かせない（置き場を読むことは止めない）
        who = {"login": "", "pc": "", "role": "", "canRelease": False, "error": str(e)}
    return jsonify(source=str(up.get("source") or ""), who=who)
