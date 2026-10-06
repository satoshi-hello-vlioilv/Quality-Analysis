# -*- coding: utf-8 -*-
"""配る ZIP を組み立てる（窓の exe と、アプリ program）。設計は program/docs/DESKTOP_MIGRATION_DESIGN.md §12.1。

    python bundle.py brand <項目>                    名前の定義（program/app/brand.json）の値を出す（CI が名前を書き写さない）
    python bundle.py build --exe <exe> --out <出力先> 配る ZIP と release.json・.sha256 を作る

配る形（ZIP の中。先頭のフォルダはアプリ名）:
    <name>/<exe>          窓（Rust）。上へたどって program/sidecar.py を探す
    <name>/program/       アプリ（git ls-files の program。手元の設定・.pyc を混ぜない）
    <name>/README.md

Python は同梱しない（利用者の決めたこと 2026-10-05: 各ユーザーが PC に入れる）。窓は PATH の Python → py ランチャーの順に探す
（desktop/src/locate.rs）。アプリは Python の標準の部品だけで動くので、pip で入れる物は無い。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROGRAM = REPO / "program"
MAX_BYTES = 1 << 30          # 取り込む側（desktop/src/update.rs）が断る大きさ


def brand() -> dict:
    return {k: v for k, v in json.loads((PROGRAM / "app" / "brand.json").read_text(encoding="utf-8")).items() if not k.startswith("_")}


def app_version(program: Path = PROGRAM) -> str:
    ns: dict = {}
    exec(compile((program / "app" / "version.py").read_text(encoding="utf-8"), "version.py", "exec"), ns)
    return ns["APP_VERSION"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def program_files() -> list[str]:
    """配るアプリのファイル（git が知っている物だけ）。"""
    out = subprocess.run(["git", "ls-files", "-z", "program"], cwd=REPO, check=True, capture_output=True).stdout
    return sorted(p for p in out.decode("utf-8").split("\0") if p)


def safe_name(name: str) -> bool:
    """release.json の zip・exe は 1 つの名前（区切り・..・ドライブ名を含まない）。"""
    return bool(name) and name not in (".", "..") and not any(c in name for c in "/\\:") and name == name.strip()


def release_json(b: dict, version: str, zip_name: str, sha: str) -> dict:
    """版のフォルダの目印（desktop/src/release.rs が読む形・schema 1）。"""
    if not (safe_name(zip_name) and safe_name(b["exe"])):
        raise SystemExit(f"名前に使えない文字があります: {zip_name} / {b['exe']}")
    return {"schema": 1, "app_id": b["app_id"], "name": b["name"], "version": version, "zip": zip_name, "sha256": sha, "exe": b["exe"]}


def zip_dir(root: Path, top: str, out: Path) -> int:
    """root の中身を top/… として ZIP にする（並びは名前順）。→ ファイルの数"""
    files = sorted(p for p in root.rglob("*") if p.is_file())
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, f"{top}/{p.relative_to(root).as_posix()}")
    return len(files)


def build(exe: Path, out: Path) -> dict:
    b, version = brand(), app_version()
    stage = out / "stage" / b["name"]
    shutil.rmtree(out / "stage", ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copy2(exe, stage / b["exe"])
    for rel in program_files():
        dst = stage / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dst)
    shutil.copy2(REPO / "README.md", stage / "README.md")
    zip_name = f"{b['name']}-{version}-windows.zip"
    zpath = out / zip_name
    n = zip_dir(stage, b["name"], zpath)
    if zpath.stat().st_size > MAX_BYTES:
        raise SystemExit("配る ZIP が 1 GB を超えました（取り込む側が断ります）")
    sha = sha256_file(zpath)
    rel = release_json(b, version, zip_name, sha)
    (out / "release.json").write_text(json.dumps(rel, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (out / f"{zip_name}.sha256").write_text(f"{sha}  {zip_name}\n", encoding="ascii")
    summary = {**rel, "path": str(zpath), "files": n, "bytes": zpath.stat().st_size, "stage": str(stage)}
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("brand")
    s.add_argument("key")
    s = sub.add_parser("build")
    s.add_argument("--exe", required=True, type=Path)
    s.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "brand":
        print(brand()[a.key])
    else:
        build(a.exe, a.out)


if __name__ == "__main__":
    main()
