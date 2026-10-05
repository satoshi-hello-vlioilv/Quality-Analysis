# -*- coding: utf-8 -*-
"""LotDsp の API の応答の項目 ↔ 画面の見出し の紐づけ（app/services/lotdsp_link.py・/api/lots/lotdsp-api/link・/lotdsp-link）。

見本の画面（tests/fixtures/lotdsp_progress_L7150C0.html）と、その値から作った疑似の応答（test_lotdsp_api.entity_of）で、
値の一致から見出しが決まること・複数のロットで偶然の一致が消えること・出力に値が入らないことを確かめる。

    python -m unittest discover -s tests
"""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from app import create_app
from app.services import lotdsp_api as api
from app.services import lotdsp_link as L
from tests.test_lotdsp_api import FIXTURE, Learning, entity_of, html_with_offs

TAB_HTML = ('<table><tr><td><a class="MniTabLnk">ICAS情報</a></td><td class="MniTabTblSelTd"><div class="MniTabSelTxt" title="Current Selection:">'
            '<span class=" disabled TabPad">進度情報</span></div></td></tr></table>')


class ByLotServer:
    """ロット番号ごとに応答を返す疑似の LotDsp。"""

    def __init__(self):
        self.by_lot, self.hits = {}, []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.hits.append(body.get("lotNo"))
                raw = json.dumps(outer.by_lot.get(body.get("lotNo"), {"status": "OK", "entity": {"searchKeyInfos": []}})).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/service/lotdsp/search//searchAction"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def two_lots():
    """見本の画面を、ロット番号と板厚を変えて2つ。"""
    a = html_with_offs(Learning.OFFS)
    b = html_with_offs(Learning.OFFS, lot_no="L7151C0", thickness_shift=0.5)
    return a, b


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.srv = ByLotServer()
        self.cfg = api.settings_of({"url": "http://x/LotDspWeb/", "api": {"search_url": self.srv.url, "timeout_seconds": 3}})
        self.km = api.KeyMap(Path(self.tmp.name) / "map.json")

    def tearDown(self):
        self.srv.stop()
        self.tmp.cleanup()

    def serve(self, *htmls, decoy=None):
        for h in htmls:
            sc = L.read_screen(h)
            ent = entity_of(h)
            if decoy:
                ent["entity"]["staffCommonBean"]["decoy"] = decoy.get(sc["lot"])
            self.srv.by_lot[sc["lot"]] = ent

    def by_path(self, out):
        return {r["path"]: r for r in out["links"]}


class ReadScreen(unittest.TestCase):
    def test_tab_and_lot(self):
        sc = L.read_screen(TAB_HTML + FIXTURE)
        self.assertEqual(sc["tab"], "進度情報")
        self.assertEqual(sc["lot"], "L7150C0")
        self.assertGreater(len(sc["cells"]), 100)
        self.assertTrue(any(c["label"] == "設備" and len(c["values"]) >= 10 for c in sc["columns"]), "並びの列（設備ごとの行）")

    def test_labels_are_words_not_symbols_or_numbers(self):
        self.assertFalse(L.label_like("×"))
        self.assertTrue(L.label_like("№"), "№ は正規化で No になり、列の見出しとして正しい")
        self.assertFalse(L.label_like("26/09/17 17:16:31"))
        self.assertFalse(L.label_like("7.000"))
        self.assertTrue(L.label_like("鋳造番号"))
        self.assertTrue(L.label_like("ﾛｯﾄ番号"))
        self.assertFalse(L.label_like("あ" * 30), "長すぎる字は値")

    def test_what_is_distinctive(self):
        self.assertFalse(L.distinctive_screen("1"))
        self.assertFalse(L.distinctive_screen("0.0"))
        self.assertTrue(L.distinctive_screen("0.505"))
        self.assertTrue(L.distinctive_screen("J66G16A"))
        self.assertFalse(L.distinctive_api(1))
        self.assertTrue(L.distinctive_api(2.73))
        self.assertFalse(L.distinctive_api(True))
        self.assertFalse(L.distinctive_api(None))


class LinkOne(Base):
    def test_values_find_their_labels(self):
        a, _ = two_lots()
        res = entity_of(a)
        one = L.link_one(res, L.read_screen(a))
        self.assertEqual(one["entity.staffCommonBean.cyno"]["labels"], ["鋳造番号"])
        self.assertEqual(one["entity.staffCommonBean.knno"]["labels"], ["検査番号"])
        self.assertEqual(one["entity.staffCommonBean.hijuu"]["labels"], ["比重"], "2.73 ↔ 2.7300（桁の違いは許す）")
        # 設備ごとの並びは、表の列と行の順で照らす
        for key, label in (("jbsm", "設備"), ("jbedate", "日付"), ("jbx", "板厚"), ("jby", "板幅"), ("jbrw", "重量")):
            r = one[f"entity.staffProgressJBoxInfos[].{key}"]
            self.assertEqual((r["labels"], r["kind"]), ([label], "列"), key)

    def test_no_value_is_in_the_output(self):
        a, _ = two_lots()
        text = json.dumps(L.link_one(entity_of(a), L.read_screen(a)), ensure_ascii=False)
        for secret in ("J66G16A", "N690979", "66508532", "MFX2", "2.73", "6220"):
            self.assertNotIn(secret, text)


class LinkFiles(Base):
    def test_two_lots_confirm_and_drop_coincidences(self):
        a, b = two_lots()
        # decoy は、ロットAでは製造板幅（39.9）と同じ値、ロットBでは別の値（どの欄にも無い）
        self.serve(a, b, decoy={"L7150C0": 39.9, "L7151C0": 77.7})
        out = L.link_files([{"name": "a.html", "html": TAB_HTML + a}, {"name": "b.html", "html": TAB_HTML + b}], self.km, self.cfg)
        links = self.by_path(out)
        cyno = links["entity.staffCommonBean.cyno"]
        self.assertEqual((cyno["status"], cyno["labels"], cyno["lots"], cyno["tab"]), ("確定", ["鋳造番号"], 2, "進度情報"))
        self.assertEqual(links["entity.staffCommonBean.lty"]["status"], "確定")
        decoy = links["entity.staffCommonBean.decoy"]
        self.assertEqual((decoy["status"], decoy["lots"]), ("候補", 1), "1つのロットだけで当たった偶然の一致は確定にしない")
        self.assertEqual(out["summary"]["lots"], ["L7150C0", "L7151C0"])
        self.assertEqual(self.srv.hits.count("L7150C0"), 1, "同じロットの応答は1回だけ取る")

    def test_one_lot_gives_candidates_but_columns_are_firm(self):
        a, _ = two_lots()
        self.serve(a)
        out = L.link_files([{"name": "a.html", "html": a}], self.km, self.cfg)
        links = self.by_path(out)
        self.assertEqual(links["entity.staffCommonBean.cyno"]["status"], "候補", "1ロットの単独の値は、確かめるまで候補")
        self.assertEqual(links["entity.staffProgressJBoxInfos[].jbsm"]["status"], "確定", "並びの列は、行の順で多数が一致する")

    def test_a_clash_between_lots_is_called_a_clash(self):
        a, b = two_lots()
        # coin は、ロットAでは板幅（39.9）、ロットBでは重量（24000.0）と同じ値 → 別の見出しに当たる
        self.serve(a, b, decoy={"L7150C0": 39.9, "L7151C0": 24000.0})
        out = L.link_files([{"name": "a", "html": a}, {"name": "b", "html": b}], self.km, self.cfg)
        d = self.by_path(out)["entity.staffCommonBean.decoy"]
        self.assertEqual(d["status"], "食い違い")
        self.assertIn("板幅", d["labels"])
        self.assertIn("重量", d["labels"])

    def test_used_by_the_app_is_shown(self):
        a, b = two_lots()
        self.serve(a, b)
        # 学習の記録（このアプリが使う項目）を作る
        for html in (a, b):
            sc = L.read_screen(html)
            self.assertIsNone(api.learn_from_html(self.km, self.cfg, html, sc["lot"]))
        out = L.link_files([{"name": "a", "html": a}, {"name": "b", "html": b}], self.km, self.cfg)
        used = self.by_path(out)["entity.staffProgressJBoxInfos[].jbx"]["used_for"]
        self.assertEqual(used, ["actual.thickness"])
        self.assertIsNone(self.by_path(out)["entity.staffCommonBean.jbcd"]["used_for"] if "entity.staffCommonBean.jbcd" in self.by_path(out) else None)

    def test_files_that_cannot_be_used_say_why(self):
        a, _ = two_lots()
        self.serve(a)
        out = L.link_files([{"name": "memo.html", "html": "<html><body>メモ</body></html>"},
                            {"name": "lost.html", "html": FIXTURE.replace("L7150C0", "L9999Z9")},
                            {"name": "ok.html", "html": a}], self.km, self.cfg)
        by = {f["name"]: f for f in out["files"]}
        self.assertIn("ロット番号を読めません", by["memo.html"]["error"])
        self.assertIn("見つかりません", by["lost.html"]["error"])
        self.assertNotIn("error", by["ok.html"])

    def test_screen_only_labels_are_listed(self):
        a, _ = two_lots()
        self.serve(a)
        out = L.link_files([{"name": "a", "html": TAB_HTML + a}], self.km, self.cfg)
        only = out["screen_only"]["進度情報"]
        self.assertIsInstance(only, list)
        self.assertNotIn("鋳造番号", only, "応答に当たった見出しは「画面だけ」に入れない")


class Routes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.srv = ByLotServer()
        self.env = dict(os.environ)
        os.environ["TRANSFER_LOCAL_ROOT"] = self.tmp.name
        self.app = create_app()
        self.app.config["LOTDSP_API_MAP"] = api.KeyMap(Path(self.tmp.name) / "map.json")
        s = self.app.config["APP_SETTINGS"].setdefault("lotdsp_import", {})
        s.setdefault("api", {}).update({"search_url": self.srv.url, "timeout_seconds": 3})
        self.c = self.app.test_client()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.env)
        self.srv.stop()
        self.tmp.cleanup()

    def test_post_and_page(self):
        a, b = two_lots()
        for h in (a, b):
            self.srv.by_lot[L.read_screen(h)["lot"]] = entity_of(h)
        r = self.c.post("/api/lots/lotdsp-api/link", json={"files": [{"name": "a", "html": a}, {"name": "b", "html": b}]})
        d = r.get_json()
        self.assertEqual(r.status_code, 200, d)
        self.assertGreater(d["summary"]["confirmed"], 10)
        self.assertNotIn("J66G16A", json.dumps(d, ensure_ascii=False), "値は返さない")
        self.assertEqual(self.c.post("/api/lots/lotdsp-api/link", json={}).status_code, 400)
        page = self.c.get("/lotdsp-link")
        self.assertEqual(page.status_code, 200)
        self.assertIn("lotdsp-link.js", page.get_data(as_text=True))
        self.assertEqual(page.headers.get("Cache-Control"), "no-store")


if __name__ == "__main__":
    unittest.main()
