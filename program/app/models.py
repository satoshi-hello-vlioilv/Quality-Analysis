# -*- coding: utf-8 -*-
"""ロット / 工程のデータモデル。"""
from dataclasses import dataclass, asdict, field

# 巻出し方向の初期値。巻出しは基本的に「上」。違う工程だけ画面の表で直す。
# （設備マスタが持つのは巻出しではなく「巻取方向」。混同しないこと）
DEFAULT_UNWIND = "上"


@dataclass
class Process:
    no: int
    equipment: str
    unwind: str = DEFAULT_UNWIND         # 巻出し方向(実績)
    thickness: float = 0                 # 作業後板厚 mm
    width: float = 0                     # 作業後板幅 mm
    weight: float = 0                    # 作業後重量 kg
    off_front_m: float = 0               # オフ長さ 前 m
    off_back_m: float = 0                # オフ長さ 後 m
    off_front_thickness_mm: float = 0    # オフ肉厚 前 mm
    off_back_thickness_mm: float = 0     # オフ肉厚 後 mm
    work_date: str = ""                  # 作業日
    design_split: int = 1                # 分割数(設計)
    horizontal_split: int = 1            # 横割数
    vertical_split: int = 1              # 縦割数


@dataclass
class Lot:
    lot_no: str
    inspection_no: str = ""
    casting_no: str = ""
    order_no: str = ""
    use_code: str = ""
    use_name: str = ""
    material: str = ""
    temper: str = ""
    product_thickness: float = 0
    product_width: float = 0
    product_length: float = 0
    density: float = 0                 # 0 = 取り込んだロットに比重が無い（計算は calculation.default_density）
    processes: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)      # 工程（Process）も dict になる
