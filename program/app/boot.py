# -*- coding: utf-8 -*-
"""アプリを動かし始める処理（デスクトップ版の窓口 sidecar.py が使う）。

始めにすること（記録の場所・品質データの写し・マスタの初期値）を1箇所にまとめる。
以前はブラウザ版のサーバー（ポートで待つ）もこれを使っていた（版 3.0.0 で外した）。
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time

import app_env

log = logging.getLogger("transfer-app")


def configure_logging(name: str = "app.log") -> None:
    """記録は この PC の作業場所の logs へ（program フォルダを汚さない）。"""
    log_dir = app_env.local_root() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=log_dir / name, level=logging.INFO, encoding="utf-8",
                        format="%(asctime)s %(levelname)s %(message)s")


def start(flask_app, mode: str, started: float):
    """アプリを作り終えたあと、裏で始めること。mode は記録に残す窓口の名前（stdio）。
    started は読み込みを始めた時刻（time.perf_counter）。起動の速さを記録に残す。"""
    # ロット一覧の元（品質データ）を起動と同時に手元へ写し始める（一覧を開いたときに待たせない）
    flask_app.config["LOT_MIRROR"].start()
    # 配った版で決めたマスタの初期値を、共有のマスタへ一度だけ当てる（裏で。共有が遅くても画面を待たせない）
    from .services import master_seeds
    threading.Thread(target=master_seeds.run, args=(flask_app.config["MASTER_STORE"],), name="master-seeds", daemon=True).start()
    log.info("START mode=%s pid=%s python=%s base=%s", mode, os.getpid(), sys.executable, app_env.BASE)
    log.info("IMPORT_READY elapsed=%.3fs", time.perf_counter() - started)


def stop() -> None:
    """終わるときの後始末（見えない Edge を閉じる）。失敗しても終わる。"""
    try:
        from .services import lotdsp_direct
        lotdsp_direct.shutdown()
    except Exception:
        log.exception("STOP cleanup failed")
