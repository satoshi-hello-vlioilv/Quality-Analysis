# -*- coding: utf-8 -*-
"""評価関数: アプリの配布（版 3.4.0）の Python 側の決まり。

- 版を置く・配る版を決めてよいのは開発者・メンテナンス者だけ（判定は services/access.py の1箇所。窓 desktop/src/distribute.rs は
  /api/update/settings の who.canRelease に従う）。切断中の PC は置けない。
- 配る版（窓が作業場所の want.json に覚えた版）が決まっていれば、利用状況の「最新版」はその版。前の版へ戻したときは、
  新しすぎる版も「要更新」（戻す）。決まっていなければ、これまでどおり使っている人たちのいちばん新しい版。
"""
import json
from unittest import mock

import app_env
from app.services import access, presence
from tests.test_access import Env


class Permission(Env):
    def told(self):
        r = self.c.get("/api/update/settings")
        self.assertEqual(r.status_code, 200)
        return r.get_json()["who"]

    def test_only_developers_and_maintainers_may_release(self):
        self.assertEqual([r for r in access.ROLES if access.role_can(r, "release:publish")], ["開発者", "メンテナンス者"])
        w = self.told()
        self.assertEqual((w["login"], w["pc"], w["role"], w["canRelease"]), ("u1", "PC-1", "一般ユーザー", False))
        self.seed("u1", "メンテナンス者")
        self.as_("u1")
        self.assertTrue(self.told()["canRelease"])
        self.assertTrue(self.c.get("/api/access/me").get_json()["canRelease"], "画面へも同じ答え")

    def test_a_disconnected_pc_may_not_release(self):
        self.seed("u1", "開発者")
        self.as_("u1")
        with mock.patch.object(presence, "revocation", lambda key: {"by": "boss", "remainingSec": 300}):
            self.as_("u1")
            self.assertFalse(self.told()["canRelease"])


class Latest(Env):
    def setUp(self):
        super().setUp()
        self.env = mock.patch.dict("os.environ", {"TRANSFER_LOCAL_ROOT": str(self.tmp / "local")})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        super().tearDown()

    def want(self, v):
        root = app_env.local_root()
        root.mkdir(parents=True, exist_ok=True)
        (root / presence.WANT_FILE).write_text(json.dumps({"version": v}), encoding="utf-8")

    def test_the_distributed_version_is_the_latest(self):
        self.assertIsNone(presence.distributed_version())
        self.want("3.4.0")
        self.assertEqual(presence.distributed_version(), "3.4.0")
        self.assertEqual(presence.latest_version(lambda pairs: {}), "3.4.0", "配る版が最新版")
        with mock.patch.dict(presence._state, newest="3.4.0"):
            n = presence.version_notice("一般ユーザー")
        self.assertTrue(n["distributed"], n)
        self.assertEqual(n["outdated"], presence.APP_VERSION != "3.4.0", "配る版と違えば要更新（新しすぎても）")

    def test_behind_means_different_from_the_distributed_version(self):
        self.assertTrue(presence.behind("3.4.0", "3.4.1", True), "前の版へ戻したら、新しすぎる版も要更新")
        self.assertFalse(presence.behind("3.4.0", "3.4.0", True))
        self.assertFalse(presence.behind("3.4.0", "3.4.1", False), "配る版が無ければ、新しい版は要更新ではない")
        self.assertTrue(presence.behind("3.4.1", "3.4.0", False))
        self.assertFalse(presence.behind(None, "3.4.0", True))

    def test_fleet_marks_pcs_off_the_distributed_version(self):
        presence.touch("u1", "PC-1", "一般ユーザー", force=True)
        with mock.patch.object(presence, "APP_VERSION", "9.9.9"):
            presence._state["last_write"] = 0
            presence.touch("u2", "PC-2", "一般ユーザー", force=True)
        self.want(presence.APP_VERSION)
        fl = presence.fleet(lambda pairs: {p: "一般ユーザー" for p in pairs})
        self.assertEqual((fl["latest"], fl["distributed"]), (presence.APP_VERSION, True))
        off = {x["pc"]: x["outdated"] for x in fl["items"]}
        self.assertEqual(off, {"PC-1": False, "PC-2": True}, "配る版より新しい版の PC も要更新（戻す）")
