# -*- coding: utf-8 -*-
"""デスクトップ版の窓口（sidecar.py）: ポートを開かず、標準入出力の枠で問い合わせる。

評価の物差しは「アプリへ直接（test_client）と同じ答えか」。本物の子プロセスを起こし、パイプで同じ問い合わせを送って
状態・種類・中身を比べる。あわせて、枠が混ざらないこと（同時に投げても id で正しく返る）・print が枠を壊さないこと・
入力を閉じれば終わること（窓を閉じたら残らない）を確かめる。

    python -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from app import create_app

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests" / "fixtures" / "lotdsp_progress_L7150C0.html").read_text(encoding="utf-8")
VOLATILE = {"server_time", "pid", "python", "elapsed", "at", "checkedAt", "ageHours", "timing",   # 時刻・プロセスで変わる値
            # 一覧の source は品質データの写しの「いまの状態」（子プロセスは起動の処理で写しを作る。Windows の CI で当たった）
            "source"}


def protocol_of(path: Path, pattern: str) -> int:
    """枠の約束の版（ファイルに書いた数）を読む。"""
    import re
    return int(re.search(pattern, path.read_text(encoding="utf-8"), re.M).group(1))


def stable(v):
    """比べるときに、時刻・プロセス番号のように毎回変わる値を除く。"""
    if isinstance(v, dict):
        return {k: stable(x) for k, x in v.items() if k not in VOLATILE}
    if isinstance(v, list):
        return [stable(x) for x in v]
    return v


class Sidecar:
    """本物の sidecar.py を子プロセスで起こし、枠で問い合わせる（Rust の窓がすることと同じ）。"""

    def __init__(self, env):
        self.p = subprocess.Popen([sys.executable, str(ROOT / "sidecar.py")], cwd=ROOT, env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.lock, self.next_id, self.waiting = threading.Lock(), 0, {}
        self.ready = self._read()                       # 最初の枠は「準備できた」
        threading.Thread(target=self._loop, daemon=True).start()

    def _read(self):
        line = self.p.stdout.readline()
        if not line:
            return None
        head = json.loads(line)
        body = self.p.stdout.read(head["len"]) if head["len"] else b""
        return head, body

    def _loop(self):
        while True:
            f = self._read()
            if f is None:
                return
            ev = self.waiting.pop(f[0]["id"])
            ev["res"] = f
            ev["done"].set()

    def send_raw(self, raw: bytes):
        with self.lock:
            self.p.stdin.write(raw)
            self.p.stdin.flush()

    def ask(self, method, path, body=b"", headers=None, timeout=30):
        """→ (status, headers dict（小文字）, 本文 bytes)"""
        path, _, query = path.partition("?")
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            ev = self.waiting[rid] = {"done": threading.Event()}
            head = {"id": rid, "method": method, "path": path, "query": query, "headers": headers or {}, "len": len(body)}
            self.p.stdin.write(json.dumps(head).encode("utf-8") + b"\n" + body)
            self.p.stdin.flush()
        if not ev["done"].wait(timeout):
            raise TimeoutError(path)
        h, b = ev["res"]
        return h["status"], {k.lower(): v for k, v in h["headers"]}, b

    def close(self, timeout=10):
        self.p.stdin.close()
        code = self.p.wait(timeout)
        self.p.stdout.close()
        return code


class Parity(unittest.TestCase):
    """アプリへ直接（test_client）と、デスクトップ版の窓口（パイプ）で同じ答えが返るか。"""

    @classmethod
    def setUpClass(cls):
        # 片付けは、裏の糸（ref の一覧の問い合わせで動き出す品質データの写しの係）がまだ書いていても失敗にしない
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        env = {**os.environ, "TRANSFER_LOCAL_ROOT": cls.tmp.name, "PYTHONIOENCODING": "utf-8"}
        cls.old_env = dict(os.environ)
        os.environ["TRANSFER_LOCAL_ROOT"] = cls.tmp.name
        cls.side = Sidecar(env)
        cls.ref = create_app().test_client()

    @classmethod
    def tearDownClass(cls):
        if cls.side.p.poll() is None:
            cls.side.close()
        os.environ.clear()
        os.environ.update(cls.old_env)
        cls.tmp.cleanup()

    def assert_same(self, method, path, json_body=None):
        body = json.dumps(json_body, ensure_ascii=False).encode("utf-8") if json_body is not None else b""
        headers = {"Content-Type": "application/json"} if json_body is not None else {}
        s, h, b = self.side.ask(method, path, body, headers)
        with self.ref.open(path, method=method, data=body, headers=headers) as r:
            self.assertEqual(s, r.status_code, path)
            self.assertEqual(h.get("content-type"), r.headers.get("Content-Type"), path)
            if r.is_json:
                self.assertEqual(stable(json.loads(b)), stable(r.get_json()), path)
                return json.loads(b)
            self.assertEqual(b, r.get_data(), path)
            return b

    def test_ready_frame(self):
        head, _ = self.side.ready
        self.assertEqual(head["event"], "ready", head)
        self.assertEqual(head["protocol"], protocol_of(ROOT / "sidecar.py", r"^PROTOCOL = (\d+)"), "枠の約束の版を名乗る（窓が違う版の中身を起こさない）")
        self.assertEqual(head["id"], 0)
        self.assertTrue(head["version"])

    def test_pages_and_files(self):
        page = self.assert_same("GET", "/")
        self.assertIn("転写距離・ピッチ解析".encode("utf-8"), page)
        self.assert_same("GET", "/static/js/shared.js?v=x")
        self.assert_same("GET", "/lotdsp-link")
        self.assert_same("GET", "/no/such/page")

    def test_json_routes(self):
        for path in ("/api/health", "/api/config", "/api/changelog", "/api/build", "/api/settings",
                     "/api/lots/lotdsp-api/status"):
            self.assert_same("GET", path)

    def test_live_state_has_the_same_shape(self):
        """共有マスタの状態は「いまの鍵」を答える（子プロセスは起動の処理でマスタの初期値を当て、その間は鍵を持つ）。
        時刻で変わる答えなので、中身ではなく状態と形（項目の名前）を比べる（Windows の CI で鍵を持つ瞬間に当たった）。"""
        s, _, b = self.side.ask("GET", "/api/masters/status")
        with self.ref.get("/api/masters/status") as r:
            self.assertEqual((s, sorted(json.loads(b))), (r.status_code, sorted(r.get_json())))

    def test_post_bodies_large_and_japanese(self):
        """約 100KB の画面（日本語）を送って取り込み、その答えで計算する（本文がそのまま届く）。"""
        lot = self.assert_same("POST", "/api/lots/import-lotdsp", {"html": FIXTURE, "lot_no": "L7150C0"})["lot"]
        self.assertEqual(len(lot["processes"]), 10)
        self.assert_same("POST", "/api/calculate", {"lot": lot, "inputs": {}})
        bad = self.assert_same("POST", "/api/lots/import-lotdsp", {"html": ""})
        self.assertIn("空", bad["error"])

    def test_query_with_japanese(self):
        self.assert_same("GET", "/api/lotlist?q=%E6%B1%9A%E3%82%8C&page=1")

    def test_many_at_once_come_back_to_the_right_asker(self):
        paths = ["/api/health", "/api/build", "/api/changelog", "/static/css/app.css"] * 10
        out = [None] * len(paths)

        def go(i, p):
            out[i] = self.side.ask("GET", p)

        ts = [threading.Thread(target=go, args=(i, p)) for i, p in enumerate(paths)]
        for t in ts:
            t.start()
        for t in ts:
            t.join(30)
        expect = {}
        for p in set(paths):
            with self.ref.get(p) as r:
                expect[p] = stable(r.get_json()) if r.is_json else r.get_data()
        for (s, h, b), p in zip(out, paths):
            self.assertEqual(s, 200, p)
            self.assertEqual(stable(json.loads(b)) if "json" in h["content-type"] else b, expect[p], p)


class Robust(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {**os.environ, "TRANSFER_LOCAL_ROOT": self.tmp.name}

    def tearDown(self):
        self.tmp.cleanup()

    def test_closing_input_ends_the_process(self):
        """窓を閉じた（親が終わった）ら、パイプが閉じて子も終わる。ポートの残りもハートビートも無い。"""
        side = Sidecar(self.env)
        self.assertEqual(side.ask("GET", "/api/health")[0], 200)
        t = time.monotonic()
        self.assertEqual(side.close(), 0)
        self.assertLess(time.monotonic() - t, 5)

    def test_print_does_not_break_the_frames(self):
        """アプリのどこかが print しても、枠（標準出力）には混ざらない。"""
        code = ("import sidecar,sys,io\n"
                "rin,w=sidecar.protocol_streams()\n"
                "print('noise'); sys.stdout.write('more noise\\n')\n"
                "w.send({'id':1,'event':'x'}, b'ok')\n")
        out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=self.env, capture_output=True, timeout=30)
        head, _, body = out.stdout.partition(b"\n")
        self.assertEqual(json.loads(head), {"id": 1, "event": "x", "len": 2})
        self.assertEqual(body, b"ok")
        self.assertIn(b"noise", out.stderr)

    def test_broken_frame_gets_an_answer_and_the_rest_continue(self):
        side = Sidecar(self.env)
        # ヘッダーは読めるが、中身がおかしい（method が数）→ 500 の答え。後の問い合わせも答える
        ev = side.waiting[99] = {"done": threading.Event()}
        side.send_raw(json.dumps({"id": 99, "method": 5, "path": "/api/health", "len": 0}).encode() + b"\n")
        self.assertTrue(ev["done"].wait(10))
        self.assertEqual(ev["res"][0]["status"], 500)
        self.assertEqual(side.ask("GET", "/api/health")[0], 200)
        side.close()


@unittest.skipUnless((ROOT.parent / "desktop" / "src" / "sidecar.rs").exists(), "desktop フォルダが無い（配った形）")
class SameProtocol(unittest.TestCase):
    def test_window_and_sidecar_agree(self):
        """窓（Rust）と窓口（Python）の枠の約束の版が同じ（違うと窓は中身を起こさない）。"""
        rust = protocol_of(ROOT.parent / "desktop" / "src" / "sidecar.rs", r"^pub const PROTOCOL: u64 = (\d+);")
        self.assertEqual(rust, protocol_of(ROOT / "sidecar.py", r"^PROTOCOL = (\d+)"))


if __name__ == "__main__":
    unittest.main()
