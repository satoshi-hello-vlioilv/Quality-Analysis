# -*- coding: utf-8 -*-
"""ロット一覧（品質データ SQLite の写し）。"""
from ..web import current_app, jsonify, request

from .. import effective_settings, lot_engine, lot_list_params
from ..services import lot_list
from .common import bp, error


def lot_mirror():
    """参照先マスタの今の値に合わせてから返す（ほかの PC が参照先を直したら、次の問い合わせで切り替わる）。
    → (写しの係, いまのロット一覧の設定)。設定は1回の問い合わせで1回だけ読む（共有のマスタを読みに行くため）。"""
    settings = effective_settings(current_app)
    m = current_app.config["LOT_MIRROR"]
    want = lot_list_params(settings)
    # 参照先が「前に当てた値」から変わったときだけ切り替える（起動時の値は create_app が当てている）
    if want != current_app.config.get("LOT_APPLIED"):
        m.reconfigure(remote=want[0], interval_sec=want[1], stale_hours=want[2])
        current_app.config["LOT_APPLIED"] = want
    m.start()   # サーバー起動時に始まっていなければ、ここで始める（何度呼んでもよい）
    return m, settings.get("lot_list") or {}


def lotlist_plan():
    """一覧を読む前の段取り → (段取り, 失敗の答え)。どちらか一方が None。
    段取り: 読むファイル（写しがあれば写し）・既定の表・既定の件数・いつのデータか。"""
    m, ll = lot_mirror()
    path = m.read_path()
    if not path:
        return None, error("ロット一覧の元ファイルが決まっていません。「マスタ管理」の「参照先」で元ファイルを入れてください。", 400,
                           source=m.source_info())
    return {"path": str(path), "table": ll.get("table", ""), "page_size": ll.get("page_size", 500), "source": m.source_info()}, None


@bp.get("/api/lotlist")
def lotlist():
    """WaveLog の /api/table と同じ引数（page, page_size, search, filters, sorts）で、写しから引く。
    group=1 はロット番号でまとめる（lot_list.grouped_rows）。デスクトップ版は Rust が同じ答えを作る（desktop/src/lotlist.rs）。"""
    plan, fail = lotlist_plan()
    if fail:
        return fail
    a = request.args
    try:
        out = lot_list.query(plan["path"], table=a.get("table", ""), preferred_table=plan["table"],
                             page=a.get("page", 1), page_size=a.get("page_size", plan["page_size"]),
                             search=a.get("search", ""), filters=a.get("filters", ""), sorts=a.get("sorts", ""),
                             group=a.get("group") == "1")
    except Exception as e:
        return error(str(e), 503, source=plan["source"])
    out["source"] = plan["source"]
    return jsonify(out)


@bp.get("/api/lotlist/settings")
def lotlist_settings():
    """デスクトップ版の Rust が尋ねる、いまの一覧の設定（参照先マスタで変えた値を重ねたもの）。写しと問い合わせは Rust が受け持つ。
    engine: "rust"（既定）か "python"（設定 desktop.lotlist_engine。食い違いに気づいたら Python に戻す）。"""
    settings = effective_settings(current_app)
    source, refresh_seconds, stale_hours = lot_list_params(settings)
    ll = settings.get("lot_list") or {}
    return jsonify(source=source, refresh_seconds=refresh_seconds, stale_hours=stale_hours, table=ll.get("table", ""),
                   page_size=ll.get("page_size", 500), engine=lot_engine(current_app.config["APP_SETTINGS"]))


@bp.get("/api/lotlist/source")
def lotlist_source():
    """いま読んでいるデータはいつのものか（共有は見に行かない）。"""
    return jsonify(lot_mirror()[0].source_info())


@bp.post("/api/lotlist/refresh")
def lotlist_refresh():
    """「再読込」: 共有から取り直す（変わっていなくても写し直す）。"""
    m, _ = lot_mirror()
    res = m.refresh(force=True)
    return jsonify(result=res, source=m.source_info())
