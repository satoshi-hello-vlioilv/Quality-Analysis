# -*- coding: utf-8 -*-
"""品質データの写しの「正しい答え」を出す係（デスクトップ版の Rust との突き合わせ・desktop/tests/mirror_parity.rs が呼ぶ）。

    python tests/mirror_oracle.py scenario 作業フォルダ
        作業フォルダ/assets に試験用の元ファイル（v1・v2・テーブルの無いもの）を作り、筋書き（STEPS）を
        作業フォルダ/py で Python の DbMirror に行わせて、一歩ずつの結果を JSON で出す。Rust は作業フォルダ/rs で同じことをして比べる。
    python tests/mirror_oracle.py op 写しの置き場 元ファイル refresh|force|read_path|source_info
        1つの操作だけ（Python と Rust が同じ置き場を交互に使い、互いの台帳を読めるかを確かめる）。

時刻で変わる値（at・copiedAt・checkedAt）は「あるか」だけ、ageHours は 0.15 時間の幅で比べる（normalize）。
"""
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.db_mirror import DbMirror  # noqa: E402

# 筋書き。share は元ファイル、other は切り替え先の元ファイル（どちらも作業フォルダの下）
STEPS = [
    {"do": "new", "remote": "share", "interval": 60, "stale": 36},
    {"do": "read_path"},
    {"do": "source_info"},
    {"do": "refresh"},                                       # 元がまだ無い
    {"do": "put", "file": "share", "asset": "v1", "age": 50},
    {"do": "refresh"},                                       # 写す（バックアップ）
    {"do": "read_path"},
    {"do": "source_info"},                                   # 50 時間前 → 古い
    {"do": "refresh"},                                       # 変わっていない
    {"do": "put", "file": "share", "asset": "v2", "age": 10},
    {"do": "refresh"},                                       # 新しい世代・古い世代を片付ける
    {"do": "files"},
    {"do": "ledger"},
    {"do": "source_info"},
    {"do": "corrupt", "file": "share", "age": 1},
    {"do": "refresh", "force": True},                        # 壊れた元は見送る
    {"do": "read_path"},
    {"do": "put", "file": "share", "asset": "empty", "age": 1},
    {"do": "refresh", "force": True},                        # テーブルの無い元も見送る
    {"do": "unlink", "file": "share"},
    {"do": "refresh"},                                       # 届かない（1回目・写しはある）
    {"do": "refresh"},                                       # 2回目
    {"do": "source_info"},
    {"do": "read_path"},
    {"do": "reconfigure", "remote": "other", "interval": 5, "stale": 0},
    {"do": "read_path"},                                     # 前の元の写しは使わない
    {"do": "source_info"},
    {"do": "put", "file": "other", "asset": "v1", "age": 500},
    {"do": "refresh"},
    {"do": "source_info"},                                   # しきい 0 は古いと言わない
    {"do": "files"},
    {"do": "new", "remote": "missing", "interval": 0, "stale": 36},
    {"do": "refresh"},                                       # 届かず、写しもまだ無い
    {"do": "read_path"},
    {"do": "new", "remote": "", "interval": 60, "stale": 36},
    {"do": "refresh"},                                       # 元が決まっていない
    {"do": "read_path"},
]


def make_assets(d):
    d.mkdir(parents=True, exist_ok=True)
    for name, rows in (("v1", 3), ("v2", 40)):
        p = d / f"{name}.sqlite3"
        if not p.exists():
            c = sqlite3.connect(p)
            c.execute("CREATE TABLE [仕掛] (ロット番号 TEXT, 重量 REAL)")
            c.executemany("INSERT INTO [仕掛] VALUES (?,?)", [(f"L{i:04d}C0", i * 1.5) for i in range(rows)])
            c.commit()
            c.close()
    p = d / "empty.sqlite3"
    if not p.exists():
        c = sqlite3.connect(p)
        c.execute("PRAGMA user_version = 7")      # テーブルは無いが、中身のある SQLite のファイル
        c.commit()
        c.close()


def normalize(v, base):
    """作業フォルダの場所を <D> に、時刻を「あるか」に。"""
    b = str(base)
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if k in ("at", "copiedAt", "checkedAt"):
                out[k] = x is not None
            elif k == "ageHours" and x is not None:
                out[k] = round(x, 1)
            else:
                out[k] = normalize(x, base)
        return out
    if isinstance(v, list):
        return [normalize(x, base) for x in v]
    if isinstance(v, str):
        return v.replace(b, "<D>").replace("\\", "/")
    return v


def run(work):
    base = Path(work) / "py"
    shutil.rmtree(base, ignore_errors=True)
    base.mkdir(parents=True)
    assets = Path(work) / "assets"
    make_assets(assets)
    where = {"share": base / "share" / "SIKADEF.sqlite3", "other": base / "other.sqlite3", "missing": base / "nowhere" / "x.sqlite3", "": ""}
    (base / "share").mkdir()
    cache = base / "cache"
    m, out = None, []
    for st in STEPS:
        do = st["do"]
        r = None
        if do == "new":
            # 受け身（背景の糸を起こさない）。写すのは筋書きの refresh だけ（Rust 側も同じ: desktop/tests/mirror_parity.rs）
            m = DbMirror("lot_list", str(where[st["remote"]]), cache, interval_sec=st["interval"], stale_hours=st["stale"], passive=True)
        elif do == "put":
            shutil.copyfile(assets / f"{st['asset']}.sqlite3", where[st["file"]])
            t = time.time() - st["age"] * 3600
            os.utime(where[st["file"]], (t, t))
        elif do == "corrupt":
            where[st["file"]].write_bytes(b"not a sqlite file" * 100)
            t = time.time() - st["age"] * 3600
            os.utime(where[st["file"]], (t, t))
        elif do == "unlink":
            where[st["file"]].unlink()
        elif do == "refresh":
            r = m.refresh(force=bool(st.get("force")))
        elif do == "read_path":
            p = m.read_path()
            r = None if p is None else str(p)
        elif do == "source_info":
            r = m.source_info()
        elif do == "reconfigure":
            m.reconfigure(remote=str(where[st["remote"]]), interval_sec=st["interval"], stale_hours=st["stale"])
        elif do == "files":
            r = sorted(p.name for p in cache.iterdir())
        elif do == "ledger":
            e = json.loads((cache / "_mirror.json").read_text(encoding="utf-8"))["lot_list"]
            sig = e["signature"]
            # 印の時刻は、そのときの元ファイルの更新時刻（ns）と同じか（Python と Rust で同じ値を書くか）
            r = {"file": e["file"], "source": sig["source"], "size": sig["size"],
                 "mtime_ns_is_stat": sig["mtime_ns"] == os.stat(where["share"]).st_mtime_ns}
        out.append({"step": st, "result": normalize(r, base)})
    return out


def op(cache, remote, what):
    m = DbMirror("lot_list", remote, Path(cache))
    if what in ("refresh", "force"):
        r = m.refresh(force=what == "force")
        r.pop("at", None)
        return r
    if what == "read_path":
        return str(m.read_path())
    return m.source_info()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1] == "scenario":
        json.dump({"steps": STEPS, "results": run(sys.argv[2])}, sys.stdout, ensure_ascii=False)
    else:
        json.dump(op(*sys.argv[2:5]), sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
