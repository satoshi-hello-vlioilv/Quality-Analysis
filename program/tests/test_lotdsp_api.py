# -*- coding: utf-8 -*-
"""LotDsp の API をログインなしで読む（app/services/lotdsp_api.py・/api/lots/fetch-lotdsp-api）。

LotDsp の応答の項目名は確かめられていないので、画面（HTML）で読めたロットと同じロットの API の応答を照らし合わせて
項目名を学ぶ作りになっている。ここでは疑似の LotDsp（この PC の中の小さなサーバー）を立てて、次を確かめる:
    学ぶ前は使えない／学べば画面で読んだのと同じ工程になる／見分けのつかない別のキーは複数のロットで除かれる／
    前オフ・後オフのように値が空のままの列は決めない／食い違えば決め直し／Cookie・認証を送らない／
    読めない理由（届かない・HTTP・JSON でない・エラー・該当なし・ロット違い）を言い分ける／学んだ対応は覚えている。

    python -m unittest discover -s tests
"""
import json
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from app import create_app
from app.services import lotdsp_api as api
from app.services import lotdsp_progress as lp

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = (ROOT / "tests" / "fixtures" / "lotdsp_progress_L7150C0.html").read_text(encoding="utf-8")
MASTER = json.loads((ROOT / "data" / "equipment_master.json").read_text(encoding="utf-8"))
ACTUAL_ROW = re.compile(r'<tr ng-repeat="meisaiInfo in staffProgressJBoxInfos[^"]*"[^>]*>.*?</tr>', re.S)
OFF_CELL = re.compile(r'<span class="prog-jb(?:fo|bo) ng-binding">[^<]*</span>')


def html_with_offs(offs, lot_no="L7150C0", thickness_shift=0.0):
    """見本の HTML。実績の各行の 前オフ・後オフ を入れ（長さ・前オフ・後オフ・肉厚 の順の4つ目までが並ぶ）、
    ロット番号と板厚を替えられる（別のロットを作る）。offs: [(前オフ, 後オフ)] を行の順に。"""
    s = FIXTURE.replace("L7150C0", lot_no)
    out = []
    for i, row in enumerate(ACTUAL_ROW.findall(s)):
        front, back = offs[i] if i < len(offs) else ("", "")
        cells = iter([("長さ", ""), ("前オフ", front), ("後オフ", back), ("肉厚", "0")])
        new = OFF_CELL.sub(lambda m: f'<span class="prog-jbfo ng-binding">{next(cells)[1]}</span>', row)
        if thickness_shift:
            new = re.sub(r'(prog-jbx ng-binding">\s*)([\d.]+)', lambda m: m.group(1) + f"{float(m.group(2)) + thickness_shift:.3f}", new)
        out.append((row, new))
    for old, new in out:
        s = s.replace(old, new, 1)
    return s


def to_moment(display, how):
    """画面の日時（YY/MM/DD hh:mm:ss）を、API の書き方に。iso=ふつうの ISO、epoch=1970年からの経過ミリ秒、utc=ずれつき（Z）の ISO。
    経過ミリ秒とずれつきは、この PC の時刻として画面と同じになる向きに作る（アプリも同じ向きで読む）。"""
    from datetime import datetime, timezone
    dt = datetime.strptime(("20" + display).strip(), "%Y/%m/%d %H:%M:%S") if len(display) > 8 else datetime.strptime("20" + display, "%Y/%m/%d")
    if how == "epoch":
        return int(dt.timestamp() * 1000)
    if how == "utc":
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def entity_of(html, key_style="a", date_style="iso", density_elsewhere=False, density_twice=False):
    """画面（html）と同じロットを、LotDsp が返しそうな JSON にする。項目名は style で変える（学ぶ側は名前を知らない）。
    値の書き方は画面と違う（数は数・日付は ISO）。decoy は先頭の行の板厚と同じ値を持つ別のキー（複数のロットで除かれるはず）。"""
    t, actual, design = lp.progress_tables(html, {})
    lot = lp.lot_fields(t, {})
    names = {"a": dict(eq="jbsm", dt="jbedate", th="jbx", w="jby", wt="jbrw", fo="maeOff", bo="atoOff", box="boxNo",
                       hs="sbyky", vs="sbtty", pc="sbmh", dsm="sbsm", dbox="boxNo"),
             "b": dict(eq="setsubi", dt="hizuke", th="atsu", w="haba", wt="omosa", fo="offF", bo="offB", box="no",
                       hs="yoko", vs="tate", pc="maiHon", dsm="setsubiD", dbox="no")}[key_style]
    iso = lambda s: to_moment(s, date_style)
    num = lambda s: float(s) if s not in ("", None) else None
    cur = []
    for r in actual:
        cur.append({names["box"]: r["no"], names["eq"]: r["equipment"], names["dt"]: iso(r["work_date"]), names["th"]: num(r["thickness"]),
                    names["w"]: num(r["width"]), names["wt"]: num(r["weight"]), names["fo"]: num(r["off_front_m"]),
                    names["bo"]: num(r["off_back_m"]), "oldThickness": num(actual[0]["thickness"]), "memo": ""})
    des = [{names["dbox"]: r["no"], names["dsm"]: r["equipment"], names["hs"]: int(r["horizontal_split"] or 1),
            names["vs"]: int(r["vertical_split"] or 1), names["pc"]: num(r["pieces"])} for r in design]
    bean = {"ltno": lot["lot_no"], "cyno": lot["casting_no"], "knno": lot["inspection_no"], "juno": lot["order_no"],
            "lta": lot["material"], "ltb": lot["temper"], "ltx": num(lot["product_thickness"]), "lty": num(lot["product_width"]),
            "ltz": num(lot["product_length"]), "yotoCd": lot["use_code"], "yotoNm": lot["use_name"], "hijuu": num(lot["density"])}
    entity = {"searchKeyInfos": [{"ltno": lot["lot_no"]}], "staffCommonBean": bean,
              "staffProgressJBoxInfos": cur, "staffProgressBoxInfos": des}
    if density_twice:           # 同じ比重が2か所にある応答（元データの bean と表示用の bean。どのロットでも同じ値）
        entity["icasBean"] = {"hijyu": num(lot["density"])}
    if density_elsewhere:       # 比重が基本情報の中ではなく、別の場所にある応答
        entity["staffCommonBean"].pop("hijuu")
        entity["staffMaterialBean"] = {"komoku": {"hijuu2": num(lot["density"])}}
    return {"status": "OK", "entity": entity}


class FakeLotDsp:
    """疑似の LotDsp。応答は呼び出しごとに差し替えられる。届いた要求の見出し（Cookie・認証が付いていないか）を覚える。"""

    def __init__(self):
        self.response = (200, {})
        self.requests = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                outer.requests.append({"headers": {k.lower(): v for k, v in self.headers.items()}, "body": json.loads(self.rfile.read(n) or b"{}")})
                status, body = outer.response
                raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
                self.send_response(status)
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


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeLotDsp()
        self.cfg = api.settings_of({"url": "http://nlmfangyweb1a/LotDspWeb/", "api": {"search_url": self.fake.url, "timeout_seconds": 3}})
        self.km = api.KeyMap(Path(self.tmp.name) / "map.json")

    def tearDown(self):
        self.fake.stop()
        self.tmp.cleanup()

    def learn(self, html, style="a", lot_no=None, **kw):
        """画面で html を読めた → 同じロットの API の応答（style の項目名）で学ぶ。"""
        t, actual, design = lp.progress_tables(html, {})
        lot_no = lot_no or lp.lot_fields(t, {})["lot_no"]
        self.fake.response = (200, entity_of(html, style, **kw))
        err = api.learn_from_html(self.km, self.cfg, html, lot_no)
        self.assertIsNone(err, err)

    OFFS = [("12.5", "3.0"), ("", "4.5"), ("7.2", ""), ("1.1", "2.2")] + [("", "")] * 6


class Learning(Base):
    def test_not_usable_before_learning(self):
        self.assertFalse(self.km.ready())
        with self.assertRaises(api.ApiError) as cm:
            api.read_lot(self.km, self.cfg, "L7150C0", MASTER)
        self.assertEqual(cm.exception.kind, "not_ready")
        self.assertEqual(self.fake.requests, [], "学び終えるまでは API を呼ばない")

    def test_empty_offs_are_never_guessed(self):
        """前オフ・後オフがすべて空のロット。値の手がかりが無いので、名前から推測して決めたりしない（画面の class 名は列とずれている）。"""
        self.learn(html_with_offs([]))
        missing = [f"{s}.{c}" for s, c in self.km.missing()]
        # 比重の項目名も、1つのロットでは手がかりが1回なので、まだ決まらない（2つ目のロットで決まる）
        self.assertEqual(sorted(missing), ["actual.off_back_m", "actual.off_front_m", "lot.density"])
        self.assertFalse(self.km.ready())

    def test_one_coincidence_is_not_enough(self):
        """見本には前オフの値が1か所だけある。1回の一致では決めない（偶然の一致で値が静かに間違うのを避ける）。"""
        self.learn(FIXTURE)
        self.assertIn("actual.off_front_m", [f"{s}.{c}" for s, c in self.km.missing()])
        self.assertFalse(self.km.ready())

    def test_learns_and_reads_the_same_lot_as_the_screen(self):
        html = html_with_offs(self.OFFS)
        self.learn(html)
        # 同点で残った別名（板厚と同じ値の oldThickness）は、1つのロットでは見分けがつかない → まだ使えない
        self.assertFalse(self.km.ready())
        self.learn(html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5), lot_no="L7151C0")
        self.assertTrue(self.km.ready(), self.km.missing())
        self.assertEqual(self.km.key("actual", "thickness"), "jbx", "別名は2つ目のロットの食い違いで除かれた")
        # 読み: 画面で読んだのと同じ工程（設備・日付・寸法・オフ・分割）になる
        self.fake.response = (200, entity_of(html))
        lot, report = api.read_lot(self.km, self.cfg, "L7150C0", MASTER)
        screen, _ = lp.read_lot(html, MASTER, None, "L7150C0")
        self.assertEqual(lot.to_dict(), screen.to_dict())
        self.assertEqual([p.off_front_m for p in lot.processes][:4], [12.5, 0, 7.2, 1.1])
        self.assertEqual(report["source"], "LotDsp API（ログインなし）")
        self.assertEqual(lot.processes[0].work_date, "26/09/17 17:16:31")

    def test_different_key_names_are_learned_from_values_not_names(self):
        html, html2 = html_with_offs(self.OFFS), html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5)
        self.learn(html, "b")
        self.learn(html2, "b", lot_no="L7151C0")
        self.assertTrue(self.km.ready(), self.km.missing())
        self.assertEqual(self.km.key("actual", "thickness"), "atsu")
        self.assertEqual(self.km.key("actual", "off_front_m"), "offF")
        self.assertEqual(self.km.key("design", "horizontal_split"), "yoko")
        self.fake.response = (200, entity_of(html, "b"))
        lot, _ = api.read_lot(self.km, self.cfg, "L7150C0", MASTER)
        screen, _ = lp.read_lot(html, MASTER, None, "L7150C0")
        self.assertEqual(lot.to_dict(), screen.to_dict())

    def test_what_is_learned_is_remembered_and_holds_no_lot_values(self):
        self.learn(html_with_offs(self.OFFS))
        self.learn(html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5), lot_no="L7151C0")
        km2 = api.KeyMap(self.km.path)
        self.assertTrue(km2.ready())
        text = self.km.path.read_text(encoding="utf-8")
        for secret in ("6220", "1200", "J66G16A", "N690979", "66508532", "MFX2"):
            self.assertNotIn(secret, text, "学んだ対応にロットの値（寸法・番号）は置かない")

    def test_a_changed_response_unlearns_the_column(self):
        html, html2 = html_with_offs(self.OFFS), html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5)
        self.learn(html)
        self.learn(html2, lot_no="L7151C0")
        self.assertTrue(self.km.ready())
        # LotDsp が項目名を替えた（板厚が別の名前になった）。画面では今までどおり読めたので学び直す → 食い違いで決め直し
        t, actual, design = lp.progress_tables(html, {})
        ent = entity_of(html)
        for x in ent["entity"]["staffProgressJBoxInfos"]:
            x["atsuNew"] = x.pop("jbx")
        self.fake.response = (200, ent)
        api.learn_from_html(self.km, self.cfg, html, "L7150C0")
        self.assertFalse(self.km.ready())
        self.assertIn("actual.thickness", [f"{s}.{c}" for s, c in self.km.missing()])


class Variants(Base):
    """応答の書き方が想定と違っても、値から学べる（実物の LotDsp の書き方は確かめられていないので、ありそうな違いを吸収する）。"""

    def two_lots(self, **kw):
        h1, h2 = html_with_offs(self.OFFS), html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5)
        self.learn(h1, **kw)
        self.learn(h2, lot_no="L7151C0", **kw)
        return h1

    def check_same_as_screen(self, html, **kw):
        self.fake.response = (200, entity_of(html, **kw))
        lot, _ = api.read_lot(self.km, self.cfg, "L7150C0", MASTER)
        screen, _ = lp.read_lot(html, MASTER, None, "L7150C0")
        self.assertEqual(lot.to_dict(), screen.to_dict())

    def test_dates_as_epoch_milliseconds(self):
        html = self.two_lots(date_style="epoch")
        self.assertTrue(self.km.ready(), self.km.missing())
        self.check_same_as_screen(html, date_style="epoch")

    def test_dates_with_a_utc_offset(self):
        html = self.two_lots(date_style="utc")
        self.assertTrue(self.km.ready(), self.km.missing())
        self.check_same_as_screen(html, date_style="utc")

    def test_density_in_another_part_of_the_response(self):
        html = self.two_lots(density_elsewhere=True)
        self.assertTrue(self.km.ready(), self.km.missing())
        self.assertEqual(self.km.key("lot", "density"), "staffMaterialBean.komoku.hijuu2")
        self.check_same_as_screen(html, density_elsewhere=True)

    def test_old_map_with_bare_lot_keys_still_works(self):
        """以前の版は基本情報の項目名だけ（staffCommonBean の中）で覚えていた。道すじに直して使い続ける。"""
        html = self.two_lots()
        for c in self.km.data["lot"]["cols"].values():
            if c.get("cands"):
                c["cands"] = [x.split(".")[-1] for x in c["cands"]]
        self.km.save()
        km2 = api.KeyMap(self.km.path)
        self.km = km2
        self.learn(html)                      # 学び直しの周回で道すじに直る
        self.assertTrue(self.km.ready(), self.km.missing())
        self.assertEqual(self.km.key("lot", "lot_no"), "staffCommonBean.ltno")
        self.check_same_as_screen(html)


class Survey(Base):
    """応答に入っている項目をすべて一覧にする調査（形だけ・値は既定で出さない）。"""

    def ready_map(self):
        h1, h2 = html_with_offs(self.OFFS), html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5)
        self.learn(h1)
        self.learn(h2, lot_no="L7151C0")
        self.assertTrue(self.km.ready())
        return h1

    def test_lists_every_field_with_type_shape_and_use(self):
        html = self.ready_map()
        result = entity_of(html)
        out = api.survey(result, self.km, self.cfg)
        by = {f["path"]: f for f in out["fields"]}
        # 基本情報・実績・設計の項目がすべて出る（並びの中は `道すじ[]` で、要素の項目を合わせて数える）
        for p in ("entity.staffCommonBean.ltno", "entity.staffProgressJBoxInfos[].jbx", "entity.staffProgressBoxInfos[].sbyky", "status"):
            self.assertIn(p, by, p)
        self.assertEqual(by["entity.staffProgressJBoxInfos[].jbx"]["of"], 10, "実績は10行")
        self.assertEqual(by["entity.staffProgressJBoxInfos[].jbx"]["type"], "float")
        self.assertEqual(by["entity.staffProgressJBoxInfos[].jbx"]["shape"], "float:9.9")
        # 空の列は「空でない件数」が少なく、使っていない項目は unused に入る
        self.assertLess(by["entity.staffProgressJBoxInfos[].maeOff"]["nonnull"], 10)
        self.assertEqual(by["entity.staffProgressJBoxInfos[].jbx"]["used_for"], ["actual.thickness"])
        self.assertEqual(by["entity.staffCommonBean.ltno"]["used_for"], ["lot.lot_no"])
        self.assertIn("entity.staffProgressJBoxInfos[].memo", [f["path"] for f in out["fields"]])
        self.assertIn("entity.staffProgressJBoxInfos[].oldThickness", out["unused_non_empty"])
        self.assertTrue({"path": "entity.staffProgressJBoxInfos", "length": 10} in out["summary"]["arrays"])
        self.assertGreater(out["summary"]["used_by_app"], 10)

    def test_shape_only_by_default_values_only_when_asked(self):
        html = self.ready_map()
        text = json.dumps(api.survey(entity_of(html), self.km, self.cfg), ensure_ascii=False)
        for secret in ("6220", "1200", "J66G16A", "N690979", "66508532", "MFX2", "L7150C0", "2026-09-17"):
            self.assertNotIn(secret, text, f"既定では値（{secret}）を出さない")
        self.assertFalse(api.survey(entity_of(html), self.km, self.cfg)["values_included"])
        with_values = api.survey(entity_of(html), self.km, self.cfg, values=True)
        self.assertTrue(with_values["values_included"])
        self.assertIn("J66G16A", json.dumps(with_values, ensure_ascii=False))
        self.assertIn("外部", with_values["note"])


class Duplicates(Base):
    """同じ内容が応答の2か所にあり、どのロットでも同じ値（比重など）だと、どちらも画面と一致し続けて見分けがつかない。"""

    def lots(self, n):
        out = []
        for i in range(n):
            no, shift = f"L715{i}C0", 0.5 * i
            h = html_with_offs(self.OFFS, lot_no=no, thickness_shift=shift)
            out.append((h, no))
        return out

    def test_identical_duplicates_are_decided_after_three_lots(self):
        lots = self.lots(3)
        for h, no in lots[:2]:
            self.learn(h, lot_no=no, density_twice=True)
        self.assertIn("lot.density", [f"{s}.{c}" for s, c in self.km.missing()], "2ロットではまだ決めない")
        p = api.status(self.km, self.cfg)["probe"]["lot.density"]
        self.assertEqual(sorted(p["cands"]), ["icasBean.hijyu", "staffCommonBean.hijuu"], "いま持っている候補が見える")
        self.assertEqual(p["seen"], 2)
        h, no = lots[2]
        self.learn(h, lot_no=no, density_twice=True)
        self.assertTrue(self.km.ready(), self.km.missing())
        self.assertEqual(self.km.key("lot", "density"), "icasBean.hijyu")
        self.fake.response = (200, entity_of(lots[0][0], density_twice=True))
        lot, _ = api.read_lot(self.km, self.cfg, lots[0][1], MASTER)
        self.assertEqual(lot.density, 2.73)

    def test_a_clash_restarts_the_count(self):
        """食い違って候補が尽きたら、手がかりの数を数え直す。決め直したあとの1回の一致で決めてしまわない。"""
        st = {"cands": ["a", "b"], "seen": 5}
        api._narrow(st, {"c"}, 1)
        self.assertIsNone(st["cands"])
        self.assertEqual(st["seen"], 0)
        api._narrow(st, {"c"}, 1)               # 次の1回で候補が戻る。数えは 1 から
        self.assertEqual((st["cands"], st["seen"]), (["c"], 1))


class Probe(Base):
    def test_undecided_columns_show_shapes_not_values(self):
        """決まらない列は、画面の値と応答の候補の「形」だけを出す（値は出さない）。次に人が見て、何が違うかを知るため。"""
        self.learn(html_with_offs([("12.5", "3.0")] + [("", "")] * 9))
        st = api.status(self.km, self.cfg)
        self.assertIn("actual.off_front_m", st["probe"])
        p = st["probe"]["actual.off_front_m"]
        self.assertEqual(p["screen"], "str:99.9", "画面の 12.5 は形だけ")
        self.assertTrue(any(v.startswith("float:") for v in p["api"].values()), p)
        text = json.dumps(st["probe"], ensure_ascii=False)       # 形の診断には値を入れない（login_free には確かめたロット番号を入れる設計）
        for secret in ("12.5", "6220", "1200", "J66G16A", "N690979", "66508532", "MFX2", "L7150C0", "2026-09-17", "ﾌｳｺｳｾﾞﾝﾕｳ"):
            self.assertNotIn(secret, text, f"形の診断に値（{secret}）を出さない")
        self.assertEqual(self.km.data["probe"], st["probe"])


class Sending(Base):
    def test_no_credentials_are_sent(self):
        self.learn(html_with_offs(self.OFFS))
        req = self.fake.requests[-1]
        for h in ("cookie", "authorization", "proxy-authorization"):
            self.assertNotIn(h, req["headers"], "ログインなし（Cookie・認証を送らない）")
        self.assertEqual(req["body"], {"lotNo": "L7150C0", "kensaNo": "", "nowPage": 0})


class Disabled(Base):
    def test_off_means_no_requests_at_all(self):
        """設定 lotdsp_import.api.enabled=false: 読む道も、学ぶための問い合わせも使わない。"""
        cfg = api.settings_of({"url": "http://x/LotDspWeb/", "api": {"enabled": False, "search_url": self.fake.url}})
        self.assertFalse(cfg["enabled"])
        self.assertIsNone(api.learn_later(self.km, cfg, html_with_offs(self.OFFS), "L7150C0"))
        with self.assertRaises(api.ApiError) as cm:
            api.search("L7150C0", cfg)
        self.assertEqual(cm.exception.kind, "disabled")
        self.assertEqual(self.fake.requests, [])

    def test_default_search_url_follows_the_lotdsp_url(self):
        cfg = api.settings_of({"url": "http://nlmfangyweb1a/LotDspWeb/"})
        self.assertEqual(cfg["search_url"], "http://nlmfangyweb1a/LotDspWeb/service/lotdsp/search//searchAction")
        self.assertFalse(api.settings_of({})["enabled"], "LotDsp の URL が無ければ使わない")


class Failures(Base):
    def setUp(self):
        super().setUp()
        self.html = html_with_offs(Learning.OFFS if hasattr(Learning, "OFFS") else self.OFFS)
        self.learn(self.html)
        self.learn(html_with_offs(self.OFFS, lot_no="L7151C0", thickness_shift=0.5), lot_no="L7151C0")
        self.assertTrue(self.km.ready())

    def kind(self, lot="L7150C0"):
        with self.assertRaises(api.ApiError) as cm:
            api.read_lot(self.km, self.cfg, lot, MASTER)
        return cm.exception.kind

    def test_not_found(self):
        ent = entity_of(self.html)
        ent["entity"]["searchKeyInfos"] = []
        self.fake.response = (200, ent)
        self.assertEqual(self.kind(), "not_found")

    def test_other_lot_is_refused(self):
        self.fake.response = (200, entity_of(self.html))
        self.assertEqual(self.kind("L9999Z9"), "mismatch")

    def test_business_error_http_error_and_not_json(self):
        self.fake.response = (200, {"status": "ERROR", "errorMessage": "システム障害"})
        self.assertEqual(self.kind(), "business")
        self.fake.response = (500, {})
        self.assertEqual(self.kind(), "http")
        self.fake.response = (200, b"<html>login</html>")
        self.assertEqual(self.kind(), "invalid", "ログインの画面が返ったときは JSON でない")

    def test_unreachable(self):
        self.fake.stop()
        self.cfg["timeout_seconds"] = 1
        self.assertEqual(self.kind(), "unreachable")
        self.fake = FakeLotDsp()          # tearDown 用


class Routes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fake = FakeLotDsp()
        import os
        self.env = dict(os.environ)
        os.environ["TRANSFER_LOCAL_ROOT"] = self.tmp.name
        self.app = create_app()
        self.app.config["LOTDSP_API_SYNC"] = True        # 学ぶのを待つ（試験では裏のスレッドにしない）
        self.app.config["LOTDSP_API_MAP"] = api.KeyMap(Path(self.tmp.name) / "map.json")
        s = self.app.config["APP_SETTINGS"].setdefault("lotdsp_import", {})
        self._saved = json.dumps(s)
        s.setdefault("api", {}).update({"search_url": self.fake.url, "timeout_seconds": 3})
        self.c = self.app.test_client()

    def tearDown(self):
        import os
        os.environ.clear()
        os.environ.update(self.env)
        self.fake.stop()
        self.tmp.cleanup()

    def test_not_ready_then_learned_by_importing(self):
        r = self.c.post("/api/lots/fetch-lotdsp-api", json={"lot_no": "L7150C0"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "not_ready"))
        h1, h2 = html_with_offs(Learning.OFFS), html_with_offs(Learning.OFFS, lot_no="L7151C0", thickness_shift=0.5)
        for html, no in ((h1, "L7150C0"), (h2, "L7151C0")):
            self.fake.response = (200, entity_of(html))
            r = self.c.post("/api/lots/import-lotdsp", json={"html": html, "lot_no": no})
            self.assertEqual(r.status_code, 200, r.get_json())
        st = self.c.get("/api/lots/lotdsp-api/status").get_json()
        self.assertTrue(st["ready"], st)
        self.assertTrue(st["login_free"], "ログインなしで応答が返った記録")
        self.fake.response = (200, entity_of(h1))
        r = self.c.post("/api/lots/fetch-lotdsp-api", json={"lot_no": "l7150c0"})
        d = r.get_json()
        self.assertEqual(r.status_code, 200, d)
        self.assertEqual(d["lot"]["lot_no"], "L7150C0")
        self.assertEqual(len(d["lot"]["processes"]), 10)
        self.assertEqual(self.c.get("/api/config").get_json()["lotdsp_api"]["ready"], True)

    def test_survey_route(self):
        h = html_with_offs(Learning.OFFS)
        self.fake.response = (200, entity_of(h))
        r = self.c.get("/api/lots/lotdsp-api/survey?lot=l7150c0")
        d = r.get_json()
        self.assertEqual(r.status_code, 200, d)
        self.assertEqual(d["lot"], "L7150C0")
        self.assertFalse(d["values_included"])
        self.assertTrue(any(f["path"].endswith("staffProgressJBoxInfos[].jbx") for f in d["fields"]))
        self.assertNotIn("6220", json.dumps(d))
        self.assertTrue(self.c.get("/api/lots/lotdsp-api/survey?lot=L7150C0&values=1").get_json()["values_included"])
        self.assertEqual(self.c.get("/api/lots/lotdsp-api/survey").status_code, 400, "ロット番号が要る")
        ent = entity_of(h)
        ent["entity"]["searchKeyInfos"] = []
        self.fake.response = (200, ent)
        r = self.c.get("/api/lots/lotdsp-api/survey?lot=L0000X0")
        self.assertEqual((r.status_code, r.get_json()["kind"]), (404, "not_found"))

    def test_empty_lot_no(self):
        r = self.c.post("/api/lots/fetch-lotdsp-api", json={"lot_no": ""})
        self.assertEqual(r.status_code, 400)


# Failures は Learning の OFFS を使う
Failures.OFFS = Learning.OFFS if hasattr(Learning, "OFFS") else Base.OFFS

if __name__ == "__main__":
    unittest.main()
