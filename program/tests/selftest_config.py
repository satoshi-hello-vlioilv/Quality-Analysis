# -*- coding: utf-8 -*-
"""自己診断（desktop/src/selftest.js）用の設定を書く: 配った設定の見本に、品質データの元を試験用のファイルにして重ねる。

    python tests/selftest_config.py 品質データ.sqlite3 出力.json
CI が窓を TRANSFER_APP_CONFIG=出力.json で起こし、異常ロット一覧を Rust と Python で引き比べる。マスタの共有は使わない（この PC の中だけ）。
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]


def main():
    src, out = sys.argv[1], sys.argv[2]
    s = json.loads((BASE / "config" / "appsettings.example.json").read_text(encoding="utf-8"))
    s["lot_list"]["source"] = str(Path(src).resolve())
    s.setdefault("master_share", {})["dir"] = ""
    Path(out).write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
