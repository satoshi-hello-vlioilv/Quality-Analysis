# -*- coding: utf-8 -*-
"""このアプリで LotDsp（ロット問い合わせ）の進度情報を読む（社内のログイン不要な範囲は見えない Edge・VPN は LotDsp の窓）。

LotDsp は AngularJS の画面で、表はブラウザの中で描かれる（裏の API は公開されていない）。そこで、この PC の
Edge（無ければ Chrome）を**画面に出さずに**（ヘッドレス）起動し、Chrome DevTools Protocol で人と同じ手順
（lotdsp_direct.js: ロット番号を入れて「検索」→「進度情報」→ 描き終わりを待つ）を行い、描き終わった画面の HTML を返す。
HTML の読み方は拡張・貼り付けと同じ lotdsp_progress.py の1箇所。

約束
    - **ログインはしない。** ログインの欄が見えたら何も押さずに LoginRequired（VPN）。ID・パスワードを持つのは
      利用者自身だけで、このアプリはパスワードを扱わない。画面はそれを受けて、LotDsp の窓（下）へ回す。
      （以前はブラウザ版だけ Edge 拡張 LotData-Link へも回した。版 3.0.0 で外した。手順はその lotdsp-relay.js と同じ道）
    - **LotDsp の窓**（版 2.3.0・login_window）: ログインが要るとき、画面に頼まれたら Edge を**見える窓**で開き、
      利用者がその窓で自分でログインするのを待って（アプリは何も押さない）、続きの検索・読み取りをアプリが行う。
      デスクトップ版（WebView2）でも VPN で読める。窓は専用のプロファイル（この PC の作業場所の
      lotdsp-window。利用者の Edge とは別）で開き、閉じても消さない（ログインの覚え・Edge が覚えたパスワードを次に使う。
      覚えるのは Edge で、このアプリではない）。読み終わった窓はしまい（最小化）、ログインが要るときだけ前に出す。
    - 追加のライブラリは要らない（WebSocket の最小限の受け答えをここに持つ）。
    - 起動したブラウザは使い捨ての一時プロファイルで動かし、読み終わったら必ず閉じて消す（利用者の Edge とは別）。
    - 同時に1つだけ（画面の検索ボタンも1つ）。
"""
import base64
import contextlib
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import app_env

from ..fsio import unquote_path

SCRIPT = Path(__file__).with_name("lotdsp_direct.js")
_LOCK = threading.Lock()
# プロキシを通さない問い合わせ（この PC の中の見えない Edge の DevTools・社内の LotDsp。社内のプロキシへ回ると届かない）
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class DirectError(Exception):
    """kind: login（ログインが要る）／ not_found（該当なし）／ unreachable（LotDsp に届かない）／
    no_browser（Edge が無い）／ browser（ブラウザを動かせない）／ screen（画面が想定と違う）／ busy（取込中）"""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


# ------------------------------------------------------------------ 設定
def settings_of(lotdsp_import):
    """lotdsp_import の設定から、直接読むための値。"""
    li = lotdsp_import or {}
    d = li.get("direct") or {}
    url = str(li.get("url") or "").strip()
    return {
        "enabled": bool(d.get("enabled", True)) and bool(url),
        "url": url,
        # LotData-Link の config.js の searchUrl と同じ最初の画面
        "search_url": str(d.get("search_url") or (url.rstrip("/") + "/#/lotdsp" if url else "")),
        "browser": unquote_path(d.get("browser")),
        "timeout_seconds": float(d.get("timeout_seconds", 60)),
        "reach_timeout_seconds": float(d.get("reach_timeout_seconds", 4)),
        # 起こしたブラウザが DevTools を開くまで待つ長さ。ふつうの PC は 1 秒ほど。遅い機械（CI など）では、新しい
        # プロファイルでの起動が 15 秒前後かかることがあるので、その環境の設定で延ばせる（既定は今までと同じ 15 秒）
        "start_timeout_seconds": float(d.get("start_timeout_seconds", 15)),
        "extra_args": [str(a) for a in (d.get("extra_args") or [])],   # 起動に足す引数（既定なし。試験の環境などで使う）
        "keep_seconds": float(d.get("keep_seconds", 300)),   # 読み終わったブラウザを次の検索のために残す長さ（0＝毎回閉じる）
        # LotDsp の窓（ログインが要るとき、利用者がログインする窓）
        "login_window": bool(d.get("login_window", True)),
        "login_wait_seconds": float(d.get("login_wait_seconds", 300)),     # 利用者のログインを待つ長さ
        "window_keep_seconds": float(d.get("window_keep_seconds", 1800)),  # ログインした窓を残す長さ（ログインし直しを減らす）
        "window_profile": unquote_path(d.get("window_profile")) or str(app_env.local_root() / "lotdsp-window"),
    }


def find_browser(configured=""):
    """使うブラウザの実行ファイル。設定があればそれ、無ければ Edge → Chrome の既知の場所。"""
    if configured:
        return configured if Path(configured).is_file() else None
    env = os.environ.get("TPA_LOTDSP_BROWSER", "")
    if env and Path(env).is_file():
        return env
    cands = []
    if sys.platform.startswith("win"):
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
            if base:
                cands += [Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                          Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"]
    for name in ("msedge", "microsoft-edge", "microsoft-edge-stable", "google-chrome", "chromium", "chromium-browser"):
        w = shutil.which(name)
        if w:
            cands.append(Path(w))
    return next((str(p) for p in cands if p.is_file()), None)


def reachable(url, timeout):
    """LotDsp のサイトへ届くか（届かなければブラウザを起こさずに早く答える）。HTTP の答えが返れば届いている。
    社内のサイトなので、まずプロキシを通さずに試し、だめなら PC のプロキシ設定で試す（どちらかで届けばよい）。"""
    for opener in (_LOCAL, urllib.request.build_opener()):
        try:
            with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout):
                return True
        except urllib.error.HTTPError:
            return True      # 401 などでも、サイトには届いている（ログインの有無はブラウザで見る）
        except Exception:
            continue
    return False


# ------------------------------------------------------------------ WebSocket（最小限）
class _WebSocket:
    """DevTools Protocol 用の最小限の WebSocket（テキストの送受・ping への pong・分割の組み立て）。"""

    def __init__(self, url, timeout):
        u = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (("?" + u.query) if u.query else "")
        req = (f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise DirectError("browser", "ブラウザとの接続が切れました（DevTools の握手）")
            head += chunk
        status, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n", 1)[0]:
            raise DirectError("browser", "ブラウザが DevTools の接続を断りました（管理者の設定で止められている可能性があります）")
        self.buf = rest

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise DirectError("browser", "ブラウザとの接続が切れました")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode("utf-8")
        head = bytes([0x81])
        n = len(data)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _send_control(self, opcode, payload=b""):
        mask = os.urandom(4)
        self.sock.sendall(bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        parts = []
        while True:
            b1, b2 = self._read(2)
            opcode, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b2 & 0x80:
                mask = self._read(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(n)))
            else:
                payload = self._read(n)
            if opcode == 0x9:
                self._send_control(0xA, payload)
                continue
            if opcode == 0x8:
                raise DirectError("browser", "ブラウザが接続を閉じました")
            if opcode in (0x1, 0x2, 0x0):
                parts.append(payload)
                if b1 & 0x80:
                    return b"".join(parts).decode("utf-8", "replace")

    def close(self):
        with contextlib.suppress(OSError):
            self.sock.close()


class _Cdp:
    """1つのページへの DevTools Protocol の呼び出し（id で答えを待つ・届く合図は読み捨てる）。"""

    def __init__(self, ws_url, timeout):
        self.ws = _WebSocket(ws_url, timeout)
        self.next_id = 0

    def call(self, method, params=None, timeout=30):
        self.next_id += 1
        mid = self.next_id
        self.ws.sock.settimeout(timeout)
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            try:
                msg = json.loads(self.ws.recv())
            except socket.timeout:
                raise DirectError("screen", "ロット問い合わせの画面の応答がありません（時間切れ）") from None
            if msg.get("id") == mid:
                if "error" in msg:
                    raise DirectError("browser", f"ブラウザの操作に失敗しました（{msg['error'].get('message', '')}）")
                return msg.get("result") or {}

    def eval(self, expression, timeout=30, await_promise=False):
        r = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": await_promise},
                      timeout=timeout)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise DirectError("screen", f"ページの中の手順が止まりました（{(d.get('exception') or {}).get('description') or d.get('text')}）")
        return (r.get("result") or {}).get("value")

    def close(self):
        self.ws.close()


# ------------------------------------------------------------------ 本体
# 途中経過（画面が 0.5 秒ごとに尋ねる）・中止の合図・使い回すブラウザ。どれもこの PC で1つ（同時に1つだけ読む）。
STAGES = ("reach", "open", "load", "login", "search", "read")
_STATUS = {"lot": "", "stage": "", "since": 0.0, "reused": False}
_CANCEL = threading.Event()
_SESSION = None          # 使い回す見えない Edge（_Browser）
_SESSION_LOCK = threading.Lock()


def status():
    """いまの途中経過。{busy, lot, stage, seconds, reused}"""
    busy = _LOCK.locked()
    return {"busy": busy, "lot": _STATUS["lot"] if busy else "", "stage": _STATUS["stage"] if busy else "",
            "seconds": round(time.time() - _STATUS["since"], 1) if busy else 0, "reused": _STATUS["reused"]}


def cancel():
    """「中止」: 読んでいる途中なら止める（使っていたブラウザは閉じる）。"""
    if _LOCK.locked():
        _CANCEL.set()
        return True
    return False


def _stage(name):
    _STATUS["stage"] = name
    if _CANCEL.is_set():
        raise DirectError("cancelled", "中止しました")


def _launch(exe, profile, extra=(), visible=False):
    # 見える窓（LotDsp の窓）は、タブもアドレス欄も無いアプリの窓にする。見えない Edge は画面に出さない
    look = ["--app=about:blank", "--window-size=1280,900"] if visible else ["--headless=new", "--disable-gpu", "--window-size=1600,1000"]
    args = [exe, *look, "--remote-debugging-port=0", f"--user-data-dir={profile}",
            "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
            "--disable-background-networking", "--disable-component-update", *extra]
    if not visible:
        args.append("about:blank")
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform.startswith("win"):
        kw["creationflags"] = 0x08000000          # CREATE_NO_WINDOW: 黒い窓を出さない
    return subprocess.Popen(args, **kw)


def _devtools_port(profile, proc, timeout=15.0):
    """起動したブラウザが書く DevToolsActivePort（1行目がポート）を待つ（timeout 秒まで）。"""
    f = Path(profile) / "DevToolsActivePort"
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            raise DirectError("browser", "ブラウザがすぐに終わりました（管理者の設定でヘッドレス起動・DevTools が止められている可能性があります）")
        try:
            port = int(f.read_text().splitlines()[0])
            if port:
                return port
        except (OSError, ValueError, IndexError):
            pass
        time.sleep(0.1)
    raise DirectError("browser", f"ブラウザの DevTools が開きませんでした（{timeout:g} 秒待ちました。管理者の設定で止められているか、"
                                 "起動に時間がかかっている可能性があります）")


def _page_ws(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with _LOCAL.open(f"http://127.0.0.1:{port}/json/list", timeout=3) as r:
                pages = [t for t in json.loads(r.read().decode()) if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise DirectError("browser", "ブラウザのページに接続できませんでした")


class _Browser:
    """Edge 1つとそのページ。読み終わっても残し、次の検索で使い回す（起動と LotDsp の画面の読み込みを省く）。
    見えない Edge は一時プロファイルで動かし、閉じるときに消す。LotDsp の窓（visible）は専用のプロファイルを残す。"""

    def __init__(self, exe, extra, visible=False, profile=None, start_timeout=15.0):
        self.exe, self.extra, self.visible = exe, tuple(extra), visible
        self.keep_profile = bool(profile)
        if profile:
            Path(profile).mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(OSError):           # 前に開いたときのポートを読まない
                (Path(profile) / "DevToolsActivePort").unlink()
        self.profile = profile or tempfile.mkdtemp(prefix="tpa-lotdsp-")
        self.proc = None
        self.cdp = None
        self.used = time.time()
        try:
            self.proc = _launch(exe, self.profile, self.extra, visible)
            self.cdp = _Cdp(_page_ws(_devtools_port(self.profile, self.proc, start_timeout)), timeout=10)
        except BaseException:
            self.close()
            raise

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def close(self):
        if self.cdp:
            with contextlib.suppress(Exception):
                self.cdp.call("Browser.close", timeout=3)
            self.cdp.close()
            self.cdp = None
        if self.proc:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    self.proc.wait(timeout=5)             # 止めたプロセスを片付ける（残骸を残さない）
            self.proc = None
        if self.keep_profile:
            return
        for _ in range(10):         # Windows ではブラウザが消えるまでファイルが掴まれている
            shutil.rmtree(self.profile, ignore_errors=True)
            if not os.path.exists(self.profile):
                break
            time.sleep(0.3)


def shutdown():
    """使い回しているブラウザを閉じる（アプリの終了・読めなかったとき・しばらく使わないとき）。"""
    global _SESSION
    with _SESSION_LOCK:
        b, _SESSION = _SESSION, None
    if b:
        b.close()


def _idle_watch(keep_seconds):
    """keep_seconds 使われなければ閉じる（読んでいる最中は閉じない）。"""
    def loop():
        while True:
            time.sleep(min(30, max(5, keep_seconds / 4)))
            b = _SESSION
            if b is None:
                return
            if not _LOCK.locked() and time.time() - b.used > keep_seconds:
                shutdown()
                return
    threading.Thread(target=loop, name="lotdsp-idle", daemon=True).start()


def _session(cfg, exe, visible=False):
    """使い回せるブラウザがあればそれ、無ければ起こす。戻り値 (browser, reused)。
    LotDsp の窓（ログイン済みのことがある）は、見えない読み方の頼みにも使い回す。窓を頼まれたら見えない Edge は閉じて開き直す。"""
    global _SESSION
    b = _SESSION
    if b and b.alive() and b.exe == exe and b.extra == tuple(cfg.get("extra_args") or ()) and (b.visible or not visible):
        return b, True
    shutdown()
    _stage("open")
    b = _Browser(exe, cfg.get("extra_args") or (), visible, cfg["window_profile"] if visible else None,
                 cfg.get("start_timeout_seconds", 15))
    with _SESSION_LOCK:
        _SESSION = b
    _window(b, "minimized")                 # 窓はログインが要るときだけ前に出す
    keep = cfg.get("window_keep_seconds", 0) if visible else cfg.get("keep_seconds", 0)
    if keep > 0:
        _idle_watch(keep)
    return b, False


def _window(b, state):
    """LotDsp の窓を出し入れする（normal: 前に出す・minimized: しまう）。できなくても読むのは続ける。"""
    if not b.visible:
        return
    with contextlib.suppress(DirectError):
        wid = b.cdp.call("Browser.getWindowForTarget", timeout=5)["windowId"]
        b.cdp.call("Browser.setWindowBounds", {"windowId": wid, "bounds": {"windowState": state}}, timeout=5)
        if state == "normal":
            b.cdp.call("Page.bringToFront", timeout=5)


_PAGE_STATE = """(() => {
  const norm = (s) => String(s || '').normalize('NFKC').replace(/\\s+/g, '');
  let lot = '';
  for (const t of document.querySelectorAll('table')) {
    const r = t.rows;
    if (r.length === 2 && r[0].cells.length === 1 && norm(r[0].textContent) === 'ロット番号') { lot = norm(r[1].textContent).toUpperCase(); break; }
  }
  return [location.href, document.readyState, lot];
})()"""


def _open_search_page(b, cfg, lot_no, reused):
    """LotDsp の検索できる画面にする。使い回しのページが LotDsp にいて、別のロットを出していれば読み込み直さない
    （上の検索欄からそのまま検索する）。同じロットを出していれば、新しい値を読むために開き直す。"""
    site = cfg["url"].rstrip("/")
    here = False
    if reused:
        try:
            href, ready, shown = b.cdp.eval(_PAGE_STATE, timeout=5) or ["", "", ""]
        except DirectError:
            href, ready, shown = "", "", ""
        # 設定の最初の画面と同じ場所（# より前）にいるときだけ続けて使う（LotDsp の場所を変えたら開き直す）
        here = str(href).split("#")[0] == cfg["search_url"].split("#")[0] and ready != "loading"
        if here and shown != lot_no:
            return
    _stage("load")
    if here:
        # 同じロットを出している: 読み込み直す（同じ URL へ移るだけだと # 以降が同じで読み込み直さず、
        # 古い結果を「検索の結果」と取り違える）
        b.cdp.call("Page.navigate", {"url": cfg["search_url"]}, timeout=20)
        b.cdp.call("Page.reload", {"ignoreCache": False}, timeout=20)
    else:
        b.cdp.call("Page.navigate", {"url": cfg["search_url"]}, timeout=20)
    end = time.time() + 20
    while True:
        try:
            st = b.cdp.eval("[location.href, document.readyState]", timeout=5)
        except DirectError:
            st = None       # 移る途中は評価できないことがある
        if st and str(st[0]).startswith(site) and st[1] != "loading":
            return
        if time.time() > end:
            raise DirectError("unreachable", "LotDsp のページを開けませんでした（時間切れ）")
        _stage("load")
        time.sleep(0.2)


def _run(b, cfg, lot_no, wait_login=False):
    """読む。wait_login（LotDsp の窓）なら、ログインの欄が見えているあいだは窓を前に出して利用者のログインを待ち、
    終わったら（欄が消えたら）続きを読む。アプリは何も押さない（手順はログインの欄を見ると何もせずに引き返すので、
    1 秒ごとに入れ直して確かめる）。ログインのあとに画面が入れ替わったときも入れ直す。"""
    if not wait_login:
        return _run_once(b, cfg, lot_no)
    end = time.time() + cfg["login_wait_seconds"]
    asked = False
    while True:
        if asked:
            # 利用者がログインし終えるのを待つ（欄が消えるまで）。消えたら、利用者が押した検索が落ち着くのを少し待つ
            # （すぐに検索すると、利用者の検索の答えと重なる）
            while _eval_quiet(b, _LOGIN_SHOWN) is not False:
                _login_deadline(cfg, end)
                _stage("login")
                time.sleep(1)
            time.sleep(1.5)
        try:
            html = _run_once(b, cfg, lot_no)
            if asked:
                _window(b, "minimized")
            return html
        except DirectError as e:
            if e.kind not in ("login", "swapped"):
                raise
            if e.kind == "login" and not asked:
                asked = True
                _window(b, "normal")
                # ロット番号だけ欄に入れておく（利用者は ID・パスワードを入れて「検索」を押せば、そのロットまで出る）
                _eval_quiet(b, _PREFILL.replace("__LOT__", json.dumps(lot_no)))
            _login_deadline(cfg, end)
        _stage("login")
        time.sleep(1)


def _login_deadline(cfg, end):
    if time.time() > end:
        raise DirectError("login", f"LotDsp の窓でのログインを {int(cfg['login_wait_seconds'])} 秒待ちましたが、終わりませんでした")


def _eval_quiet(b, expression):
    """評価できなければ None（ページが移る途中など）。"""
    try:
        return b.cdp.eval(expression, timeout=5)
    except DirectError:
        return None


# ログインの欄が見えているか（lotdsp_direct.js の loginShown と同じ見方）
_LOGIN_SHOWN = """(() => {
  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  return shown(document.querySelector('#input_userId')) || [...document.querySelectorAll('button')].some((b) => shown(b) && /ログイン/.test(b.textContent || ''));
})()"""
# ログインを待つあいだ、空いているロット番号の欄にだけロット番号を入れる（ID・パスワードの欄には触れない）
_PREFILL = """((lot) => {
  for (const id of ['input_searchLtno', 'common_searchLtno']) {
    const el = document.getElementById(id);
    if (el && !el.value) { el.value = lot; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  return true;
})(__LOT__)"""


def _run_once(b, cfg, lot_no):
    """ページの中の手順（lotdsp_direct.js）を走らせ、0.25 秒ごとに段階と結果を尋ねる（途中経過・中止のため）。"""
    _stage("search")
    total_ms = int(max(10, cfg["timeout_seconds"] - 5) * 1000)
    js = SCRIPT.read_text(encoding="utf-8").replace("__LOT__", json.dumps(lot_no)).replace("__TOTAL_MS__", str(total_ms))
    b.cdp.eval(js, timeout=10)
    end = time.time() + cfg["timeout_seconds"]
    while True:
        try:
            st = b.cdp.eval("window.__tpaDirect ? [window.__tpaDirect.stage, window.__tpaDirect.result] : null", timeout=10)
        except DirectError as e:
            if e.kind != "screen" or "時間切れ" in str(e):
                raise
            st = None                       # 移る途中で評価できなかった
        if not st:
            raise DirectError("swapped", "ロット問い合わせの画面が途中で入れ替わりました")
        stage, res = st
        if res:
            if not res.get("ok"):
                raise DirectError(res.get("kind") or "screen", res.get("error") or "進度情報を読めませんでした")
            return res["html"]
        if stage in STAGES:
            _stage(stage)
        if _CANCEL.is_set():
            raise DirectError("cancelled", "中止しました")
        if time.time() > end:
            raise DirectError("screen", "ロット問い合わせの画面の応答がありません（時間切れ）")
        time.sleep(0.25)


def fetch_progress_html(lot_no, cfg, window=False):
    """ロット番号で LotDsp を検索し、進度情報を描き終わった画面の HTML を返す。失敗は DirectError（kind つき）。
    ブラウザは使い回す（cfg.keep_seconds）。使い回しのページが壊れていたら、1度だけ起こし直して読み直す。
    window: LotDsp の窓で読む（ログインが要れば利用者を待つ）。画面が、ログインが要ったあとに頼む。"""
    lot_no = str(lot_no or "").strip().upper()
    if not lot_no or not lot_no.isalnum() or len(lot_no) > 12:
        raise DirectError("invalid", f"ロット番号の形が違います（{lot_no or '空'}）")
    if not cfg.get("enabled"):
        raise DirectError("disabled", "このアプリだけで LotDsp を読む設定が切ってあります（lotdsp_import.direct.enabled）")
    if not _LOCK.acquire(blocking=False):
        raise DirectError("busy", "いまほかのロットを LotDsp から読んでいます。終わってからもう一度押してください")
    _CANCEL.clear()
    _STATUS.update(lot=lot_no, stage="", since=time.time(), reused=False)
    try:
        for attempt in (0, 1):
            b = _SESSION
            if not (b and b.alive()):
                _stage("reach")          # 起こす前にだけ確かめる（使い回しのときは届いている）。社外なら Edge を探す前に言う
                if not reachable(cfg["url"], cfg["reach_timeout_seconds"]):
                    raise DirectError("unreachable", f"LotDsp（{cfg['url']}）に届きません（社外・VPN 未接続・サイトの停止）")
            exe = find_browser(cfg.get("browser", ""))
            if not exe:
                raise DirectError("no_browser", "LotDsp を裏で開くブラウザ（Edge）が見つかりません（「マスタ管理」の「参照先」で場所を入れられます）")
            visible = bool(window and cfg.get("login_window"))
            b, reused = _session(cfg, exe, visible)
            _STATUS["reused"] = reused
            try:
                _open_search_page(b, cfg, lot_no, reused)
                html = _run(b, cfg, lot_no, wait_login=visible)
                b.used = time.time()
                if not cfg.get("keep_seconds", 0) > 0:
                    shutdown()
                return html
            except DirectError as e:
                if e.kind == "not_found":
                    b.used = time.time()    # 該当なしは正しい答え。ページはそのまま次に使える
                    raise
                shutdown()                  # ログインが要る（VPN）・中止・壊れた ときは残さない
                if e.kind in ("login", "cancelled", "browser", "unreachable") or not reused or attempt:
                    raise
                # 使い回しのページが想定外の画面だった → 1度だけ起こし直して読み直す
    finally:
        _STATUS["stage"] = ""
        _LOCK.release()

