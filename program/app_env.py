# -*- coding: utf-8 -*-
"""このアプリの置き場所の決まり（起動の仕組み・止める仕組み・サーバー・アプリ本体がすべてここを見る）。

以前は同じ式が 6 箇所に書き写されていた（手元の作業場所・アプリの名前）うえ、設定ファイルの場所は
サーバーと起動の仕組みで読み方が違った（起動の仕組みだけ TRANSFER_APP_CONFIG・見本の設定を見ず、ポートが食い違い得た）。
標準ライブラリだけで書く（Flask を読み込む前の起動の仕組みからも使う）。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent          # program フォルダ
# 作業場所のフォルダ名（変えない目印。app/brand.json の data_dir。アプリ名を変えても変えない）
DATA_DIR = json.loads((BASE / "app" / "brand.json").read_text(encoding="utf-8"))["data_dir"]


def local_root() -> Path:
    """この PC の作業場所（ログ・写し・キャッシュ）。program フォルダの外に置く（動いていても program を入れ替えられる）。
    読むたびに環境変数を見る（起動の仕組みが子のプロセスへ渡す TRANSFER_LOCAL_ROOT・試験が差し替える値を拾う）。"""
    if os.environ.get("TRANSFER_LOCAL_ROOT"):
        return Path(os.environ["TRANSFER_LOCAL_ROOT"])
    return Path(os.environ.get("LOCALAPPDATA") or os.environ.get("TEMP") or Path.home()) / DATA_DIR


def config_path(base: Path = BASE) -> Path:
    """配った設定ファイル（TRANSFER_APP_CONFIG があればそれ。無ければ config/appsettings.json、それも無ければ見本）。"""
    path = Path(os.getenv("TRANSFER_APP_CONFIG", Path(base) / "config" / "appsettings.json"))
    return path if path.exists() else Path(base) / "config" / "appsettings.example.json"


def load_settings(base: Path = BASE) -> dict:
    return json.loads(config_path(base).read_text(encoding="utf-8"))

