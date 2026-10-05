# -*- coding: utf-8 -*-
"""一本化の評価関数: ブラウザ版（ポートで待つサーバー）の名残が無く、入口がデスクトップ版の exe だけか（版 3.0.0・3.1.0）。

外したもの: ポートで待つサーバーと、それを起こす・止める・見張る仕組み（DESKTOP_MIGRATION_DESIGN.md §10.3）、
LotData-Link（Edge 拡張）の道（拡張はブラウザ版の画面にだけ入った）、
Start.vbs（版 3.1.0。exe を開くだけになっていた。更新は exe が引き継ぐ: desktop/src/update.rs）。
残すもの: 利用状況の心拍（/api/heartbeat。だれがどの版を使っているか・「新しい版あり」・切断。画面の「接続 ●」も）、
画面の設定の控え（ブラウザ版で使い込んだ設定をデスクトップ版へ引き継ぐ）。

更新履歴（app/version.py）と説明（docs・README）は歴史を書くので調べない。
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from app import create_app

PROGRAM = Path(__file__).resolve().parents[1]
REPO = PROGRAM.parent

REMOVED = ["server.py", "launch_guard.py", "process_manager.py", "local_app.py", "start_app.py", "start.bat", "stop.bat",
           "loading.html", "app/lifecycle.py", "tests/test_lifecycle.py", "tests/test_local_app.py"]

# 名残（名前 → なぜ残ってはいけないか）
FORBIDDEN = {
    "57821": "ブラウザ版のポート",
    "launch_guard": "起動の仕組み（古いサーバーの止め直し）",
    "process_manager": "ポートの持ち主探し",
    "local_app": "ポートへの問い合わせ",
    "start_app": "ブラウザ版の起動の入口",
    "loading.html": "起動を待つ画面",
    "stop.bat": "ブラウザ版の停止",
    "start.bat": "ブラウザ版の診断起動",
    "lifecycle": "ブラウザを閉じたかの推し量り",
    "LIFECYCLE": "ブラウザを閉じたかの推し量り",
    "auto_shutdown_on_close": "推し量りの設定",
    "idle_shutdown_seconds": "推し量りの設定",
    "waitress": "ポートで待つサーバーの部品",
    "/api/instance": "起動画面・起動の仕組みが尋ねた道",
    "tpaLotdspExt": "LotData-Link の名乗り",
    "data-tpa-lotdsp-ext": "LotData-Link の名乗り",
    "tpa:lotdsp-": "LotData-Link との合図",
    "fetchViaExtension": "LotData-Link の道",
    "TRANSFER_BROWSER_BY_VBS": "Start.vbs がブラウザ版を開いた印",
    "Start.vbs": "前の入口（入口は exe だけ）",
    "TPA_VBS_DRYRUN": "Start.vbs の確かめ",
    "vbs_launcher": "Start.vbs の記録",
}
SKIP = {PROGRAM / "app" / "version.py", Path(__file__).resolve()}


def scanned():
    """調べるファイル（中身・場所）。"""
    roots = [(PROGRAM, ("*.py", "*.js", "*.html", "*.css", "*.json", "*.bat")),
             (REPO / "desktop" / "src", ("*.rs", "*.js")), (REPO / "desktop" / "splash", ("*",)),
             (REPO / "desktop" / "bundle", ("*.py", "*.txt", "*.json")), (REPO / ".github", ("*.yml",))]
    for root, pats in roots:
        for pat in pats:
            for p in root.rglob(pat):
                if p.is_file() and p not in SKIP and "docs" not in p.relative_to(root).parts \
                        and "__pycache__" not in p.parts and "fixtures" not in p.parts:
                    yield p, p.read_text(encoding="utf-8", errors="replace")


class NoBrowserVersion(unittest.TestCase):
    def test_removed_files_are_gone(self):
        left = [f for f in REMOVED if (PROGRAM / f).exists()]
        self.assertEqual(left, [], "ブラウザ版だけのためのファイルが残っている")

    def test_no_leftovers_in_code(self):
        found = []
        for p, text in scanned():
            for word, why in FORBIDDEN.items():
                for m in re.finditer(re.escape(word), text):
                    line = text.count("\n", 0, m.start()) + 1
                    found.append(f"{p.relative_to(REPO)}:{line}: {word}（{why}）")
        self.assertEqual(found, [], "\n".join(found[:40]))

    def test_api_has_no_browser_only_routes(self):
        app = create_app({"TESTING": True})
        rules = {r.rule for r in app.url_map.iter_rules()}
        self.assertFalse({"/api/instance", "/api/shutdown"} & rules, "終了は窓（Rust）が答える。起動画面は無い")
        self.assertIn("/api/heartbeat", rules, "利用状況の心拍は残す")
        c = app.test_client()
        cfg = c.get("/api/config").get_json()
        self.assertNotIn("auto_shutdown_on_close", cfg)
        beat = c.post("/api/heartbeat", json={}).get_json()
        self.assertNotIn("enabled", beat, "心拍は利用状況だけ（ブラウザを閉じたかの推し量りは無い）")
        self.assertIn("version", beat)

    def test_the_exe_is_the_only_entry(self):
        left = sorted(p.name for p in REPO.glob("*") if p.suffix.lower() in (".vbs", ".bat", ".cmd", ".ps1"))
        self.assertEqual(left, [], "入口は TransferPitchAnalyzer.exe だけ（更新も exe が引き継ぐ）")

    def test_settings_have_no_port(self):
        for name in ("appsettings.json", "appsettings.example.json"):
            server = json.loads((PROGRAM / "config" / name).read_text(encoding="utf-8")).get("server", {})
            self.assertFalse({"host", "port"} & set(server), f"{name} の server に host・port が残っている")


if __name__ == "__main__":
    unittest.main()
