# -*- coding: utf-8 -*-
"""マスタ(設備 / ロール)の中身の決まり（列・必須・同じ名前の重複・行の版）。

置き場（手元の data/ か共有フォルダか）と、書き込みの錠・取り直しは `master_store.MasterStore` の1箇所。
ここは「どの行をどう直すか」だけを持つ。

行の版（`rev`）: 行を直すたびに1つ上がる。画面は開いたときの `rev` を `base_rev` として送り、
保存の時点で違えば、ほかの PC（または同じ PC の別の画面）が先に直したとして `RowConflict` で断る
（黙って上書きしない）。`base_rev` を送らない古い呼び出しは確かめない。
"""
from pathlib import Path

from ..services import equipment_names
from ..services.identity import normalize_part as _key     # 名前の比べ方（NFKC・前後の空白を除く・大文字）は1箇所
from .master_store import DuplicateKey, MasterError, MasterStore, NotFound, RowConflict, next_id


class InvalidRow(MasterError):
    """行の中身が決まりに合わない（例: 同一工程の名前がほかの設備の名前に当たる）。"""
    kind, status = "invalid", 400

# 同一工程: この設備と同じ工程とみなす名前（ANF, ANI* など。読み方は services/equipment_names.py）
EQUIPMENT_FIELDS = ["設備名", "巻取方向", "ライン方向", "同一工程", "検査計"]   # 検査計: "有" or 空（発見設備の自動選択の候補）
# 旧い列名 -> 正しい列名。Excel から移植した際に「巻取方向」を「巻出し方向」と
# 誤って名付けていた。利用者の PC に旧名で保存されたマスタも読むときに読み替える。
EQUIPMENT_RENAMED = {"巻出し方向": "巻取方向"}
ROLL_FIELDS = [
    "設備", "入出位置", "接触面", "ロール径MAX", "ロール径MIN", "ロール面長",
    "材質", "硬度", "本数", "ロール名", "ロール使用条件", "駆動方式", "基準番号", "備考",
]

# マスタごとの決まり: 列・旧い列名・同じ値を2行に持てない列（名前で引くマスタだけ）
SPECS = {
    "equipment_master": {"fields": EQUIPMENT_FIELDS, "renamed": EQUIPMENT_RENAMED, "unique": "設備名"},
    "roll_master": {"fields": ROLL_FIELDS, "renamed": {}, "unique": None},
    # 参照先（読みに行く場所）。項目ごとに1行（services/path_settings.py の ITEMS）
    "path_settings": {"fields": ["項目", "値"], "renamed": {}, "unique": "項目"},
    # アクセス権限（services/access.py）。ログインID・PC名の組は1行だけ（_check_row）
    "access_permissions": {"fields": ["ログインID", "PC名", "権限区分", "マスタ編集", "有効", "備考"], "renamed": {}, "unique": None},
}


def _clean(v):
    return ("" if v is None else str(v)).strip()


def _normalize(row, spec):
    """読むときの形をそろえる（旧い列名の読み替え・版が無い行は1）。"""
    for old, new in spec["renamed"].items():
        if old in row:
            row.setdefault(new, row.pop(old))
    row.setdefault("rev", 1)
    return row


def _normalize_all(rows, spec):
    for r in rows:
        _normalize(r, spec)


class MasterRepository:
    def __init__(self, store):
        # 昔の呼び方（アプリのフォルダを渡す）は「手元のみ」の置き場として扱う
        self.store = store if isinstance(store, MasterStore) else MasterStore(Path(store))

    # -------------------------------------------------- 汎用
    def _list(self, name):
        spec = SPECS[name]
        return [_normalize(r, spec) for r in self.store.read(name)]

    @staticmethod
    def _find(rows, item_id):
        for i, r in enumerate(rows):
            if r.get("id") == item_id:
                return i, r
        return -1, None

    @staticmethod
    def _check_rev(row, base_rev):
        if base_rev is not None and int(row.get("rev", 1)) != int(base_rev):
            raise RowConflict(dict(row))

    @staticmethod
    def _check_unique(rows, spec, data, self_id=None):
        col = spec["unique"]
        if not col or col not in data:
            return
        k = _key(data.get(col))
        for r in rows:
            if r.get("id") != self_id and k and _key(r.get(col)) == k:
                raise DuplicateKey(f"{col}「{_clean(data.get(col))}」はもう登録されています（ほかの PC が先に追加した可能性があります）。")

    @staticmethod
    def _check_row(name, rows, data, self_id=None):
        if name == "access_permissions":
            key = (_key(data.get("ログインID")), _key(data.get("PC名")))
            for r in rows:
                if r.get("id") != self_id and (_key(r.get("ログインID")), _key(r.get("PC名"))) == key:
                    raise DuplicateKey(f"ログインID「{data.get('ログインID') or '（空）'}」・PC名「{data.get('PC名') or '（空）'}」の組はもう登録してあります。その行を直してください。")
        if name == "equipment_master":
            msg = equipment_names.check_row(rows, data, self_id)
            if msg:
                raise InvalidRow(msg)

    def _create(self, name, data):
        spec = SPECS[name]

        def mutate(rows, stamp):
            _normalize_all(rows, spec)
            self._check_unique(rows, spec, data)
            self._check_row(name, rows, data)
            row = {"id": next_id(rows)}
            row.update({k: _clean(data.get(k)) for k in spec["fields"]})
            row.update(rev=1, **stamp)
            rows.append(row)
            return dict(row)
        return self.store.write(name, mutate)

    def _update(self, name, item_id, data, base_rev=None):
        spec = SPECS[name]

        def mutate(rows, stamp):
            _normalize_all(rows, spec)
            _, row = self._find(rows, item_id)
            if row is None:
                if base_rev is not None:
                    raise RowConflict(None)
                raise NotFound(f"id={item_id} が見つかりません。")
            self._check_rev(row, base_rev)
            self._check_unique(rows, spec, data, self_id=item_id)
            self._check_row(name, rows, {**row, **data}, self_id=item_id)
            for k in spec["fields"]:
                if k in data:
                    row[k] = _clean(data.get(k))
            row.update(rev=int(row.get("rev", 1)) + 1, **stamp)
            return dict(row)
        return self.store.write(name, mutate)

    def _delete(self, name, item_id, base_rev=None):
        spec = SPECS[name]

        def mutate(rows, stamp):
            _normalize_all(rows, spec)
            i, row = self._find(rows, item_id)
            if row is None:
                if base_rev is not None:
                    return None            # もう消えている＝望みどおり
                raise NotFound(f"id={item_id} が見つかりません。")
            self._check_rev(row, base_rev)
            rows.pop(i)
            return None
        self.store.write(name, mutate)

    # -------------------------------------------------- 設備マスタ
    def equipment(self):
        return self._list("equipment_master")

    def equipment_create(self, data):
        return self._create("equipment_master", data)

    def equipment_update(self, item_id, data, base_rev=None):
        return self._update("equipment_master", item_id, data, base_rev)

    def equipment_delete(self, item_id, base_rev=None):
        self._delete("equipment_master", item_id, base_rev)

    def equipment_resolver(self):
        """同一工程の名前も含めて、設備名 → 設備マスタの行を引く係。"""
        return equipment_names.EquipmentResolver(self.equipment())

    def inspection_of(self, names):
        """設備名ごとに「検査計がある設備か」（同一工程の名前も読み替えて引く）。発見設備の自動選択の候補。"""
        res = self.equipment_resolver()
        out = {}
        for n in names:
            r, _, _ = res.resolve(n)
            out[n] = bool(r) and str(r.get("検査計") or "").strip() == "有"
        return out

    def equipment_map(self):
        out = {}
        for r in self.equipment():
            key = (r.get("設備名") or "").strip()
            if key:
                out[key] = {
                    "rewind": (r.get("巻取方向") or "").strip(),
                    "line_direction": (r.get("ライン方向") or "").strip(),
                }
        return out

    # -------------------------------------------------- 参照先マスタ
    # ---- アクセス権限（中身の判定は services/access.py。ここは行の読み書きだけ）
    def access_permissions(self):
        return self._list("access_permissions")

    def access_permissions_create(self, data):
        return self._create("access_permissions", data)

    def access_permissions_update(self, item_id, data, base_rev=None):
        return self._update("access_permissions", item_id, data, base_rev)

    def access_permissions_delete(self, item_id, base_rev=None):
        return self._delete("access_permissions", item_id, base_rev)

    def path_settings(self):
        return self._list("path_settings")

    def path_setting_put(self, key, value, base_rev=None):
        """項目 key の値を置く（value が None なら行を消して既定へ戻す）。1回の錠の中で「有れば直す・無ければ足す」。
        base_rev: 画面が開いたときの行の版（行が無かったときは 0）。違えば RowConflict（ほかの PC が先に直した）。"""
        spec = SPECS["path_settings"]

        def mutate(rows, stamp):
            _normalize_all(rows, spec)
            i = next((k for k, r in enumerate(rows) if r.get("項目") == key), -1)
            row = rows[i] if i >= 0 else None
            if base_rev is not None:
                have = int(row.get("rev", 1)) if row else 0
                if have != int(base_rev):
                    raise RowConflict(dict(row) if row else None)
            if value is None:
                if row is not None:
                    rows.pop(i)
                return None
            if row is None:
                row = {"id": next_id(rows), "項目": key, "rev": 0}
                rows.append(row)
            row["値"] = str(value)
            row.update(rev=int(row.get("rev", 0)) + 1, **stamp)
            return dict(row)
        return self.store.write("path_settings", mutate)

    # -------------------------------------------------- ロールマスタ
    def rolls(self):
        return self._list("roll_master")

    def rolls_create(self, data):
        return self._create("roll_master", data)

    def rolls_update(self, item_id, data, base_rev=None):
        return self._update("roll_master", item_id, data, base_rev)

    def rolls_delete(self, item_id, base_rev=None):
        self._delete("roll_master", item_id, base_rev)
