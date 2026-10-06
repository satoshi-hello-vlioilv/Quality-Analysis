# -*- coding: utf-8 -*-
"""配る形と更新の通しを、本物の窓で確かめる（評価関数・設計書「更新（B+）」）。Windows の CI と、手元の Linux（xvfb-run の下）で流す。

    python verify.py update --exe <作った exe> [--work <作業フォルダ>] [--keep]

利用者の PC を真似る: 作業場所（TRANSFER_LOCAL_ROOT）はまっさら、配る形は共有を真似たフォルダ、更新の置き場は BOX を真似たフォルダ。
窓は自己診断（TPA_SELFTEST）で起こし、結果のファイル（selftest.js が更新の係の状態と、動いている exe・program を添える）を読む。

  1. 共有の exe を開く → この PC の app へ写り、版ごとの写しの窓で開く。使っている間に置き場の次の版（+1）を取り込む（ready）
  2. app の exe（ショートカットの行き先）を開く → 起動の最初に +1 へ入れ替わり、その版で開く。直前の版は控えに
  3. 起動できない版（+2）を置いて開く → 使っている間に取り込む
  4. もう一度開く → +2 へ入れ替えるが起動できず、控え（+1）へ戻して開き直す。+2 には印が付き、もう取り込まない
  5. 配る版を前の版（distribute.json）に戻す → 使っている間に戻す向きで取り込み、配る版を作業場所に覚える（want.json）
  6. 開き直すと配る版になる
  あわせて: 共有の配る形は 1 ファイルも変わらない・終わったあと Python が残らない。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import bundle

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
WAIT = 240


def bump(v: str, n: int) -> str:
    a, b, c = (int(x) for x in v.split("."))
    return f"{a}.{b}.{c + n}"


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(x for x in root.rglob("*") if x.is_file()):
        h.update(p.relative_to(root).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()


def place(stage: Path, version: str, rel_root: Path, broken: bool = False) -> None:
    """配る形 stage の版を書き換えて ZIP にし、置き場の <アプリ>/<版>/ に release.json と並べて置く。"""
    b = bundle.brand()
    work = Path(tempfile.mkdtemp(prefix="da-variant-"))
    try:
        top = work / b["name"]
        shutil.copytree(stage, top)
        vp = top / "program" / "app" / "version.py"
        text = vp.read_text(encoding="utf-8")
        old = bundle.app_version(top / "program")
        vp.write_text(text.replace(f'APP_VERSION = "{old}"', f'APP_VERSION = "{version}"', 1), encoding="utf-8")
        if broken:   # 中身が起動できない版（取り込みの確かめは通る）
            (top / "program" / "sidecar.py").write_text('raise SystemExit("試験のために壊した版")\n', encoding="utf-8")
        dest = rel_root / b["name"] / version
        dest.mkdir(parents=True, exist_ok=True)
        zip_name = f"{b['name']}-{version}-windows.zip"
        bundle.zip_dir(top, b["name"], dest / zip_name)
        rel = bundle.release_json(b, version, zip_name, bundle.sha256_file(dest / zip_name))
        (dest / "release.json").write_text(json.dumps(rel, ensure_ascii=False, indent=1), encoding="utf-8")
    finally:
        shutil.rmtree(work, ignore_errors=True)


class Run:
    def __init__(self, work: Path, env: dict):
        self.work, self.env, self.n = work, env, 0

    def open(self, exe: Path, label: str) -> dict:
        """exe を開き、自己診断の結果を待つ（入口・写し・開き直しの窓をたどった先の窓が書く）。"""
        self.n += 1
        out = self.work / f"selftest-{self.n}-{label}.json"
        env = {**self.env, "TPA_SELFTEST": str(out)}
        subprocess.Popen([str(exe)], cwd=str(exe.parent), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.time() + WAIT
        while time.time() < end and not out.exists():
            time.sleep(1)
        time.sleep(3)    # 窓と Python が終わるのを待つ
        if not out.exists():
            return {"ok": False, "error": f"{WAIT} 秒たっても結果がありません（{label}）"}
        r = json.loads(out.read_text(encoding="utf-8"))
        # 試験の版は program の版だけを書き換えた物（窓の exe は元の版のまま）なので、「窓の版と中身の版が同じ」は数えない。
        # 本物の配る形では、窓と中身は同じ版で作る（bundle.py・test_version.py）
        res = [x for x in r.get("results", []) if x["name"] != "窓の版と中身の版が同じ"]
        for x in res:
            if not x["ok"]:
                print(f"  [{label}] FAIL {x['name']} -- {x['info']}")
        if "results" in r:
            r["ok"] = bool(res) and all(x["ok"] for x in res)
        return r


def check(cond: bool, what: str, info="") -> bool:
    print(("PASS " if cond else "FAIL ") + what + (f" -- {info}" if info else ""))
    return cond


def leftover_python(root: Path) -> list[str]:
    """作業フォルダの program を動かしている Python が残っていないか（Linux は /proc、Windows は wmic の代わりに tasklist では見えないので省く）。"""
    if os.name == "nt":
        return []
    out = []
    for d in Path("/proc").iterdir():
        if d.name.isdigit():
            try:
                cmd = (d / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
            except OSError:
                continue
            if "sidecar.py" in cmd and str(root) in cmd:
                out.append(f"{d.name}: {cmd[:120]}")
    return out


def update(exe: Path, work: Path) -> bool:
    b = bundle.brand()
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    built = bundle.build(exe, work / "out")
    v0 = built["version"]
    v1, v2 = bump(v0, 1), bump(v0, 2)
    share = work / "share"
    with zipfile.ZipFile(built["path"]) as z:
        z.extractall(share)
    share_app = share / b["name"]
    share_exe = share_app / b["exe"]
    if os.name != "nt":
        share_exe.chmod(0o755)
    share_digest = tree_digest(share_app)
    rel_root = work / "Releases"
    place(Path(built["stage"]), v0, rel_root)     # 置き場には配った版も並ぶ（配る版を前の版に戻すときに選ぶ）
    place(Path(built["stage"]), v1, rel_root)
    fixture = work / "q.sqlite3"
    subprocess.run([sys.executable, str(REPO / "program" / "tests" / "lotlist_fixture.py"), str(fixture), "300"], check=True, capture_output=True)
    conf = work / "appsettings.json"
    subprocess.run([sys.executable, str(REPO / "program" / "tests" / "selftest_config.py"), str(fixture), str(conf), str(rel_root)], check=True)
    local = work / "local"
    env = {k: v for k, v in os.environ.items() if k not in ("TPA_NO_HANDOFF", "TPA_PROGRAM_DIR", "TPA_SELFTEST")}
    env.update({"TRANSFER_APP_CONFIG": str(conf), "TRANSFER_LOCAL_ROOT": str(local)})
    run = Run(work, env)
    app = local / "app"
    ok = True

    # 1. 共有の exe を開く
    r = run.open(share_exe, "share")
    info, upd = r.get("info") or {}, r.get("update") or {}
    ok &= check(r.get("ok") is True, "1. 共有の exe で開くと自己診断が通る", r.get("error", ""))
    ok &= check(Path(info.get("program", "")).resolve() == (app / "program").resolve(), "1. この PC の app の program で動く", info.get("program"))
    ok &= check(str(local / "desktop") in str(info.get("exe", "")), "1. 窓は版ごとの写しで動く（app を掴まない）", info.get("exe"))
    ok &= check(info.get("installed") is True and info.get("version") == v0, f"1. 版 {v0}", json.dumps(info, ensure_ascii=False))
    ok &= check(upd.get("state") == "ready" and upd.get("ready") == v1, f"1. 使っている間に {v1} を取り込んだ", json.dumps(upd, ensure_ascii=False)[:300])
    ok &= check(bundle.app_version(app / "program") == v0, "1. 取り込んでも動いている app はそのまま")

    # 2. ショートカットの行き先（app の exe）で開く → 入れ替わる
    r = run.open(app / b["exe"], "app")
    info, upd = r.get("info") or {}, r.get("update") or {}
    ok &= check(r.get("ok") is True, "2. app の exe で開くと自己診断が通る", r.get("error", ""))
    ok &= check(info.get("version") == v1, f"2. 起動の最初に {v1} へ入れ替わった", info.get("version"))
    ok &= check(bundle.app_version(local / "update" / "old" / "program") == v0, f"2. 直前の版 {v0} は控えに")
    ok &= check(upd.get("state") == "latest", "2. 置き場の最新を使っている", upd.get("state"))

    # 3. 起動できない版を置き、使っている間に取り込ませる
    place(Path(built["stage"]), v2, rel_root, broken=True)
    r = run.open(app / b["exe"], "stage-broken")
    upd = r.get("update") or {}
    ok &= check(r.get("ok") is True and upd.get("ready") == v2, f"3. {v2} を取り込んだ（まだ {v1} で動く）", json.dumps(upd, ensure_ascii=False)[:300])

    # 4. 開く → 入れ替えるが起動できず、控えへ戻して開き直す
    r = run.open(app / b["exe"], "revert")
    info, upd = r.get("info") or {}, r.get("update") or {}
    ok &= check(r.get("ok") is True and info.get("version") == v1, f"4. {v2} は起動できず、{v1} に戻して開き直した", info.get("version"))
    failed = json.loads((local / "update" / "FAILED.json").read_text(encoding="utf-8")).get("versions", []) if (local / "update" / "FAILED.json").exists() else []
    ok &= check(failed == [v2], f"4. {v2} に起動できなかった印", failed)
    ok &= check(upd.get("state") == "latest" and v2 in (upd.get("failed") or []), "4. 起動できなかった版はもう取り込まない", json.dumps(upd, ensure_ascii=False)[:300])

    # 5. 配る版を前の版（v0）に戻す → 使っている間に取り込み（戻す向き）、配る版を作業場所に覚える
    (rel_root / b["name"] / "distribute.json").write_text(json.dumps(
        {"schema": 1, "app_id": b["app_id"], "version": v0, "entry": b["exe"], "setAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
         "setBy": "verify", "setPc": "verify", "previous": v1}, ensure_ascii=False), encoding="utf-8")
    r = run.open(app / b["exe"], "distribute-down")
    upd = r.get("update") or {}
    want = json.loads((local / "want.json").read_text(encoding="utf-8")) if (local / "want.json").exists() else {}
    ok &= check(r.get("ok") is True and upd.get("ready") == v0 and upd.get("direction") == "down", f"5. 配る版 {v0} を戻す向きで取り込んだ",
                json.dumps(upd, ensure_ascii=False)[:300])
    ok &= check(want.get("version") == v0, "5. 配る版を作業場所に覚えた（Python の利用状況が最新版に使う）", want)
    r = run.open(app / b["exe"], "distribute-open")
    ok &= check(r.get("ok") is True and (r.get("info") or {}).get("version") == v0, f"6. 開き直すと配る版 {v0} になる",
                (r.get("info") or {}).get("version"))

    ok &= check(tree_digest(share_app) == share_digest, "共有の配る形は 1 ファイルも変わらない")
    left = leftover_python(work)
    ok &= check(not left, "終わったあと Python が残らない", left)
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("update")
    s.add_argument("--exe", required=True, type=Path)
    s.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "da-verify")
    s.add_argument("--keep", action="store_true")
    a = ap.parse_args(argv)
    ok = update(a.exe.resolve(), a.work.resolve())
    if not a.keep and ok:
        shutil.rmtree(a.work, ignore_errors=True)
    print("OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
