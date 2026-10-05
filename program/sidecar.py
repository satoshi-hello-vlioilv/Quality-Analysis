# -*- coding: utf-8 -*-
"""デスクトップ版（Tauri・desktop/）の窓口: 標準入出力でアプリへ問い合わせる。**ポートを開かない**。

以前のブラウザ版はポートで待ち受けたため、プロキシの設定・ポートの取り合い・古いサーバーの居残り・
ブラウザを閉じたかの推し量りに悩まされた（版 3.0.0 で外した。DESKTOP_MIGRATION_DESIGN.md §1・§10）。
デスクトップ版はこのプロセスを子として起動し、パイプで問い合わせる。窓を閉じれば親が終わり、
標準入力が閉じたのを見てこのプロセスも終わる（推し量りが要らない）。

枠の形（両方向とも同じ。テキストの行と生のバイトを混ぜる）:
    ヘッダー: JSON 1行（UTF-8・改行で終わる）。"len" が本文のバイト数
    本文    : len バイトそのまま（base64 にしない。大きな一覧でも膨らませない）
  問い合わせ {"id", "method", "path", "query", "headers": {名前: 値}, "len"}
  答え       {"id", "status", "headers": [[名前, 値], ...], "len"}
  知らせ     {"id": 0, "event": "ready" | "fatal", ...}（id 0 は問い合わせに使わない）

アプリ本体（app/web.py の App）へ、問い合わせをそのまま渡す（App.handle。試験は test_client で同じ道を呼ぶ）。
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import app_env

# .pyc は program フォルダではなく手元の作業場所へ（起こす側の Rust も -X pycache_prefix で渡す）
sys.pycache_prefix = str(app_env.local_root() / "pycache")

log = logging.getLogger("transfer-app")
BASE_URL = "http://tpa.localhost/"     # Tauri（Windows の WebView2）が自前の仕組みに付ける名前と同じ
WORKERS = 16                           # 長い問い合わせ（見えない Edge で数十秒）の間も、ほかの問い合わせ・進み具合の確認に答える


# ---------------- 枠を読む・書く ----------------
def read_frame(stream):
    """→ (ヘッダー dict, 本文 bytes)。入力が閉じたら None。"""
    line = stream.readline()
    if not line:
        return None
    head = json.loads(line.decode("utf-8"))
    n = int(head.get("len") or 0)
    body = stream.read(n) if n else b""
    if len(body) != n:
        return None                    # 途中で閉じた
    return head, body


class Writer:
    """答えを書く係（複数の糸から呼ばれても、1つの枠を混ぜずに書く）。"""

    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()

    def send(self, head: dict, body: bytes = b"") -> None:
        line = json.dumps({**head, "len": len(body)}, ensure_ascii=False).encode("utf-8") + b"\n"
        with self.lock:
            self.stream.write(line + body)
            self.stream.flush()


# ---------------- 1つの問い合わせをアプリへ渡す ----------------
def handle(app, head: dict, body: bytes):
    """問い合わせのヘッダー・本文 → (答えのヘッダー, 本文)。アプリの中で何が起きても答えは返す。"""
    rid = head.get("id")
    try:
        r = app.handle((head.get("method") or "GET"), head.get("path") or "/", head.get("query") or "",
                       head.get("headers") or {}, body)
        return {"id": rid, "status": r.status_code,
                "headers": [[k, v] for k, v in r.headers.items() if k.lower() != "content-length"]}, r.data
    except Exception as e:             # ここまで来るのはアプリの外の失敗（枠の中身がおかしい等）
        log.exception("SIDECAR request failed path=%s", head.get("path"))
        msg = json.dumps({"error": f"問い合わせを処理できませんでした: {e}", "type": type(e).__name__}, ensure_ascii=False).encode("utf-8")
        return {"id": rid, "status": 500, "headers": [["Content-Type", "application/json"]]}, msg


def serve(app, rin, writer: Writer, workers: int = WORKERS) -> None:
    """入力が閉じるまで問い合わせを読み、糸の組で答える（長い問い合わせが短いものを待たせない）。"""
    def one(head, body):
        h, b = handle(app, head, body)
        writer.send(h, b)

    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="sidecar")
    try:
        while True:
            frame = read_frame(rin)
            if frame is None:
                break
            pool.submit(one, *frame)
    finally:
        # 入力が閉じた＝窓が終わった。答える先が無いので、待っている問い合わせは捨てる
        pool.shutdown(wait=False, cancel_futures=True)


def protocol_streams():
    """枠を通す入出力。標準出力は枠だけに使い、print などが紛れ込まないよう fd 1 を標準エラーへ向け直す。"""
    rin = sys.stdin.buffer
    out = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    try:
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    except (OSError, ValueError, AttributeError):
        pass
    sys.stdout = sys.stderr
    return rin, Writer(out)


def main() -> int:
    from app import boot
    boot.configure_logging()
    started = time.perf_counter()
    rin, writer = protocol_streams()
    try:
        from app import create_app
        from app.version import APP_VERSION
        app = create_app()
    except Exception as e:             # 起動できない理由を窓（Rust）へ伝える
        log.exception("SIDECAR fatal")
        writer.send({"id": 0, "event": "fatal", "error": f"{type(e).__name__}: {e}"})
        return 1
    boot.start(app, "stdio", started)
    writer.send({"id": 0, "event": "ready", "version": APP_VERSION, "build": app.config["BUILD"], "pid": os.getpid(),
                 "python": sys.executable, "elapsed": round(time.perf_counter() - started, 3)})
    try:
        serve(app, rin, writer)
    finally:
        log.info("SIDECAR input closed. stopping")
        boot.stop()
    # 裏の糸（品質データの写し等）を待たずに終わる。親（窓）はもう居ない
    logging.shutdown()
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
