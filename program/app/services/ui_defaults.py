# -*- coding: utf-8 -*-
"""一覧の表示の設定（個人の分）の範囲と、新しく入れた PC の初期設定（開発者が押し上げる）。

- 表示の設定 … 画面が localStorage に覚えている名前のうち、一覧の見せ方に関わる物（PROFILE_KEYS）。
  画面はこの範囲を書き出し・読み込みでき、開発者は今の形を「初期設定」として置ける。範囲はここ 1 か所で決め、画面に渡す。
  その時だけの状態（効いている条件・畳んだまとまり・窓の位置・色付け・拡大率）は入れない
- 初期設定 … MasterStore のマスタ `ui_defaults`（行は {名前, 値}）。共有フォルダがあれば共有（全員の PC に効く）、
  無ければ同梱の data/ui_defaults.json（配る版に入る）。画面の設定がまだ何も無い PC（入れたばかり）が開いたときに当てる
"""
from __future__ import annotations

import json

NAME = "ui_defaults"
PROFILE_KEYS = (
    "tpa.lotlist.layout.v1",       # 表示列（並び・表示・幅・表示名・書式・揃え・式・読み替えの割り当て）
    "tpa.lotlist.colPresets.v1",   # 保存した列の設定
    "tpa.lotlist.rules.v1",        # 読み替えルール
    "tpa.lotlist.rowGap.v1", "tpa.lotlist.cellPad.v1", "tpa.lotlist.overflow.v1", "tpa.lotlist.freeze.v1",   # 列と文字
    "tpa.lotlist.arrange.v1", "tpa.lotlist.sorts.v1",   # 並び・まとめ・並べ替え
    "tpa.lotlist.pageSize.v1", "tpa.lotlist.features.v1",
    "tpa.lotlist.slicer.v1",       # スライサー（足した列・選んだ値・置き場）
    "tpa.lotlist.zoomStep.v1",     # 拡大のつまみの刻み
    "tpa.lotlist.presets.v1",      # 登録した条件・プリセット
)
MAX_BYTES = 2 * 1024 * 1024


def clean(keys):
    """{名前: 文字} のうち、表示の設定の範囲の物だけ。大きすぎれば ValueError。"""
    if not isinstance(keys, dict):
        raise ValueError("keys の形が違います（{名前: 文字}）。")
    out = {k: v for k, v in keys.items() if k in PROFILE_KEYS and isinstance(v, str)}
    if len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
        raise ValueError("表示の設定が大きすぎます。")
    return out


def load(store):
    """→ {"keys": {名前: 文字}, "updated_at", "updated_by", "revision"}（置いていなければ keys は空）"""
    rows = store.read(NAME)
    keys = {str(r.get("名前") or ""): r.get("値") for r in rows if isinstance(r, dict)}
    first = rows[0] if rows and isinstance(rows[0], dict) else {}
    return {"keys": clean({k: v for k, v in keys.items() if isinstance(v, str)}),
            "updated_at": first.get("updated_at", ""), "updated_by": first.get("updated_by") or {}, "revision": store.revision(NAME)}


def replace(store, keys):
    """初期設定を keys で置き換える（空なら初期設定を外す）。→ 置いた名前の数"""
    keys = clean(keys)

    def mutate(rows, stamp):
        rows[:] = [{"名前": k, "値": v, **stamp} for k, v in sorted(keys.items())]
        return len(rows)
    return store.write(NAME, mutate)
