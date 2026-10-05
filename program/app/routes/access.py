# -*- coding: utf-8 -*-
"""版・名乗り・アクセス権限・利用状況。判定は services/access.py の1箇所（ここは渡すだけ）。"""
from flask import current_app, jsonify, request

from ..services import access, presence
from ..version import APP_VERSION
from .common import Forbidden, base_rev, bp, error, find_row, master_call, master_repo, me, roles_from


@bp.get("/api/access/me")
def access_me():
    """だれが・どの PC で・どの権限で使っているか（画面の見出し・マスタ管理の入口と書ける範囲）。"""
    m = me()
    return jsonify(loginId=m["login"], pcName=m["pc"], pcNameSource=m["pcSource"], version=APP_VERSION,
                   revoked=m["revoked"], **m["caps"])


# 書き込みの門番: マスタへ書く道（現場のマスタ＝設備・ロール、管理のマスタ＝アクセス権限・参照先）だけを見る。
# 計算・一覧・取込・心拍は書き込みではないので止めない。切断された PC は冷却のあいだ書けない。
_GUARDED = (("/api/masters/equipment", "equipment_master"), ("/api/masters/rolls", "roll_master"),
            ("/api/masters/access", "access_permissions"), ("/api/settings/", "path_settings"))


@bp.before_app_request
def _access_guard():
    if request.method in ("GET", "HEAD", "OPTIONS") or request.path == "/api/settings/check":
        return None
    name = next((n for pfx, n in _GUARDED if request.path.startswith(pfx)), None)
    if not name:
        return None
    try:
        m = me()
    except Exception:
        return None      # 権限を読めないときは止めない（WaveLog と同じ・マスタの共有に届かないときは書く側が断る）
    if m["revoked"]:
        r = m["revoked"]
        return error(f"この PC は {r.get('by') or '管理する人'} により一時的に切断されています（あと {r.get('remainingSec', 0) // 60 + 1} 分）。"
                     + (f"理由: {r['reason']}" if r.get("reason") else ""), 403, "revoked")
    scope = access.master_scope(name)
    if not access.master_edit_can(m["flags"]["masterEdit"], "write", scope):
        what = "管理のマスタ（アクセス権限・参照先）" if scope == "admin" else "マスタ"
        return error(f"この PC の権限（{m['flags']['role']}・マスタ編集「{m['flags']['masterEdit']}」）では{what}を書き換えられません。",
                     403, "forbidden")
    return None


# ---- アクセス権限マスタ（登録・更新・削除は同じ門: 区分の変更・マスタ編集の上限を access の1箇所で確かめる）
def _perm_payload():
    d = request.get_json(silent=True) or {}
    out = {k: str(d.get(k) or "").strip() for k in ("ログインID", "PC名", "権限区分", "マスタ編集", "有効", "備考")}
    out["権限区分"] = access.normalize_role(out["権限区分"])
    out["マスタ編集"] = access.normalize_master_edit(out["マスタ編集"])
    out["有効"] = "無" if out["有効"] == "無" else "有"
    return out


def _perm_gate(m, data, old=None):
    """その行を置いてよいか（与える段が区分の上限以内か・区分を変えてよいか）。通らなければ Forbidden。"""
    ok, why = access.master_edit_check(data["権限区分"], data["マスタ編集"])
    if ok:
        ok, why = access.role_change_check(m["rows"], m["login"], m["pc"], old.get("権限区分") if old else access.ROLE_DEFAULT,
                                           data["権限区分"], row_id=(old or {}).get("id"), row_login=data["ログインID"], row_pc=data["PC名"])
    if not ok:
        raise Forbidden(why)


@bp.get("/api/masters/access")
def access_list():
    m = me()
    return jsonify(items=m["rows"], matchedId=m["flags"]["matchedId"], **access.choices())


@bp.post("/api/masters/access")
def access_create():
    def run():
        m, data = me(), _perm_payload()
        _perm_gate(m, data)
        return master_repo().access_permissions_create(data)
    return master_call(run, 201)


@bp.put("/api/masters/access/<int:item_id>")
def access_update(item_id):
    base = base_rev()

    def run():
        m, data = me(), _perm_payload()
        _perm_gate(m, data, find_row(m["rows"], item_id) or {"id": item_id})
        return master_repo().access_permissions_update(item_id, data, base)
    return master_call(run)


@bp.delete("/api/masters/access/<int:item_id>")
def access_delete(item_id):
    base = base_rev()

    def run():
        m = me()
        old = find_row(m["rows"], item_id)
        if old:
            ok, why = access.delete_check(m["rows"], m["login"], m["pc"], old)   # 自分の行・上位の行は消せない
            if not ok:
                raise Forbidden(why)
        master_repo().access_permissions_delete(item_id, base)
        return {"status": "deleted", "id": item_id}
    return master_call(run)


# ---- 利用状況（見る・切断・切断を解く・記録を消す。できるかは access.role_can の1箇所）
@bp.get("/api/presence")
def presence_list():
    m = me()
    if not m["caps"]["canViewPresence"]:
        return error(f"この PC の権限区分（{m['flags']['role']}）では利用状況を見られません。", 403, "forbidden")
    try:
        fl = presence.fleet(roles_from(m["rows"]))
        readable = True
    except Exception as e:
        fl, readable = {"items": [], "latest": None, "online": 0, "outdated": 0, "total": 0, "error": str(e)}, False
    st = current_app.config["MASTER_STORE"]
    return jsonify(fleet=fl, readable=readable, shared=st.share_dir is not None, dir=str(presence.presence_dir() or ""),
                   me=m["key"], can=m["caps"], ttlSec=presence.TTL_SEC, cooldownSec=presence.REVOKE_COOLDOWN_SEC,
                   revoked=m["revoked"], roles=list(access.ROLES))


def _presence_target():
    """→ (自分, 本文, 相手の PC の記録)。記録が無ければ相手は None。"""
    m = me()
    body = request.get_json(silent=True) or {}
    key = str(body.get("key") or "").strip()
    items = {x["key"]: x for x in presence.fleet(roles_from(m["rows"]))["items"]}
    return m, body, items.get(key)


_NO_RECORD = "その PC の記録がありません。"


@bp.post("/api/presence/disconnect")
def presence_disconnect():
    m, body, t = _presence_target()
    if not t:
        return error(_NO_RECORD, 404, "not_found")
    if t["key"] == m["key"]:
        return error("自分の PC は切断できません。", 400, "invalid")
    if not access.role_can(m["flags"]["role"], "presence:disconnect", t["role"]):
        return error(f"この PC の権限区分（{m['flags']['role']}）では{t['role'] or ''}の PC を切断できません。", 403, "forbidden")
    if not t["online"]:
        return error("その PC はいま使っていません（切断するものがありません）。", 409, "conflict")
    if not presence.disconnect(t["key"], m["login"], m["pc"], str(body.get("reason") or "")):
        return error("切断の指示を書けませんでした（共有フォルダを確かめてください）。", 503, "unavailable")
    return jsonify(ok=True)


@bp.post("/api/presence/allow")
def presence_allow():
    m, _, t = _presence_target()
    if not t:
        return error(_NO_RECORD, 404, "not_found")
    if not access.role_can(m["flags"]["role"], "presence:disconnect", t["role"]):
        return error(f"この PC の権限区分（{m['flags']['role']}）では切断を解けません。", 403, "forbidden")
    presence.clear_revocation(t["key"])
    return jsonify(ok=True)


@bp.post("/api/presence/forget")
def presence_forget():
    m, _, t = _presence_target()
    if not t:
        return error(_NO_RECORD, 404, "not_found")
    if not access.role_can(m["flags"]["role"], "presence:forget"):
        return error(f"この PC の権限区分（{m['flags']['role']}）では記録を消せません。", 403, "forbidden")
    if t["online"]:
        return error("いま使っている PC の記録は消せません（使い終わってから消してください）。", 409, "conflict")
    presence.forget(t["key"])
    return jsonify(ok=True)


# ---- 使用の履歴（起動ごと）と保存期間・整理
@bp.get("/api/presence/sessions")
def presence_sessions():
    m = me()
    if not m["caps"]["canViewPresence"]:
        return error(f"この PC の権限区分（{m['flags']['role']}）では利用状況を見られません。", 403, "forbidden")
    try:
        limit = max(1, min(2000, int(request.args.get("limit") or 300)))
    except ValueError:
        limit = 300
    d = presence.sessions(key=(request.args.get("key") or "").strip() or None, limit=limit)
    return jsonify(**d, historyDays=presence.history_days(), range=list(presence.HISTORY_DAYS_RANGE), can=m["caps"])


def _manager(m, what):
    """記録を消す・整理する・残す日数を変えるのは、記録を消せる区分（メンテナンス者以上）だけ。"""
    if access.role_can(m["flags"]["role"], "presence:forget"):
        return None
    return error(f"この PC の権限区分（{m['flags']['role']}）では{what}。", 403, "forbidden")


@bp.post("/api/presence/retention")
def presence_retention():
    m = me()
    denied = _manager(m, "履歴を残す日数を変えられません")
    if denied:
        return denied
    try:
        days = presence.parse_history_days((request.get_json(silent=True) or {}).get("days"))
    except ValueError as e:
        return error(str(e), 400, "invalid")
    if not presence.save_settings({"historyDays": days}, m["login"], m["pc"]):
        return error("書けませんでした（共有フォルダを確かめてください）。", 503, "unavailable")
    return jsonify(ok=True, historyDays=days)


@bp.post("/api/presence/prune")
def presence_prune():
    m = me()
    denied = _manager(m, "古い記録を整理できません")
    if denied:
        return denied
    return jsonify(ok=True, **presence.prune_all())
