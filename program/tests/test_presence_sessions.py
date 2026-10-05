# -*- coding: utf-8 -*-
"""評価関数: 使用の履歴（起動ごとに いつ・だれ・どの PC・どの版・何分）と、保存期間・整理（版 3.3.0）。

置き場は利用状況と同じ共有フォルダの presence_tpa/。履歴は sessions/<PC名@ログインID>/<年-月>.json に、
その PC だけが書く（ほかの PC とぶつからない）。保存日数は presence_tpa/settings.json（管理する人が書く）。
"""
import json
from datetime import datetime, timedelta
from unittest import mock

from app.services import presence
from tests.test_access import Env

T0 = datetime(2026, 10, 1, 9, 0, 0)


def iso(t):
    return t.isoformat(timespec="seconds")


class Sessions(Env):
    def setUp(self):
        super().setUp()
        presence._state.update(session_key=None, session_start=None, last_history=0.0, last_write=0.0, since=None, left=False)
        self.p3 = mock.patch.object(presence, "HISTORY_WRITE_SEC", 0)
        self.p3.start()

    def tearDown(self):
        self.p3.stop()
        super().tearDown()

    def beat(self, t, version="3.3.0", login=None, pc=None, role="一般ユーザー"):
        """その時刻に心拍が書いた（利用状況を書く間隔ごと）。"""
        login, pc = login or self.who["login"], pc or self.who["pc"]
        with mock.patch.object(presence, "now_iso", lambda: iso(t)), mock.patch.object(presence, "APP_VERSION", version):
            presence._state["last_write"] = 0
            presence.touch(login, pc, role, force=True)

    def close(self, t, version="3.3.0", login=None, pc=None):
        with mock.patch.object(presence, "now_iso", lambda: iso(t)), mock.patch.object(presence, "APP_VERSION", version):
            presence._state["left"] = False
            presence.leave(login or self.who["login"], pc or self.who["pc"])

    def run_session(self, start, minutes, version="3.3.0", **kw):
        """start から minutes 分、20 秒ごとに心拍 → 終了。"""
        for s in range(0, minutes * 60 + 1, 20):
            self.beat(start + timedelta(seconds=s), version, **kw)
        self.close(start + timedelta(minutes=minutes), version, **kw)

    def sessions(self, **q):
        r = self.c.get("/api/presence/sessions", query_string=q)
        self.assertEqual(r.status_code, 200, r.get_json())
        return r.get_json()

    def test_each_launch_is_one_session_with_who_where_version_and_time(self):
        self.run_session(T0, 30)
        self.run_session(T0 + timedelta(hours=3), 10, version="3.3.1")          # 間が空いた → 別の使い始め
        d = self.sessions()
        items = d["items"]
        self.assertEqual(len(items), 2, items)
        new, old = items                                                      # 新しい順
        self.assertEqual((new["login"], new["pc"], new["version"], new["role"]), ("u1", "PC-1", "3.3.1", "一般ユーザー"))
        self.assertEqual((old["start"], old["end"]), (iso(T0), iso(T0 + timedelta(minutes=30))))
        self.assertAlmostEqual(old["sec"], 30 * 60, delta=40, msg="使った時間は心拍の間を足したもの")
        self.assertEqual(new.get("changedFrom"), "3.3.0", "版が変わったことが分かる")
        self.assertIsNone(old.get("changedFrom"))
        f = presence.presence_dir() / "sessions" / presence.terminal_key("u1", "PC-1") / "2026-10.json"
        self.assertTrue(f.exists(), "履歴は PC ごと・月ごとのファイル（その PC だけが書く）")

    def test_a_crash_keeps_the_last_heartbeat_as_end(self):
        for s in range(0, 121, 20):
            self.beat(T0 + timedelta(seconds=s))                              # 終了の記録なし（落ちた・電源断）
        self.beat(T0 + timedelta(hours=1))                                    # 次の起動
        old = self.sessions()["items"][-1]
        self.assertEqual(old["end"], iso(T0 + timedelta(seconds=120)), "最後の心拍の時刻で終わったことにする")

    def test_several_pcs_merge_newest_first_and_filter_by_pc(self):
        self.run_session(T0, 5)
        self.run_session(T0 + timedelta(hours=1), 5, login="u2", pc="PC-2")
        self.run_session(T0 + timedelta(hours=2), 5, login="u3", pc="PC-3")
        d = self.sessions()
        self.assertEqual([x["pc"] for x in d["items"]], ["PC-3", "PC-2", "PC-1"])
        only = self.sessions(key=presence.terminal_key("u2", "PC-2"))["items"]
        self.assertEqual([x["login"] for x in only], ["u2"])
        page = self.sessions(limit=2)
        self.assertEqual((len(page["items"]), page["more"]), (2, True), "多いときは続きがあると言う")

    def test_retention_is_shared_and_only_managers_change_it(self):
        self.assertEqual(self.sessions()["historyDays"], presence.DEFAULT_HISTORY_DAYS)
        r = self.c.post("/api/presence/retention", json={"days": 180})
        self.assertEqual(r.status_code, 403, "一般ユーザーは保存日数を変えられない")
        self.seed("boss", "メンテナンス者")
        self.as_("boss")
        for bad in (10, 99999, "x", None):
            self.assertEqual(self.c.post("/api/presence/retention", json={"days": bad}).status_code, 400, bad)
        self.assertEqual(self.c.post("/api/presence/retention", json={"days": 180}).status_code, 200)
        saved = json.loads((presence.presence_dir() / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual((saved["historyDays"], saved["by"]), (180, "boss"))
        self.as_("u1")
        self.assertEqual(self.sessions()["historyDays"], 180, "ほかの PC も同じ日数を読む（共有フォルダ）")

    def test_the_settings_file_is_not_a_pc(self):
        """保存日数のファイル（settings.json）は利用状況の置き場にあるが、PC の記録ではない: 数えない・掃除で消さない。"""
        self.beat(datetime.now())
        presence.save_settings({"historyDays": 90}, by="boss", by_pc="PC-9")
        self.assertEqual(self.c.get("/api/presence").status_code, 200, "PC ごとの状況が開ける")
        self.assertEqual(self.c.get("/api/presence/sessions").status_code, 200, "使用の履歴が開ける")
        f = presence.presence_dir() / "settings.json"
        old = json.loads(f.read_text(encoding="utf-8"))
        f.write_text(json.dumps({**old, "at": iso(datetime.now() - timedelta(days=3))}), encoding="utf-8")
        presence._sweep()
        self.assertTrue(f.exists(), "古い「いま使っている」の掃除で、保存日数のファイルを消さない")
        self.assertEqual(presence.history_days(), 90)

    def _old_month(self, login, pc, start):
        key = presence.terminal_key(login, pc)
        d = presence.presence_dir() / "sessions" / key
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{start:%Y-%m}.json"
        f.write_text(json.dumps({"key": key, "login": login, "pc": pc, "sessions": [
            {"start": iso(start), "end": iso(start + timedelta(minutes=5)), "sec": 300, "version": "3.0.0", "role": ""}]}), encoding="utf-8")
        return f

    def test_each_pc_drops_its_own_old_history(self):
        presence.save_settings({"historyDays": 30}, by="boss", by_pc="PC-9")
        old = self._old_month("u1", "PC-1", T0 - timedelta(days=120))
        edge = self._old_month("u1", "PC-1", datetime(2026, 9, 1, 8, 0))      # 31 日前の分だけを含む月
        self.run_session(T0, 5)                                               # 新しい使い始めで片付ける
        self.assertFalse(old.exists(), "保存日数より古い月のファイルは消す")
        self.assertEqual(json.loads(edge.read_text(encoding="utf-8"))["sessions"], [], "月の中でも古い分は消す")

    def test_managers_can_tidy_everyones_old_months_now(self):
        presence.save_settings({"historyDays": 30}, by="boss", by_pc="PC-9")
        a = self._old_month("u2", "PC-2", T0 - timedelta(days=200))
        b = self._old_month("u3", "PC-3", T0 - timedelta(days=90))
        keep = self._old_month("u3", "PC-3", T0 - timedelta(days=3))
        self.assertEqual(self.c.post("/api/presence/prune").status_code, 403, "一般ユーザーは整理できない")
        self.seed("boss", "メンテナンス者")
        self.as_("boss")
        with mock.patch.object(presence, "_now", lambda: T0):
            r = self.c.post("/api/presence/prune")
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertEqual(r.get_json()["files"], 2)
        self.assertFalse(a.exists() or b.exists())
        self.assertTrue(keep.exists(), "保存日数の中の記録は残す")

    def test_forget_removes_the_history_too(self):
        self.run_session(T0, 5, login="u2", pc="PC-2")
        self.seed("boss", "メンテナンス者")
        self.as_("boss")
        key = presence.terminal_key("u2", "PC-2")
        self.assertEqual(self.c.post("/api/presence/forget", json={"key": key}).status_code, 200)
        self.assertFalse((presence.presence_dir() / "sessions" / key).exists(), "記録を消すと使用の履歴も消える")

    def test_operators_cannot_read_history(self):
        self.seed("boss", "開発者")
        self.as_("boss")
        self.c.post("/api/masters/access", json={"ログインID": "op", "PC名": "", "権限区分": "設備作業者", "マスタ編集": "非表示"})
        self.as_("op")
        self.assertEqual(self.c.get("/api/presence/sessions").status_code, 403)
