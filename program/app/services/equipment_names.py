# -*- coding: utf-8 -*-
"""設備名の読み替え（同一工程の名前）。

LotDsp では同じ工程が別の名前で出てくることがある:
    焼鈍      … ANI・ANF、番号付き（ANI1・ANF2 …）
    連続焼鈍  … CAL・CAI・CAF（番号付きも）
設備マスタの各行に「同一工程の名前」（列 `同一工程`）を登録しておくと、その名前で出てきた工程を
その行の設備（代表の設備名）として扱う。取込（lotdsp_progress）と計算（calculator）の両方がここを使う。

書き方（区切りは カンマ・読点・空白・改行）
    ANF          … ちょうど ANF
    ANI*         … ANI で始まる名前（ANI・ANI1・ANI12 …）。* は「どんな文字でも・無くてもよい」
    CA?          … ? は「どれか1文字」（CAI・CAF・CAL）
大文字・小文字、全角・半角は区別しない（NFKC で読みそろえる）。

どの行に当たるかの順:
    1. 設備名にそのまま一致
    2. 同一工程の名前に（* ? を使わずに）そのまま一致
    3. * ? を使った名前に当たるもの。複数当たれば、* ? 以外の字が多い（具体的な）ほうを取る
番号に意味がある設備（L-1・L-2・LS3・LS4 など）は、登録しなければ今までどおり別の設備のまま。
"""
import re
import unicodedata

FIELD = "同一工程"
_SPLIT = re.compile(r"[,、，\s]+")


def compact(text):
    """比べるための読みそろえ: NFKC で全角半角をそろえ、空白を除く（大小はそのまま）。"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text or "")))


def norm(name):
    """設備名の読みそろえ（compact ＋ 大文字）。"""
    return compact(name).upper()


def parse_patterns(text):
    """「ANF, ANI*」→ ['ANF', 'ANI*']（読みそろえ済み・重複なし・空は除く）。"""
    out = []
    for p in _SPLIT.split(str(text or "")):
        p = norm(p)
        if p and p not in out:
            out.append(p)
    return out


def is_wild(p):
    return "*" in p or "?" in p


def _regex(p):
    return re.compile("^" + "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in p) + "$")


def _specificity(p):
    return len(p.replace("*", "").replace("?", ""))


class EquipmentResolver:
    """設備マスタの行から「LotDsp などに出てきた設備名 → マスタの行」を引く。"""

    def __init__(self, rows):
        self.rows = [r for r in (rows or []) if norm(r.get("設備名"))]
        self.by_name = {norm(r["設備名"]): r for r in self.rows}
        self.by_alias = {}
        self.wild = []
        for r in self.rows:
            for p in parse_patterns(r.get(FIELD)):
                if is_wild(p):
                    self.wild.append((_specificity(p), p, _regex(p), r))
                else:
                    self.by_alias.setdefault(p, r)
        self.wild.sort(key=lambda x: -x[0])

    def resolve(self, name):
        """→ (行 or None, どう当たったか: 'name' / 'alias' / 'pattern' / '', 当たった書き方)"""
        k = norm(name)
        if not k:
            return None, "", ""
        if k in self.by_name:
            return self.by_name[k], "name", k
        if k in self.by_alias:
            return self.by_alias[k], "alias", k
        for _, p, rx, r in self.wild:
            if rx.match(k):
                return r, "pattern", p
        return None, "", ""

    def canonical(self, name):
        """代表の設備名（当たらなければ元の名前のまま）。"""
        r, _, _ = self.resolve(name)
        return (r.get("設備名") or "").strip() if r else str(name or "").strip()

    def same(self, a, b):
        """2つの名前が同じ工程か（どちらもマスタに当たり、同じ行を指す／または文字として同じ）。"""
        ra, _, _ = self.resolve(a)
        rb, _, _ = self.resolve(b)
        if ra is not None and rb is not None:
            return ra is rb
        return norm(a) == norm(b)


def check_row(rows, data, self_id=None):
    """保存する前の確かめ。問題があれば利用者に見せる文を返す（無ければ None）。

    - 同一工程の名前が、ほかの行の設備名に当たる → その名前はほかの行が持っているので取り合いになる
    - * ? を使わない同一工程の名前が、ほかの行の同一工程の名前と同じ
    """
    name = str(data.get("設備名") or "").strip()
    pats = parse_patterns(data.get(FIELD))
    others = [r for r in rows if r.get("id") != self_id]
    for p in pats:
        rx = _regex(p) if is_wild(p) else None
        for r in others:
            other = norm(r.get("設備名"))
            if other and (rx.match(other) if rx else p == other):
                return (f"「{p}」はほかの設備「{r.get('設備名')}」の名前にも当たります。"
                        f"同じ工程なら「{r.get('設備名')}」の行を消してから登録するか、当たらない書き方にしてください。")
            if not rx and p in parse_patterns(r.get(FIELD)) and not is_wild(p):
                return f"「{p}」はもう設備「{r.get('設備名')}」の同一工程の名前に登録されています。"
    if name:
        own = norm(name)
        for r in others:
            for q in parse_patterns(r.get(FIELD)):
                if (_regex(q).match(own) if is_wild(q) else q == own):
                    return f"設備名「{name}」は、設備「{r.get('設備名')}」の同一工程の名前「{q}」に当たります。先にそちらを直してください。"
    return None
