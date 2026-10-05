# -*- coding: utf-8 -*-
"""開発用: ブラウザから画面を見る（窓の外）。 python -m app [ポート]（既定 5000。この PC の中だけで待ち受ける）。

配る物（デスクトップ版）はこれを使わない（窓口は sidecar.py）。app/web.py の serve_http で、App.handle へそのまま渡す。
"""
import sys

from . import create_app
from .web import serve_http

serve_http(create_app(), port=int(sys.argv[1]) if len(sys.argv) > 1 else 5000)
