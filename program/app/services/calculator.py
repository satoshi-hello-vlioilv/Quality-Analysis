# -*- coding: utf-8 -*-
"""転写距離・ピッチ計算エンジン。

移植元 Excel「計算結果」シートの数式ロジックを忠実に再現する。

内径(AA列): 表で工程ごとに入れた値があればそれを使う。空欄なら自動:
    - 設定 calculation.equipment_inner_diameter_mm に設備名があればその値
    - 設備が "HOT"  -> calculation.hot_inner_diameter_mm（既定 610）
    - それ以外      -> calculation.default_inner_diameter_mm（既定 558。Excel の L- も同じ 558）
    ※Excel の「発見設備の内径 = 検入時内径」の分岐は、数式の比較が常に不成立のデッド分岐だった。
      検入時内径の欄は 2026-09-30 に削除（内径は表で工程ごとに直す）。

比重: 取り込んだロットの比重（LotDsp の「比重」）。無い・0 なら calculation.default_density（既定 2.7）。

転写距離:
    - 発見設備: 汚れ位置 A・B（表裏の位置）の差分 |B - A| そのもの。
      発見設備では実測した表裏の間隔が転写距離であり、巻きの周長からの換算は不要。
    - それ以外(上流工程): 汚れ位置を各工程の内巻長さへ換算し、その巻きの周長を
      発見板厚基準へ直した値。
    - **使うのは汚れ位置 A だけ**。A から上流へさかのぼって各工程での位置・肉厚・1 周を出し、
      発見設備で何 m のラップ長さになるか（予測）を求める。B は実測 |B - A| との一致の判定にだけ使う。

さかのぼりの板厚比（calculation.trace_ratio）:
    - "adjacent"（既定）: 1 つ下流の工程の板厚 ÷ その工程の板厚。体積が保たれるので、同じ汚れの
      「全長に対する位置の割合」がどの工程でもほぼ一定になる（オフの分を除く）。
    - "found": 発見板厚 ÷ その工程の板厚（以前の式）。板厚が 2 回以上変わると換算が二重にずれ、
      上流ほど位置が内側へ寄る（見本 L6183D0 の HOT で全長の 0.4 %）。移植元と突き合わせるときだけ使う。

頭と尾: 巻き替えるたびに頭と尾が入れ替わる（先に巻いた頭が内側）。位置は「A 側の端」から測り、
    A 側の端が頭か尾かを head_tail（1=頭）が持つ。焼鈍（AN）は巻き替えないので入れ替えない。

エンドバック（calculation.end_back_equipment、既定 ["L-"]）:
    - 冷延設備（L-1・L-2・L-3 など）で前工程より重量が減っていたら、お尻側（後オフ）を取ったとみなし、
      減った重量（両エッジを落とした分は除く）からこの工程の板厚・板幅で長さへ直して後オフに入れる。
    - 総オフ後が入力されていれば（0 も入力）入力を使う。未入力のときだけ自動の値を使う。

面(表裏)の反転:
    - 巻出し方向(工程ごとの実績。既定は上)と、設備マスタの巻取方向が違う工程で反転する。
    - 巻取方向が 上／下 でない設備(- の設備)は比べない。

ピッチ計算 / 候補ロール:
    - 出側ピッチ = 発見ピッチ * 発見板厚 / 板厚、径 = ピッチ / π
    - 入側ピッチ = 直前工程の出側ピッチ
    - 候補ロール: 移植したロールマスタから、対象径が ±誤差% に入り、
      設備が一致し、入出位置が該当(入側 / 出側・ー)するロールを抽出。
"""
from math import pi, sqrt


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


DIRECTIONS = ("上", "下")
REWIND_VALUES = ("上", "下", "-")      # 巻取方向として入れられる値（- は巻き取らない・テールを描かない）


def direction(v):
    """上／下 だけを方向として扱う（- や空は方向なし）。"""
    v = (v or "").strip()
    return v if v in DIRECTIONS else ""


def opt_num(v):
    """未入力（空・None・数でない）は None。0 は入力された値として扱う。"""
    return num(v, None)   # None・空・空白は float() が断るので None になる


def flip(v):
    return {
        "表": "裏", "裏": "表", "上": "下", "下": "上",
        "A": "B", "B": "A", "OS": "DS", "DS": "OS",
        "WS": "DS", "O": "D", "D": "O", 0: 1, 1: 0,
    }.get(v, v)


class Calculator:
    def __init__(self, settings, masters):
        self.settings = settings
        self.masters = masters

    def _calc_cfg(self):
        return self.settings.get("calculation", {})

    def _auto_inner_diameter(self, equipment):
        """内径の自動の値（表で空欄のとき）: 設定の設備ごとの値 → HOT → 既定。"""
        cfg = self._calc_cfg()
        eq = (equipment or "").strip()
        ids = cfg.get("equipment_inner_diameter_mm") or {}
        if eq in ids:
            return num(ids[eq])
        if eq == "HOT":
            return num(cfg.get("hot_inner_diameter_mm"), 610.0)
        return num(cfg.get("default_inner_diameter_mm"), 558.0)

    def _density(self, lot):
        """比重と出どころ: 取り込んだロットの値（lot）、無い・0 なら設定の既定（default）。"""
        d = num(lot.get("density"), 0)
        if d > 0:
            return d, "lot"
        return num(self._calc_cfg().get("default_density"), 2.7), "default"

    def _end_back_eligible(self, eq):
        prefixes = self._calc_cfg().get("end_back_equipment", ["L-"])
        return any(eq.startswith(x) for x in prefixes)

    @staticmethod
    def _end_back_m(p, prev, density):
        """前工程との重量差（両エッジの分を除く）から、この工程で取った後オフの長さ（m）。減っていなければ None。"""
        if prev is None:
            return None
        t, w = num(p["thickness"]), num(p["width"])
        if not (t and w and density):
            return None
        # 重量が空欄（実績なし）の工程は比べない（空欄を「減った」と読まない）
        if num(prev["weight"]) <= 0 or num(p["weight"]) <= 0:
            return None
        dk = num(prev["weight"]) - num(p["weight"])
        if dk <= 0:
            return None
        split = max(num(p.get("design_split"), 1), 1)
        vs = max(num(p.get("vertical_split"), 1), 1)
        length = num(p["weight"]) * 1000 / (w * t * density) / split * vs
        dw = num(prev["width"]) - w
        edge_kg = dw * t * density * length * split / vs / 1000.0 if dw > 0 else 0.0
        kg = dk - edge_kg
        if kg <= 0:
            return None
        return kg * 1000 / (w * t * density) / split * vs

    def calculate(self, lot, inputs):
        """ロットと入力 → 工程ごとの値・仮の発生設備ごとのたどり直し・最も確からしい発生設備。
        段階: ①工程ごとの値 ②面・側の反転 ③転写距離（発見設備から遡る） ④幅落ち・丈落ち ⑤ピッチと候補ロール"""
        ps = [dict(p) for p in lot["processes"]]
        found_no = int(str(inputs["found_equipment"]).split(":", 1)[0])
        pitch = num(inputs["found_pitch_mm"])
        # 汚れ位置 A・B は既定で未入力。そろうまで転写距離は計算しない（0 m として扱わない）
        a = opt_num(inputs.get("soil_a_m"))
        b = opt_num(inputs.get("soil_b_m"))
        tol = num(inputs.get("tolerance_percent"), 5)
        density, density_source = self._density(lot)
        found_t = next((num(p["thickness"]) for p in ps if int(p["no"]) == found_no), 0)
        actual = abs(b - a) if a is not None and b is not None else None
        # 手で入れた設備名も同一工程の名前（ANF2・CAF など）なら代表の設備として引く
        resolver = self.masters.equipment_resolver()
        ratio_mode = self._calc_cfg().get("trace_ratio", "adjacent")

        self._derive(ps, found_no, density, resolver)
        self._track_face_side(ps)
        included = self._trace_back(ps, found_no, a, actual, found_t, tol, ratio_mode)
        origins = self._origins(included, found_no, found_t, actual)
        self._losses(ps, density)
        self._pitches(ps, pitch, found_t, tol, resolver)

        ranked = sorted((o for o in origins.values() if o["agreement_percent"] is not None),
                        key=lambda o: -o["agreement_percent"])
        return {
            "lot": lot,
            "inputs": inputs,
            "actual_transfer_distance_m": actual,
            "soil_positions_ready": actual is not None,
            "soil_a_ready": a is not None,
            "found_thickness_mm": found_t,
            "density": density, "density_source": density_source,
            "trace_ratio": ratio_mode,
            "origins": origins,
            # 最も確からしい仮の発生設備（B があるときだけ・一致率の高い順の先頭）
            "likely_origin_no": ranked[0]["no"] if ranked else None,
            "processes": ps,
        }

    def _derive(self, ps, found_no, density, resolver):
        """① 工程ごとの値: 後オフ・内径・巻取方向（入力か自動）・ライン方向・巻き後の長さ・オフの合計・設備の区別。"""
        eqmap = self.masters.equipment_map()
        canon = resolver.canonical if resolver else (lambda x: x)
        prev_p = None
        for p in ps:
            eq = (p["equipment"] or "").strip()
            # 後オフ: 入力（0 も入力）があれば入力、無ければエンドバックの自動値
            entered = opt_num(p.get("off_back_m"))
            auto = self._end_back_m(p, prev_p, density) if eq and self._end_back_eligible(canon(eq)) else None
            p["auto_off_back_m"] = auto
            p["off_back_source"] = "input" if entered is not None else ("auto" if auto is not None else "")
            p["off_back_m"] = entered if entered is not None else (auto or 0.0)
            prev_p = p
            ce = canon(eq)
            # 巻取方向: 表で入れた値（上・下・-）があればそれ、無ければ設備マスタの値（自動）
            auto_rw = eqmap.get(ce, {}).get("rewind", "")
            entered_rw = str(p.get("rewind_master") or "").strip()
            rw_input = entered_rw in REWIND_VALUES
            p.update({
                "auto_rewind_master": auto_rw,
                "rewind_source": "input" if rw_input else ("auto" if auto_rw else ""),
                "rewind_master": entered_rw if rw_input else auto_rw,
                "line_direction": eqmap.get(ce, {}).get("line_direction", ""),
            })
            t, w, kg = num(p["thickness"]), num(p["width"]), num(p["weight"])
            split = max(num(p.get("design_split"), 1), 1)
            vs = max(num(p.get("vertical_split"), 1), 1)
            p["after_length_m"] = kg * 1000 / (w * t * density) / split * vs if t * w * density else 0
            # 内径: 入力（正の数）があれば入力、無ければ自動（0 や字は内径として使えないので自動）
            entered_d = opt_num(p.get("inner_diameter_mm"))
            p["auto_inner_diameter_mm"] = self._auto_inner_diameter(eq)
            p["inner_diameter_source"] = "input" if entered_d and entered_d > 0 else "auto"
            p["inner_diameter_mm"] = entered_d if p["inner_diameter_source"] == "input" else p["auto_inner_diameter_mm"]
            r = p["inner_diameter_mm"] / 2
            p["total_off_front_m"] = num(p.get("off_front_m")) + pi * ((num(p.get("off_front_thickness_mm")) + r) ** 2 - r ** 2) / t / 1000 if t else 0
            p["total_off_back_m"] = num(p.get("off_back_m")) + pi * ((num(p.get("off_back_thickness_mm")) + r) ** 2 - r ** 2) / t / 1000 if t else 0
            p["equipment_flag"] = 1 if eq.startswith("AN") else (2 if int(p["no"]) == found_no else 0)

    @staticmethod
    def _track_face_side(ps):
        """② 面・側の反転: 巻出しと巻取りの向きが違えば面が、ライン方向が前の工程と違えば側が入れ替わる（焼鈍は除く）。"""
        face = 0
        side = 0
        for i, p in enumerate(ps):
            eq = (p["equipment"] or "").strip()
            if i and not eq.startswith("AN"):
                unwind, rewind = direction(p.get("unwind")), direction(p["rewind_master"])
                if unwind and rewind and unwind != rewind:
                    face = flip(face)
                prev = ps[i - 1]
                if prev.get("line_direction") and p.get("line_direction") and prev["line_direction"] != p["line_direction"]:
                    side = flip(side)
            p["face_state"] = face
            p["side_state"] = side

    @staticmethod
    def _trace_back(ps, found_no, a, actual, found_t, tol, ratio_mode):
        """③ 転写距離: 発見設備から遡って汚れ位置 A を各工程の内巻長さへ換算（B は判定にだけ使う）。→ 遡った工程
        trace は説明パネル（3D）が「どう遡ったか」を示すための途中の値。計算そのものには使わない。"""
        included = [p for p in ps if int(p["no"]) <= found_no] if a is not None else []
        pos = None
        head_tail = 1
        for idx in range(len(included) - 1, -1, -1):
            p = included[idx]
            prev_pos, ratio, off, an_skip = pos, 1.0, 0.0, False
            if int(p["no"]) == found_no:
                prev_pos, off = a, p["total_off_front_m"]
                pos = a + off
                head_tail = 1
            elif included[idx + 1]["equipment"].strip().startswith("AN"):
                an_skip = True
            else:
                head_tail = 1 - head_tail
                t_row = num(p["thickness"])
                t_ref = found_t if ratio_mode == "found" else num(included[idx + 1]["thickness"])
                ratio = t_ref / t_row if t_row else 1.0
                off = p["total_off_front_m"] if head_tail == 1 else p["total_off_back_m"]
                pos = pos * ratio + off
            other = p["after_length_m"] - pos
            inner_len = pos if head_tail == 1 else other
            r = p["inner_diameter_mm"] / 2
            inner_th = sqrt(max(0, r * r + inner_len * num(p["thickness"]) * 1000 / pi)) - r
            circumference = (2 * inner_th + p["inner_diameter_mm"]) * pi / 1000
            if int(p["no"]) == found_no:
                transfer = actual
            else:
                transfer = circumference * num(p["thickness"]) / found_t if found_t else 0
            p["trace"] = {
                "prev_pos_m": prev_pos, "ratio": ratio, "off_m": off,
                "off_side": "" if an_skip else ("頭" if head_tail == 1 else "尾"),
                "an_skip": an_skip, "circumference_m": circumference,
            }
            p.update({
                "head_tail": head_tail,
                "position_from_a_m": pos,
                "position_from_b_m": other,
                "inner_length_m": inner_len,
                "inner_thickness_mm": inner_th,
                "transfer_distance_m": transfer,
                "agreement_percent": (min(actual, transfer) / max(actual, transfer) * 100
                                      if actual and transfer else (0 if actual is not None else None)),
                "transfer_match": ((abs(transfer - actual) < actual * tol / 100 if p["equipment_flag"] == 0 else False)
                                   if actual is not None else None),
            })
        return included

    @staticmethod
    def _losses(ps, density):
        """④ 幅落ち(AD) / 丈落ち-kg(AE) / 丈落ち-m(AF): 直前工程との差から算出。"""
        prev = None
        for p in ps:
            eq = (p["equipment"] or "").strip()
            t, w, kg, al = num(p["thickness"]), num(p["width"]), num(p["weight"]), p["after_length_m"]
            p["width_loss_kg"] = ""
            p["length_loss_kg"] = ""
            p["length_loss_m"] = ""
            if prev is not None and eq:
                dw = num(prev["width"]) - w
                if dw != 0:
                    p["width_loss_kg"] = dw * t * density * al * 1000.0 / 1e6
                    dk = num(prev["weight"]) - kg
                    if dk != 0:
                        p["length_loss_kg"] = dk
                        p["length_loss_m"] = dk / t / w * 1e6 / 1e3 / density if (t and w and density) else ""
            prev = p

    def _pitches(self, ps, pitch, found_t, tol, resolver):
        """⑤ ピッチ計算 + 候補ロール検索（発見ピッチを板厚の比で各工程の入側・出側へ換算し、径が合うロールを探す）。"""
        rolls = self.masters.rolls()
        previous_out = None
        for p in ps:
            eq = (p["equipment"] or "").strip()
            t = num(p["thickness"])
            out_pitch = pitch * found_t / t if t else 0
            in_pitch = previous_out if previous_out is not None else 0
            previous_out = out_pitch
            p["pitch_in_mm"] = in_pitch if eq != "HOT" and not eq.startswith("AN") else 0
            p["diameter_in_mm"] = p["pitch_in_mm"] / pi if p["pitch_in_mm"] else 0
            p["pitch_out_mm"] = out_pitch if not eq.startswith("AN") else 0
            p["diameter_out_mm"] = p["pitch_out_mm"] / pi if p["pitch_out_mm"] else 0
            p["roll_candidates"] = self._candidates(eq, p["diameter_in_mm"], p["diameter_out_mm"], rolls, tol, resolver)

    @staticmethod
    def _wall_mm(p, inner_len):
        r = p["inner_diameter_mm"] / 2
        return sqrt(max(0, r * r + max(0.0, inner_len) * num(p["thickness"]) * 1000 / pi)) - r

    def _origins(self, included, found_no, found_t, actual):
        """仮の発生設備ごとに、汚れ位置 A だけから下流へたどり直した結果（3D と説明文がそのまま描く）。

        発生設備 X では、A からさかのぼった位置（内側から inner_length・肉厚 inner_thickness）に汚れがあり、
        その巻きの 1 周（circumference）だけ外側の巻きへ写る。以降の工程では 2 か所の間隔が
        「間隔 × X の板厚 ÷ その工程の板厚」に広がり、頭尾は巻き替えのたびに入れ替わる。
        発見設備での間隔（予測のラップ長さ）は表の転写距離と同じ値になる（同じ式を順方向にたどるだけ）。
        """
        out = {}
        for i, x in enumerate(included):
            if x["equipment_flag"] != 0:
                continue
            c, tx = x["trace"]["circumference_m"], num(x["thickness"])
            outward = 1 if x["head_tail"] == 1 else -1     # 2 か所目は内側から遠い方（A 側の端から見た向き）
            steps, prev = [], None
            for p in included[i:]:
                length, t = p["after_length_m"], num(p["thickness"])
                spacing = c * tx / t if t else c
                pos1 = p["position_from_a_m"]
                pos2 = pos1 + outward * spacing
                a_is_head = p["head_tail"] == 1
                from_head = (lambda v: v) if a_is_head else (lambda v, L=length: L - v)
                inner = (lambda v: v) if a_is_head else (lambda v, L=length: L - v)
                hs = max(num(p.get("horizontal_split"), 1), 1)
                edge = (num(prev["width"]) - num(p["width"]) * hs) / 2 if prev is not None else 0
                steps.append({
                    "no": p["no"], "equipment": p["equipment"], "thickness": t, "width": num(p["width"]),
                    "after_length_m": length, "inner_diameter_mm": p["inner_diameter_mm"],
                    "a_end": "頭" if a_is_head else "尾",
                    "inner_end": "頭",          # 巻き取りで先に巻いた頭が内側
                    "spacing_m": spacing, "ratio_to_origin": spacing / c if c else 1.0,
                    "marks": [
                        {"from_head_m": from_head(pos1), "inner_length_m": inner(pos1),
                         "wall_mm": self._wall_mm(p, inner(pos1))},
                        {"from_head_m": from_head(pos2), "inner_length_m": inner(pos2),
                         "wall_mm": self._wall_mm(p, inner(pos2))},
                    ],
                    "off_front_m": p["total_off_front_m"], "off_back_m": p["total_off_back_m"],
                    "off_back_source": p.get("off_back_source", ""),
                    "edge_trim_mm": edge if edge > 0 else 0.0,
                    "annealing": (p["equipment"] or "").strip().startswith("AN"),
                    "is_origin": p is x, "is_found": int(p["no"]) == found_no,
                })
                prev = p
            predicted = steps[-1]["spacing_m"] if steps else None
            out[str(x["no"])] = {
                "no": x["no"], "equipment": x["equipment"],
                "soil_a_m": included[-1]["trace"]["prev_pos_m"],
                "inner_length_m": x["inner_length_m"], "inner_thickness_mm": x["inner_thickness_mm"],
                "inner_diameter_mm": x["inner_diameter_mm"], "circumference_m": c, "thickness": tx,
                "found_thickness_mm": found_t, "predicted_m": predicted,
                "actual_m": actual,
                "agreement_percent": x["agreement_percent"], "match": x["transfer_match"],
                "steps": steps,
            }
        return out

    @staticmethod
    def _candidates(eq, dia_in, dia_out, rolls, tol, resolver=None):
        """移植したロールマスタから候補ロールを抽出（Excel の FILTER 相当）。同一工程の名前のロールも当てる。"""
        out = []
        if not eq:
            return out
        lo, hi = (1 - tol / 100), (1 + tol / 100)
        for rrow in rolls:
            req = (rrow.get("設備") or "").strip()
            if not (req == eq or (resolver is not None and resolver.same(req, eq))):
                continue
            loc = (rrow.get("入出位置") or "").strip()
            # 入側は入側径、それ以外(出側 / ー)は出側径で判定
            if loc == "入側":
                target = dia_in
            else:
                target = dia_out
            rd = num(rrow.get("ロール径MAX"), -1)
            if target and rd >= 0 and target * lo <= rd <= target * hi:
                out.append({
                    "name": rrow.get("ロール名", ""),
                    "location": loc or "ー",
                    "diameter_max_mm": rd,
                    "diameter_min_mm": num(rrow.get("ロール径MIN"), 0),
                    "reference": rrow.get("基準番号", ""),
                    "condition": rrow.get("ロール使用条件", ""),
                })
        return out
