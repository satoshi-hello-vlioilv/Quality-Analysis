# -*- coding: utf-8 -*-
"""アプリの配布の置き場（参照先の「更新の置き場」update.source）を、別の場所・別の名前へ変える。

置き場の中身（版のフォルダ・release.json・配る ZIP・配る版の覚え・配る入口の exe）は、窓（desktop/src/distribute.rs）が作る。
ここは「置き場ごと」を扱うだけで、中身の形には触らない:
  - 確かめる（plan）… 新しい名前が Windows のフォルダ名に使えるか・上のフォルダに届くか・いまの置き場と同じ／その中でないか・
                       新しい場所が空か（既に置き場なら、写さずに切り替えるだけ）・写す量。
  - 写す（Mover）  … いまの置き場を丸ごと、新しい場所の隣の一時フォルダへ写し、写し終えてから名前を付け替える
                       （各 PC が写しかけの置き場を読まない）。前の置き場は消さない（戻せる・ほかの PC の入口が残る）。
参照先（update.source）を新しい場所へ書き換えるのは画面（/api/settings/update.source。書き込みの門番と行の版が効く）。
全員の PC が次に確かめたとき（起動・30 分ごと）から新しい置き場を見る。
"""
from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

from ..fsio import unquote_path

MARKER = "release.json"              # 版のフォルダの目印（窓が置く。release.rs が探すのも同じ）
MARKER_DEPTH = 3                     # 置き場の下を何階層まで探すか（置き場\版\release.json が 2 階層目）
NAME_MAX = 120
_BAD = set('<>:"/\\|?*') | {chr(i) for i in range(32)}
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def check_name(name) -> str:
    """フォルダの名前（Windows で使えるもの）。合わなければ ValueError（理由つき）。"""
    s = str(name or "").strip()
    if not s:
        raise ValueError("フォルダの名前を入れてください。")
    if len(s) > NAME_MAX:
        raise ValueError(f"フォルダの名前は {NAME_MAX} 字までにしてください。")
    bad = sorted({c for c in s if c in _BAD})
    if bad:
        shown = "".join(c if c.isprintable() else "（制御文字）" for c in bad)
        raise ValueError(f"フォルダの名前に使えない字があります: {shown}（\\ / : * ? \" < > | は使えません）")
    if s.endswith((".", " ")):
        raise ValueError("フォルダの名前の最後に「.」や空白は付けられません。")
    if s.split(".")[0].upper() in _RESERVED:
        raise ValueError(f"「{s}」は Windows が使う名前なので、フォルダの名前にできません。")
    if s in (".", ".."):
        raise ValueError("フォルダの名前にできません。")
    return s


def has_release(folder: Path, depth: int = MARKER_DEPTH) -> bool:
    """その下（depth 階層まで）に版の目印（release.json）があるか＝既に配布の置き場か。"""
    try:
        if (folder / MARKER).is_file():
            return True
        if depth <= 0:
            return False
        return any(has_release(p, depth - 1) for p in folder.iterdir() if p.is_dir())
    except OSError:
        return False


def _tree_size(folder: Path):
    files = size = 0
    for root, _, names in os.walk(folder):
        for n in names:
            try:
                size += (Path(root) / n).stat().st_size
                files += 1
            except OSError:
                pass
    return files, size


def _same(a: Path, b: Path) -> bool:
    try:
        return os.path.normcase(str(a.resolve())) == os.path.normcase(str(b.resolve()))
    except OSError:
        return os.path.normcase(str(a)) == os.path.normcase(str(b))


def _inside(child: Path, parent: Path) -> bool:
    c, p = os.path.normcase(str(child.resolve())), os.path.normcase(str(parent.resolve()))
    return c.startswith(p.rstrip("\\/") + os.sep)


def plan(src, parent, name, copy=True) -> dict:
    """新しい置き場（parent\\name）へ変えられるか。→ {ok, dest, mode, ...} / 変えられなければ ok=False と problem。

    mode: "copy"   … 新しい場所は無い（か空）。いまの置き場を写してから切り替える
          "switch" … 新しい場所が既に置き場（release.json がある）。写さずに参照先だけ切り替える
          "empty"  … 写さない（copy=False）・新しい場所は空。切り替えると、版を置くまで各 PC は今の版のまま"""
    try:
        name = check_name(name)
    except ValueError as e:
        return {"ok": False, "problem": str(e)}
    up = unquote_path(parent)
    if not up:
        return {"ok": False, "problem": "置く場所（上のフォルダ）を入れてください。"}
    base = Path(up)
    if not base.is_dir():
        return {"ok": False, "problem": f"上のフォルダに届きません: {up}（場所・BOX の同期・権限を確かめてください）"}
    dest = base / name
    out = {"ok": True, "dest": str(dest), "name": name, "parent": str(base)}
    s = unquote_path(src)
    srcp = Path(s) if s else None
    if srcp is not None and srcp.is_dir():
        if _same(srcp, dest):
            return {**out, "ok": False, "problem": "いまの置き場と同じ場所・名前です。"}
        if _inside(dest, srcp):
            return {**out, "ok": False, "problem": "いまの置き場の中には置けません（置き場の外のフォルダを選んでください）。"}
        if _inside(srcp, dest):
            return {**out, "ok": False, "problem": "いまの置き場を含むフォルダは選べません。"}
    exists = dest.exists()
    if exists and not dest.is_dir():
        return {**out, "ok": False, "problem": "同じ名前のファイルがあります。別の名前にしてください。"}
    dest_release = exists and has_release(dest)
    dest_empty = not exists or not any(dest.iterdir())
    if dest_release:
        return {**out, "mode": "switch", "note": "新しい場所は既に配布の置き場です（版があります）。写さずに切り替えます。"}
    if not dest_empty:
        return {**out, "ok": False, "problem": "新しい場所に、配布と関係の無い物が入っています。空のフォルダか、まだ無い名前を選んでください。"}
    if not copy:
        return {**out, "mode": "empty", "note": "写さずに切り替えます。新しい置き場に版を置いて配るまで、各 PC はいまの版のまま開きます。"}
    if srcp is None or not srcp.is_dir():
        return {**out, "ok": False, "problem": "いまの置き場に届かないので写せません。「写さずに切り替える」を選ぶか、届くときにやり直してください。"}
    files, size = _tree_size(srcp)
    return {**out, "mode": "copy", "src": str(srcp), "files": files, "bytes": size,
            "note": f"いまの置き場（{files} ファイル）を写してから切り替えます。前の置き場は消さずに残します。"}


class Mover:
    """置き場を丸ごと写す係（1つずつ。画面は progress() を尋ねて進み具合を出す）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._p = {"state": "idle"}

    def progress(self) -> dict:
        with self._lock:
            p = dict(self._p)
        if p.get("started"):
            p["elapsed"] = round(time.time() - p["started"], 1)
        return p

    def _set(self, **kw):
        with self._lock:
            self._p.update(kw)

    def start(self, src: str, dest: str, total_files: int, total_bytes: int) -> bool:
        with self._lock:
            if self._p.get("state") == "running":
                return False
            self._p = {"state": "running", "src": src, "dest": dest, "files": 0, "totalFiles": total_files,
                       "done": 0, "total": total_bytes, "started": time.time()}
        threading.Thread(target=self._run, args=(Path(src), Path(dest)), daemon=True).start()
        return True

    def run_sync(self, src: str, dest: str):
        """試験用: その場で写す（start と同じ流れ）。"""
        self._p = {"state": "running", "src": src, "dest": dest, "files": 0, "done": 0, "started": time.time()}
        self._run(Path(src), Path(dest))
        return self.progress()

    def _run(self, src: Path, dest: Path):
        tmp = dest.parent / f".{dest.name}.copying-{os.getpid()}-{int(time.time())}"
        try:
            for root, dirs, names in os.walk(src):
                rel = Path(root).relative_to(src)
                (tmp / rel).mkdir(parents=True, exist_ok=True)
                for n in names:
                    s = Path(root) / n
                    shutil.copy2(s, tmp / rel / n)
                    with self._lock:
                        self._p["files"] += 1
                        self._p["done"] = self._p.get("done", 0) + s.stat().st_size
            if dest.exists():
                dest.rmdir()               # 確かめたときは空（空でなければここで失敗し、写した物は片付ける）
            os.replace(tmp, dest)          # 写し終えてから名前を付ける（各 PC は写しかけを見ない）
            self._set(state="done", finished=time.time())
        except Exception as e:             # 届かない・権限・容量: 写しかけを片付けて理由を返す
            shutil.rmtree(tmp, ignore_errors=True)
            self._set(state="failed", error=f"写せませんでした: {e}")
