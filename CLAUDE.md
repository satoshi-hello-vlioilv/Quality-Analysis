# CLAUDE.md

このリポジトリで作業するときの決まり（利用者が決めたこと）。

## 返答・報告・解説は、常に日本語で書く

利用者への返答は、どんなに短くても日本語で書く。英語に戻さない。対象は次の全て:

- 返答と解説
- 途中の一言（いま何をしているか）
- 状況報告（CI の結果、PR の状態、定期確認の結果、マージ、exe の配置）
- PR の説明

## push の決まり

1. **push の前に、手元で型・構文（typecheck）・lint・test をすべて通す（green にしてから push する）。**
   CI で初めて失敗に気づく push はしない。下の「push 前の確かめ」を全部通してから push する。1 つでも落ちていれば push しない。
   文書だけの変更でも同じ。
2. **レビューの指摘は、1 件ずつ直して push しない。まとめて直し、1 回で push する。**
   届いた指摘をすべて直し、「push 前の確かめ」を通してから 1 回だけ push する。

## push 前の確かめ（CI と同じ物を手元で）

リポジトリの最上位で実行する:

```sh
# 1. 型・構文（JavaScript・Python・Rust）
find program/app/static/js program/tools desktop/src -name '*.js' -o -name '*.mjs' | xargs -n1 node --check
python -m compileall -q program
(cd desktop && cargo build --locked)
# 2. lint（Python・Rust）
ruff check program
(cd desktop && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
# 3. テスト（Python・Rust）
(cd program && python -m unittest discover -s tests -t .)
python -m unittest discover -s desktop/bundle -t desktop/bundle
(cd desktop && cargo test --locked)
```

- 型検査の道具（TypeScript・mypy）は入れていないので、JavaScript・Python は構文の確かめで代えている。入れたら差し替える。Rust はコンパイラが型を確かめる。
- JavaScript の lint の設定は無い（2 は Python と Rust）。JavaScript のテスト（`npm test`）も、このリポジトリにはまだ無い。
- CI（`.github/workflows/ci.yml`）も同じ物を流す。ruff と Rust（clippy）は手元と同じ版に留めてある（ruff 0.15.20・Rust 1.97.0。
  版が上がると決まりが増え、手元で通った物が CI で落ちるため）。上げるときは手元と CI を一緒に上げる。
- `program` の中身を変えたら、版を上げて `cd program && python app_build.py --release` で `RELEASE` を書き直す（`tests/test_version.py` が止める）。
- 窓（`desktop/`。Tauri）を Linux で作るには WebKitGTK などが要る（`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev libssl-dev`）。
- Windows だけのコード（`#[cfg(windows)]`）は Linux の確かめではコンパイルされない。変えたときは `rustup target add x86_64-pc-windows-msvc` のうえで
  `cargo clippy --target x86_64-pc-windows-msvc --all-targets -- -D warnings` も通す。窓全体が Linux から Windows 向けに組めないときは、その部分だけを
  `windows` クレートに頼る小さな作業用クレートへ写し、`cargo check --target x86_64-pc-windows-msvc` で型を確かめる。
- 起動・更新・配布の流れ（`desktop/src/install.rs`・`update.rs`・`distribute.rs`・`main.rs`）を変えたら、`desktop/bundle/verify.py` の通し
  （local・update・distribute）を本物の窓で確かめる（Windows は CI。手元の Linux では Windows だけの部分を差し替えて流す）。
- Windows の本物の WebView2 での自己診断は CI（`.github/workflows/desktop.yml`）が行う。手順の考え方は `program/docs/DESKTOP_MIGRATION_DESIGN.md`。
- 結果は**終了コードと「Ran … / OK / FAILED」の行で**読む。出力の最後の 1 行だけ（`tail -1` など）で判断しない
  （Python の試験は最後に ResourceWarning が出ることがあり、FAILED の行が隠れる。版 3.5.0 で、これを見落として CI で初めて失敗に気づいた）。
- 失敗が残っているときは push しない。直せない理由があるときは、push せずに利用者へ伝える。

## UI/UX を変えるときは、最低 5 案を画像で直接比べて選ぶ

画面の見た目・使い方（UI/UX）を改良するときは、必ず次の順で設計する。案を文章だけで採点しない。

1. 今の画面を撮り（`ui-check.mjs`）、画像を見て評価する。何が使いにくいか・分かりにくいかを、画像で見えたことを根拠に挙げる
2. 改良案を**最低 5 案**出し、案ごとに画面を撮る（`ui-variants.mjs`）
3. 画像を直接見比べて採点し（7 基準。`ui_score.py`）、1 位を選ぶ
4. 1 位と 2 位が**僅差**（僅差の幅 11 点より近い）なら、無理に選ばない。より良さそうな**複合案を 3 つ**作り、**元の案の上位 2 案**を足した 5 案を、また画像にして比べ、選び直す
5. 選び直しても僅差なら、無理に選ばない。上位の案の画像を添えて、利用者に確かめる
6. 選んだ案を作ったら、作る前と後を `ui-check.mjs` で撮って測り、画像と数で確かめる。比べた画像は比較のページ（Artifact）で見せる

```sh
node program/tools/ui-check.mjs 出力フォルダ                                         # 今の画面（作った後の前後比較にも）
node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs --states list,grouped,calc   # 案ごとの画面と、全案を並べた一覧
node program/tools/ui-variants.mjs 出力フォルダ 案の定義.mjs --view 1536x864        # フル HD・125% でも
python program/tools/ui_score.py 採点.json                                            # 採点・僅差の判定・次にすること
```

- 道具は Inventor のリポジトリの同じ名前の道具を、このアプリに合わせて移した（開発用のサーバー `ui_server.py` は試験用の品質データ 1500 行で起こす。
  撮る状態は `ui-harness.mjs` の `STATES`: 異常ロット一覧・並び・まとめ・表の見せ方・カード・計算の検索前・アプリのメニュー・更新履歴・スライサー・表示の設定・表示列の設定・マスタ管理の各タブ）
- 7 基準の 6 つ目は、このアプリでは「一覧・3D の見やすさ・操作の短さ」（Inventor では「3D の…」）。重みは同じなので、僅差の幅も同じ 11 点
- 案の定義と採点は `program/tools/ui-proposals/` に比較ごとに置く（例: `2026-10-shortcut.mjs`）
- 案は、今の画面に案の CSS と DOM の組み替えを当てて再現する（`ui-variants.mjs` の冒頭の説明）
- 全案を並べた一覧（`sheet-状態-テーマ.png`）で全体を見る。細部（隠れる・切れる・折り返す・空く）は 1 枚ずつの画像で見る
- 撮る大きさは利用者の PC（1728×1152。既定）と、フル HD・125%（1536×864）。このアプリにはダークの見た目がまだ無いので、テーマは light。
  ダークを入れたら、上位の案はダーク（`--themes light,dark`）でも見る
