# -*- coding: utf-8 -*-
"""ロットの取り込み（LotDsp）と計算。"""
import time

from ..web import current_app, jsonify, render_template, request

from .. import effective_settings
from ..services import lotdsp_api, lotdsp_direct, lotdsp_link, lotdsp_progress
from ..version import APP_VERSION
from .common import api_map, api_settings, bp, calculator, error, exception_error, master_repo


def read_lot(html, expect_lot=""):
    """進度情報の HTML → (Lot, report)。どの道（見えない Edge・LotDsp の窓・貼り付け）で読んでも同じ。
    読めたら、同じロットを LotDsp の API でも引いて項目名を学ぶ（lotdsp_api.learn_later。裏で・失敗しても取込は済んでいる）。"""
    read_cfg = current_app.config["APP_SETTINGS"].get("lotdsp_import")
    lot, report = lotdsp_progress.read_lot(html, master_repo().equipment(), read_cfg, expect_lot)
    learn = lotdsp_api.learn_from_html if current_app.config.get("LOTDSP_API_SYNC") else lotdsp_api.learn_later
    learn(api_map(), api_settings(), html, lot.lot_no, read_cfg)
    return lot, report


@bp.post("/api/lots/import-lotdsp")
def lot_import_lotdsp():
    """ロット問い合わせ（LotDsp）「進度情報」の HTML からロットを読む。

    呼ぶのはこのアプリ自身の画面だけ（HTML は Edge 拡張・保存ファイル・貼り付けのどれかで画面が受け取る）。
    """
    try:
        payload = request.get_json(force=True) or {}
        lot, report = read_lot(payload.get("html", ""), payload.get("lot_no", ""))
        return jsonify(lot=lot.to_dict(), report=report)
    except Exception as e:
        return exception_error(e)


# 読めなかった理由 → 状態コード（ここに無いもの: unreachable・no_browser・browser・screen・disabled は 503）
_DIRECT_STATUS = {"login": 409, "busy": 409, "cancelled": 409, "not_found": 404, "invalid": 400}


@bp.post("/api/lots/fetch-lotdsp")
def lot_fetch_lotdsp():
    """このアプリで LotDsp を読んで取り込む（社内のログイン不要な範囲は見えない Edge・ログインが要れば LotDsp の窓）。

    読めなければ kind で理由を返す。画面はそれを見て、ログインが要る（VPN）なら
    LotDsp の窓（login_window: true。利用者がその窓でログインし、続きをアプリが読む）へ回す。
      login 409 ／ not_found 404 ／ busy 409 ／ invalid 400 ／ unreachable・no_browser・browser・screen・disabled 503
    """
    payload = request.get_json(force=True) or {}
    lot_no = str(payload.get("lot_no") or "").strip().upper()
    cfg = lotdsp_direct.settings_of(effective_settings(current_app).get("lotdsp_import"))
    t0 = time.perf_counter()
    try:
        html = lotdsp_direct.fetch_progress_html(lot_no, cfg, window=bool(payload.get("login_window")))
    except lotdsp_direct.DirectError as e:
        return error(str(e), _DIRECT_STATUS.get(e.kind, 503), e.kind)
    try:
        lot, report = read_lot(html, lot_no)
    except Exception as e:
        return error(str(e), 400, "parse")
    return jsonify(lot=lot.to_dict(), report=report, seconds=round(time.perf_counter() - t0, 1))


# API で読めなかった理由 → 状態コード（ここに無いもの: unreachable・timeout・http・invalid・business・mismatch は 502）
_API_STATUS = {"not_ready": 409, "disabled": 409, "not_found": 404}


@bp.post("/api/lots/fetch-lotdsp-api")
def lot_fetch_lotdsp_api():
    """LotDsp の API で、ログインなしで読む（LotSearch と同じ道）。項目名を学び終えるまでは not_ready（409）。
    画面はこれを最初に試し、読めなければ（not_found 以外）今までの道（見えない Edge・LotDsp の窓・貼り付け）へ回す。"""
    payload = request.get_json(force=True) or {}
    lot_no = str(payload.get("lot_no") or "").strip().upper()
    if not lot_no:
        return error("ロット番号がありません。", 400, "invalid")
    try:
        lot, report = lotdsp_api.read_lot(api_map(), api_settings(), lot_no, master_repo().equipment(),
                                          current_app.config["APP_SETTINGS"].get("lotdsp_import"))
    except lotdsp_api.ApiError as e:
        return error(str(e), _API_STATUS.get(e.kind, 502), e.kind)
    except LookupError as e:
        return error(str(e), 400, "parse")
    return jsonify(lot=lot.to_dict(), report=report, seconds=report.get("seconds"))


@bp.get("/api/lots/lotdsp-api/survey")
def lot_lotdsp_api_survey():
    """調査用: LotDsp の API の応答に入っている項目をすべて一覧にする（?lot=ロット番号。?values=1 で値も入れる＝この PC の画面で見るだけ）。
    同じ問い合わせ先（searchAction）を1回呼ぶだけで、何も覚えず・書き換えない。"""
    lot_no = str(request.args.get("lot") or "").strip().upper()
    if not lot_no:
        return error("ロット番号を付けてください（例: …/survey?lot=L7150C0）。", 400, "invalid")
    cfg = api_settings()
    try:
        result = lotdsp_api.call(lot_no, cfg)
        lotdsp_api.entity_of(result, cfg, lot_no)          # 該当なしは、ほかの道と同じ言い方で返す
    except lotdsp_api.ApiError as e:
        return error(str(e), _API_STATUS.get(e.kind, 502), e.kind)
    out = lotdsp_api.survey(result, api_map(), cfg, values=request.args.get("values") == "1")
    return jsonify(lot=lot_no, **out)


@bp.post("/api/lots/lotdsp-api/link")
def lot_lotdsp_api_link():
    """調査用: 保存した LotDsp の画面（タブごとの HTML）と、同じロットの API の応答を値で照らし、項目 ↔ 画面の見出し を紐づける。
    body: {files: [{name, html}]}。同じタブをロット違いで2つ以上渡すと絞れる。出力に値は含まない。"""
    payload = request.get_json(force=True) or {}
    files = [f for f in (payload.get("files") or []) if isinstance(f, dict)]
    if not files:
        return error("画面（保存した HTML）を1つ以上渡してください。", 400, "invalid")
    if len(files) > 40:
        return error("一度に渡せるのは 40 ファイルまでです。", 400, "invalid")
    return jsonify(lotdsp_link.link_files(files, api_map(), api_settings()))


@bp.get("/lotdsp-link")
def lotdsp_link_page():
    """調査用の画面: 保存した LotDsp の画面を選んで、項目 ↔ 見出し の紐づけを見る。"""
    resp = current_app.make_response(render_template("lotdsp_link.html", app_version=APP_VERSION))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.get("/api/lots/lotdsp-api/status")
def lot_lotdsp_api_status():
    """API を使えるか（学び終えたか）・まだ決まらない列・ログインなしで応答した最後の記録。"""
    return jsonify(lotdsp_api.status(api_map(), api_settings()))


@bp.get("/api/lots/fetch-lotdsp/status")
def lot_fetch_lotdsp_status():
    """読んでいる途中の段階（画面のモーダルが 0.5 秒ごとに尋ねる）。{busy, lot, stage, seconds, reused}"""
    return jsonify(lotdsp_direct.status())


@bp.post("/api/lots/fetch-lotdsp/cancel")
def lot_fetch_lotdsp_cancel():
    """モーダルの「中止」。読んでいる途中なら止める。"""
    return jsonify(cancelled=lotdsp_direct.cancel())


@bp.post("/api/calculate")
def calculate():
    try:
        payload = request.get_json(force=True) or {}
        if not payload.get("lot"):
            return error("計算するロット（lot）がありません。", 400)
        return jsonify(calculator().calculate(payload["lot"], payload["inputs"]))
    except Exception as e:
        return exception_error(e)
