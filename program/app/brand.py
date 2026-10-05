# -*- coding: utf-8 -*-
"""アプリの名前（app/brand.json を読むだけ。標準ライブラリだけで書く: アプリを読み込む前の app_env からも使う）。

    name      アプリ名（窓の題名・見出し・ショートカット・配る ZIP・リリース）
    subtitle  副題（和名。見出しに添える）
    exe       入口の exe の名前
    app_id    変えない目印（更新の置き場の release.json で「このアプリの版」を見分ける。Tauri の identifier と同じ）
    data_dir  変えない作業場所のフォルダ名（%LOCALAPPDATA%\\<data_dir>）
デスクトップ版（Rust）は同じファイルを作るときに取り込む（desktop/src/brand.rs）。
"""
import json
from pathlib import Path

BRAND = {k: v for k, v in json.loads((Path(__file__).with_name("brand.json")).read_text(encoding="utf-8")).items()
         if not k.startswith("_")}
