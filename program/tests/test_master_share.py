# -*- coding: utf-8 -*-
"""マスタの共有と競合管理（app/repositories/master_store.py・WaveLog §9.263／§9.384 と同じ考え方）。

2台の PC（名乗りと手元の写しの置き場が別）を1つのプロセスの中に作り、同じ共有フォルダを取り合わせて確かめる。

物差し（評価関数）
  ① 読むのは手元の写し（共有をほかの PC が書き換えても、取り直すまでは写しを読む）
  ② 書く前に共有から取り直す（ほかの PC の変更を踏み潰さない）・版番号が1つずつ上がる
  ③ 同じ行を後から保存したら断る（誰が・いつ変えたかを返す）。消された行も断る
  ④ 錠: ほかの PC が保存中なら「誰が・あと何秒」で断る。自分の残した錠は引き継ぐ。切れた錠は取れる。
     名乗れない PC は自分と見なさない
  ⑤ 共有に届かない: 読みは写しで続け、書きは断る（写しだけ書くと PC ごとにずれる）
  ⑥ 2台×10件を同時に追加しても、全部残り、id が重ならない
  ⑦ API は 409（locked／conflict／duplicate）・503（unavailable）で理由を返す
"""
import json
import shutil
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from app import create_app
from app.repositories.master_repository import MasterRepository
from app.repositories.master_store import (DuplicateKey, MasterLocked, MasterStore, RowConflict,
                                           ShareUnavailable)

ROOT = Path(__file__).resolve().parents[1]


class Env:
    """一時の アプリ（data/ の写し）・共有フォルダ・PC ごとの手元の置き場。"""

    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.base = self.tmp / "app"
        shutil.copytree(ROOT / "data", self.base / "data")
        self.share = self.tmp / "share"
        self.share.mkdir()

    def store(self, pc, login="user", refresh=0.0, ttl=20.0, share=None):
        cfg = {"dir": str(share or self.share), "refresh_seconds": refresh, "lock_ttl_seconds": ttl}
        return MasterStore(self.base, local_root=self.tmp / f"local-{pc or 'noname'}", settings=cfg,
                           who={"pc": pc, "login": login})

    def repo(self, *a, **k):
        return MasterRepository(self.store(*a, **k))

    def share_doc(self, name="roll_master"):
        return json.loads((self.share / f"{name}.json").read_text(encoding="utf-8"))

    def put_lock(self, pc, login="user", seconds=10):
        now = datetime.now()
        (self.share / "master.lock.json").write_text(json.dumps({
            "token": "x", "holder_pc": pc, "holder_login": login,
            "acquired_at": now.isoformat(), "expires_at": (now + timedelta(seconds=seconds)).isoformat()},
            ensure_ascii=False), encoding="utf-8")

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.bundled = json.loads((self.env.base / "data" / "roll_master.json").read_text(encoding="utf-8"))

    def tearDown(self):
        self.env.close()


class LocalMode(Base):
    """共有しない設定（dir が空）は、これまでどおり data/ を読み書きする。行の版はここでも効く。"""

    def test_local_crud_and_row_conflict(self):
        repo = MasterRepository(MasterStore(self.env.base, local_root=self.env.tmp / "l", settings={}))
        row = repo.rolls_create({"設備": "TLV", "ロール名": "試験"})
        self.assertEqual(row["rev"], 1)
        saved = json.loads((self.env.base / "data" / "roll_master.json").read_text(encoding="utf-8"))
        self.assertIsInstance(saved, list, "同梱の data/ は行の配列の形のまま")
        repo.rolls_update(row["id"], {"備考": "A"}, base_rev=1)
        with self.assertRaises(RowConflict):
            repo.rolls_update(row["id"], {"備考": "B"}, base_rev=1)   # 同じ PC の別の画面が古い版で保存
        with self.assertRaises(DuplicateKey):
            repo.equipment_create({"設備名": "ｔｌｖ"})                  # 全角・小文字でも同じ名前


class ReadFromMirror(Base):
    def test_seed_and_read_mirror(self):
        a = self.env.repo("PC-A", refresh=60)
        self.assertEqual(len(a.rolls()), len(self.bundled), "最初は同梱の data/ から共有へ置く")
        doc = self.env.share_doc()
        self.assertEqual((doc["revision"], len(doc["rows"])), (1, len(self.bundled)))
        # ほかの PC が共有を直接書き換える
        doc["rows"][0]["備考"] = "共有で変えた"
        doc["revision"] = 2
        (self.env.share / "roll_master.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        self.assertNotEqual(a.rolls()[0]["備考"], "共有で変えた", "①取り直すまでは手元の写しを読む")
        a.store._maybe_refresh("roll_master", force=True)
        self.assertEqual(a.rolls()[0]["備考"], "共有で変えた", "取り直せば見える（取りこぼしではない）")
        self.assertEqual(json.loads((self.env.base / "data" / "roll_master.json").read_text(encoding="utf-8")),
                         self.bundled, "共有にしたあと、同梱の data/ は書き換えない")


class WriteCycle(Base):
    def test_write_pulls_first_and_bumps_revision(self):
        a = self.env.repo("PC-A", refresh=60)
        b = self.env.repo("PC-B", refresh=60)
        a.rolls()
        b.rolls()                                    # 両方とも写しを持つ（版1）
        x = b.rolls_update(1, {"備考": "B が変更"}, base_rev=1)  # 共有は版2
        y = a.rolls_update(2, {"備考": "A が変更"}, base_rev=1)  # A の写しは古い（版1）まま書く
        rows = {r["id"]: r for r in self.env.share_doc()["rows"]}
        self.assertEqual(rows[1]["備考"], "B が変更", "②A の保存が B の変更を踏み潰していない")
        self.assertEqual(rows[2]["備考"], "A が変更")
        self.assertEqual(self.env.share_doc()["revision"], 3)
        self.assertEqual((x["updated_by"]["pc"], y["updated_by"]["pc"]), ("PC-B", "PC-A"))
        self.assertFalse((self.env.share / "master.lock.json").exists(), "錠は保存のあと返す")

    def test_same_row_conflict_and_deleted_row(self):
        a = self.env.repo("PC-A", refresh=60)
        b = self.env.repo("PC-B", refresh=60)
        opened = a.rolls()[0]                                   # A が編集画面を開いた（版1）
        b.rolls_update(opened["id"], {"備考": "B が先に保存"}, base_rev=1)
        with self.assertRaises(RowConflict) as cm:
            a.rolls_update(opened["id"], {"備考": "A があとで保存"}, base_rev=opened["rev"])
        cur = cm.exception.current
        self.assertEqual((cur["備考"], cur["rev"], cur["updated_by"]["pc"]), ("B が先に保存", 2, "PC-B"))
        self.assertIn("PC-B", str(cm.exception), "③誰が変えたかを言う")
        with self.assertRaises(RowConflict):
            a.rolls_delete(opened["id"], base_rev=1)            # 古い版のまま消そうとした
        a.rolls_update(opened["id"], {"備考": "A が見直して保存"}, base_rev=2)   # 最新を見てからなら通る
        b.rolls_delete(opened["id"], base_rev=3)
        with self.assertRaises(RowConflict) as cm:
            a.rolls_update(opened["id"], {"備考": "消えた行へ"}, base_rev=3)
        self.assertIsNone(cm.exception.current)
        self.assertIn("削除", str(cm.exception))

    def test_duplicate_equipment_name_across_pcs(self):
        a = self.env.repo("PC-A", refresh=60)
        b = self.env.repo("PC-B", refresh=60)
        a.equipment()
        b.equipment()
        b.equipment_create({"設備名": "NEW-1"})
        with self.assertRaises(DuplicateKey):
            a.equipment_create({"設備名": "new-1"})            # A の写しにはまだ無いが、取り直して気づく


class Lock(Base):
    def test_other_pc_holds_lock(self):
        a = self.env.repo("PC-A")
        a.rolls()
        self.env.put_lock("PC-B", seconds=10)
        with self.assertRaises(MasterLocked) as cm:
            a.rolls_update(1, {"備考": "x"})
        e = cm.exception
        self.assertEqual(e.holder_pc, "PC-B")
        self.assertTrue(5 <= e.remaining <= 11, e.remaining)
        self.assertIn("PC-B", str(e))
        self.assertEqual(json.loads((self.env.share / "master.lock.json").read_text(encoding="utf-8"))["holder_pc"],
                         "PC-B", "④ほかの PC の錠は消さない")

    def test_own_leftover_lock_is_taken_over(self):
        a = self.env.repo("PC-A", login="me")
        a.rolls()
        self.env.put_lock("PC-A", login="me", seconds=15)       # 前回うまく消せなかった自分の錠
        a.rolls_update(1, {"備考": "引き継いで保存"})
        self.assertEqual({r["id"]: r for r in self.env.share_doc()["rows"]}[1]["備考"], "引き継いで保存")

    def test_expired_lock_is_taken(self):
        a = self.env.repo("PC-A")
        a.rolls()
        self.env.put_lock("PC-B", seconds=-1)
        a.rolls_update(1, {"備考": "切れた錠のあとで保存"})

    def test_nameless_pc_is_not_the_holder(self):
        a = self.env.repo("", login="")
        a.rolls()
        self.env.put_lock("", login="", seconds=10)
        with self.assertRaises(MasterLocked):
            a.rolls_update(1, {"備考": "x"})


class Unreachable(Base):
    def test_read_continues_write_refused(self):
        a = self.env.repo("PC-A")
        before = a.rolls()
        moved = self.env.tmp / "share-off"
        self.env.share.rename(moved)                             # 共有が見えなくなった
        self.assertEqual(a.rolls(), before, "⑤読みは手元の写しで続く")
        with self.assertRaises(ShareUnavailable):
            a.rolls_update(1, {"備考": "x"})
        st = a.store.status()
        self.assertFalse(st["reachable"])
        self.assertTrue(st["error"])


class Concurrency(Base):
    def test_two_pcs_ten_creates_each(self):
        repos = [self.env.repo("PC-A", ttl=5), self.env.repo("PC-B", ttl=5)]
        for r in repos:
            r.rolls()
        errors = []

        def worker(repo, n):
            for i in range(10):
                for _ in range(200):                             # 画面と同じく、錠待ちは粘って取り直す
                    try:
                        repo.rolls_create({"設備": f"{repo.store.who['pc']}", "ロール名": f"{n}-{i}"})
                        break
                    except MasterLocked:
                        time.sleep(0.01)
                else:
                    errors.append((n, i))

        ts = [threading.Thread(target=worker, args=(r, r.store.who["pc"])) for r in repos]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        rows = self.env.share_doc()["rows"]
        added = [r for r in rows if r.get("ロール名", "").startswith("PC-")]
        self.assertEqual(errors, [])
        self.assertEqual(len(added), 20, "⑥同時に追加しても全部残る")
        ids = [r["id"] for r in rows]
        self.assertEqual(len(ids), len(set(ids)), "id が重ならない")
        self.assertEqual(self.env.share_doc()["revision"], 21)


class LockRaces(Base):
    """共有の錠（master.lock.json）を2台が同時に持てないか。たまたまの順番に頼らず、危ない順番を試験の中で起こす。
    （2026-10-02 の Windows の CI で、2台が同時に追加して1件消えたことがあった。そのとき錠がどの順番で重なったかは記録に無い）"""

    def stores(self, ttl=20.0):
        return self.env.store("PC-A", ttl=ttl), self.env.store("PC-B", ttl=ttl)

    def holder(self):
        return json.loads((self.env.share / "master.lock.json").read_text(encoding="utf-8"))["token"]

    def test_lock_removed_just_before_reading_is_not_overwritten(self):
        """B の作成が断られる → A が外して、すぐ取り直す → B が「錠が無い」と読む。B は上書きで取ってはいけない。"""
        a, b = self.stores()
        a1 = a._acquire_lock()
        real = MasterStore._read_lock
        box = {}

        def b_reads(self_):
            if "a2" not in box:
                a._release_lock(a1)
                v = real(self_)                    # 錠は無い（None）
                box["a2"] = a._acquire_lock()      # B が次に動く前に、A が取り直す
                return v
            return real(self_)
        b._read_lock = b_reads.__get__(b)
        with self.assertRaises(MasterLocked):
            b._acquire_lock()
        self.assertEqual(self.holder(), box["a2"], "錠は A のまま")

    def test_expired_lock_is_taken_over_by_one_only(self):
        """切れた錠を2台が同時に見つけても、引き継げるのは1台だけ。"""
        self.env.put_lock("PC-X", seconds=-5)
        a, b = self.stores()
        real = MasterStore._read_lock
        box = {}

        def a_reads(self_):
            v = real(self_)
            if "b" not in box:
                box["b"] = b._acquire_lock()      # A が「切れている」と読んだ直後に、B が先に引き継ぐ
            return v
        a._read_lock = a_reads.__get__(a)
        with self.assertRaises(MasterLocked):
            a._acquire_lock()
        self.assertEqual(self.holder(), box["b"], "錠は B のまま")

    def test_release_does_not_remove_someone_elses_lock(self):
        """A の錠が（長くかかって）切れ、A が外す直前に B が引き継いだ。A は B の錠を消してはいけない。
        割り込ませるのは「A が錠のファイルを消す・どける直前」（消し方が unlink でも名前の変更でも、同じ瞬間を突く）。"""
        from unittest import mock
        from app.repositories import master_store as ms
        a, b = self.env.store("PC-A", ttl=0.05), self.env.store("PC-B")
        a1 = a._acquire_lock()
        time.sleep(0.1)                           # A の錠が切れる
        lock = self.env.share / "master.lock.json"
        box = {}

        def b_cuts_in():
            if "b" not in box:
                box["b"] = None
                box["b"] = b._acquire_lock()

        real_replace, real_unlink = ms.os.replace, Path.unlink

        def replace(src, dst, *k):
            if Path(src) == lock:
                b_cuts_in()
            return real_replace(src, dst, *k)

        def unlink(self_, *k, **kw):
            if Path(self_) == lock:
                b_cuts_in()
            return real_unlink(self_, *k, **kw)
        with mock.patch.object(ms.os, "replace", replace), mock.patch.object(Path, "unlink", unlink):
            a._release_lock(a1)
        self.assertTrue(box.get("b"), "B が割り込んで錠を取った")
        self.assertTrue(lock.exists(), "B の錠が残っている")
        self.assertEqual(self.holder(), box["b"])

    def test_three_pcs_many_creates(self):
        """3 台が同時に 15 件ずつ追加しても、全部残り、版がちょうど件数ぶん進む。
        錠は早い者勝ち（順番待ちの列は無い）。ここでは 3 台が休まずに続けて保存するので、錠を返した台がそのまま取り直し、
        1 台が長く待つことがある（人の保存ではまず起きない）。確かめたいのは「消えない・版が狂わない」なので、
        諦めるまでは回数ではなく時間で決める（以前の 400 回 × 5ms は、Windows の CI の遅さで 2 秒を超えて「諦めた」になった）。"""
        repos = [self.env.repo(f"PC-{c}", ttl=5) for c in "ABC"]
        for r in repos:
            r.rolls()
        start = self.env.share_doc()["revision"]
        errors, waits = [], []

        def worker(repo):
            for i in range(15):
                t0 = time.monotonic()
                while True:
                    try:
                        repo.rolls_create({"設備": repo.store.who["pc"], "ロール名": f"{repo.store.who['pc']}-{i}"})
                        break
                    except MasterLocked:
                        if time.monotonic() - t0 > 60:
                            errors.append((repo.store.who["pc"], i))
                            break
                        time.sleep(0.005)
                waits.append(time.monotonic() - t0)

        ts = [threading.Thread(target=worker, args=(r,)) for r in repos]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        doc = self.env.share_doc()
        added = [r for r in doc["rows"] if str(r.get("ロール名", "")).startswith("PC-")]
        self.assertEqual(errors, [], f"60 秒待っても保存できなかった（いちばん長い待ち {max(waits):.1f} 秒）")
        self.assertEqual(len(added), 45)
        self.assertEqual(doc["revision"], start + 45)


class Api(Base):
    def client(self, store):
        app = create_app({"MASTER_STORE": store})
        return app.test_client()

    def test_api_reports_reasons(self):
        a = self.client(self.env.store("PC-A"))
        b_repo = self.env.repo("PC-B")
        row = a.get("/api/masters/rolls").get_json()[0]
        b_repo.rolls_update(row["id"], {"備考": "B"}, base_rev=row["rev"])
        r = a.put(f"/api/masters/rolls/{row['id']}", json={"備考": "A", "base_rev": row["rev"]})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.get_json()["kind"], "conflict")
        self.assertEqual(r.get_json()["current"]["備考"], "B")
        r = a.delete(f"/api/masters/rolls/{row['id']}?rev={row['rev']}")
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "conflict"))
        r = a.post("/api/masters/equipment", json={"設備名": "TLV"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (409, "duplicate"))
        self.env.put_lock("PC-B", seconds=10)
        r = a.post("/api/masters/rolls", json={"設備": "X"})
        self.assertEqual((r.status_code, r.get_json()["kind"], r.get_json()["holder_pc"]), (409, "locked", "PC-B"))
        (self.env.share / "master.lock.json").unlink()
        st = a.get("/api/masters/status").get_json()
        self.assertEqual((st["mode"], st["reachable"], st["who"]["pc"]), ("shared", True, "PC-A"))
        self.assertGreaterEqual(st["masters"]["roll_master"]["revision"], 2)
        self.env.share.rename(self.env.tmp / "gone")
        r = a.post("/api/masters/rolls", json={"設備": "X"})
        self.assertEqual((r.status_code, r.get_json()["kind"]), (503, "unavailable"))
        self.assertEqual(a.get("/api/masters/rolls").status_code, 200, "読みは続く")

    def test_calculation_uses_shared_rolls(self):
        """計算（ロール候補）も同じ置き場のマスタを読む。"""
        store = self.env.store("PC-A")
        MasterRepository(self.env.store("PC-B")).rolls_create({"設備": "TLV", "ロール名": "共有で足した", "ロール径MAX": "610"})
        names = [r["ロール名"] for r in MasterRepository(store).rolls() if r["設備"] == "TLV"]
        self.assertIn("共有で足した", names)


if __name__ == "__main__":
    unittest.main()
