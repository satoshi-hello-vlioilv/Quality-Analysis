# -*- coding: utf-8 -*-
"""マスタの置き場（手元／共有）と、書き込みの競合管理。**置き場の答えはここ1箇所。**

WaveLog のマスタ共有（WaveLog §9.263・§9.384）と同じ考え方を JSON のマスタへ当てる。

    読む   … 手元の写し（%LOCALAPPDATA%/TransferPitchAnalyzer/master_cache）。
             共有は「数秒に1回、変わったかを見る」だけで、読むたびには開かない。
             共有に届かなくても、前に取った写しで読み続ける（fail-open）。
    書く   … 錠を取る → 共有から取り直す → 行の版を確かめて当てる → 版番号を上げる
             → 共有を丸ごと置き換える（書きかけを拾わせないよう一時ファイル＋置換）→ 錠を返す。
             取り直してから当てるので、ほかの PC が書いた変更を踏み潰さない。

競合の種類（どれも理由を付けて返し、黙って上書きしない）
    MasterLocked    … ほかの PC が保存中（誰が・あと何秒）。錠は短い（既定20秒）ので待てば通る。
    RowConflict     … 開いてから保存するまでに、同じ行がほかの PC で変わった／消えた。
    DuplicateKey    … 同じ名前の行がもうある（設備名など、名前で引くマスタ）。
    ShareUnavailable… 共有に届かない。読みは写しで続くが、書きは断る（写しだけ書くと PC ごとにずれる）。

共有しない設定（`master_share.dir` が空）のときは、アプリの `data/` の JSON を読み書きする
（これまでどおり）。行の版の確認はこのときも効く（同じ PC の2つの画面の競合を防ぐ）。
"""
from __future__ import annotations

import contextlib
import copy
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import app_env

from ..fsio import retrying, write_json_atomic

log = logging.getLogger("transfer-app")

LOCK_FILENAME = "master.lock.json"
MOVED_FILENAME = "_MOVED.json"        # 置き場を変えたとき、前の置き場に置く引っ越し先の印（{to, at, by}）。ほかの PC がたどる
OVERRIDE_FILENAME = "master_share.json"   # この PC が使う置き場（設定ファイルの master_share.dir より先。作業場所に置く）
MOVED_HOPS = 5                        # 引っ越し先を何回までたどるか（印が輪になっていても止まる）
HISTORY_KEEP = 10                     # この PC が覚えておく、前の置き場の数
LOCK_TRIES = 5                  # 錠を取る試み（外された直後・切れた錠をどけた直後に取り直す回数）
LOCK_MOVE_BUDGET_SEC = 0.5      # 錠をどける（名前を変える）のを、Windows でほかが開いている間に待つ長さ
LOCK_TTL_DEFAULT = 20.0
REFRESH_DEFAULT = 5.0
SCHEMA = 1


def next_id(rows):
    """新しい行の id（いまの最大 + 1）。"""
    return max((int(r.get("id") or 0) for r in rows), default=0) + 1


# ------------------------------------------------------------------ 例外（画面へ理由を返す）
class MasterError(Exception):
    kind = "error"
    status = 400

    def payload(self):
        return {"error": str(self), "kind": self.kind}


class MasterLocked(MasterError):
    kind, status = "locked", 409

    def __init__(self, holder_pc, holder_login, remaining):
        self.holder_pc, self.holder_login, self.remaining = holder_pc, holder_login, int(remaining)
        who = "／".join(x for x in (holder_pc, holder_login) if x) or "ほかの PC"
        super().__init__(f"{who} がマスタを保存中です（あと約{self.remaining}秒）。少し待つと保存できます。")

    def payload(self):
        return {**super().payload(), "holder_pc": self.holder_pc,
                "holder_login": self.holder_login, "remaining": self.remaining}


class RowConflict(MasterError):
    kind, status = "conflict", 409

    def __init__(self, current):
        self.current = current
        if current is None:
            msg = "この行は、ほかの PC で削除されました。"
        else:
            by = current.get("updated_by") or {}
            who = "／".join(x for x in (by.get("pc"), by.get("login")) if x) or "ほかの PC"
            when = str(current.get("updated_at", "")).replace("T", " ")[:16]
            msg = f"この行は、開いたあとに {who} が変更しました（{when}）。"
        super().__init__(msg)

    def payload(self):
        return {**super().payload(), "current": self.current}


class DuplicateKey(MasterError):
    kind, status = "duplicate", 409


class NotFound(MasterError):
    kind, status = "not_found", 404


class ShareUnavailable(MasterError):
    kind, status = "unavailable", 503


# ------------------------------------------------------------------ 端末の名乗り
def identity():
    """この PC とログインの名前。**名乗れないときは空**（空どうしを「同じ人」とは見なさない）。
    取り方は services/identity.py の1箇所（WaveLog と同じ順・設定の「この端末の名前」）。"""
    from ..services import identity as ident
    me = ident.current()
    return {"pc": me["pc"], "login": me["login"]}


def _now():
    return datetime.now()


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json_atomic(path, data):
    """マスタ・錠はディスクへ書き切ってから置き換える（停電・切断でも書きかけを残さない）。"""
    write_json_atomic(path, data, durable=True)


def _doc(rows, revision=0, updated_at="", updated_by=None):
    return {"schema": SCHEMA, "revision": int(revision), "updated_at": updated_at,
            "updated_by": updated_by or {}, "rows": rows}


def _as_doc(raw):
    """共有・写しは {schema, revision, rows…}。アプリ同梱の data/ は行の配列（昔の形）。どちらも読む。"""
    if isinstance(raw, list):
        return _doc(raw)
    if isinstance(raw, dict) and isinstance(raw.get("rows"), list):
        return _doc(raw["rows"], raw.get("revision", 0), raw.get("updated_at", ""), raw.get("updated_by"))
    raise ValueError("マスタの形が読めません")


def _stat_sig(path):
    """変わったかの目印（更新時刻・大きさ）。届かなければ None。"""
    try:
        st = os.stat(path)
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


# ------------------------------------------------------------------ 置き場
class MasterStore:
    """マスタの読み書きの窓口。アプリに1つ（`app.config["MASTER_STORE"]`）。"""

    def __init__(self, base_dir, local_root=None, settings=None, who=None):
        self.base = Path(base_dir)
        cfg = dict(settings or {})
        raw_dir = str(cfg.get("dir") or "").strip()
        self.share_dir = Path(os.path.expandvars(raw_dir)) if raw_dir else None
        # 参照先マスタは、共有フォルダがあればいつも共有（読みに行く場所は全員で同じ。1台で直せば全員に効く）
        # アクセス権限も同じ（権限は全員で1つ。PC ごとに違うと、権限を持たない PC で書き換えられる）
        # app_seeds: 起動で一度だけ当てた初期値の記録（services/master_seeds.py）。全員で1つ
        # ui_defaults: 新しく入れた PC の一覧の表示の初期設定（services/ui_defaults.py）。開発者が置く。全員で1つ
        self.shared_names = set(cfg.get("masters") or ["roll_master", "equipment_master"]) | {"path_settings", "access_permissions", "app_seeds", "ui_defaults"}
        self.lock_ttl = float(cfg.get("lock_ttl_seconds", LOCK_TTL_DEFAULT))
        self.refresh_sec = float(cfg.get("refresh_seconds", REFRESH_DEFAULT))
        root = Path(local_root) if local_root else app_env.local_root()
        self.cache_dir = root / "master_cache"
        # この PC が覚えた置き場（画面で変えた・引っ越し先をたどった）があれば、設定ファイルの値より先に使う
        self.override_path = root / OVERRIDE_FILENAME
        self.configured_dir = self.share_dir
        try:
            ov = str(_read_json(self.override_path).get("dir") or "").strip()
            if ov:
                self.share_dir = Path(ov)
        except (OSError, ValueError, AttributeError):
            pass
        self.on_moved = None          # 置き場が変わったときに呼ぶ（利用状況の置き場を合わせる。app が入れる）
        self._moved_checked = 0.0
        self.who = who or identity()
        self._write_lock = threading.RLock()   # この PC の中で書き込みを1本にまとめる
        self._state_lock = threading.Lock()
        self._checked = {}      # name -> 最後に共有を見た時刻（monotonic）
        self._share_sig = {}    # name -> 最後に取り込んだ共有の (mtime, size)
        self._mem = {}          # name -> (写しの sig, doc)
        self._last_error = ""
        self._last_sync = ""

    # ---------------------------------------------------------- 置き場の答え
    def is_shared(self, name):
        return self.share_dir is not None and name in self.shared_names

    def _bundled(self, name):
        return self.base / "data" / f"{name}.json"

    def _share_file(self, name):
        return self.share_dir / f"{name}.json"

    def _mirror(self, name):
        return self.cache_dir / f"{name}.json"

    def _lock_file(self):
        return self.share_dir / LOCK_FILENAME

    def share_reachable(self):
        return self.share_dir is not None and self.share_dir.is_dir()

    # ---------------------------------------------------------- 読む
    def read(self, name):
        """行の配列（写しの中身の複製）。共有へ届かなくても投げない。"""
        return copy.deepcopy(self._read_doc(name)["rows"])

    def revision(self, name):
        return self._read_doc(name)["revision"]

    def _read_doc(self, name):
        if self.is_shared(name):
            self._maybe_refresh(name)
            mirror = self._mirror(name)
            if mirror.exists():
                return self._cached(mirror)
            # 共有にも写しにも無い（初回で共有に届かない）。同梱のデータで読むだけは続ける。
        path = self._bundled(name)
        return self._cached(path) if path.exists() else _doc([])

    def _cached(self, path):
        sig = _stat_sig(path)
        key = str(path)
        hit = self._mem.get(key)
        if hit and hit[0] == sig and sig is not None:
            return hit[1]
        doc = _as_doc(_read_json(path))
        self._mem[key] = (sig, doc)
        return doc

    # ---------------------------------------------------------- 置き場を変える（services/master_place.py）
    def retarget(self, new_dir, persist=True):
        """置き場を new_dir に切り替える（写しは次に読むときに新しい置き場から取り直す）。persist ならこの PC に覚える。"""
        with self._write_lock, self._state_lock:
            before = self.share_dir
            self.share_dir = Path(new_dir)
            self._checked.clear()
            self._share_sig.clear()
            self._mem.clear()
            self._last_error = ""
        if persist:
            hist = [{"dir": str(before or ""), "until": _iso(_now()), "by": dict(self.who)}] + self.history()
            _write_json_atomic(self.override_path, {"dir": str(new_dir), "at": _iso(_now()), "by": dict(self.who),
                                                    "history": hist[:HISTORY_KEEP]})
        log.info("MASTER_RETARGET dir=%s", new_dir)
        if self.on_moved:
            self.on_moved(Path(new_dir))

    def history(self):
        """この PC が前に使っていた置き場（新しい順）→ [{dir（空なら手元のみ）, until, by}]。前の置き場のマスタは消していない。"""
        try:
            h = _read_json(self.override_path).get("history")
        except (OSError, ValueError, AttributeError):
            return []
        return [x for x in h if isinstance(x, dict)] if isinstance(h, list) else []

    def moved_to(self, folder=None):
        """その置き場に引っ越し先の印があれば → {to, at, by}。無ければ None。"""
        folder = Path(folder) if folder else self.share_dir
        if not folder:
            return None
        try:
            d = _read_json(folder / MOVED_FILENAME)
            return d if isinstance(d, dict) and str(d.get("to") or "").strip() else None
        except (OSError, ValueError):
            return None

    def follow_moved(self, force=False):
        """いまの置き場に引っ越し先の印があり、引っ越し先に届けば、そちらへ移る（ほかの PC が置き場を変えたとき）。
        数秒に 1 回だけ見る。移ったら True。"""
        now = time.monotonic()
        if not self.share_dir or (not force and now - self._moved_checked < self.refresh_sec):
            return False
        self._moved_checked = now
        cur, hops = self.share_dir, 0
        while hops < MOVED_HOPS:
            m = self.moved_to(cur)
            if not m:
                break
            nxt = Path(str(m["to"]).strip())
            if not nxt.is_dir() or str(nxt) == str(cur):
                break
            cur, hops = nxt, hops + 1
        if hops == 0:
            return False
        log.info("MASTER_FOLLOW_MOVED from=%s to=%s", self.share_dir, cur)
        self.retarget(cur)
        return True

    def _maybe_refresh(self, name, force=False):
        """共有が変わっていれば写しを取り直す。**数秒に1回だけ**共有を見る。失敗しても投げない。"""
        try:
            self.follow_moved()
        except Exception as e:  # 印を読めなくても、いまの置き場で続ける
            log.warning("MASTER_FOLLOW_MOVED failed: %s", e)
        now = time.monotonic()
        with self._state_lock:
            last = self._checked.get(name)
            if not force and last is not None and now - last < self.refresh_sec:
                return False
            self._checked[name] = now
        try:
            return self._pull(name, force=force)
        except Exception as e:  # 読みは写しで続ける
            self._last_error = f"共有マスタを取り込めませんでした（写しで続けます）: {e}"
            log.warning(self._last_error)
            return False

    def _pull(self, name, force=False, have_lock=False):
        src = self._share_file(name)
        sig = _stat_sig(src)
        if sig is None:
            if not self.share_reachable():
                raise ShareUnavailable(f"共有フォルダに届きません: {self.share_dir}")
            self._seed(name, have_lock)      # 共有にまだ無い（初めて共有にする）
            sig = _stat_sig(src)
            if sig is None:
                return False
        if not force and self._share_sig.get(name) == sig and self._mirror(name).exists():
            return False
        doc = _as_doc(_read_json(src))
        _write_json_atomic(self._mirror(name), doc)
        self._share_sig[name] = sig
        self._last_error = ""
        self._last_sync = _iso(_now())
        return True

    def _seed(self, name, have_lock=False):
        """共有にマスタが無いとき、手元の写し（無ければ同梱の data/）を最初の版として置く。錠を取って行う
        （書き込みの途中なら、もう持っている錠のまま）。"""
        token = None if have_lock else self._acquire_lock()
        try:
            src = self._share_file(name)
            if _stat_sig(src) is not None:
                return
            seed = self._mirror(name) if self._mirror(name).exists() else self._bundled(name)
            doc = _as_doc(_read_json(seed)) if seed.exists() else _doc([])
            doc.update(revision=max(1, doc["revision"]), updated_at=_iso(_now()), updated_by=dict(self.who))
            _write_json_atomic(src, doc)
            log.info("MASTER_SEED name=%s from=%s rows=%d", name, seed, len(doc["rows"]))
        finally:
            self._release_lock(token)

    # ---------------------------------------------------------- 錠（共有フォルダの master.lock.json）
    def _read_lock(self):
        p = self._lock_file()
        try:
            return _read_json(p)
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            # 書きかけ・壊れた錠。古ければ切れたものとして扱う
            sig = _stat_sig(p)
            if sig is None:
                return None
            age = time.time() - sig[0] / 1e9
            return {"expires_at": _iso(_now() - timedelta(seconds=1))} if age > self.lock_ttl else {"expires_at": _iso(_now() + timedelta(seconds=2))}

    @staticmethod
    def _remaining(lock):
        try:
            return (datetime.fromisoformat(lock["expires_at"]) - _now()).total_seconds()
        except Exception:
            return 0.0

    def _is_mine(self, lock):
        """持ち主が自分か。**名乗れない PC は自分と言わない**（WaveLog §9.384）。"""
        pc, login = self.who.get("pc", ""), self.who.get("login", "")
        if not pc or not login or not lock:
            return False
        return lock.get("holder_pc") == pc and lock.get("holder_login") == login

    def _acquire_lock(self):
        """共有の錠を取る → 錠の印（token）。ほかの PC が持っていれば MasterLocked。

        錠は「無ければ作る」（O_EXCL。作れた1台だけが持つ）でしか置かない。上書きで置くと、2台が同時に
        「自分が持っている」と思い込む順番がある（2026-10-02 に3つの順番を試験で再現した。tests/test_master_share.py の LockRaces）:
          - 作ろうとして断られた → 読むと錠がもう無い → 上書きで置く（その間に相手が作り直していた）
          - 切れた錠を2台が同時に見つけ、両方が上書きで引き継ぐ
        切れた錠・自分の残した錠は、名前を変えてどけてから（_take_away）、もう一度「無ければ作る」で取る。"""
        if not self.share_reachable():
            raise ShareUnavailable(f"共有フォルダに届かないため保存できません（読みは手元の写しで続けています）: {self.share_dir}")
        p = self._lock_file()
        token = uuid.uuid4().hex
        now = _now()
        payload = {"token": token, "holder_pc": self.who.get("pc", ""), "holder_login": self.who.get("login", ""),
                   "acquired_at": _iso(now), "expires_at": _iso(now + timedelta(seconds=self.lock_ttl))}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        for _ in range(LOCK_TRIES):
            try:
                self._create_exclusive(p, body)
                break
            except FileExistsError:
                cur = self._read_lock()
                if cur is None:
                    continue                      # 外された直後。もう一度「無ければ作る」で取る（上書きしない）
                if self._remaining(cur) > 0 and not self._is_mine(cur):
                    raise MasterLocked(cur.get("holder_pc", ""), cur.get("holder_login", ""),
                                       max(1, int(self._remaining(cur)) + 1)) from None
                self._take_away(cur.get("token"))  # 切れた錠・自分の残した錠をどけてから取り直す
            except OSError as e:
                raise ShareUnavailable(f"共有フォルダに錠を置けません: {e}") from e
        else:
            cur = self._read_lock() or {}
            raise MasterLocked(cur.get("holder_pc", ""), cur.get("holder_login", ""), 2)
        check = self._read_lock()
        if not check or check.get("token") != token:
            raise MasterLocked((check or {}).get("holder_pc", ""), (check or {}).get("holder_login", ""), 2)
        return token

    @staticmethod
    def _create_exclusive(path, body):
        """無ければ作って書く（あれば FileExistsError）。作れた1台だけが持つ。"""
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            os.write(fd, body)
        finally:
            os.close(fd)

    def _take_away(self, expected_token):
        """錠を名前を変えてどける（名前の変更は1台しか成功しない）。どけた錠が思っていた錠（expected_token）でなければ、
        ほかの PC が取り直した新しい錠なので「無ければ作る」で元へ戻す。→ "ok"（どけた）・"other"（ほかの錠だった）・
        "gone"（もう無い）・"error"（どけられない。Windows でほかが開いている間など）"""
        p = self._lock_file()
        aside = p.with_name(f".{p.name}.{uuid.uuid4().hex}.gone")
        try:
            retrying(lambda: os.replace(p, aside), LOCK_MOVE_BUDGET_SEC)
        except FileNotFoundError:
            return "gone"
        except OSError:
            return "error"
        try:
            raw = aside.read_bytes()
            try:
                got = json.loads(raw.decode("utf-8")).get("token")
            except (ValueError, AttributeError):
                got = None                          # 書きかけ・壊れた錠
            if got == expected_token:
                return "ok"
            with contextlib.suppress(FileExistsError):
                self._create_exclusive(p, raw)      # 取り違えた。元の持ち主へ戻す（その間に別の PC が取っていればそのまま）
            return "other"
        finally:
            with contextlib.suppress(OSError):
                aside.unlink()

    def _release_lock(self, token):
        """自分の錠だけを外す（読んでから消す間に、ほかの PC が置いた錠を消さない）。"""
        if not token:
            return
        if self._take_away(token) == "error":
            log.warning("マスタの錠を消せませんでした（%s秒で切れます）", self.lock_ttl)

    def lock_status(self):
        if self.share_dir is None:
            return None
        cur = self._read_lock()
        if not cur or self._remaining(cur) <= 0:
            return {"locked": False}
        return {"locked": True, "holder_pc": cur.get("holder_pc", ""), "holder_login": cur.get("holder_login", ""),
                "remaining": max(1, int(self._remaining(cur)) + 1), "mine": self._is_mine(cur)}

    # ---------------------------------------------------------- 書く（1回の書き込み＝1サイクル）
    def write(self, name, mutate):
        """`mutate(rows, stamp)` が行の配列を直し、画面へ返す値を返す。競合は例外で返る。"""
        with self._write_lock:
            stamp = {"updated_at": _iso(_now()), "updated_by": dict(self.who)}
            if not self.is_shared(name):
                path = self._bundled(name)
                doc = _as_doc(_read_json(path)) if path.exists() else _doc([])
                result = mutate(doc["rows"], stamp)
                # 同梱の data/ は昔からの形（行の配列）のまま保つ
                _write_json_atomic(path, doc["rows"])
                return result
            token = self._acquire_lock()
            try:
                self._pull(name, force=True, have_lock=True)   # **当てる前に共有から取り直す**
                doc = copy.deepcopy(self._cached(self._mirror(name)))
                result = mutate(doc["rows"], stamp)
                doc.update(schema=SCHEMA, revision=doc["revision"] + 1, **stamp)
                _write_json_atomic(self._share_file(name), doc)
                _write_json_atomic(self._mirror(name), doc)
                self._share_sig[name] = _stat_sig(self._share_file(name))
                self._last_sync = stamp["updated_at"]
                log.info("MASTER_WRITE name=%s revision=%s by=%s", name, doc["revision"], self.who)
                return result
            finally:
                self._release_lock(token)

    # ---------------------------------------------------------- 状態（画面・起動画面へ）
    def status(self, names=("equipment_master", "roll_master", "path_settings", "access_permissions")):
        shared = self.share_dir is not None
        out = {"mode": "shared" if shared else "local", "dir": str(self.share_dir) if shared else "",
               "configured": str(self.configured_dir or ""), "override": self.override_path.exists(),
               "who": dict(self.who), "masters": {}}
        if shared:
            for n in names:
                if self.is_shared(n):
                    self._maybe_refresh(n)
            out["reachable"] = self.share_reachable()
            out["lock"] = self.lock_status() if out["reachable"] else None
            out["last_sync"] = self._last_sync
            out["error"] = self._last_error
        for n in names:
            doc = self._read_doc(n)
            src = ("shared" if self.is_shared(n) and self._mirror(n).exists()
                   else "bundled-fallback" if self.is_shared(n) else "local")
            out["masters"][n] = {"revision": doc["revision"], "rows": len(doc["rows"]),
                                 "updated_at": doc.get("updated_at", ""), "updated_by": doc.get("updated_by") or {},
                                 "source": src}
        return out
