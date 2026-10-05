# -*- coding: utf-8 -*-
"""このアプリだけで LotDsp を読む（app/services/lotdsp_direct.py・/api/lots/fetch-lotdsp）。

LotData-Link が無くても、社内のログイン不要な範囲なら「検索」だけで取り込めること。ログインの画面（VPN）では
何も押さずに kind: login を返し、画面が LotData-Link（無ければ貼り付け）へ回せること。

本物のブラウザで確かめる試験は、Chromium（または Edge）がある環境でだけ動く（無ければ飛ばす）。
LotDsp の見本は LotData-Link の tests/fixtures/lotdsp_progress.html の写し（tests/fixtures/lotdsp_site_fake.html:
検索・遅れて出る「検索」・タブ・描き終わりまで行数が動く実績の表・?vpn=1 の一体型ログイン）。

    python -m unittest discover -s tests
"""
import http.server
import os
import socket
import threading
import time
import unittest
from pathlib import Path

import tempfile

from app import create_app
from app.repositories.master_store import MasterStore
from app.services import lotdsp_direct as D

ROOT = Path(__file__).resolve().parents[1]
SITE = (ROOT / "tests" / "fixtures" / "lotdsp_site_fake.html").read_bytes()
CHROMIUM = os.environ.get("TPA_TEST_BROWSER") or next(
    (p for p in ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome",) if Path(p).is_file()), None) or D.find_browser()
# この試験の環境（Linux の root）ではサンドボックスを外さないと起動しない。Windows の利用者には足さない。
EXTRA = ["--no-sandbox"] if hasattr(os, "geteuid") and os.geteuid() == 0 else []


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Settings(unittest.TestCase):
    def test_search_url_from_the_lotdsp_url(self):
        cfg = D.settings_of({"url": "http://nlmfangyweb1a/LotDspWeb/"})
        self.assertTrue(cfg["enabled"])
        self.assertEqual(cfg["search_url"], "http://nlmfangyweb1a/LotDspWeb/#/lotdsp", "LotData-Link の searchUrl と同じ最初の画面")

    def test_disabled_without_url_or_by_setting(self):
        self.assertFalse(D.settings_of({"url": ""})["enabled"])
        self.assertFalse(D.settings_of({"url": "http://x/", "direct": {"enabled": False}})["enabled"])

    def test_configured_browser_must_exist(self):
        self.assertIsNone(D.find_browser("/no/such/msedge.exe"))

    def test_reachable(self):
        self.assertFalse(D.reachable(f"http://127.0.0.1:{free_port()}/", 1))


class Api(unittest.TestCase):
    """ブラウザを起こす前に答えられる失敗（どの PC でも動く）。"""

    def client(self, lotdsp_import):
        app = create_app({"TESTING": True, "MASTER_STORE": MasterStore(ROOT, local_root=Path(tempfile.mkdtemp()), settings={})})
        app.config["APP_SETTINGS"]["lotdsp_import"] = lotdsp_import
        return app.test_client()

    def test_unreachable_is_quick_and_says_why(self):
        c = self.client({"url": f"http://127.0.0.1:{free_port()}/LotDspWeb/", "direct": {"reach_timeout_seconds": 1}})
        t = time.time()
        r = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (503, "unreachable"))
        self.assertIn("届きません", r.get_json()["error"])
        self.assertLess(time.time() - t, 5, "届かないときはブラウザを起こさずに早く答える")

    def test_invalid_lot(self):
        c = self.client({"url": "http://127.0.0.1:9/LotDspWeb/"})
        r = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L71;50"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (400, "invalid"))

    def test_config_tells_the_screen(self):
        self.assertTrue(self.client({"url": "http://x/"}).get("/api/config").get_json()["lotdsp_direct"])
        self.assertFalse(self.client({"url": "http://x/", "direct": {"enabled": False}}).get("/api/config").get_json()["lotdsp_direct"])


class SiteServer(unittest.TestCase):
    """見本の LotDsp を HTTP で出す（本物のブラウザの試験の土台。試験は持たない）。"""

    @classmethod
    def setUpClass(cls):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(SITE)))
                self.end_headers()
                self.wfile.write(SITE)

            def log_message(self, *a):
                pass
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/LotDspWeb/"

    @classmethod
    def tearDownClass(cls):
        D.shutdown()
        cls.srv.shutdown()

    def client(self, query=""):
        app = create_app({"TESTING": True, "MASTER_STORE": MasterStore(ROOT, local_root=Path(tempfile.mkdtemp()), settings={})})
        app.config["APP_SETTINGS"]["lotdsp_import"] = {
            "url": self.url, "only_master_equipment": True,
            "direct": {"browser": CHROMIUM, "extra_args": EXTRA, "timeout_seconds": 40,
                       "search_url": self.url + query + "#/lotdsp"}}
        return app.test_client()


@unittest.skipUnless(CHROMIUM, "Chromium／Edge が無い環境では飛ばす")
class RealBrowser(SiteServer):
    """本物のブラウザを画面に出さずに動かして読む。"""

    def test_reads_and_imports_without_the_extension(self):
        r = self.client().post("/api/lots/fetch-lotdsp", json={"lot_no": "l7150c0"})
        d = r.get_json()
        self.assertEqual(r.status_code, 200, d)
        self.assertEqual(d["lot"]["lot_no"], "L7150C0")
        self.assertEqual([p["equipment"] for p in d["lot"]["processes"]][:3], ["HOT", "L-1", "L-1"])
        self.assertEqual(d["report"]["actual_rows"], 10, "実績の行が描き終わるまで待ってから読む（行は2回に分けて描かれる）")

    def test_not_found(self):
        r = self.client().post("/api/lots/fetch-lotdsp", json={"lot_no": "X9999"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (404, "not_found"))
        self.assertIn("見つかりません", r.get_json()["error"])

    def test_login_screen_is_left_to_lotdata_link(self):
        D.shutdown()
        r = self.client("?vpn=1").post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "login"), "ログインが要る画面では押さずに引き返す")

    def test_browser_is_reused_then_removed(self):
        """見えない Edge は次の検索のために残して使い回し（起動と画面の読み込みを省く）、閉じれば一時プロファイルを消す。"""
        import glob
        D.shutdown()
        before = set(glob.glob(os.path.join(tempfile.gettempdir(), "tpa-lotdsp-*")))
        c = self.client()
        r = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertFalse(D.status()["reused"])
        t = time.time()
        r = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual(r.status_code, 200, f"同じロットをもう一度（読み込み直して読む）: {r.get_json()}")
        self.assertTrue(D.status()["reused"])
        self.assertLess(time.time() - t, 8)
        D.shutdown()
        self.assertEqual(set(glob.glob(os.path.join(tempfile.gettempdir(), "tpa-lotdsp-*"))) - before, set(), "閉じたら一時プロファイルは消す")

    def test_status_and_cancel(self):
        self.assertEqual(self.client().get("/api/lots/fetch-lotdsp/status").get_json()["busy"], False)
        self.assertFalse(self.client().post("/api/lots/fetch-lotdsp/cancel").get_json()["cancelled"], "読んでいないときは何もしない")


# 見える窓を出せる環境（Windows・Linux は画面のあるとき。試験は xvfb-run でも動く）
WINDOW_OK = bool(CHROMIUM) and (os.name == "nt" or bool(os.environ.get("DISPLAY")))


@unittest.skipUnless(WINDOW_OK, "見える窓を出せない環境では飛ばす（Linux は xvfb-run で動かす）")
class LoginWindow(SiteServer):
    """ログインが要るとき（VPN）: LotDsp の窓を出し、利用者がログインしたら、続きをアプリが読む（LotData-Link が無くても）。
    アプリは ID・パスワードを扱わず、ログインも押さない。利用者の手は、同じ窓へつないだもう1本の DevTools で演じる。"""

    def client(self, query="?vpn=1", wait=60):
        c = super().client(query)
        c.application.config["APP_SETTINGS"]["lotdsp_import"]["direct"].update(
            window_profile=self.profile, login_wait_seconds=wait)
        return c

    def setUp(self):
        D.shutdown()
        self.profile = tempfile.mkdtemp(prefix="tpa-window-test-")

    def tearDown(self):
        D.shutdown()

    def fetch_in_background(self, c, **body):
        out = {}
        t = threading.Thread(target=lambda: out.update(r=c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0", **body})))
        t.start()
        return t, out

    def wait_stage(self, stage, limit=30):
        end = time.time() + limit
        seen = []
        while time.time() < end:
            st = D.status()["stage"]
            if st and (not seen or seen[-1] != st):
                seen.append(st)
            if st == stage:
                return seen
            time.sleep(0.1)
        self.fail(f"段階 {stage} になりません（{seen}）")

    def user(self):
        """利用者の手: 窓のページへ別につなぐ。"""
        port = int((Path(self.profile) / "DevToolsActivePort").read_text().splitlines()[0])
        return D._Cdp(D._page_ws(port), timeout=10)

    def test_waits_for_the_user_to_log_in_then_reads(self):
        c = self.client()
        t, out = self.fetch_in_background(c, login_window=True)
        self.wait_stage("login")
        hand = self.user()
        self.assertEqual(hand.eval("__fake.vpnSent.length"), 0, "アプリは ID・パスワードを送らない")
        self.assertEqual(hand.eval("__fake.loginClicks"), 0, "アプリはログインを押さない")
        # 利用者: ID・パスワードを入れて、同じ枠の「検索」を押す（VPN の一体型の画面。ボタンは少し遅れて出る）
        hand.eval("""(async () => { const put = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles: true})); };
          put(document.querySelector('#input_userId'), 'wl-user'); put(document.querySelector('#input_password'), 'p@ss w0rd');
          for (let i = 0; i < 40 && !document.querySelector('#startBtnRow button'); i++) await new Promise((r) => setTimeout(r, 100));
          document.querySelector('#startBtnRow button').click(); return true; })()""", await_promise=True)
        t.join(60)
        r = out["r"]
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["lot"]["lot_no"], "L7150C0")
        sent = hand.eval("__fake.vpnSent")
        self.assertEqual(len(sent), 1, "送ったのは利用者の1回だけ")
        self.assertEqual(sent[0]["lot"], "L7150C0", "ロット番号はアプリが欄に入れておいた（利用者は ID・パスワードと「検索」だけ）")
        self.assertEqual(hand.eval("__fake.startSearches"), 1, "利用者の検索のあと、アプリは検索し直さない（答えが重ならない）")
        hand.close()
        # 2 回目: ログインした窓を使い回す（窓の道を頼まなくても。ログインの待ちは無い）
        r2 = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual(r2.status_code, 200, r2.get_json())
        self.assertTrue(D.status()["reused"])
        # 閉じても、窓のプロファイル（ログインの覚え）は残す（一時プロファイルとは違う）
        D.shutdown()
        self.assertTrue(Path(self.profile).is_dir() and any(Path(self.profile).iterdir()))

    def test_gives_up_when_nobody_logs_in(self):
        c = self.client(wait=3)
        t0 = time.time()
        r = c.post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0", "login_window": True})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "login"), r.get_json())
        self.assertIn("ログイン", r.get_json()["error"])
        self.assertLess(time.time() - t0, 30)

    def test_cancel_while_waiting(self):
        c = self.client()
        t, out = self.fetch_in_background(c, login_window=True)
        self.wait_stage("login")
        self.assertTrue(D.cancel())
        t.join(20)
        self.assertEqual((out["r"].status_code, out["r"].get_json()["kind"]), (409, "cancelled"))

    def test_window_is_not_used_unless_asked(self):
        r = self.client().post("/api/lots/fetch-lotdsp", json={"lot_no": "L7150C0"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "login"), "頼まれなければ窓を出さずに引き返す（LotData-Link・窓の道は画面が選ぶ）")
        self.assertFalse(any(Path(self.profile).iterdir()), "窓のプロファイルは使っていない")

    def test_config_tells_the_screen(self):
        c = self.client()
        self.assertTrue(c.get("/api/config").get_json()["lotdsp_login_window"])
        c.application.config["APP_SETTINGS"]["lotdsp_import"]["direct"]["login_window"] = False
        self.assertFalse(c.get("/api/config").get_json()["lotdsp_login_window"])


if __name__ == "__main__":
    unittest.main()
