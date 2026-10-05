# -*- coding: utf-8 -*-
"""画面の設定（列の並び・読み替えルール・表示列のプリセット・窓の配置など）の控え。

画面は設定を localStorage に覚えている（shared.js の TPA.local）。localStorage は「画面の置き場（オリジン）」ごとに
別なので、以前のブラウザ版（ポートの置き場）で使い込んだ設定は、デスクトップ版（http://tpa.localhost）から見えない。
このため画面は覚え直すたびに「変わった名前だけ」をここ（この PC の作業場所）へ送って控えに重ね、
開くときに控えのほうが新しければ（版の番号 rev が進んでいれば）戻す。
ブラウザ版で使い込んだ設定もここから引き継ぐ（版 3.0.0 でブラウザ版を外したあとも）。WebView の作業場所が消えても戻せる。
控えを丸ごと置き換えないのは、2つの窓が同時に開いているとき、片方の古い全体がもう片方の新しい変更を消さないため。

控えに入れるのは tpa. で始まる名前だけ（ほかのページ・拡張が書いたものは入れない）。
"""
from __future__ import annotations

import json
import threading

import app_env

from ..fsio import write_json_atomic

PREFIX = "tpa."
MAX_BYTES = 4 * 1024 * 1024          # localStorage の上限（5MB 前後）より小さく。超える控えは受け取らない
_LOCK = threading.Lock()


def path():
    return app_env.local_root() / "ui_state.json"


def load() -> dict:
    """→ {"rev": 控えの版（重ねるたびに1つ進む。無ければ 0）, "keys": {名前: 文字}}。無い・壊れているときは空。"""
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
        keys = {k: v for k, v in (data.get("keys") or {}).items() if k.startswith(PREFIX) and isinstance(v, str)}
        return {"rev": int(data.get("rev") or 0), "keys": keys}
    except (OSError, ValueError, AttributeError, TypeError):
        return {"rev": 0, "keys": {}}


def merge(changed, removed=()) -> dict:
    """変わった名前（changed: {名前: 文字}）と消した名前（removed）を控えに重ねる → {"rev": 重ねたあとの版}"""
    if not isinstance(changed, dict) or not isinstance(removed, (list, tuple)):
        raise ValueError("changed・removed の形が違います。")
    def ok(k):
        return isinstance(k, str) and k.startswith(PREFIX)

    with _LOCK:
        cur = load()
        keys = cur["keys"]
        keys.update({k: v for k, v in changed.items() if ok(k) and isinstance(v, str)})
        for k in removed:
            if ok(k):
                keys.pop(k, None)
        if len(json.dumps(keys, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
            raise ValueError("画面の設定が大きすぎます。")
        rev = cur["rev"] + 1
        write_json_atomic(path(), {"rev": rev, "keys": keys}, indent=0)
    return {"rev": rev}
