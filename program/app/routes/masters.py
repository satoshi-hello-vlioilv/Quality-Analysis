# -*- coding: utf-8 -*-
"""現場のマスタ（設備・ロール）の読み書き・マスタの置き場の状態。アクセス権限マスタは access.py。"""
from ..web import current_app, jsonify, request

from .common import base_rev, bp, master_call, master_repo

# マスタごとの API（設備: 設備名が必須／ロール: 設備が必須）
MASTER_APIS = {
    "equipment": ("equipment", "設備名"),
    "rolls": ("rolls", "設備"),
}


def _payload(required):
    data = request.get_json(force=True) or {}
    data.pop("base_rev", None)
    if required in data and not str(data.get(required, "")).strip():
        raise ValueError(f"{required}は必須です。")
    return data


def _register_master_api(kind, prefix, required):
    url = f"/api/masters/{kind}"

    def list_():
        return master_call(lambda: getattr(master_repo(), prefix)())

    def create():
        def run():
            data = _payload(required)
            if not str(data.get(required, "")).strip():   # 追加は必須の列を省けない
                raise ValueError(f"{required}は必須です。")
            return getattr(master_repo(), f"{prefix}_create")(data)
        return master_call(run, 201)

    def update(item_id):
        base = base_rev()
        return master_call(lambda: getattr(master_repo(), f"{prefix}_update")(item_id, _payload(required), base))

    def delete(item_id):
        base = base_rev()

        def run():
            getattr(master_repo(), f"{prefix}_delete")(item_id, base)
            return {"status": "deleted", "id": item_id}
        return master_call(run)

    bp.add_url_rule(url, f"{kind}_list", list_, methods=["GET"])
    bp.add_url_rule(url, f"{kind}_create", create, methods=["POST"])
    bp.add_url_rule(f"{url}/<int:item_id>", f"{kind}_update", update, methods=["PUT"])
    bp.add_url_rule(f"{url}/<int:item_id>", f"{kind}_delete", delete, methods=["DELETE"])


for _kind, (_prefix, _required) in MASTER_APIS.items():
    _register_master_api(_kind, _prefix, _required)


@bp.post("/api/equipment/inspection")
def equipment_inspection():
    """{names: [...]} → {inspection: {設備名: 検査計があるか}}。画面が発見設備を自動で選ぶ（実績のうち検査計がある最後の設備）ため。"""
    names = [str(n) for n in ((request.get_json(silent=True) or {}).get("names") or [])][:100]
    return master_call(lambda: {"inspection": master_repo().inspection_of(names)})


@bp.get("/api/masters/status")
def masters_status():
    """置き場（手元／共有）・共有へ届くか・錠・各マスタの版。画面はこれで「いつの・どこの」マスタかを言う。"""
    return jsonify(current_app.config["MASTER_STORE"].status())
