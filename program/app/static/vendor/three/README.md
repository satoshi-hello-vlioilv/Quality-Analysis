# three.js（同梱）

「計算の考え方（3D）」パネル（`app/static/js/explain3d.js`）が使う three.js です。
社内 PC がインターネットに出られなくても動くよう、CDN ではなく同梱しています。

- 版: three **0.186.1**（npm）・ライセンス: MIT（`LICENSE`）
- 中身: `three`（build/three.module.js）＋ `OrbitControls` ＋ `CSS2DRenderer / CSS2DObject` を 1 ファイルにまとめたもの
- 読み込み: パネルを開いたときだけ（約 750KB）。畳んでいる間は読み込まない

作り直し方（版を上げるとき）:

```sh
npm pack three@<版> && tar xzf three-<版>.tgz && cd package
cat > entry.js <<'JS'
export * from "./build/three.module.js";
export { OrbitControls } from "./examples/jsm/controls/OrbitControls.js";
export { CSS2DRenderer, CSS2DObject } from "./examples/jsm/renderers/CSS2DRenderer.js";
JS
# examples の import 'three' を build へ向ける
sed -i "s#from 'three'#from './../../../build/three.module.js'#" examples/jsm/controls/OrbitControls.js examples/jsm/renderers/CSS2DRenderer.js
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=none --outfile=three-bundle.min.js
```
