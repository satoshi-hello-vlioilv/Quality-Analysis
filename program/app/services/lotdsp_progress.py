# -*- coding: utf-8 -*-
"""ロット問い合わせ（LotDsp）「進度情報」画面の HTML から、ロットと工程を読む。

LotDsp は AngularJS の画面で、表はブラウザの中で描かれる。ここへ届くのは
**描き終わった画面の HTML**（Edge 拡張が渡す `document.documentElement.outerHTML`、
または利用者が「名前を付けて保存」したファイル／表をコピーして貼り付けたもの）。

読み方の約束:
    - 列は**見出しの文字**で探す（クラス名は使わない。実物の class は列とずれている
      箇所がある: 「前ｵﾌ」の見出しが prog-label-jbfo、値の td が prog-jbbo 等）。
      見出しの行と値の行には同じ位置に空の区切りセルが並ぶので、見出しの位置が
      そのまま値の位置になる。
    - 見出しは NFKC で正規化して比べる（ｵﾌ／オフ、ﾛｯﾄ番号／ロット番号を同じに扱う）。
      値は正規化しない（用途名などの半角カナはそのまま残す）。
    - 設備の行（BOX）は可変（最大25）。行数を決め打ちしない。
    - 「実績」の表が工程の正。「設計」の表は同じ№の行から分割数（枚本・横・縦）を補う。
    - 設備マスタに無い設備の行は取り込まない（黙って捨てず `report.skipped` に出す）。
    - 巻出し方向は進度情報に無いので、初期値「上」（models.DEFAULT_UNWIND）を入れる。
      設備マスタが持つのは「巻取方向」で、巻出し方向の初期値には使わない。

標準ライブラリだけで動く（BeautifulSoup を要しない）。
"""
import re
from html.parser import HTMLParser

from ..models import DEFAULT_UNWIND, Lot, Process
from .equipment_names import EquipmentResolver
from .equipment_names import compact as norm       # 見出しの比較用（大小はそのまま）
from .equipment_names import norm as name_key      # ロット番号・設備名の比較用（大文字にそろえる）

MAX_HTML_CHARS = 5_000_000

# 列の見出し（正規化後の文字で完全一致）。設定 lotdsp_import.* で上書きできる。
DEFAULT_ACTUAL_COLUMNS = {
    "no": "№",
    "equipment": "設備",
    "work_date": "日付",
    "thickness": "板厚",
    "width": "板幅",
    "weight": "重量",
    "pieces": "枚本",
    "length_m": "長さ",
    "off_front_m": "前オフ",
    "off_back_m": "後オフ",
}
DEFAULT_DESIGN_COLUMNS = {
    "no": "№",
    "equipment": "設備",
    "horizontal_split": "横",
    "vertical_split": "縦",
    "pieces": "枚本",
}
# ロットの見出し項目（「見出し｜値」の小さな表）。
DEFAULT_LOT_LABELS = {
    "lot_no": "ロット番号",
    "casting_no": "鋳造番号",
    "inspection_no": "検査番号",
    "order_no": "オーダー番号",
    "use_code": "用途",
    "use_name": "用途名",
    "density": "比重",
}
# 「材質・調質・板厚・板幅・板丈・重量」の表（オーダー行と製造行）。製造行を製品寸法にする。
DEFAULT_PRODUCT_COLUMNS = {
    "material": "材質",
    "temper": "調質",
    "product_thickness": "板厚",
    "product_width": "板幅",
    "product_length": "板丈",
}
PROCESS_HEADER_KEYS = ("設備", "日付", "板厚", "板幅", "重量")


def to_number(text):
    """'1,200.00' → 1200.0、空・数字なし → None。"""
    m = re.search(r"-?\d+(?:\.\d+)?", str(text or "").replace(",", ""))
    return float(m.group()) if m else None


class _TableCollector(HTMLParser):
    """HTML の全 <table> を、直下の行・セルの文字の二次元配列として集める。

    入れ子の表は別の表として数え、親の表には `has_child` を立てる（値を読むのは
    入れ子を持たない一番内側の表だけ）。<script>/<style> の中身は読まない。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._stack = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
            return
        if tag == "table":
            if self._stack:
                self._stack[-1]["has_child"] = True
            t = {"rows": [], "has_child": False, "cell": None}
            self.tables.append(t)
            self._stack.append(t)
        elif not self._stack:
            return
        elif tag == "tr":
            self._close_cell()
            self._stack[-1]["rows"].append([])
        elif tag in ("td", "th"):
            t = self._stack[-1]
            self._close_cell()
            if not t["rows"]:
                t["rows"].append([])
            t["cell"] = []
        elif tag == "br":
            self.handle_data(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._skip = max(0, self._skip - 1)
            return
        if not self._stack:
            return
        if tag == "table":
            self._close_cell()
            self._stack.pop()
        elif tag in ("td", "th", "tr"):
            self._close_cell()

    def handle_data(self, data):
        if self._skip or not self._stack:
            return
        cell = self._stack[-1]["cell"]
        if cell is not None:
            cell.append(data)

    def _close_cell(self):
        t = self._stack[-1] if self._stack else None
        if t is None or t["cell"] is None:
            return
        text = re.sub(r"\s+", " ", "".join(t["cell"])).strip()
        t["rows"][-1].append(text)
        t["cell"] = None


def inner_tables(html):
    """入れ子を持たない表だけを、空行を除いた行の配列で返す。"""
    c = _TableCollector()
    c.feed(html)
    c.close()
    out = []
    for t in c.tables:
        if t["has_child"]:
            continue
        rows = [r for r in t["rows"] if any(x for x in r)]
        if rows:
            out.append(rows)
    return out


def _header_index(header, columns):
    """見出しの行から {項目: 列位置}。見出しは正規化して完全一致で探す。"""
    labels = [norm(h) for h in header]
    idx = {}
    for key, label in columns.items():
        want = norm(label)
        if want in labels:
            idx[key] = labels.index(want)
    return idx


def _process_rows(rows, columns):
    """工程の表（見出し＋BOXの行）を dict の配列へ。№が数でない行は読まない。"""
    idx = _header_index(rows[0], columns)
    out = []
    for r in rows[1:]:
        def cell(k, r=r):
            return r[idx[k]] if k in idx and idx[k] < len(r) else ""
        no = to_number(cell("no"))
        equipment = cell("equipment").strip()
        if no is None:
            continue
        # 実績の表は、実績が無い BOX では設備名が空欄になる。値も無ければ「実績なし」として読まない
        # （設計の設備名だけを入れた行として後で足す）。値があって名前だけ空欄の行は、名前を設計から取る
        if not equipment and not any(to_number(cell(k)) for k in ("thickness", "width", "weight")):
            continue
        row = {k: cell(k) for k in idx}
        row["no"] = int(no)
        row["equipment"] = equipment
        out.append(row)
    return out, idx


def _classify(rows):
    """工程の表なら 'actual'／'design'、それ以外は None。"""
    labels = {norm(h) for h in rows[0]}
    if not all(k in labels for k in PROCESS_HEADER_KEYS):
        return None
    if "前オフ" in labels or "後オフ" in labels:
        return "actual"
    if "横" in labels and "縦" in labels:
        return "design"
    return None


def _lot_pairs(tables):
    """見出し項目の小さな表から {正規化した見出し: 値}。先に出たほうを採る。

    形は3つ:
      - 各行が2セル（[見出し, 値] の横並び。例: 営業納期｜26/09/02）
      - 2行（1行目が見出し、2行目が値。1列でも複数列でも位置でそろえる）
      - それ以外は読まない（公差・品質などの大きな表）
    """
    pairs = {}
    for rows in tables:
        if all(len(r) == 2 for r in rows):
            for k, v in rows:
                if k:
                    pairs.setdefault(norm(k), v)
        elif len(rows) == 2 and len(rows[0]) == len(rows[1]):
            for k, v in zip(rows[0], rows[1]):
                if k:
                    pairs.setdefault(norm(k), v)
    return pairs


def _product(tables, columns):
    """材質・調質の表の**製造行**（最後の行）から製品の材質・寸法。"""
    for rows in tables:
        labels = [norm(h) for h in rows[0]]
        if "材質" in labels and "調質" in labels and len(rows) >= 2:
            idx = _header_index(rows[0], columns)
            last = rows[-1]
            return {k: last[i] for k, i in idx.items() if i < len(last)}
    return {}


def _int_or(value, default=1):
    n = to_number(value)
    return int(round(n)) if n else default


def _process_tables(tables, actual_cols, design_cols):
    """実績・設計の工程の表を見つけて読む → (実績の行, 設計の行)。実績の表・大事な列が無ければ LookupError。"""
    actual = design = None
    for rows in tables:
        kind = _classify(rows)
        if kind == "actual" and actual is None:
            actual = rows
        elif kind == "design" and design is None:
            design = rows
    if actual is None:
        raise LookupError(
            "進度情報の「実績」の表が見つかりません。ロット問い合わせで進度情報タブを開いた画面か確かめてください。"
        )
    actual_rows, actual_idx = _process_rows(actual, actual_cols)
    design_rows, _ = _process_rows(design, design_cols) if design else ([], {})
    missing_cols = [actual_cols[k] for k in ("equipment", "thickness", "width", "weight") if k not in actual_idx]
    if missing_cols:
        raise LookupError("実績の表に次の列が見つかりません: " + "、".join(missing_cols))
    return actual_rows, design_rows


def lot_fields(tables, cfg):
    """画面のロットの見出し項目と製品の材質・寸法（文字のまま）。"""
    pairs = _lot_pairs(tables)
    labels = dict(DEFAULT_LOT_LABELS, **(cfg.get("lot_labels") or {}))
    lot = {k: pairs.get(norm(v), "") for k, v in labels.items()}
    lot.update(_product(tables, dict(DEFAULT_PRODUCT_COLUMNS, **(cfg.get("product_columns") or {}))))
    return lot


def check_lot(lot, expect_lot):
    """ロットの項目をそろえる（比重・寸法は数に）。読んだロット番号が頼んだものと違えば ValueError（取り違え防止）。
    画面（HTML）から読んでも API から読んでも同じ。"""
    lot = dict(lot)
    for k in ("density", "product_thickness", "product_width", "product_length"):
        if k in lot:
            n = to_number(lot[k])
            lot[k] = n if n is not None else 0
    page_lot = str(lot.get("lot_no") or "").strip()
    want = (expect_lot or "").strip()
    if want and page_lot and name_key(page_lot) != name_key(want):
        raise ValueError(f"画面のロット番号（{page_lot}）が、取込を頼んだロット番号（{want}）と違います。")
    if not page_lot:
        lot["lot_no"] = want
    return lot


def _processes(actual_rows, design_rows, equipment_master, only_master):
    """実績（無い BOX は設計）の行 → 工程の配列と、読まなかった・読み替えた・実績待ちの記録。
    設備名は設備マスタで引く。同一工程の名前（ANF・ANI2・CAF など）で出てきたら、その行の設備名（代表）に読み替える。"""
    resolver = EquipmentResolver(equipment_master)
    processes, skipped, warnings, renamed, pending = [], [], [], [], []
    design_by_no = {r["no"]: r for r in design_rows}
    actual_by_no = {r["no"]: r for r in actual_rows}

    def resolve(no, raw, skip_reason):
        """設備名 → 取り込む設備名（マスタに無く取り込まないなら None。読まなかった・読み替えたことを記録する）。"""
        m, how, pattern = resolver.resolve(raw)
        if m is None and only_master:
            skipped.append({"no": no, "equipment": raw, "reason": skip_reason})
            return None
        eq = (m.get("設備名") or "").strip() if m else raw
        if m is not None and how in ("alias", "pattern") and norm(raw) != norm(eq):
            renamed.append({"no": no, "from": raw, "to": eq, "by": pattern})
        return eq

    for no in sorted(set(actual_by_no) | set(design_by_no)):
        r = actual_by_no.get(no)
        if r is None:
            # 実績なし: 設計の設備名だけを入れる（板厚・重量などは空欄＝まだ実績が無いと見て分かる）
            eq = resolve(no, design_by_no[no]["equipment"], "設備マスタに無い設備（実績なし）")
            if eq is None:
                continue
            pending.append({"no": no, "equipment": eq})
            processes.append({
                "no": len(processes) + 1, "equipment": eq, "unwind": None,
                "thickness": None, "width": None, "weight": None, "off_front_m": None, "off_back_m": None,
                "work_date": "",
                "design_split": None, "horizontal_split": None, "vertical_split": None,
                "lotdsp_no": no,
            })
            continue
        raw = r["equipment"]
        if not raw and no in design_by_no:
            raw = design_by_no[no]["equipment"]   # 実績の値はあるが名前が空欄 → 設計の名前
        if not raw:
            skipped.append({"no": no, "equipment": "", "reason": "設備名が実績にも設計にもありません"})
            continue
        eq = resolve(no, raw, "設備マスタに無い設備")
        if eq is None:
            continue
        d = design_by_no.get(no)
        if d and not resolver.same(d["equipment"], raw):
            warnings.append(f"№{no}: 設計は{d['equipment']}、実績は{raw}でした。実績の設備で取り込み、分割数は実績の枚本を使いました。")
            d = None
        processes.append({
            "no": len(processes) + 1,
            "equipment": eq,
            "unwind": DEFAULT_UNWIND,
            "thickness": to_number(r.get("thickness")) or 0,
            "width": to_number(r.get("width")) or 0,
            "weight": to_number(r.get("weight")) or 0,
            "off_front_m": to_number(r.get("off_front_m")) or 0,
            "off_back_m": to_number(r.get("off_back_m")) or 0,
            "work_date": r.get("work_date", ""),
            "design_split": _int_or((d or {}).get("pieces") or r.get("pieces")),
            "horizontal_split": _int_or((d or {}).get("horizontal_split")),
            "vertical_split": _int_or((d or {}).get("vertical_split")),
            "lotdsp_no": no,
        })
    return processes, {"skipped": skipped, "renamed": renamed, "planned": pending, "warnings": warnings}


def progress_tables(html, cfg=None):
    """進度情報の HTML → (入れ子の無い表, 実績の行, 設計の行)。行は {項目: 画面の字, "no": BOX の№}。"""
    cfg = cfg or {}
    html = str(html or "")
    if not html.strip():
        raise ValueError("取り込む HTML が空です。")
    if len(html) > MAX_HTML_CHARS:
        raise ValueError("HTML が大きすぎます（進度情報の画面だけを渡してください）。")
    tables = inner_tables(html)
    actual_rows, design_rows = _process_tables(
        tables,
        dict(DEFAULT_ACTUAL_COLUMNS, **(cfg.get("actual_columns") or {})),
        dict(DEFAULT_DESIGN_COLUMNS, **(cfg.get("design_columns") or {})))
    return tables, actual_rows, design_rows


def build_lot(lot, actual_rows, design_rows, equipment_master, cfg=None, source="LotDsp 進度情報"):
    """ロットの項目（check_lot 済み）と実績・設計の行 → (lot の dict, report の dict)。
    画面（HTML）から読んでも API（lotdsp_api）から読んでも、ここから先は同じ道（設備マスタで絞る・巻出しは初期値）。"""
    cfg = cfg or {}
    lot = dict(lot)
    processes, notes = _processes(actual_rows, design_rows, equipment_master, cfg.get("only_master_equipment", True))
    if not any(p["thickness"] is not None for p in processes):
        raise LookupError("取り込める工程がありません（実績の行が無いか、すべて設備マスタに無い設備です）。")

    lot["processes"] = processes
    report = {
        "source": source,
        "lot_no": lot.get("lot_no", ""),
        "actual_rows": len(actual_rows),
        "imported": [{"no": p["no"], "lotdsp_no": p["lotdsp_no"], "equipment": p["equipment"]} for p in processes],
        **notes,
        "default_unwind": DEFAULT_UNWIND,
    }
    return lot, report


def parse_progress_html(html, equipment_master, cfg=None, expect_lot=""):
    """進度情報の HTML → (lot の dict, report の dict)。

    equipment_master: 設備マスタの行（{"設備名","巻取方向",...}）の配列。
    cfg: 設定 `lotdsp_import`（無ければ既定）。
    expect_lot: 取込を頼んだロット番号。画面のロット番号と違えば止める（取り違え防止）。
    """
    cfg = cfg or {}
    tables, actual_rows, design_rows = progress_tables(html, cfg)
    lot = check_lot(lot_fields(tables, cfg), expect_lot)
    return build_lot(lot, actual_rows, design_rows, equipment_master, cfg)


_PROC_FIELDS = set(Process.__dataclass_fields__)
_LOT_FIELDS = set(Lot.__dataclass_fields__) - {"processes", "lot_no"}


def to_models(data, report, expect_lot=""):
    """(lot の dict, report) → (Lot, report)。models に無い項目は落とし、無い項目は既定で埋める。"""
    procs = [Process(**{"no": i, **{k: v for k, v in p.items() if k in _PROC_FIELDS}})
             for i, p in enumerate(data.get("processes", []), 1)]
    lot = Lot(lot_no=str(data.get("lot_no") or expect_lot), processes=procs,
              **{k: v for k, v in data.items() if k in _LOT_FIELDS})
    return lot, report


def read_lot(html, equipment_master, cfg=None, expect_lot=""):
    """進度情報の HTML → (Lot, report)。"""
    data, report = parse_progress_html(html, equipment_master, cfg, expect_lot)
    return to_models(data, report, expect_lot)
