# -*- coding: utf-8 -*-
"""このアプリのプログラムの指紋（アプリを読み込まずに使える小さな部品）。

配った新しいファイルに入れ替えたのに、前から動いていたアプリがそのまま使われると、古い画面（HTML）に
ディスクの新しい JS が読み込まれて画面が止まる（2026-09-29 の不具合。以前のブラウザ版で起きた）。そこで:
    - 画面に起動したときの指紋を埋め（<meta name="tpa-build">）、JS・CSS の URL にも指紋を付ける
    - app.js は2つを比べ、違えば「版が混ざっています」と言って再起動を促す
指紋 = 版（app/version.py）＋ app/ の下のプログラム（.py .html .js .css）の名前・大きさ・更新時刻。

もう1つ、配る物の中身の要約（release_digest）で版を管理する（2026-09-30。版を上げずに6回配っていたため）:
    - app/version.py の RELEASE に「配った版と、そのときの中身の要約」を書いておく
    - tests/test_version.py が、いまの中身と RELEASE を比べる。版を上げずにプログラムを変えると失敗して、直し方を言う
    - RELEASE は手で書かず、版を上げて更新履歴を足してから `python app_build.py --release` で書く
      （版が上がっていない・更新履歴の先頭がいまの版でなければ書かない）。
      まだ配っていない版を直しただけなら `python app_build.py --amend`（版はそのままで要約だけ書き直す）
"""
import hashlib
import os
import re
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
EXTS = (".py", ".html", ".js", ".css", ".json")


def app_version(base=BASE):
    try:
        m = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', (Path(base) / "app" / "version.py").read_text(encoding="utf-8"))
        return m.group(1) if m else ""
    except OSError:
        return ""


def fingerprint(base=BASE):
    """版＋プログラムのファイルの名前・大きさ・更新時刻の要約（12 桁）。ファイルが1つでも変われば変わる。"""
    base = Path(base)
    h = hashlib.sha1(app_version(base).encode("utf-8"))
    root = base / "app"
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in ("__pycache__", "vendor"))
        for name in filenames:
            if name.endswith(EXTS):
                p = Path(dirpath) / name
                try:
                    st = p.stat()
                except OSError:
                    continue
                items.append(f"{p.relative_to(root).as_posix()}|{st.st_size}|{st.st_mtime_ns}")
    for it in sorted(items):
        h.update(it.encode("utf-8"))
    return f"{app_version(base)}-{h.hexdigest()[:12]}"


# ------------------------------------------------------------------ 配る物の中身の要約（版の管理）
# 配る物: app/（three.js も）・窓口（sidecar.py）と場所の決まり・設定・マスタの初期値（入口の exe は desktop/ で作る）。
# 説明（README・docs・.md）とテストは含めない。app/version.py 自身も含めない（RELEASE を書くと要約が変わるため）
RELEASE_GLOBS = ("app/**/*", "*.py", "config/*.json", "data/*")
RELEASE_SKIP = {"app/version.py"}


def release_files(base=BASE):
    base = Path(base).resolve()
    out = {}
    for pattern in RELEASE_GLOBS:
        for p in base.glob(pattern):
            if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".md"):
                continue
            rel = os.path.relpath(p, base).replace(os.sep, "/")
            if rel not in RELEASE_SKIP:
                out[rel] = p
    return dict(sorted(out.items()))


def release_digest(base=BASE):
    """配る物の中身の要約（16 桁）。改行は LF にそろえる（Windows で取り出して CRLF になっても同じ要約）。"""
    h = hashlib.sha256()
    for rel, p in release_files(base).items():
        h.update(rel.encode("utf-8") + b"\0" + p.read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()[:16]


def _version_module(base):
    """app/version.py を原文から読む（__pycache__ の控えは、同じ秒・同じ大きさの書き直しに気づかないことがある）。"""
    path = Path(base) / "app" / "version.py"
    ns = {}
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), ns)
    return ns


def _write_release(base, version, digest):
    import importlib.util
    path = Path(base) / "app" / "version.py"
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(r'^RELEASE = .*$', f'RELEASE = {{"version": "{version}", "digest": "{digest}"}}', text, flags=re.M)
    if n != 1:
        raise SystemExit("app/version.py に RELEASE の行が見つかりません。")
    path.write_text(new, encoding="utf-8")
    Path(importlib.util.cache_from_source(str(path))).unlink(missing_ok=True)   # 直後のテストが古い控えを読まないように


def record_release(base=BASE, amend=False):
    """RELEASE を書く。版を上げずに中身だけ変えた記録は作らない（上げ忘れを止めるための仕組みなので）。"""
    v = _version_module(base)
    digest = release_digest(base)
    cur, rel, key = v["APP_VERSION"], v["RELEASE"], v["version_key"]
    if v["CHANGELOG"][0]["version"] != cur:
        raise SystemExit(f"更新履歴（CHANGELOG）の先頭が版 {cur} ではありません。先頭に {cur} の1件を足してください。")
    if rel["version"] == cur and rel["digest"] == digest:
        return f"記録済みです（{cur}・{digest}）。"
    if rel["version"] == cur and not amend:
        raise SystemExit(f"版 {cur} は記録済みで、そのあとプログラムが変わっています。"
                         f"版を上げて（app/version.py の APP_VERSION と CHANGELOG の先頭）からもう一度。"
                         f"まだ配っていない {cur} を直しただけなら --amend。")
    if key(cur) < key(rel["version"]):
        raise SystemExit(f"版 {cur} が、記録済みの {rel['version']} より古くなっています。")
    _write_release(base, cur, digest)
    return f"記録しました: {cur}・{digest}"


if __name__ == "__main__":
    if "--release" in sys.argv or "--amend" in sys.argv:
        print(record_release(BASE, amend="--amend" in sys.argv))
    else:
        print(f"指紋 {fingerprint()}・配る物の要約 {release_digest()}（{len(release_files())} ファイル）")
