# -*- coding: utf-8 -*-
"""画面と API の受け口（app/web.py。版 3.8.0 で Flask から置き換えた）。

評価の物差しは「Flask のときと同じ答えか」。置き換えるときに、Flask の版で全部の道・静的ファイル・失敗の答えを記録し、
置き換えた版と突き合わせて同じだったこと（69 件。違いは指紋と一時フォルダの名前だけ）を、ここで決まりとして残す:
道の当て方（<int:>・<path:>・固定の字が長い道が先）・JSON の書き方・404／405 と許す方法・HEAD／OPTIONS・
本文の JSON の読み方（415／400／silent）・画面の型（逃がし・tojson・url_for の ?v=）・静的ファイル（種類・no-cache・304）・
問い合わせの外では request／current_app を使えないこと・糸ごとに別の問い合わせを見ること・Flask を読み込まないこと。
"""
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from app import web
from app.web import App, BadRequest, Blueprint, current_app, jsonify, render_template, request

ROOT = Path(__file__).resolve().parents[1]


def make_app(tmp: Path):
    """静的ファイルと画面の型を持つ試験用のアプリ。"""
    (tmp / "static" / "js").mkdir(parents=True)
    (tmp / "static" / "js" / "a.js").write_text("console.log('あ');\n", encoding="utf-8")
    (tmp / "static" / "LICENSE").write_text("x", encoding="utf-8")
    (tmp / "templates").mkdir()
    (tmp / "templates" / "page.html").write_text(
        "<title>{{ brand.name }}</title><script src=\"{{ url_for('static', filename='js/a.js') }}\"></script>"
        "<script>var S = {{ state|tojson }};</script>{{ missing }}{{ brand.nothing }}\n", encoding="utf-8")
    bp = Blueprint("t", __name__)
    seen = []

    @bp.before_app_request
    def guard():
        seen.append(request.path)
        if request.path == "/blocked":
            return jsonify(error="止めました"), 403
        return None

    @bp.get("/items/<int:item_id>")
    def item(item_id):
        return {"id": item_id, "type": type(item_id).__name__}

    @bp.get("/items/new")
    def item_new():
        return "new"

    @bp.put("/files/<path:key>")
    def file_put(key):
        return jsonify(key=key, body=request.get_json(silent=True))

    @bp.get("/names/<name>")
    def name(name):
        return name

    @bp.post("/strict")
    def strict():
        return jsonify(request.get_json())

    @bp.post("/force")
    def force():
        try:
            return jsonify(request.get_json(force=True))
        except Exception as e:
            return jsonify(error=str(e), type=type(e).__name__), 400

    @bp.get("/page")
    def page():
        resp = current_app.make_response(render_template("page.html", state={"a": "</script><b>", "日": "本"}))
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @bp.get("/args")
    def args():
        return {"q": request.args.get("q"), "n": request.args.get("n", type=int), "all": request.args.getlist("q")}

    @bp.get("/boom")
    def boom():
        raise RuntimeError("中で失敗")

    def listing():
        return jsonify([3, 1])
    bp.add_url_rule("/added", "added", listing, methods=["GET"])

    app = App("t", root=tmp)
    app.register_blueprint(bp)

    @app.url_defaults
    def _v(endpoint, values):
        if endpoint == "static":
            values.setdefault("v", "B1")

    @app.context_processor
    def _brand():
        return {"brand": {"name": "A&B <アプリ>"}}

    return app, seen


class Web(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app, self.seen = make_app(Path(self.tmp.name))
        self.c = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_routes_convert_and_prefer_fixed_text(self):
        self.assertEqual(self.c.get("/items/12").get_json(), {"id": 12, "type": "int"})
        self.assertEqual(self.c.get("/items/new").get_data(as_text=True), "new", "固定の字の道が、変数の道より先")
        self.assertEqual(self.c.get("/items/abc").status_code, 404, "<int:> に字は当たらない")
        r = self.c.put("/files/a/b.c", json={"x": 1})
        self.assertEqual(r.get_json(), {"key": "a/b.c", "body": {"x": 1}}, "<path:> は / も含む")
        self.assertEqual(self.c.get("/names/%E6%97%A5%E6%9C%AC").get_data(as_text=True), "日本", "道の %xx は戻して当てる")
        self.assertEqual(self.c.get("/added").get_json(), [3, 1], "add_url_rule の道")

    def test_json_is_written_like_flask(self):
        r = self.c.get("/items/1")
        self.assertEqual(r.headers["Content-Type"], "application/json")
        self.assertEqual(r.get_data(as_text=True), '{"id":1,"type":"int"}\n', "鍵の順・詰めて書く・最後に改行")
        self.assertEqual(json.loads(web.jsonify(日="本").get_data()), {"日": "本"})
        self.assertIn("\\u65e5", web.jsonify(日="本").get_data(as_text=True), "日本語は \\u で書く")

    def test_404_405_head_options(self):
        r = self.c.get("/nothing")
        self.assertEqual((r.status_code, r.headers["Content-Type"]), (404, "text/html; charset=utf-8"))
        self.assertIn("<title>404 Not Found</title>", r.get_data(as_text=True))
        r = self.c.post("/items/1")
        self.assertEqual(r.status_code, 405)
        self.assertEqual(set(r.headers["Allow"].split(", ")), {"GET", "HEAD", "OPTIONS"})
        r = self.c.open("/items/1", method="OPTIONS")
        self.assertEqual((r.status_code, r.get_data()), (200, b""))
        r = self.c.head("/items/1")
        full = len(self.c.get("/items/1").get_data())
        self.assertEqual((r.status_code, r.get_data(), r.headers["Content-Length"]), (200, b"", str(full)), "HEAD は本文なし・長さは GET と同じ")

    def test_reading_the_json_body(self):
        self.assertEqual(self.c.post("/strict", data=b"{}", headers={"Content-Type": "text/plain"}).status_code, 415)
        self.assertEqual(self.c.post("/strict", data=b"{x", headers={"Content-Type": "application/json"}).status_code, 400)
        r = self.c.post("/force", data=b"{x")
        self.assertEqual(r.get_json(), {"error": str(BadRequest()), "type": "BadRequest"}, "読めない本文は Flask と同じ 400 の文")
        self.assertEqual(self.c.post("/force", data=b'{"a": 1}').get_json(), {"a": 1}, "force は種類を見ない")
        self.assertIsNone(self.c.put("/files/k", data=b"{x", headers={"Content-Type": "application/json"}).get_json()["body"], "silent は None")

    def test_query_args(self):
        r = self.c.get("/args?q=a+b&q=c&n=3").get_json()
        self.assertEqual(r, {"q": "a b", "n": 3, "all": ["a b", "c"]})
        self.assertEqual(self.c.get("/args", query_string={"n": "x"}).get_json()["n"], None, "数にできない値は既定")

    def test_before_request_runs_first_and_can_answer(self):
        r = self.c.get("/blocked")
        self.assertEqual((r.status_code, r.get_json()), (403, {"error": "止めました"}))
        self.c.get("/nothing")
        self.assertIn("/nothing", self.seen, "当たる道が無くても先に呼ぶ（Flask と同じ）")

    def test_template_escapes_and_embeds(self):
        r = self.c.get("/page")
        t = r.get_data(as_text=True)
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertIn("<title>A&amp;B &lt;アプリ&gt;</title>", t, "値は HTML 用に逃がす")
        self.assertIn('src="/static/js/a.js?v=B1"', t, "url_for は url_defaults の ?v= を付ける")
        self.assertIn('var S = {"a": "\\u003c/script\\u003e\\u003cb\\u003e", "\\u65e5": "\\u672c"};', t, "tojson は </script> で切れない")
        self.assertTrue(t.endswith("</script>"), "無い名前は空・最後の改行1つは出さない")

    def test_template_rejects_what_it_cannot_do(self):
        for bad in ("{% if x %}a{% endif %}", "{{ x|upper }}", "{{ x + 1 }}", "{{ __import__('os') }}"):
            with self.assertRaises(ValueError, msg=bad):
                web.Template(bad, "t").render({})

    def test_static_files(self):
        r = self.c.get("/static/js/a.js")
        self.assertEqual((r.status_code, r.headers["Content-Type"], r.headers["Cache-Control"]), (200, "text/javascript; charset=utf-8", "no-cache"))
        self.assertEqual(r.get_data(as_text=True), "console.log('あ');\n")
        again = self.c.get("/static/js/a.js", headers={"If-None-Match": r.headers["ETag"]})
        self.assertEqual((again.status_code, again.get_data()), (304, b""), "変わっていなければ 304")
        since = self.c.get("/static/js/a.js", headers={"If-Modified-Since": r.headers["Last-Modified"]})
        self.assertEqual(since.status_code, 304)
        self.assertEqual(self.c.get("/static/LICENSE").headers["Content-Type"], "application/octet-stream")
        for bad in ("/static/../templates/page.html", "/static/%2e%2e/templates/page.html", "/static/js/none.js", "/static/js"):
            self.assertEqual(self.c.get(bad).status_code, 404, bad)

    def test_errors_inside_a_route(self):
        with self.assertRaises(RuntimeError):            # 試験のときは原因をそのまま上げる
            self.app.config["TESTING"] = True
            self.c.get("/boom")
        self.app.config["TESTING"] = False
        with self.assertLogs("app", "ERROR"):
            r = self.c.get("/boom")
        self.assertEqual(r.status_code, 500)

    def test_request_is_only_inside_a_request_and_per_thread(self):
        with self.assertRaises(RuntimeError):
            request.path                                  # noqa: B018
        got, gate = {}, threading.Barrier(2)

        bp = Blueprint("x", __name__)

        @bp.get("/who/<name>")
        def who(name):
            gate.wait(5)                                  # 2本の問い合わせが同時に中にいる
            return {"path": request.path, "q": request.args.get("q")}
        app = App("x", root=Path(self.tmp.name))
        app.register_blueprint(bp)

        def ask(n):
            got[n] = app.test_client().get(f"/who/{n}?q={n}").get_json()
        ts = [threading.Thread(target=ask, args=(n,)) for n in ("a", "b")]
        [t.start() for t in ts]
        [t.join(10) for t in ts]
        self.assertEqual(got, {"a": {"path": "/who/a", "q": "a"}, "b": {"path": "/who/b", "q": "b"}}, "糸ごとに自分の問い合わせを見る")


class NoFlask(unittest.TestCase):
    def test_app_and_sidecar_do_not_import_flask(self):
        """アプリ（画面・API・窓口）は Flask 一式を読み込まない（同梱の Python から外せる）。"""
        code = ("import sys, app, sidecar; from app import create_app; create_app({'TESTING': True}); "
                "bad = sorted(m for m in sys.modules if m.split('.')[0] in "
                "('flask', 'werkzeug', 'jinja2', 'markupsafe', 'itsdangerous', 'click', 'blinker')); print(','.join(bad))")
        with tempfile.TemporaryDirectory() as tmp:
            out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120,
                                 env={**__import__("os").environ, "TRANSFER_LOCAL_ROOT": tmp})
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        self.assertEqual(out.stdout.strip().splitlines()[-1] if out.stdout.strip() else "", "", "読み込んだ Flask 一式の部品")


if __name__ == "__main__":
    unittest.main()
