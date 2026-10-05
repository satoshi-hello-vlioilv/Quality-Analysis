# -*- coding: utf-8 -*-
"""LotDsp の API の応答の項目 ↔ LotDsp の画面の見出し を、値の一致で紐づける（調査の道具）。

なぜ値で照らすか
    画面（保存した HTML）には、どの値が応答のどの項目かを示す印が残っていない（束縛の式は保存されない）。
    進度の表だけは部品名（prog-jbsm など）が項目名に似るが、列とずれている所がある（長さの列が jbfo など）。
    そこで、同じロットの応答の値と画面の値を照らし、同じ値の欄の「見出し」をその項目の名前の候補にする。

見出しの探し方（欄ごとに候補を複数作る。決まった形を仮定しない）
    header … 表の最初の行の同じ列　above … 同じ列の上にある見出し　left … 同じ行の左にある見出し　row … 同じ行の最初の欄
    画面の表は「見出しの下に値」「見出しの左に値」「表の列」が混ざっているため、どれが当たるかは値の一致と複数のロットで絞る。
絞り方
    - 値が目立たないもの（1・0・1文字など）は照らさない（どの項目にも当たってしまう）。
    - 並びの項目（設備ごとの行）は、画面の表の列と行の順に照らす（8割以上の行で一致したら、その列の見出し）。
    - 同じタブの画面を、ロットを変えて2つ以上渡すと、どのロットでも一致する見出しだけが残る（偶然の一致が消える）。
出力は「項目の道すじ ↔ 見出し」だけで、値は含まない（そのまま貼って見せられる）。
"""
import re
import unicodedata

from . import lotdsp_api as api
from . import lotdsp_progress as lp

LABEL_MAX = 24
HOW_RANK = {"header": 0, "above": 1, "left": 2, "row": 3}
_DATEISH = re.compile(r"^[\d\s/:.,\-]+$")
COLUMN_MATCH = 0.8          # 並びの列: 照らせた行のうち、これ以上の割合で一致したら、その列の見出し
COLUMN_MIN_PAIRS = 2        # 並びの列: 照らせた行がこれ未満なら決めない


def _nfkc(v):
    return unicodedata.normalize("NFKC", str(v)).strip()


def label_like(t):
    """見出しらしい字か（数・日付・長すぎる字は値）。"""
    t = _nfkc(t)
    return (bool(t) and len(t) <= LABEL_MAX and not api._NUM_TEXT.match(t) and not _DATEISH.match(t)
            and any(ch.isalpha() for ch in t))                # 記号だけ（× ・ № など）は見出しにしない


def distinctive_screen(t):
    """画面の値が、項目を見分ける手がかりになるか（1・0・1文字は、どの項目にも当たる）。"""
    d = _nfkc(t)
    if not d:
        return False
    if api._NUM_TEXT.match(d):
        return len(re.sub(r"\D", "", d)) >= 3 and float(d.replace(",", "")) != 0
    if _DATEISH.match(d):
        return len(re.sub(r"\D", "", d)) >= 4
    return len(d) >= 2


def distinctive_api(v):
    if v is None or isinstance(v, bool) or isinstance(v, (list, dict)):
        return False
    if isinstance(v, (int, float)):
        txt = format(float(v), ".10g")
        if "." in txt:
            txt = txt.rstrip("0").rstrip(".")                    # 2.7300 → 2.73（小数の末尾の 0 だけ。24000 の 0 は取らない）
        return len(re.sub(r"\D", "", txt)) >= 3 and v != 0
    s = _nfkc(v)
    return len(s) >= 2


# ------------------------------------------------------------------ 画面
def read_screen(html):
    """保存した画面 → {tab, lot, cells, columns}。cells は値のある欄（見出しの候補つき）、columns は並びの照合用の列。"""
    tables = lp.inner_tables(html)
    # 選ばれているタブ: <td class="MniTabTblSelTd"><div class="MniTabSelTxt"><span …>進度情報</span>
    m = re.search(r'MniTabSelTxt[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*</span>', html or "")
    tab = _nfkc(m.group(1)) if m else ""
    cells, columns = [], []
    for tid, rows in enumerate(tables):
        width = max(len(r) for r in rows)
        for r, row in enumerate(rows):
            for c, v in enumerate(row):
                if not _nfkc(v):
                    continue
                cand = []
                if r > 0 and c < len(rows[0]) and label_like(rows[0][c]):
                    cand.append((_nfkc(rows[0][c]), "header"))
                for rr in range(r - 1, -1, -1):                       # 同じ列の、上の見出し
                    if c < len(rows[rr]) and label_like(rows[rr][c]):
                        cand.append((_nfkc(rows[rr][c]), "above")); break
                for cc in range(c - 1, -1, -1):                       # 同じ行の、左の見出し
                    if label_like(row[cc]):
                        cand.append((_nfkc(row[cc]), "left")); break
                if c > 0 and label_like(row[0]):
                    cand.append((_nfkc(row[0]), "row"))
                seen, labels = set(), []
                for label, how in cand:
                    if label != _nfkc(v) and label not in seen:
                        seen.add(label); labels.append((label, how))
                cells.append({"value": _nfkc(v), "labels": labels, "tid": tid, "r": r, "c": c})
        if len(rows) >= 3:                                            # 見出し＋2行以上の表: 列ごとに行の順の値を持つ
            for c in range(width):
                head = rows[0][c] if c < len(rows[0]) else ""
                vals = [_nfkc(rr[c]) if c < len(rr) else "" for rr in rows[1:]]
                if label_like(head) and sum(1 for x in vals if distinctive_screen(x)) >= COLUMN_MIN_PAIRS:
                    columns.append({"label": _nfkc(head), "values": vals, "tid": tid})
    lot = (lp.lot_fields(tables, {}).get("lot_no") or "").strip()
    return {"tab": tab, "lot": lot, "cells": cells, "columns": columns}


class _Index:
    """画面の欄を、値の照合を速くするための索引にする。"""

    def __init__(self, cells):
        self.cells = [c for c in cells if distinctive_screen(c["value"])]
        self.by_text, self.numeric, self.dates = {}, [], []
        for c in self.cells:
            v = c["value"]
            self.by_text.setdefault(v.replace(" ", ""), []).append(c)
            code = len(v) > 1 and v.startswith("0") and "." not in v         # 003 のような先頭が 0 の番号は、数ではなく字（コード）
            if api._NUM_TEXT.match(v) and not code:
                dec = len(v.split(".")[1]) if "." in v else 0
                self.numeric.append((float(v.replace(",", "")), dec, c))
            elif _DATEISH.match(v) and len(re.sub(r"\D", "", v)) >= 6:
                self.dates.append((re.sub(r"\D", "", v), c))

    @staticmethod
    def _round_eq(shown, dec, raw):
        """画面の数（小数 dec 桁）が、応答の数を丸めたものか。整数の欄は、応答も整数のときだけ（2.73 が 3 に当たらないように）。"""
        if abs(shown - raw) > 0.5 * 10 ** -dec + 1e-9:
            return False
        return dec > 0 or abs(raw - round(raw)) < 1e-9

    def find(self, raw):
        """API の値と同じ値の欄。"""
        out = []
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            out += [c for x, dec, c in self.numeric if self._round_eq(x, dec, raw)]
        else:
            t = _nfkc(raw).replace(" ", "")
            out += self.by_text.get(t, [])
            if api._NUM_TEXT.match(t):
                x = float(t.replace(",", ""))
                out += [c for y, dec, c in self.numeric if self._round_eq(y, dec, x) and c not in out]
        m = api.moment(raw)
        if m and self.dates:
            stamp = m.strftime("%Y%m%d%H%M%S")
            out += [c for d, c in self.dates if d in stamp and c not in out]
        return out


# ------------------------------------------------------------------ 応答
def collect(result):
    """応答 → (単独の値 {道すじ: 値}, 並びの列 {道すじ[].項目: [値…]})。要素が1つの並びは単独の値として扱う。"""
    scalars, columns = {}, {}

    def flat(node, prefix, out):
        if isinstance(node, dict):
            for k, v in node.items():
                flat(v, f"{prefix}.{k}" if prefix else str(k), out)
        elif not isinstance(node, list):
            out[prefix] = node

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                p = f"{path}.{k}" if path else str(k)
                if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
                    flats = []
                    for x in v:
                        d = {}
                        flat(x, "", d)
                        flats.append(d)
                    keys = []
                    for d in flats:
                        keys += [kk for kk in d if kk not in keys]
                    for kk in keys:
                        vals = [d.get(kk) for d in flats]
                        (scalars if len(vals) == 1 else columns)[f"{p}[].{kk}"] = vals[0] if len(vals) == 1 else vals
                elif isinstance(v, dict):
                    walk(v, p)
                elif not isinstance(v, list):
                    scalars[p] = v

    walk(result, "")
    return scalars, columns


def _value_texts(scalars, columns, idx):
    """応答のどれかの値に当たった欄の字（＝値であって、見出しではない）。"""
    texts = set()
    for raw in list(scalars.values()) + [x for vals in columns.values() for x in vals]:
        if distinctive_api(raw):
            texts.update(c["value"] for c in idx.find(raw))
    return texts


def best_label(cell, value_texts):
    """欄の見出し: 構造上いちばん確からしいもの（表の見出し行 > 上 > 左 > 行頭）。値に当たった字は見出しにしない。"""
    return next((label for label, _ in cell["labels"] if label not in value_texts), None)


def link_one(result, screen):
    """1つの画面 ↔ 応答 → {道すじ: {"labels": [見出し…（確からしい順）], "kind": "値"|"列", "pairs": 一致した数}}。"""
    scalars, columns = collect(result)
    idx = _Index(screen["cells"])
    texts = _value_texts(scalars, columns, idx)
    out = {}
    for path, raw in scalars.items():
        if not distinctive_api(raw):
            continue
        hits = idx.find(raw)
        if not hits:
            continue
        score = {}
        for cell in hits:
            label = best_label(cell, texts)
            if label:
                score[label] = score.get(label, 0) + 1
        if score:
            out[path] = {"labels": [k for k, _ in sorted(score.items(), key=lambda kv: (-kv[1], kv[0]))],
                         "votes": score, "kind": "値", "pairs": len(hits)}
    for path, vals in columns.items():
        best = None
        for col in screen["columns"]:
            n = min(len(vals), len(col["values"]))
            pairs = ok = 0
            for raw, disp in zip(vals[:n], col["values"][:n]):
                if distinctive_api(raw) and distinctive_screen(disp):
                    pairs += 1
                    ok += 1 if api.same(disp, raw) else 0
            if pairs >= COLUMN_MIN_PAIRS and ok / pairs >= COLUMN_MATCH and (best is None or (ok, pairs) > best[0]):
                best = ((ok, pairs), col["label"])
        if best:
            out[path] = {"labels": [best[1]], "votes": {best[1]: best[0][0]}, "kind": "列", "pairs": best[0][0]}
    return out


def unmatched(result, screen):
    """画面にあって、どの応答の項目にも当たらなかった見出し（画面の中で計算した値・別の問い合わせの値・目立たない値）。"""
    scalars, columns = collect(result)
    idx = _Index(screen["cells"])
    matched = set()
    for raw in scalars.values():
        if distinctive_api(raw):
            matched.update(id(c) for c in idx.find(raw))
    for vals in columns.values():
        for raw in vals:
            if distinctive_api(raw):
                matched.update(id(c) for c in idx.find(raw))
    texts = _value_texts(scalars, columns, idx)
    labels = []
    for c in idx.cells:
        label = best_label(c, texts)
        if id(c) not in matched and label and label not in labels:
            labels.append(label)
    return labels


# ------------------------------------------------------------------ まとめ
def link_files(files, km, cfg):
    """画面のファイル（{name, html}）の並び → 紐づけの結果。同じロットの応答は1回だけ取る。同じタブの複数のロットで絞る。"""
    results, per_file, acc, gone = {}, [], {}, {}
    for f in files:
        name, html = str(f.get("name") or "画面"), str(f.get("html") or "")
        try:
            screen = read_screen(html)
        except Exception as e:                                  # 読めない画面は、そう言って飛ばす
            per_file.append({"name": name, "error": f"画面を読めませんでした: {e}"})
            continue
        if not screen["lot"]:
            per_file.append({"name": name, "tab": screen["tab"], "error": "画面からロット番号を読めませんでした（LotDsp の画面を保存したものか確かめてください）"})
            continue
        try:
            if screen["lot"] not in results:
                results[screen["lot"]] = api.call(screen["lot"], cfg)
                api.entity_of(results[screen["lot"]], cfg, screen["lot"])
        except api.ApiError as e:
            results.pop(screen["lot"], None)
            per_file.append({"name": name, "tab": screen["tab"], "lot": screen["lot"], "error": str(e)})
            continue
        res = results[screen["lot"]]
        one = link_one(res, screen)
        tab = screen["tab"] or "（タブ名なし）"
        for path, info in one.items():
            acc.setdefault((tab, path), []).append((info, screen["lot"]))
        gone.setdefault(tab, set()).update(unmatched(res, screen))
        per_file.append({"name": name, "tab": tab, "lot": screen["lot"], "cells": len(screen["cells"]), "linked": len(one)})
    used = api.used_paths(km, cfg)
    rows = []
    for (tab, path), found in acc.items():
        sets = [set(i["labels"]) for i, _ in found]
        inter = set.intersection(*sets)
        lots = sorted({lot for _, lot in found})
        labels_pool = inter if inter else set.union(*sets)
        votes = {x: sum(i["votes"].get(x, 0) for i, _ in found) for x in labels_pool}      # 当たった欄の数（どのロットでも合計）
        labels = sorted(labels_pool, key=lambda x: (-votes[x], x))
        strong = any(i["kind"] == "列" for i, _ in found)
        # 確定: どのロットでも残った見出しがあり、2ロット以上（または並びの列）で一致し、票が1つだけ抜けて多い
        lead = len(labels) == 1 or (len(labels) > 1 and votes[labels[0]] > votes[labels[1]])
        if inter and lead and (len(lots) >= 2 or strong):
            status = "確定"
        elif inter:
            status = "候補"
        else:
            status = "食い違い"
        rows.append({"tab": tab, "path": path, "labels": labels[:4], "status": status, "lots": len(lots),
                     "kind": "列" if strong else "値", "used_for": used.get(path)})
    order = {"確定": 0, "候補": 1, "食い違い": 2}
    rows.sort(key=lambda r: (r["tab"], order[r["status"]], r["path"]))
    return {
        "files": per_file,
        "summary": {"linked": len(rows), "confirmed": sum(1 for r in rows if r["status"] == "確定"),
                    "candidates": sum(1 for r in rows if r["status"] == "候補"),
                    "conflicts": sum(1 for r in rows if r["status"] == "食い違い"),
                    "lots": sorted(results), "tabs": sorted({r["tab"] for r in rows})},
        "links": rows,
        "screen_only": {tab: sorted(v)[:80] for tab, v in gone.items()},
        "note": "値は含みません（項目の道すじと画面の見出しだけです）。確定は、見出しが1つに絞れて、2つ以上のロット（または並びの列の照合）で一致したものです。",
    }
