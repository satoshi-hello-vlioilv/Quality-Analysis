# -*- coding: utf-8 -*-
"""アプリを作る（受け口は app/web.py。版 3.8.0 で Flask から置き換えた）。"""
import os
from pathlib import Path

import app_build
import app_env

from .web import App


def effective_settings(app):
    """配った設定（config/appsettings.json）に、参照先マスタで変えた値を重ねた設定。読むたびに作る（共有の変更を拾う）。"""
    from .repositories.master_repository import MasterRepository
    from .services import path_settings
    base = app.config["APP_SETTINGS"]
    try:
        rows = MasterRepository(app.config["MASTER_STORE"]).path_settings()
    except Exception:
        rows = []           # 読めなくても配った設定で動く
    return path_settings.effective(base, rows)[0]


def lot_list_params(settings):
    """ロット一覧の元の設定 → (元ファイル, 写し直す間隔 秒, 古いとみなす時間)。起動時とロット一覧の問い合わせで同じ読み方をする。"""
    ll = settings.get("lot_list") or {}
    return (ll.get("source", ""), ll.get("refresh_seconds", 60), ll.get("stale_hours", 36))


def lot_engine(settings):
    """デスクトップ版で異常ロット一覧（写しと問い合わせ）を受け持つ係。"rust"（既定）か "python"（設定 desktop.lotlist_engine）。"""
    return (settings.get("desktop") or {}).get("lotlist_engine", "rust")


def shell_serves():
    """窓（デスクトップ版の Rust）が受け持つと名乗ったこと（環境変数 TPA_SHELL_SERVES・desktop/src/sidecar.rs の SERVES）。
    名乗っていないことはこのプロセスが受け持つ（受け持ちを移す途中の窓と組んでも欠けない）。"""
    if os.environ.get("TPA_SHELL") != "desktop":
        return frozenset()
    return frozenset(s.strip() for s in os.environ.get("TPA_SHELL_SERVES", "").split(",") if s.strip())


def mirror_is_external(settings):
    """品質データの写しを、このプロセスの外（デスクトップ版の Rust）が作るか。窓が異常ロット一覧（lotlist）を受け持つと名乗り、
    設定も rust のときだけ。そのときこのプロセスは写さず、同じ台帳を読むだけにする（同じ PC で写しの係を2つ動かさない）。"""
    return "lotlist" in shell_serves() and lot_engine(settings) == "rust"


def make_lot_mirror(params, passive=False):
    """ロット一覧の元（品質データ SQLite）を手元（この PC の作業場所の db_cache）へ写す係。passive は読むだけ（写さない）。"""
    from .services.db_mirror import DbMirror
    source, refresh_seconds, stale_hours = params
    return DbMirror("lot_list", source, app_env.local_root() / "db_cache",
                    interval_sec=refresh_seconds, stale_hours=stale_hours, passive=passive)


def create_app(test_config=None):
    app = App(__name__)
    base = Path(__file__).resolve().parents[1]
    app.config["APP_SETTINGS"] = app_env.load_settings(base)
    app.config["BASE_DIR"] = base
    if test_config:
        app.config.update(test_config)
    # この PC の名乗り（設定の「この端末の名前」があればそれ。services/identity.py）
    from .services import identity, presence
    identity.set_override((app.config["APP_SETTINGS"].get("identity") or {}).get("pc_name", ""))
    if "MASTER_STORE" not in app.config:
        from .repositories.master_store import MasterStore
        app.config["MASTER_STORE"] = MasterStore(base, settings=app.config["APP_SETTINGS"].get("master_share"))
    # 利用状況の置き場: マスタの共有フォルダの下（無ければこの PC の中だけ）。WaveLog の presence とは分ける
    _st = app.config["MASTER_STORE"]
    presence.configure(_st.share_dir / "presence_tpa" if _st.share_dir else _st.cache_dir.parent / "presence")
    # 起動したときの参照先（ロット一覧）。参照先マスタがこれから変わったら、ロット一覧の問い合わせで切り替える
    app.config["LOT_APPLIED"] = lot_list_params(effective_settings(app))
    if "LOT_MIRROR" not in app.config:
        # ロット一覧の元（品質データ SQLite）を手元へ写す係。写し始めるのは起動したとき（boot.start）か、
        # 一覧を初めて開いたとき（テストでアプリを作るたびに共有へ触らないように）。
        app.config["LOT_MIRROR"] = make_lot_mirror(app.config["LOT_APPLIED"], passive=mirror_is_external(app.config["APP_SETTINGS"]))

    # 起動したときのプログラムの指紋（app_build.py）。画面に埋め、JS・CSS の URL にも付ける（app.js が比べて、版の混ざりを言う）
    app.config["BUILD"] = app_build.fingerprint(base)

    @app.url_defaults
    def _static_build(endpoint, values):
        if endpoint == "static" and "v" not in values:
            values["v"] = app.config["BUILD"]

    # アプリの名前（app/brand.json）。どの画面の型でも {{ brand.name }}・{{ brand.subtitle }} で使う
    from .brand import BRAND

    @app.context_processor
    def _brand():
        return {"brand": BRAND}

    from .routes import bp
    app.register_blueprint(bp)

    return app
