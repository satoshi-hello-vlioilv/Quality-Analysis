# -*- coding: utf-8 -*-
"""共有上の読み取り専用 SQLite を、手元へ写してから読む（WaveLog backend/db_mirror.py と同じ方式）。

なぜ写すか
    品質データ（SIKADEF.sqlite3）は別の PC の別のアプリが更新している。SMB 越しの
    SQLite のロックは当てにならず、書き手がファイルごと置き換えることもあるので、
    共有を直接読むと更新中の中途半端な状態を読むことがある。共有を手元の一時ファイルへ
    写し、写しが正しいと確かめてから切り替え、画面はいつも手元の写しだけを読む。

写し方（この順）
    1. SQLite のバックアップ API（書き手が動いていても一貫したスナップショット）
    2. 失敗したらバイト単位のコピー
    どちらも採用前に PRAGMA quick_check で検査し、壊れていれば捨てて前の写しを使い続ける。

世代名
    写しは毎回新しい名前 <キー>.g<世代>.sqlite3 で作り、台帳 _mirror.json が今の世代を指す。
    Windows では開いているファイルを置き換えられないため、上書きしない（読み手とぶつからない）。
    古い世代は消せたときに消す（読んでいる間は消えないので、次の周回でまた試す）。

いつ写すか
    背景スレッドが一定間隔で元ファイルの (パス, サイズ, 更新時刻) を見て、変わっていれば写す。
    共有へ触るのは背景スレッド（と利用者が押した「再読込」）だけで、一覧を出す要求の中では
    共有を stat しない。写しがまだ無いときだけ元を直接読む（fail-open）。
    起動して最初の周回が済むまでは、読む側が待つ（前回の起動の古い写しを出さない）。

受け身（passive）
    デスクトップ版では写しの係を Rust（desktop/src/mirror.rs）が受け持つ。同じ台帳・同じ世代名で写すので、
    このプロセスは写さず（背景スレッドを起こさない）、台帳を読むだけにする（read_path・source_info はそのまま使える）。
    台帳の形（signature の source・size・mtime_ns と file）を変えるときは、Rust 側も合わせる（desktop/tests/mirror_parity.rs が突き合わせる）。
"""
import contextlib
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from ..fsio import retrying, write_json_atomic
from .sqlite_ro import ro_uri

log = logging.getLogger(__name__)

LEDGER = "_mirror.json"
DEFAULT_INTERVAL_SEC = 60
MIN_INTERVAL_SEC = 10
FIRST_WAIT_SEC = 30
STAT_RETRY_SEC = (0.3, 0.7, 1.5)          # 書き直しの最中の一瞬の不在は待って取り直す
RETRY_AFTER_UNREACHABLE_SEC = 10          # 届かなくなった最初の1回は早めに取り直す
REPLACE_BUDGET_SEC = 2.0
DEFAULT_STALE_HOURS = 36                  # 毎日の更新が1回抜けたら気づく長さ（夜中の更新時刻のずれは許す）


def _os_error_text(e):
    if e is None:
        return ""
    win = getattr(e, "winerror", None)
    code = f"WinError {win}" if win else (f"Errno {e.errno}" if getattr(e, "errno", None) else "")
    return f"{code} {getattr(e, 'strerror', None) or e}".strip()


def _retrying(fn, budget=REPLACE_BUDGET_SEC):
    """置き換え・削除は開かれている間 Windows で拒まれるので、少し待ってやり直す（fsio.retrying）。"""
    return retrying(fn, budget)


class DbMirror:
    def __init__(self, key, remote, cache_dir, interval_sec=DEFAULT_INTERVAL_SEC, stale_hours=DEFAULT_STALE_HOURS, passive=False):
        self.key = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in str(key or "db"))
        self.remote = str(remote or "")
        self.cache_dir = Path(cache_dir)
        self.interval = max(MIN_INTERVAL_SEC, int(interval_sec or DEFAULT_INTERVAL_SEC))
        # 元データは毎日更新される前提。最後の更新からこれより経っていたら「古い」と言う（0 以下なら言わない）
        self.stale_hours = float(stale_hours if stale_hours is not None else DEFAULT_STALE_HOURS)
        self._lock = threading.RLock()
        self._refresh_lock = threading.Lock()   # 背景の周回と「再読込」を1本ずつ
        self._first = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._state = {}
        self.passive = bool(passive)

    def reconfigure(self, remote=None, interval_sec=None, stale_hours=None):
        """参照先マスタで元ファイル・間隔・古さのしきいが変わったとき、起動し直さずに切り替える。
        元のパスは写しの印に入っているので、前の元の写しは使われない（新しい元を写すまでは元を直接読む）。
        変わった物があれば True。"""
        changed = False
        with self._lock:
            if remote is not None and str(remote) != self.remote:
                self.remote = str(remote)
                self._state = {}
                changed = True
            if interval_sec is not None:
                iv = max(MIN_INTERVAL_SEC, int(interval_sec))
                if iv != self.interval:
                    self.interval = iv
                    changed = True
            if stale_hours is not None and float(stale_hours) != self.stale_hours:
                self.stale_hours = float(stale_hours)
                changed = True
        if changed and not self.passive:
            if self._thread is None or not self._thread.is_alive():
                self.start()
            self.wake()
        return changed

    # ------------------------------------------------------------ 台帳
    @property
    def enabled(self):
        return bool(self.remote)

    def _ledger_path(self):
        return self.cache_dir / LEDGER

    def _ledger(self):
        """台帳（元ファイルごとの「どの写しが・どの元から」）。読めない・壊れていれば空。"""
        try:
            data = json.loads(self._ledger_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _entry(self):
        e = self._ledger().get(self.key)
        return e if isinstance(e, dict) else {}

    def _save_entry(self, signature, filename):
        data = self._ledger()
        data[self.key] = {"signature": signature, "file": str(filename)}
        write_json_atomic(self._ledger_path(), data, indent=1, retry_budget=REPLACE_BUDGET_SEC)

    def _generation_path(self, gen):
        return self.cache_dir / f"{self.key}.g{int(gen)}.sqlite3"

    def _next_generation(self):
        top, prefix = 0, f"{self.key}.g"
        try:
            for p in self.cache_dir.glob(f"{prefix}*.sqlite3"):
                try:
                    top = max(top, int(p.name[len(prefix):-len(".sqlite3")]))
                except ValueError:
                    continue
        except OSError:
            pass
        return top + 1

    def mirror_path(self):
        name = self._entry().get("file")
        return self.cache_dir / str(name) if name else None

    def _sweep(self, keep):
        keep = Path(keep).name
        try:
            olds = [p for p in self.cache_dir.glob(f"{self.key}.g*.sqlite3") if p.name != keep]
        except OSError:
            return
        for p in olds:
            try:
                _retrying(p.unlink, budget=0.2)
            except OSError:
                pass   # 読んでいる間は消せない。次の周回でまた試す

    # ------------------------------------------------------------ 共有へ触る（背景・再読込のみ）
    def _remote_stat(self, retry):
        err = None
        for wait in ((0,) + STAT_RETRY_SEC if retry else (0,)):
            if wait:
                time.sleep(wait)
            try:
                st = os.stat(self.remote)
                # 元のパスも印に含める（パスを差し替えたら前の写しを使わない）
                return {"source": self.remote, "size": st.st_size, "mtime_ns": st.st_mtime_ns}, ""
            except OSError as e:
                err = e
        return None, _os_error_text(err)

    @staticmethod
    def _snapshot_backup(remote, tmp):
        src = sqlite3.connect(ro_uri(remote), uri=True, timeout=15)
        try:
            dst = sqlite3.connect(str(tmp))
            try:
                src.backup(dst, pages=256, sleep=0.05)
            finally:
                dst.close()
        finally:
            src.close()

    @staticmethod
    def _verify(tmp):
        try:
            c = sqlite3.connect(ro_uri(tmp), uri=True, timeout=10)
        except sqlite3.Error as e:
            return f"開けません: {e}"
        try:
            row = c.execute("PRAGMA quick_check(1)").fetchone()
            if not row or str(row[0]).lower() != "ok":
                return f"整合性検査に通りません: {row[0] if row else '(応答なし)'}"
            n = c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
            if not int(n or 0):
                return "テーブルが1つもありません（まだ書き込み中の可能性）"
        except sqlite3.Error as e:
            return f"読めません: {e}"
        finally:
            c.close()
        return None

    def refresh(self, force=False):
        """1回ぶん写し直す。結果（画面の診断用）を返す。"""
        with self._refresh_lock:
            return self._refresh(force)

    def _refresh(self, force):
        res = {"updated": False, "reason": "", "at": time.time(), "remote": self.remote}
        if not self.enabled:
            res["reason"] = "元ファイルが設定されていません"
            return self._record(res)
        entry = self._entry()
        local = self.mirror_path()
        has_local = bool(local and local.exists())
        prev = self._state
        known_good = bool(prev) and prev.get("remote") == self.remote and not prev.get("unreachable")
        sig, err = self._remote_stat(retry=known_good)
        if sig is None:
            same = bool(prev.get("unreachable")) and prev.get("remote") == self.remote
            res.update(unreachable=True, error=err, fails=(int(prev.get("fails") or 1) + 1) if same else 1)
            res["reason"] = ("共有の元ファイルへ届かないため、前の写しを使い続けます" if has_local
                             else "共有の元ファイルへ届かず、写しもまだありません") + f"（{Path(self.remote).name}: {err}）"
            if not (same and prev.get("error") == err):
                log.warning("%s: %s", self.key, res["reason"])
            return self._record(res)
        if not force and has_local and entry.get("signature") == sig:
            res.update(skipped=True, reason="元ファイルは変わっていません")
            self._sweep(local)
            return self._record(res)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        target = self._generation_path(self._next_generation())
        tmp = target.with_suffix(".sqlite3.tmp")
        with contextlib.suppress(OSError):
            tmp.unlink()
        try:
            try:
                self._snapshot_backup(self.remote, tmp)
                how = "backup"
            except Exception as e:
                log.info("%s: バックアップAPIで写せなかったのでコピーします: %s", self.key, e)
                shutil.copyfile(self.remote, tmp)
                how = "copy"
        except Exception as e:
            res["reason"] = f"写せませんでした: {e}"
            self._cleanup(tmp)
            return self._record(res)
        bad = self._verify(tmp)
        if bad:
            res["reason"] = f"写しが正しくないため見送りました（{bad}）"
            self._cleanup(tmp)
            return self._record(res)
        try:
            _retrying(lambda: os.replace(tmp, target))
            self._save_entry(sig, target.name)
        except OSError as e:
            res["reason"] = f"写しを置き換えられませんでした: {e}"
            self._cleanup(tmp)
            return self._record(res)
        res.update(updated=True, how=how,
                   reason="写しを更新しました（" + ("バックアップAPI" if how == "backup" else "コピー") + "）")
        self._sweep(target)
        return self._record(res)

    @staticmethod
    def _cleanup(tmp):
        with contextlib.suppress(OSError):
            _retrying(Path(tmp).unlink, budget=1.0)

    def _record(self, res):
        with self._lock:
            self._state = res
        return res

    # ------------------------------------------------------------ 読む側
    def read_path(self):
        """実際に読む場所。その元から作った写しがあればそれ、無ければ元（fail-open）。"""
        if not self.enabled:
            return None
        if not self._first.is_set() and self._thread is not None and self._thread.is_alive():
            self._first.wait(FIRST_WAIT_SEC)
        entry = self._entry()
        sig = entry.get("signature") or {}
        if sig.get("source") and str(sig["source"]) != self.remote:
            return Path(self.remote)
        local = self.mirror_path()
        try:
            if local and local.exists():
                return local
        except OSError:
            pass
        return Path(self.remote)

    def source_info(self):
        """いま読んでいるデータは「いつのものか」。共有は stat しない（台帳の印から読む）。
        取れないものは None（「分からない」を 0 や「たった今」にしない）。"""
        out = {"remote": self.remote, "at": None, "mirrored": False, "copiedAt": None,
               "checkedAt": None, "unreachable": False, "reason": "", "interval_sec": self.interval}
        entry = self._entry()
        sig = entry.get("signature") or {}
        local = self.mirror_path()
        try:
            mirrored = bool(local) and sig.get("source") == self.remote and local.exists()
        except OSError:
            mirrored = False
        out["mirrored"] = mirrored
        if mirrored:
            if isinstance(sig.get("mtime_ns"), (int, float)):
                out["at"] = float(sig["mtime_ns"]) / 1e9
            with contextlib.suppress(OSError):
                out["copiedAt"] = local.stat().st_mtime
        with self._lock:
            st = dict(self._state)
        if isinstance(st.get("at"), (int, float)):
            out["checkedAt"] = float(st["at"])
        out["unreachable"] = bool(st.get("unreachable"))
        out["reason"] = st.get("reason", "")
        # 元データの古さ: 元ファイルが最後に書き換えられた時刻（写しの台帳の印）から、いまで何時間か。
        # 分からない（まだ写していない）ときは None（「古くない」と言い切らない）
        out["staleHours"] = self.stale_hours
        if out["at"] is not None:
            age = (time.time() - out["at"]) / 3600
            out["ageHours"] = round(age, 1)
            out["stale"] = bool(self.stale_hours > 0 and age > self.stale_hours)
        else:
            out["ageHours"] = None
            out["stale"] = None
        return out

    # ------------------------------------------------------------ 背景スレッド
    def _next_wait(self):
        st = self._state
        if st.get("unreachable") and int(st.get("fails") or 1) == 1:
            return min(self.interval, RETRY_AFTER_UNREACHABLE_SEC)
        return self.interval

    def _loop(self):
        try:
            self.refresh()
        except Exception as e:
            log.warning("写しの更新に失敗しました: %s", e)
        finally:
            self._first.set()
        while True:
            self._wake.clear()
            self._wake.wait(self._next_wait())
            try:
                self.refresh()
            except Exception as e:
                log.warning("写しの更新に失敗しました: %s", e)

    def start(self):
        with self._lock:
            if self.passive or not self.enabled or (self._thread and self._thread.is_alive()):
                return False
            self._thread = threading.Thread(target=self._loop, name=f"db-mirror-{self.key}", daemon=True)
            self._thread.start()
            return True

    def wake(self):
        self._wake.set()
