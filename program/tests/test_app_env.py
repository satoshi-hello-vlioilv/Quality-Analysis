# -*- coding: utf-8 -*-
"""このアプリの置き場所の決まり（app_env.py）。起動の仕組み・止める仕組み・サーバーが同じ答えを使う。"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app_env


class AppEnv(unittest.TestCase):
    def test_local_root_follows_the_environment_each_time(self):
        with mock.patch.dict(os.environ, {"TRANSFER_LOCAL_ROOT": "/x/work"}):
            self.assertEqual(app_env.local_root(), Path("/x/work"))
        with mock.patch.dict(os.environ, {"TRANSFER_LOCAL_ROOT": "", "LOCALAPPDATA": "/x/appdata"}):
            self.assertEqual(app_env.local_root(), Path("/x/appdata") / app_env.DATA_DIR)

    def test_settings_are_read_in_one_order(self):
        """設定ファイルの読み方は1つ: TRANSFER_APP_CONFIG → config/appsettings.json → 見本。"""
        base = Path(tempfile.mkdtemp())
        (base / "config").mkdir()
        beat = lambda: app_env.load_settings(base)["presence"]["heartbeat_interval_seconds"]  # noqa: E731
        (base / "config" / "appsettings.example.json").write_text(json.dumps({"presence": {"heartbeat_interval_seconds": 1}}), encoding="utf-8")
        with mock.patch.dict(os.environ, {"TRANSFER_APP_CONFIG": ""}):
            os.environ.pop("TRANSFER_APP_CONFIG")
            self.assertEqual(beat(), 1, "appsettings.json が無ければ見本の設定")
            (base / "config" / "appsettings.json").write_text(json.dumps({"presence": {"heartbeat_interval_seconds": 2}}), encoding="utf-8")
            self.assertEqual(beat(), 2)
        other = base / "other.json"
        other.write_text(json.dumps({"presence": {"heartbeat_interval_seconds": 3}}), encoding="utf-8")
        with mock.patch.dict(os.environ, {"TRANSFER_APP_CONFIG": str(other)}):
            self.assertEqual(beat(), 3, "TRANSFER_APP_CONFIG があればそれ")


if __name__ == "__main__":
    unittest.main()
