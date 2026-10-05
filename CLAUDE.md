# CLAUDE.md

このリポジトリで作業するときの決まり（利用者が決めたこと）。

## push の決まり

1. **push の前に、手元で typecheck・lint・test をすべて通す（green にしてから push する）。**
   CI で初めて失敗に気づく push はしない。下の「push 前の確かめ」を全部通してから push する。
2. **レビューの指摘は、1 件ずつ直して push しない。まとめて直し、1 回で push する。**
   届いた指摘をすべて直し、「push 前の確かめ」を通してから 1 回だけ push する。

## push 前の確かめ（CI と同じ物を手元で）

| 種類 | 何を | コマンド（リポジトリの最上階から） |
|---|---|---|
| typecheck | Rust（窓） | `cd desktop && cargo build --locked` |
| lint | Rust の書式 | `cd desktop && cargo fmt --check` |
| lint | 画面の JS の文法 | `node --check program/app/static/js/<変えたファイル>.js`（`desktop/src/selftest.js` を変えたらそれも） |
| lint | Python の文法 | `python -m py_compile <変えたファイル>.py` |
| test | Rust | `cd desktop && cargo test --locked` |
| test | Python（アプリ） | `cd program && python -m unittest discover -s tests -t .` |
| test | Python（組み立て・確かめ） | `python -m unittest discover -s desktop/bundle -t desktop/bundle` |

- `program` の中身を変えたら、版を上げて `cd program && python app_build.py --release` で `RELEASE` を書き直す（`tests/test_version.py` が止める）。
- Windows だけのコード（`#[cfg(windows)]`）は Linux の `cargo build` では型を確かめられない。変えたときは、その部分だけを
  `windows` クレートに頼る小さな作業用クレートへ写し、`cargo check --target x86_64-pc-windows-msvc` で型を確かめる。
- 起動・更新・配布の流れ（`desktop/src/install.rs`・`update.rs`・`distribute.rs`・`main.rs`）を変えたら、`desktop/bundle/verify.py` の通し
  （local・update・distribute）を本物の窓で確かめる（Windows は CI。手元の Linux では Windows だけの部分を差し替えて流す）。
- 結果は**終了コードと「Ran … / OK / FAILED」の行で**読む。出力の最後の 1 行だけ（`tail -1` など）で判断しない
  （Python の試験は最後に ResourceWarning が出ることがあり、FAILED の行が隠れる。版 3.5.0 で、これを見落として CI で初めて失敗に気づいた）。
- 失敗が残っているときは push しない。直せない理由があるときは、push せずに利用者へ伝える。
