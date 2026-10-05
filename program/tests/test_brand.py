# -*- coding: utf-8 -*-
"""評価関数: アプリの名前は 1 か所（app/brand.json）の定義から配る（版 3.3.0）。

- 変えてよい名前（name・subtitle・exe）: 窓の題名・画面の見出し・ショートカット・配る ZIP・リリースがすべてここから読む。
  exe の名前は作る道具（desktop/Cargo.toml・tauri.conf.json）にも書くので、食い違えばここで止める。
- 変えない目印（app_id・data_dir）: 変えると各 PC の設定・記録・入れたアプリ・取り込んだ版を引き継げない。値を固定して守る。
- 名前を書き写していない（コードに表示名・アプリ名をじかに書かない）。更新履歴・説明・試験は歴史や例を書くので調べない。
"""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from app import create_app
from app.brand import BRAND

PROGRAM = Path(__file__).resolve().parents[1]
REPO = PROGRAM.parent
DESKTOP = REPO / "desktop"


def code_lines(p: Path):
    """(行番号, 行) のうち、説明でないもの: 1 行のコメント・ブロックコメント（/* */・<!-- -->）・Python の docstring・
    Rust の試験（#[cfg(test)] より下）を除く。"""
    import ast
    text = p.read_text(encoding="utf-8", errors="replace")
    blank = lambda m: "\n" * m.group(0).count("\n")    # noqa: E731  行番号を保つ
    if p.suffix in (".js", ".rs", ".html", ".css"):
        text = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    if p.suffix == ".html":
        text = re.sub(r"<!--.*?-->", blank, text, flags=re.S)
    if p.suffix == ".rs" and "#[cfg(test)]" in text:
        text = text[:text.index("#[cfg(test)]")]
    skip = set()
    if p.suffix == ".py":
        for node in ast.walk(ast.parse(text)):
            body = getattr(node, "body", None)
            if isinstance(body, list) and body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
                    and isinstance(body[0].value.value, str):
                skip.update(range(body[0].lineno, body[0].end_lineno + 1))
    for i, line in enumerate(text.splitlines(), 1):
        if i in skip or line.lstrip().startswith(("//", "#", "<!--")):
            continue
        yield i, line


class Brand(unittest.TestCase):
    def test_definition(self):
        raw = json.loads((PROGRAM / "app" / "brand.json").read_text(encoding="utf-8"))
        for k in ("name", "subtitle", "exe", "app_id", "data_dir"):
            self.assertTrue(str(raw.get(k) or "").strip(), f"brand.json の {k} が空")
        self.assertEqual(BRAND["name"], raw["name"])
        self.assertTrue(raw["exe"].endswith(".exe") and "/" not in raw["exe"] and "\\" not in raw["exe"])

    def test_fixed_ids_never_change(self):
        # 変えると、作業場所（%LOCALAPPDATA%\<data_dir>）・WebView の保存先・入れたアプリ・取り込んだ版・更新の見分けが切れる
        self.assertEqual(BRAND["app_id"], "local.transferpitchanalyzer.desktop")
        self.assertEqual(BRAND["data_dir"], "TransferPitchAnalyzer")

    def test_names_are_not_copied_into_code(self):
        """表示名・アプリ名をコードにじかに書かない（brand.json から読む）。説明（コメント・docstring）と試験のコードは調べない。
        行に「名前の歴史」とあるものは、昔の名前そのものが要る所（版 3.1.0 で取り込んだ版を起こすなど。名前が変わっても変えない）。"""
        words = {BRAND["subtitle"]: "副題", BRAND["name"]: "アプリ名"}
        roots = [(PROGRAM / "app", ("*.py", "*.js", "*.html")), (PROGRAM, ("*.py",)), (DESKTOP / "src", ("*.rs", "*.js")),
                 (DESKTOP / "splash", ("*.html",)), (DESKTOP / "bundle", ("*.py",)), (REPO / ".github", ("*.yml",))]
        skip = {PROGRAM / "app" / "version.py"}           # 更新履歴は歴史を書く
        found = []
        for root, pats in roots:
            for pat in pats:
                for p in (root.rglob(pat) if root != PROGRAM else root.glob(pat)):
                    if p in skip or "tests" in p.parts or p.name.startswith("test_") or "__pycache__" in p.parts:
                        continue
                    for i, line in code_lines(p):
                        for w, why in words.items():
                            if w in line and "名前の歴史" not in line:
                                found.append(f"{p.relative_to(REPO)}:{i}: {why}「{w}」")
        self.assertEqual(found, [], "\n".join(found[:30]))

    def test_screen_shows_the_name_and_subtitle(self):
        c = create_app({"TESTING": True}).test_client()
        page = c.get("/").get_data(as_text=True)
        self.assertIn(f"<title>{BRAND['name']}</title>", page)
        self.assertRegex(page, rf'<h1[^>]*>{re.escape(BRAND["name"])}')
        self.assertIn(BRAND["subtitle"], page, "副題（和名）を見出しに添える")
        cfg = c.get("/api/config").get_json()
        self.assertEqual((cfg["app"]["name"], cfg["app"]["subtitle"]), (BRAND["name"], BRAND["subtitle"]))

    def test_work_place_uses_the_fixed_folder(self):
        import os
        import app_env
        old = os.environ.pop("TRANSFER_LOCAL_ROOT", None)
        try:
            self.assertEqual(app_env.local_root().name, BRAND["data_dir"])
        finally:
            if old is not None:
                os.environ["TRANSFER_LOCAL_ROOT"] = old


@unittest.skipUnless((DESKTOP / "tauri.conf.json").exists(), "desktop フォルダが無い（配った形）。作る道具との突き合わせはリポジトリで行う")
class BuildTools(unittest.TestCase):
    """作る道具（desktop/Cargo.toml・tauri.conf.json）が brand.json と食い違わない。配る ZIP には desktop が無いので、そのときは比べない。"""

    def test_identifier_is_the_fixed_id(self):
        conf = json.loads((DESKTOP / "tauri.conf.json").read_text(encoding="utf-8"))
        self.assertEqual(conf["identifier"], BRAND["app_id"], "Tauri の identifier は変えない目印と同じ")

    def test_build_tools_agree_with_the_definition(self):
        stem = BRAND["exe"][:-4]
        cargo = (DESKTOP / "Cargo.toml").read_text(encoding="utf-8")
        bins = re.findall(r'\[\[bin\]\]\s*\nname\s*=\s*"([^"]+)"', cargo)
        self.assertEqual(bins, [stem], "desktop/Cargo.toml の [[bin]] name は brand.json の exe と同じ")
        conf = json.loads((DESKTOP / "tauri.conf.json").read_text(encoding="utf-8"))
        self.assertEqual(conf["mainBinaryName"], stem, "tauri.conf.json の mainBinaryName は brand.json の exe と同じ")
        self.assertEqual(conf["productName"], BRAND["name"], "tauri.conf.json の productName は brand.json の name と同じ")


if __name__ == "__main__":
    unittest.main()
