# -*- coding: utf-8 -*-
"""画面と API の受け口（Python の標準の部品だけで作る小さな枠組み。版 3.8.0 で Flask から置き換えた）。

アプリが使う所だけを、Flask と同じ名前・同じ使い方で持つ（routes/* と試験を書き換えないため）:
    bp = Blueprint("main")                道を足す: @bp.get / post / put / delete / route(methods=[...])・add_url_rule(道, 名前, 関数, methods=[...])
                                          道の形: "/a/<int:item_id>"（数）・"/a/<path:key>"（/ も含む）・"/a/<name>"
    @bp.before_app_request                問い合わせごとに先に呼ぶ（None 以外を返すと、それを答えにする）
    request.method / path / args / headers / data / get_json(force=, silent=)
    current_app.config / make_response(...)
    jsonify(...)                          JSON の答え（Flask と同じ書き方: 鍵の順にそろえ、詰めて書く）
    render_template(name, **ctx)          画面の型（{{ 式 }} だけ。下の「画面の型」）
    App.test_client()                     試験の口（get / post / put / delete / open・json= data= headers= query_string=）
問い合わせ1つは App.handle(method, path, query, headers, body) → Response（デスクトップ版の窓口 sidecar.py が呼ぶ）。
開発で窓の外（ブラウザ）から見るときは `python -m app [ポート]`（app/__main__.py。この PC の中だけで待ち受ける。配る物では使わない）。
道の答えは Response・dict / list（JSON にする）・str（HTML）・bytes、またはそれと状態コードの組 (答え, 状態)。
置き換えの前後で答えが同じことは tests/test_web.py が確かめる（状態・種類・見出し・中身・404/405・HEAD/OPTIONS・静的ファイル）。
"""
from __future__ import annotations

import ast
import contextvars
import dataclasses
import decimal
import email.utils
import hashlib
import json
import logging
import mimetypes
import re
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode

log = logging.getLogger("app")


# ================================================================ 失敗（状態コードつき）
class HTTPError(Exception):
    """道の中で投げると、その状態の答えになる（Werkzeug と同じ文と同じ HTML）。"""
    code, name, description = 500, "Internal Server Error", ("The server encountered an internal error and was unable to complete "
                                                            "your request. Either the server is overloaded or there is an error in the application.")

    def __str__(self):
        return f"{self.code} {self.name}: {self.description}"

    def response(self):
        page = (f"<!doctype html>\n<html lang=en>\n<title>{self.code} {self.name}</title>\n"
                f"<h1>{self.name}</h1>\n<p>{self.description}</p>\n")
        return Response(page, self.code)


class BadRequest(HTTPError):
    code, name, description = 400, "Bad Request", "The browser (or proxy) sent a request that this server could not understand."


class NotFound(HTTPError):
    code, name, description = (404, "Not Found", "The requested URL was not found on the server. "
                               "If you entered the URL manually please check your spelling and try again.")


class MethodNotAllowed(HTTPError):
    code, name, description = 405, "Method Not Allowed", "The method is not allowed for the requested URL."


class UnsupportedMediaType(HTTPError):
    code, name, description = (415, "Unsupported Media Type",
                               "Did not attempt to load JSON data because the request Content-Type was not 'application/json'.")


# ================================================================ 見出し（名前の大小を区別しない）
class Headers:
    """見出しの並び。名前の大小は区別しない（Content-Type も content-type も同じ）。足した順を保つ。"""

    def __init__(self, items=None):
        self._items: list[list[str]] = []
        for k, v in (items.items() if hasattr(items, "items") else items or []):
            self[k] = v

    def _find(self, key):
        k = key.lower()
        return next((i for i, (n, _) in enumerate(self._items) if n.lower() == k), -1)

    def __getitem__(self, key):
        i = self._find(key)
        if i < 0:
            raise KeyError(key)
        return self._items[i][1]

    def __setitem__(self, key, value):
        i = self._find(key)
        if i < 0:
            self._items.append([key, str(value)])
        else:
            self._items[i][1] = str(value)

    def __delitem__(self, key):
        i = self._find(key)
        if i >= 0:
            del self._items[i]

    def __contains__(self, key):
        return self._find(key) >= 0

    def __iter__(self):
        return iter(n for n, _ in self._items)

    def get(self, key, default=None):
        i = self._find(key)
        return self._items[i][1] if i >= 0 else default

    def items(self):
        return [(n, v) for n, v in self._items]

    def __repr__(self):
        return f"Headers({self.items()!r})"


class Args(dict):
    """問い合わせの ?a=1&b=2。同じ名前が並んだら最初の値（getlist ですべて）。"""

    def __init__(self, query: str):
        self._all = parse_qs(query or "", keep_blank_values=True)
        super().__init__({k: v[0] for k, v in self._all.items()})

    def get(self, key, default=None, type=None):
        if key not in self:
            return default
        if type is None:
            return self[key]
        try:
            return type(self[key])
        except (TypeError, ValueError):
            return default

    def getlist(self, key):
        return list(self._all.get(key, []))


# ================================================================ JSON（Flask の jsonify と同じ書き方）
def _json_default(o):
    if isinstance(o, datetime):
        return email.utils.format_datetime(o.astimezone(timezone.utc) if o.tzinfo else o.replace(tzinfo=timezone.utc), usegmt=True)
    if isinstance(o, date):
        return email.utils.format_datetime(datetime(o.year, o.month, o.day, tzinfo=timezone.utc), usegmt=True)
    if isinstance(o, (decimal.Decimal, uuid.UUID)):
        return str(o)
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return dataclasses.asdict(o)
    if hasattr(o, "__html__"):
        return str(o.__html__())
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def dumps(obj, **kw) -> str:
    """JSON の文字（鍵の順にそろえ、日本語は \\u で書く）。"""
    kw.setdefault("ensure_ascii", True)
    kw.setdefault("sort_keys", True)
    return json.dumps(obj, default=_json_default, **kw)


def jsonify(*args, **kwargs):
    """JSON の答え。jsonify(値) か jsonify(名前=値, ...)（Flask と同じ）。"""
    if args and kwargs:
        raise TypeError("jsonify() は値か名前つきのどちらか一方で呼んでください")
    data = args[0] if len(args) == 1 else (list(args) if args else kwargs)
    return Response(dumps(data, separators=(",", ":")) + "\n", 200, mimetype="application/json")


# ================================================================ 問い合わせと答え
class Request:
    def __init__(self, method: str, path: str, query: str = "", headers=None, body: bytes = b""):
        self.method = method.upper()
        self.path = path or "/"
        self.query_string = query or ""
        self.args = Args(self.query_string)
        self.headers = headers if isinstance(headers, Headers) else Headers(headers or {})
        self.data = body or b""

    def get_data(self, as_text=False):
        return self.data.decode("utf-8", "replace") if as_text else self.data

    @property
    def mimetype(self):
        return (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

    @property
    def is_json(self):
        m = self.mimetype
        return m == "application/json" or (m.startswith("application/") and m.endswith("+json"))

    def get_json(self, force=False, silent=False):
        """本文の JSON。JSON でない（force でない）・読めないときは、silent なら None、でなければ 415／400（Flask と同じ）。"""
        if not (force or self.is_json):
            if silent:
                return None
            raise UnsupportedMediaType()
        try:
            return json.loads(self.data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            if silent:
                return None
            raise BadRequest() from None


class Response:
    def __init__(self, body=b"", status=200, headers=None, mimetype=None):
        self.data = body.encode("utf-8") if isinstance(body, str) else bytes(body or b"")
        self.status_code = int(status)
        self.headers = Headers(headers or {})
        if "Content-Type" not in self.headers:
            mt = mimetype or "text/html"
            self.headers["Content-Type"] = f"{mt}; charset=utf-8" if mt.startswith("text/") else mt

    def get_data(self, as_text=False):
        return self.data.decode("utf-8") if as_text else self.data


# 問い合わせの中だけで使う「いまの問い合わせ」「いまのアプリ」（糸ごとに別。Flask の request・current_app と同じ使い方）
_request_var: contextvars.ContextVar = contextvars.ContextVar("request")
_app_var: contextvars.ContextVar = contextvars.ContextVar("current_app")


class _Local:
    def __init__(self, var, name):
        object.__setattr__(self, "_var", var)
        object.__setattr__(self, "_name", name)

    def _get_current_object(self):
        try:
            return self._var.get()
        except LookupError:
            raise RuntimeError(f"{self._name} は問い合わせを処理している間だけ使えます") from None

    def __getattr__(self, key):
        return getattr(self._get_current_object(), key)

    def __setattr__(self, key, value):
        setattr(self._get_current_object(), key, value)

    def __repr__(self):
        try:
            return repr(self._get_current_object())
        except RuntimeError:
            return f"<{self._name}（問い合わせの外）>"


request: Request = _Local(_request_var, "request")      # type: ignore[assignment]
current_app: "App" = _Local(_app_var, "current_app")     # type: ignore[assignment]


# ================================================================ 道
_CONVERTERS = {"int": (r"\d+", int), "path": (r"[^/].*?", str), "string": (r"[^/]+", str)}


class Rule:
    def __init__(self, pattern: str, methods, fn, endpoint=None):
        self.pattern, self.fn, self.endpoint = pattern, fn, endpoint or fn.__name__
        self.rule = pattern                      # Flask と同じ名前（道の一覧を見る試験が使う）
        self.methods = {m.upper() for m in methods}
        if "GET" in self.methods:
            self.methods.add("HEAD")
        rx, self.converters, statics, n = "", {}, 0, 0
        for part in re.split(r"(<[^>]+>)", pattern):
            m = re.fullmatch(r"<(?:(\w+):)?(\w+)>", part)
            if m:
                kind = m.group(1) or "string"
                if kind not in _CONVERTERS:
                    raise ValueError(f"知らない道の形 <{kind}:…>: {pattern}")
                rx += f"(?P<{m.group(2)}>{_CONVERTERS[kind][0]})"
                self.converters[m.group(2)] = _CONVERTERS[kind][1]
                n += 2 if kind == "path" else 1
            else:
                rx += re.escape(part)
                statics += len(part)
        self.regex = re.compile(rx + r"\Z")
        # 当てる順: 変数の少ない道・固定の字の長い道を先に（"/api/x/status" を "/api/x/<name>" より先に）
        self.weight = (n, -statics)

    def match(self, path):
        m = self.regex.match(path)
        if not m:
            return None
        return {k: self.converters[k](v) for k, v in m.groupdict().items()}


class Blueprint:
    def __init__(self, name: str, import_name: str = ""):
        self.name = name
        self.rules: list[Rule] = []
        self.before: list = []

    def route(self, pattern, methods=("GET",)):
        def deco(fn):
            self.rules.append(Rule(pattern, methods, fn))
            return fn
        return deco

    def add_url_rule(self, pattern, endpoint=None, view_func=None, methods=("GET",)):
        self.rules.append(Rule(pattern, methods or ("GET",), view_func, endpoint))

    def get(self, pattern):
        return self.route(pattern, ("GET",))

    def post(self, pattern):
        return self.route(pattern, ("POST",))

    def put(self, pattern):
        return self.route(pattern, ("PUT",))

    def delete(self, pattern):
        return self.route(pattern, ("DELETE",))

    def before_app_request(self, fn):
        self.before.append(fn)
        return fn


# ================================================================ 画面の型
# 使えるのは {{ 式 }} だけ（式: 名前・名前.名前・url_for('static', filename='…')・文字と数の値）と、その後ろの |tojson・|safe。
# {% %} など、ほかの書き方は読み込むときに失敗させる（気づかずに字のまま出さない）。値は HTML 用に逃がす（|tojson・|safe を除く）。
_TAG = re.compile(r"\{\{(.*?)\}\}", re.S)
_ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;"}


def _escape(s) -> str:
    return re.sub(r"[&<>\"']", lambda m: _ESC[m.group(0)], str(s))


def _tojson(v) -> str:
    """HTML の中に置いても安全な JSON（< > & ' を \\u で書く）。"""
    return (dumps(v).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026").replace("'", "\\u0027"))


class _Undefined:
    def __str__(self):
        return ""


def _lookup(v, name):
    if isinstance(v, dict):
        return v.get(name, _Undefined())
    return getattr(v, name, _Undefined())


def _eval(node, ctx):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return ctx.get(node.id, _Undefined())
    if isinstance(node, ast.Attribute):
        return _lookup(_eval(node.value, ctx), node.attr)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ctx and callable(ctx[node.func.id]):
        return ctx[node.func.id](*[_eval(a, ctx) for a in node.args], **{k.arg: _eval(k.value, ctx) for k in node.keywords})
    raise ValueError(f"画面の型で使えない式です: {ast.dump(node)}")


class Template:
    def __init__(self, source: str, name: str = ""):
        if "{%" in source or "{#" in source:
            raise ValueError(f"画面の型 {name}: {{% %}}・{{# #}} は使えません（{{{{ 式 }}}} だけ）")
        self.parts: list = []
        pos = 0
        for m in _TAG.finditer(source):
            self.parts.append(source[pos:m.start()])
            expr, *filters = [x.strip() for x in m.group(1).split("|")]
            bad = [f for f in filters if f not in ("tojson", "safe")]
            if bad:
                raise ValueError(f"画面の型 {name}: 使えない |{bad[0]}")
            self.parts.append((ast.parse(expr, mode="eval").body, filters))
            pos = m.end()
        tail = source[pos:]
        self.parts.append(tail[:-1] if tail.endswith("\n") else tail)   # 最後の改行1つは出さない（Jinja と同じ）

    def render(self, ctx: dict) -> str:
        out = []
        for p in self.parts:
            if isinstance(p, str):
                out.append(p)
                continue
            node, filters = p
            v = _eval(node, ctx)
            if "tojson" in filters:
                out.append(_tojson(v))
            elif "safe" in filters or getattr(v, "_safe", False):
                out.append(str(v))
            else:
                out.append(_escape(v))
        return "".join(out)


class _Safe(str):
    _safe = True


def render_template(name: str, **ctx) -> str:
    app = current_app._get_current_object()
    return app.render(name, ctx)


# ================================================================ アプリ
class Config(dict):
    pass


class App:
    """アプリ（道・設定・画面の型・静的ファイル）。import_name はこのファイルの置き場を決めるため（Flask と同じ形）。"""

    def __init__(self, import_name: str, root: Path | None = None):
        self.import_name = import_name
        self.root_path = Path(root) if root else Path(__file__).resolve().parent
        self.template_folder = self.root_path / "templates"
        self.static_folder = self.root_path / "static"
        self.config = Config(TESTING=False)
        self.rules: list[Rule] = []
        self.before: list = []
        self.url_default_funcs: list = []
        self.context_processors: list = []
        self._templates: dict = {}

    # ---------- 組み立て ----------
    def register_blueprint(self, bp: Blueprint):
        self.rules.extend(bp.rules)
        self.before.extend(bp.before)
        self.rules.sort(key=lambda r: r.weight)

    @property
    def url_map(self):
        """道の一覧（Flask と同じ使い方: app.url_map.iter_rules() → 各道の .rule・.methods・.endpoint）。"""
        rules = list(self.rules)
        return type("UrlMap", (), {"iter_rules": staticmethod(lambda: iter(rules))})()

    def url_defaults(self, fn):
        self.url_default_funcs.append(fn)
        return fn

    def context_processor(self, fn):
        self.context_processors.append(fn)
        return fn

    # ---------- 画面の型・URL ----------
    def url_for(self, endpoint, **values):
        for fn in self.url_default_funcs:
            fn(endpoint, values)
        if endpoint != "static":
            raise ValueError(f"url_for は static だけに使えます（{endpoint}）")
        path = "/static/" + str(values.pop("filename"))
        return path + ("?" + urlencode(values) if values else "")

    def render(self, name: str, ctx: dict) -> str:
        t = self._templates.get(name)
        if t is None or self.config.get("TESTING"):
            t = self._templates[name] = Template((self.template_folder / name).read_text(encoding="utf-8"), name)
        full = {"url_for": lambda e, **v: _Safe(_escape(self.url_for(e, **v)))}
        for fn in self.context_processors:
            full.update(fn() or {})
        full.update(ctx)
        return t.render(full)

    # ---------- 答えを作る ----------
    def make_response(self, rv):
        status, headers = None, None
        if isinstance(rv, tuple):
            rv, status, *rest = rv + (None,) if len(rv) == 1 else rv
            headers = rest[0] if rest else None
        if isinstance(rv, Response):
            resp = rv
        elif isinstance(rv, (dict, list)):
            resp = jsonify(rv)
        elif isinstance(rv, (str, bytes)):
            resp = Response(rv)
        else:
            raise TypeError(f"道の答えにできない型です: {type(rv).__name__}")
        if status is not None:
            resp.status_code = int(status)
        for k, v in (headers.items() if isinstance(headers, dict) else headers or []):
            resp.headers[k] = v
        return resp

    def _static(self, req: Request, filename: str):
        base = self.static_folder.resolve()
        try:
            p = (base / unquote(filename)).resolve()
        except (OSError, ValueError):
            raise NotFound() from None
        if base not in p.parents or not p.is_file():
            raise NotFound()
        st = p.stat()
        etag = '"' + hashlib.sha1(f"{st.st_mtime_ns}-{st.st_size}-{p.name}".encode()).hexdigest()[:20] + '"'
        last = email.utils.formatdate(st.st_mtime, usegmt=True)
        mt = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        headers = {"Content-Disposition": f"inline; filename={p.name}", "Cache-Control": "no-cache", "ETag": etag, "Last-Modified": last}
        inm, ims = req.headers.get("If-None-Match"), req.headers.get("If-Modified-Since")
        fresh = (inm is not None and etag in [x.strip() for x in inm.split(",")]) or (
            inm is None and ims is not None and _not_modified_since(ims, st.st_mtime))
        if fresh:
            r = Response(b"", 304, headers)
            del r.headers["Content-Type"]
            return r
        return Response(p.read_bytes(), 200, headers, mimetype=mt)

    def dispatch(self, req: Request) -> Response:
        for fn in self.before:
            rv = fn()
            if rv is not None:
                return self.make_response(rv)
        if req.path.startswith("/static/") and req.method in ("GET", "HEAD"):
            return self._static(req, req.path[len("/static/"):])
        allowed = set()
        for rule in self.rules:
            kwargs = rule.match(req.path)
            if kwargs is None:
                continue
            if req.method in rule.methods:
                return self.make_response(rule.fn(**kwargs))
            allowed |= rule.methods
        if allowed:
            allowed.add("OPTIONS")
            if req.method == "OPTIONS":
                return Response(b"", 200, {"Allow": ", ".join(sorted(allowed))})
            r = MethodNotAllowed().response()
            r.headers["Allow"] = ", ".join(sorted(allowed))
            return r
        raise NotFound()

    def handle(self, method: str, path: str, query: str = "", headers=None, body: bytes = b"") -> Response:
        """問い合わせ1つ → 答え。道の中で何が起きても答えを返す（試験のときは失敗をそのまま上げる＝原因が見える）。"""
        req = Request(method, unquote(path or "/"), query, headers, body)
        t_req, t_app = _request_var.set(req), _app_var.set(self)
        try:
            try:
                resp = self.dispatch(req)
            except HTTPError as e:
                resp = e.response()
            except Exception:
                if self.config.get("TESTING"):
                    raise
                log.exception("Exception on %s [%s]", req.path, req.method)
                resp = HTTPError().response()
        finally:
            _request_var.reset(t_req)
            _app_var.reset(t_app)
        if req.method == "HEAD":
            resp.headers["Content-Length"] = len(resp.data)
            resp.data = b""
        return resp

    def test_client(self):
        return TestClient(self)


def _not_modified_since(value: str, mtime: float) -> bool:
    try:
        t = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return False
    return int(mtime) <= int(t.timestamp())


# ================================================================ 試験の口
class TestResponse(Response):
    @property
    def is_json(self):
        m = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        return m == "application/json" or (m.startswith("application/") and m.endswith("+json"))

    def get_json(self, silent=False):
        if not self.is_json:
            return None
        try:
            return json.loads(self.data.decode("utf-8"))
        except ValueError:
            if silent:
                return None
            raise

    @property
    def json(self):
        return self.get_json()

    @property
    def text(self):
        return self.get_data(as_text=True)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestClient:
    """試験の口（Flask の test_client と同じ使い方）。"""

    def __init__(self, app: App):
        self.application = app

    def open(self, path="/", method="GET", json=None, data=None, headers=None, query_string=None, content_type=None):
        h = Headers(headers or {})
        path, _, query = str(path).partition("?")
        if query_string is not None:
            query = query_string if isinstance(query_string, str) else urlencode(query_string, doseq=True)
        if json is not None:
            body = dumps(json).encode("utf-8")
            if "Content-Type" not in h:
                h["Content-Type"] = "application/json"
        elif isinstance(data, dict):
            body = urlencode(data, doseq=True).encode("utf-8")
            if "Content-Type" not in h:
                h["Content-Type"] = "application/x-www-form-urlencoded"
        elif isinstance(data, str):
            body = data.encode("utf-8")
        else:
            body = data or b""
        if content_type and "Content-Type" not in h:
            h["Content-Type"] = content_type
        r = self.application.handle(method, path, query, h, body)
        out = TestResponse(r.data, r.status_code, r.headers.items())
        return out

    def get(self, path="/", **kw):
        return self.open(path, method="GET", **kw)

    def post(self, path="/", **kw):
        return self.open(path, method="POST", **kw)

    def put(self, path="/", **kw):
        return self.open(path, method="PUT", **kw)

    def delete(self, path="/", **kw):
        return self.open(path, method="DELETE", **kw)

    def head(self, path="/", **kw):
        return self.open(path, method="HEAD", **kw)


# ================================================================ 開発用: ブラウザから見る（窓の外。配る物では使わない）
def serve_http(app: App, host: str = "127.0.0.1", port: int = 5000):
    """この PC の中だけで待ち受け、問い合わせを App.handle へ渡す（標準の http.server。開発で画面を見るため）。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _any(self):
            path, _, query = self.path.partition("?")
            n = int(self.headers.get("Content-Length") or 0)
            r = app.handle(self.command, path, query, Headers(list(self.headers.items())), self.rfile.read(n) if n else b"")
            self.send_response(r.status_code)
            for k, v in r.headers.items():
                if k.lower() != "content-length":
                    self.send_header(k, v)
            self.send_header("Content-Length", str(r.headers.get("Content-Length") or len(r.data)))
            self.end_headers()
            self.wfile.write(r.data)
        do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_OPTIONS = _any

        def log_message(self, fmt, *args):
            log.info("%s %s", self.address_string(), fmt % args)

    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"http://{host}:{port}/ で待ち受けています（Ctrl+C で止める）")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()

