# -*- coding: utf-8 -*-
"""HTTP の道（Blueprint "main"）。関心ごとに分けたモジュールが同じ bp へ登録する。

    common   … 共通の部品（bp・マスタの窓口・失敗の返し方・この PC の名乗りと権限）
    system   … 画面・版・起動の確認・画面の設定・心拍と終了
    access   … アクセス権限・利用状況・書き込みの門番
    lots     … ロットの取り込み（LotDsp）と計算
    masters  … 現場のマスタ（設備・ロール）
    lotlist  … ロット一覧
    settings … 参照先マスタ
"""
from . import access, lots, lotlist, masters, settings, system  # 読み込むと bp へ登録される
from .common import _REVOKE_CACHE, bp  # _REVOKE_CACHE はテストが切断の覚えを消すため

__all__ = ["bp", "_REVOKE_CACHE", "access", "lots", "lotlist", "masters", "settings", "system"]
