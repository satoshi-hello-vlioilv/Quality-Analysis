/* =========================================================================
   計算の考え方（3D）: 表の計算を、仮の発生設備から下流へ「たどり直して」見せる
   - 数値はサーバの計算結果だけを使う（res.origins[仮の発生設備]・calculator._origins）。ここでは縮尺だけを決める。
   - 使うのは発見設備の汚れ位置 A だけ（ラップ長さ |B − A| は使わない）:
       ① A からさかのぼると、仮の発生設備では「内側から L m・肉厚 T mm」の所に混入していたはず
       ② その巻きの 1 周 = π ×（内径 + 2T）＝ C m だけ外側の巻きへ写る（2 か所目の汚れ）
       ③ 下流では巻き替えのたびに頭と尾が入れ替わり、前後のオフ・両エッジが落とされ、
          2 か所の間隔は「C × 発生時の板厚 ÷ その工程の板厚」に広がる
       ④ 発見設備でのラップ長さ（予測）＝表の転写距離。B があれば実測と比べる
   - 既定の仮の発生設備は、最も確からしい設備（一致率が最も高い・res.likely_origin_no）。
   - 操作は2つに分ける: 「仮の発生設備（計算の起点）」は左のメニュー、「視点（見る工程）」は上の行。
     視点を動かしても計算は変わらない。右の説明は既定で畳む（開閉は覚える・app.js）。
   - コイルの 1 周の矢印は仮の発生設備だけ。以降の設備は圧延・巻き替えで「1 周」の関係が崩れるので、
     汚れのある肉厚の位置に 1 点だけ描く。
   - ピッチ計算（表が「入力＋ピッチ計算」のとき）は転写とは別物: 発見ピッチが板厚の比で伸び縮みした
     各工程のピッチから、径（ピッチ ÷ π）の合うロールを絞り込む。板だけで描き、コイルは描かない（showPitch）。
   - 工程を上流（左）→ 下流（右）へ並べる。1 工程 = 奥にコイル、手前に同じコイルを展開した板（頭が左）。
     頭は先に巻かれて内側。A 側の端が頭か尾かは工程ごとに入れ替わるので、汚れの位置も板の上で左右に移る。
   - 縮尺: 板の長さ・厚さ・幅と径は全工程で共通（工程どうしで比べられる）。長さは短い工程が点にならないよう
     平方根で縮める（長いほど長い・順番は実寸どおり）、厚さも同じく縮める。幅も同じく縮め、細い条のコイルが
     円板（2 次元）にならず奥行きが読めるようにする（コイルの奥行き＝板の幅）。工程の中の位置は実寸の比。
     2 か所の間隔は発生時を一定の見かけに拡大し、下流はその何倍かを実寸の比で描く。
   - コイルの向き: 設備マスタの巻取方向（上／下）とライン方向（←／→）から回る向きを決め、外周の最後の 1 巻きを
     テール（参考のコイル 3D モデルの作り: 浮き・舌形の最後端・角 R・端面の丸み）として、胴と同じ透過率のガラスで描く。テールは巻取り後の
     姿: 板が入る所（上巻き＝コイルの上・下巻き＝下）から上流の側（板が来た側。ライン→なら左・←なら右）へ回り込み、
     最後端の先はコイルの中心の高さにある（上巻きは先が下・下巻きは先が上を向く）。
     巻取方向が「-」の設備はテールを描かない（drawTail）。
   ========================================================================= */
import * as THREE from "../vendor/three/three-bundle.min.js";
import { OrbitControls, CSS2DRenderer, CSS2DObject } from "../vendor/three/three-bundle.min.js";

const COLOR = {
  steel: 0x8fa6b6, spiral: 0x4d6577, strip: 0xd6dfe6, stripEdge: 0x6f8797,
  defect: 0xd62c1a, arrow: 0xc0392b, flow: 0x2f7d78,
  lengthOff: 0xf07f00, lengthOffEdge: 0x9a4d00,   // 丈のオフ（頭・尾）: 濃い橙
  edgeOff: 0x1f5fd1, edgeOffEdge: 0x0d3580,       // 両エッジのオフ: 濃い青
  // コイル・テールのガラス（胴の層・外周・端面・芯）と縁の線。テールも胴と同じ材質にする（テールだけ濃く見えない）
  glassLayer: 0x9fb6c8, glassOuter: 0xa9bfd0, glassFace: 0xb9cad6, core: 0x5d7688,
  rimOuter: 0xf4f8fb, rimInner: 0x9fb3c2,
  gridMajor: 0xd5dee5, gridMinor: 0xe6ecf0,      // 床の格子
};
/* 凡例（HTML）の見本の色を COLOR から（3D と凡例の色が1つの元から出る） */
const cssHex = (c) => "#" + c.toString(16).padStart(6, "0");
const cssRgba = (c, a) => `rgba(${c >> 16},${(c >> 8) & 255},${c & 255},${a})`;
/* 凡例のオフの見本: 3D と同じ混ぜ方（板の色にオフの色）・同じ透け方 */
const offSwatch = (color, look) => { const c = mixHex(COLOR.strip, color, look.mix); return cssRgba(c, look.opacity); };
function mixHex(a, b, t) {
  const ch = (x, s) => (x >> s) & 255, m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
const LAYOUT = {
  coilR: 1.1,        // 最大外径の見かけの半径
  depth: 1.2,        // 最大幅の見かけ（コイルの奥行き＝板の幅）
  stripLen: 12.0,    // いちばん長い工程の板の見かけの長さ（ほかはこの何倍かを平方根で縮めて描く）
  stripMin: 2.4,     // いちばん短く見せる長さ（オフや汚れの印が読める長さ）
  lenPow: 0.5,       // 長さの縮め方（実寸の比の 0.5 乗）
  thickMax: 0.2,     // いちばん厚い板の見かけの厚さ
  thickMin: 0.018,   // いちばん薄く見せる厚さ
  thickPow: 0.6,     // 厚さの縮め方
  widthPow: 0.5,     // 幅の縮め方（細い条のコイルが円板＝2 次元にならないよう、実寸の比の 0.5 乗）
  widthMin: 0.16,    // いちばん細く見せる幅（コイルの奥行き）
  rowGap: 0.55,      // 手前の板の列と、奥のコイルの列のすき間
  gap: 1.6,          // 工程と工程のすき間
  turns: 16,         // 渦巻きの見かけの巻き数（圧縮表示）
  minMark: 0.12,     // 丈のオフの見える最小の長さ（実寸は札）
  minEdge: 0.06,     // 両エッジのオフの見える最小の幅（実寸は札）
  pairBase: 0.4,     // 発生設備での 2 本線の間隔の見かけ（下流はこの何倍か）
};
/* テール（巻き終わり）の見かけ（drawTail）。参考モデルの既定（浮き範囲 90°・舌の出 14°・角 R 150 mm／幅 1100 mm）に倣う */
const TAIL = {
  liftDeg: 80,       // 最後端の手前で板が浮く範囲（巻きの角）
  liftK: 0.16,       // 最後端の浮き（外径の半径の何倍か）
  liftMax: 0.2,      // 浮きの上限（見かけ）
  arcDeg: 14,        // 舌形: 幅の中央が両エッジより先に出る角
  cornerK: 0.14,     // 角 R（幅の何倍か）
  tMin: 0.03,        // 最後の巻きの見かけの厚さの下限（薄い板でも厚みが読める）
};
/* オフの見え方（offStrip・凡例）: 板の色にオフの色を混ぜる割合・透け方・点線の濃さ。past は前工程までのオフ */
const OFF_LOOK = { now: { mix: 0.6, opacity: 0.62, line: 0.9 }, past: { mix: 0.35, opacity: 0.28, line: 0.45 } };
/* テールもコイルと同じガラス（外周・端面・帯と同じ透過率と色）。[透過率, 色] */
const GLASS = { outer: [0.32, COLOR.glassOuter], under: [0.12, COLOR.glassFace], cut: [0.2, COLOR.glassLayer] };
const TOUR_MS = 1700;
const FLOOR = 0;

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? "-"
  : Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const esc = window.TPA.esc;      // 共通の部品（static/js/shared.js）

let ui = null;          // { stage, text, steps, menu, onSelect }
let view = null;        // three.js 一式（初回に作る）
let data = null;        // { res, stations, origin, originNo, focusNo, tolerance }
let tourTimer = null;

/* ---------------------------------------------------------------- 公開 */
export function mount(opts) { ui = opts; }

/* 描く物が無い（汚れ位置 A が未入力・工程が無い）: 動きを止め、案内だけを出す */
function showEmpty(res) { pause(); data = null; renderControls(); renderEmpty(res); }

export function show(res, { selectedNo = null, tolerance = 5, mode = "transfer" } = {}) {
  if (mode === "pitch") { showPitch(res, tolerance); return; }
  const origins = res && res.origins ? res.origins : {};
  const keys = Object.keys(origins);
  if (!res || !res.soil_a_ready || !keys.length) { showEmpty(res); return; }
  const stations = res.processes.filter((p) => p.trace).sort((a, b) => a.no - b.no);   // 上流 → 下流
  // 利用者が押して選んだ設備だけを覚える（自動で選んだ設備は覚えない＝B が入れば最有力へ移る）
  const keep = (no) => (no != null && origins[String(no)] ? no : null);
  const originNo = keep(selectedNo) ?? res.likely_origin_no
    ?? Math.max(...keys.map(Number));                     // B が無いときは発見設備の1つ上流から
  data = { res, stations, originNo, origin: origins[String(originNo)], focusNo: originNo, tolerance };
  renderControls();
  selectOrigin(originNo, { instant: true });
}

/* 表の行を押したとき（ピッチ）: その工程を見る */
export function focusTo(no) {
  if (data && data.stations.some((p) => p.no === no)) focus(no);
}

export function pause() {
  if (tourTimer) { clearInterval(tourTimer); tourTimer = null; }
  const b = ui && ui.steps.querySelector(".v-play");
  if (b) b.textContent = "▶ 下流へ追う";
}

/* ---------------------------------------------------------------- 操作（2 つの行を分ける） */
/* 仮の発生設備の候補: 一致率の高い順（B が無ければ上流から）。最有力には印 */
function rankedOrigins() {
  const os = Object.values(data.res.origins);
  return data.res.soil_positions_ready
    ? os.slice().sort((a, b) => (b.agreement_percent ?? -1) - (a.agreement_percent ?? -1))
    : os.slice().sort((a, b) => a.no - b.no);
}
function renderControls() {
  if (!ui) return;
  if (!data) { ui.steps.innerHTML = ""; ui.menu.innerHTML = ""; ui.menu.className = "explain-menu"; return; }
  if (data.mode === "pitch") renderPitchMenu();
  else renderOriginMenu();
  const views = data.stations.map((p) => `<option value="${p.no}"${p.no === data.focusNo ? " selected" : ""}>${p.no} ${esc(p.equipment)}${data.mode !== "pitch" && p.no === data.originNo ? "（仮の発生）" : p.equipment_flag === 2 ? "（発見）" : ""}</option>`).join("");
  ui.steps.innerHTML = `
    <div class="ctl ctl-view" role="group" aria-label="視点（見る工程）">
      <span class="ctl-lead">視点<small>見る工程</small></span>
      <button type="button" class="v-btn" data-move="-1" title="1 つ上流の工程を見る">◀</button>
      <select class="v-select" title="カメラで見る工程（計算は変わりません）">${views}</select>
      <button type="button" class="v-btn" data-move="1" title="1 つ下流の工程を見る">▶</button>
      ${data.mode === "pitch" ? "" : '<button type="button" class="v-btn v-play" title="仮の発生設備から発見設備まで、カメラで順に追います">▶ 下流へ追う</button>'}
    </div>`;
  ui.steps.querySelector(".v-select").onchange = (e) => { pause(); focus(+e.target.value); };
  ui.steps.querySelectorAll("[data-move]").forEach((b) => { b.onclick = () => { pause(); move(+b.dataset.move); }; });
  const play = ui.steps.querySelector(".v-play");
  if (play) play.onclick = toggleTour;
}
/* 左のメニュー（転写）: 仮の発生設備＝計算の起点。一致率の高い順、最有力に印 */
function renderOriginMenu() {
  const likely = data.res.likely_origin_no, judged = data.res.soil_positions_ready;
  ui.menu.className = "explain-menu origin";
  ui.menu.innerHTML = `<div class="m-head">仮の発生設備<small>計算の起点（押すと切り替え）</small></div>`
    + rankedOrigins().map((o, i) => {
      const cls = ["m-item", o.match === true ? "match" : "", o.no === data.originNo ? "active" : ""].join(" ");
      const val = o.agreement_percent != null ? `${fmt(o.agreement_percent, 1)}%${o.match === true ? " ✓" : ""}` : "";
      return `<button type="button" class="${cls}" data-origin="${o.no}" title="${esc(o.equipment)} で混入したと仮定して、発見設備までたどり直します">
        <span class="m-rank">${judged ? i + 1 : o.no}</span><span class="m-name">${o.no} ${esc(o.equipment)}${o.no === likely ? "<small>最有力</small>" : ""}</span><span class="m-val">${val}</span></button>`;
    }).join("")
    + `<div class="m-note">${judged ? "一致率の高い順（✓ は誤差内）。表の行を押しても切り替わります。" : "汚れ位置 B を入れると一致率の高い順に並び、最有力を選びます。"}</div>`;
  ui.menu.querySelectorAll("[data-origin]").forEach((b) => { b.onclick = () => { pause(); selectOrigin(+b.dataset.origin, { picked: true }); }; });
}
function move(d) {
  const nos = data.stations.map((p) => p.no), i = nos.indexOf(data.focusNo);
  focus(nos[Math.min(nos.length - 1, Math.max(0, i + d))]);
}
function focus(no, instant) {
  data.focusNo = no;
  const sel = ui.steps.querySelector(".v-select");
  if (sel) sel.value = String(no);
  if (data.mode === "pitch") { renderPitchMenu(); renderPitchText(); }
  focusStation(no, instant);
}
/* 仮の発生設備 → 発見設備へ、カメラで 1 工程ずつ追う（視点だけが動く） */
function toggleTour() {
  if (tourTimer) { pause(); return; }
  const path = data.origin.steps.map((s) => s.no);
  let i = 0;
  focus(path[0]);
  tourTimer = setInterval(() => {
    i += 1;
    if (i >= path.length) { pause(); return; }
    focus(path[i]);
  }, TOUR_MS);
  ui.steps.querySelector(".v-play").textContent = "❚❚ 止める";
}
/* 仮の発生設備を変える＝計算の起点を変える（3D を組み直し、視点はその設備へ） */
function selectOrigin(no, { instant = false, picked = false } = {}) {
  data.originNo = no;
  data.origin = data.res.origins[String(no)];
  if (picked && ui.onSelect) ui.onSelect(no);
  renderControls();
  renderText();
  buildScene();
  focus(no, instant);
}

/* ---------------------------------------------------------------- 説明文 */
function renderEmpty(res) {
  if (!ui) return;
  if (ui.menu) { ui.menu.innerHTML = ""; ui.menu.className = "explain-menu"; }
  const msg = !res ? "ロットを検索すると、ここに計算の考え方を 3D で表示します。"
    : "汚れ位置 A を入れると、発見設備から上流へさかのぼって各設備での混入位置を求め、<br>仮の発生設備から発見設備までの汚れの広がりをここに表示します。";
  if (view) { disposeGroup(view.group); view.stations = new Map(); }
  ui.stage.querySelector(".x-empty")?.remove();
  ui.stage.insertAdjacentHTML("beforeend", `<div class="x-empty">${msg}</div>`);
  ui.text.innerHTML = `<h3>考え方</h3><ol>
    <li>使うのは発見設備の汚れ位置 A だけ。上流へさかのぼると、各設備で「内側から何 m・肉厚何 mm」の所に混入していたはずかが分かる。</li>
    <li>そこで混入したなら、その巻きの 1 周 ＝ π ×（内径 ＋ 2 × 肉厚）だけ離れた所へ汚れが写る。</li>
    <li>下流では巻き替えのたびに頭と尾が入れ替わり、前後のオフ・両エッジが落とされ、2 か所の間隔は板厚に反比例して広がる。</li>
    <li>発見設備で予測されるラップ長さが、実測 |B − A| と誤差内で一致する設備が発生設備の候補。</li></ol>`;
  requestRender();
}

function renderText() {
  const o = data.origin, res = data.res;
  const found = o.steps[o.steps.length - 1];
  const fp = res.processes.find((p) => p.no === found.no);
  const rows = o.steps.map((s) => {
    const off = [s.off_front_m > 0 ? `前${fmt(s.off_front_m, 1)}` : "", s.off_back_m > 0 ? `後${fmt(s.off_back_m, 1)}${s.off_back_source === "auto" ? "*" : ""}` : ""].filter(Boolean).join(" ") || "―";
    return `<tr class="${s.is_found ? "found" : s.is_origin ? "origin" : ""}"><td>${s.no} ${esc(s.equipment)}</td><td>${s.a_end}</td>`
      + `<td>${off}</td><td>${s.edge_trim_mm > 0 ? `各 ${fmt(s.edge_trim_mm, 1)}` : "―"}</td><td>${fmt(s.thickness, 3)}</td><td>${fmt(s.spacing_m, 3)}</td></tr>`;
  }).join("");
  const judged = res.soil_positions_ready;
  const verdict = judged
    ? `<div class="verdict ${o.match ? "ok" : ""}">発見設備でのラップ長さ（予測）${fmt(o.predicted_m, 3)} m ／ 実測 |B − A| ${fmt(o.actual_m, 3)} m ・一致率 ${fmt(o.agreement_percent, 2)} % → ${o.match ? `発生設備の候補（誤差 ±${fmt(data.tolerance, 1)} % 内）` : "候補外"}</div>`
    : `<div class="verdict">発見設備でのラップ長さ（予測）${fmt(o.predicted_m, 3)} m ・ 汚れ位置 B を入れると実測と比べます</div>`;
  const likely = res.likely_origin_no === o.no ? "（最有力）" : "";
  ui.text.innerHTML = `<h3>仮の発生設備: ${o.no} ${esc(o.equipment)}${likely}</h3>
    <div class="sub">発見設備 ${found.no} ${esc(found.equipment)} の汚れ位置 A だけから計算（ラップ長さ |B − A| は使いません）</div>
    <ol>
      <li>発見設備の汚れ位置 A ＝ <span class="v">${fmt(o.soil_a_m, 2)} m</span>（頭から）。上流へさかのぼると、${esc(o.equipment)} では
        内側（頭）から <span class="v">${fmt(o.inner_length_m, 1)} m</span>・肉厚 <span class="v">${fmt(o.inner_thickness_mm, 1)} mm</span> の所に混入していたはず。</li>
      <li>その巻きの 1 周 ＝ π ×（内径 ${fmt(o.inner_diameter_mm, 0)} ＋ 2 × ${fmt(o.inner_thickness_mm, 1)}）＝ <span class="v">${fmt(o.circumference_m, 3)} m</span>。
        1 周先の巻きへ写り、汚れは 2 か所になる。</li>
      <li>下流では巻き替えのたびに頭と尾が入れ替わり（A 側の端が頭⇄尾）、前後のオフと両エッジが落とされ、
        2 か所の間隔は ${fmt(o.circumference_m, 3)} × ${fmt(o.thickness, 3)} ÷ その工程の板厚 に広がる。
        <table class="x-spread"><thead><tr><th>工程</th><th>A側の端</th><th>オフ m</th><th>両エッジ mm</th><th>板厚 mm</th><th>間隔 m</th></tr></thead><tbody>${rows}</tbody></table>
        ${o.steps.some((s) => s.off_back_source === "auto" && s.off_back_m > 0) ? '<div class="f">* 後オフはエンドバックの自動値（前工程との重量差から）</div>' : ""}</li>
      <li>発見設備 ${esc(found.equipment)} では ${fmt(o.circumference_m, 3)} × ${fmt(o.thickness, 3)} ÷ ${fmt(fp ? fp.thickness : found.thickness, 3)} ＝
        ラップ長さ <span class="v">${fmt(o.predicted_m, 3)} m</span> になるはず（表の転写距離と同じ）。</li>
    </ol>${verdict}`;
}

/* ---------------------------------------------------------------- three.js: 土台 */
function ensureView() {
  if (view) return view;
  const stage = ui.stage;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  stage.appendChild(labels.domElement);
  // 凡例（色と形の意味を先に示す）。転写とピッチで中身を差し替える（setLegend）
  stage.insertAdjacentHTML("beforeend", `<div class="x-legend"></div>`);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 2.5; controls.maxDistance = 60;
  controls.screenSpacePanning = true;
  controls.addEventListener("change", requestRender);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c6d0, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-4, 9, 7);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xdfeefa, 0.9);   // 後ろからの縁の光（コイルの輪郭を立てる）
  rim.position.set(3, 4, -8);
  scene.add(rim);

  const group = new THREE.Group();
  scene.add(group);
  view = { renderer, labels, scene, camera, controls, group, frame: 0, anims: new Set(), stations: new Map() };

  const resize = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  };
  new ResizeObserver(resize).observe(stage);
  resize();
  return view;
}

const LEGEND = {
  transfer: `<span><i class="lg-line"></i><i class="lg-line"></i>汚れ（2 か所）</span><span><i class="lg-arrow">↻</i>仮の発生設備で 1 周して写る</span>
    <span><i class="lg-dot"></i>以降の設備: 汚れのある肉厚の位置</span>
    <span><i class="lg-sw lg-off" style="background:${offSwatch(COLOR.lengthOff, OFF_LOOK.now)};border-color:${cssHex(COLOR.lengthOffEdge)}"></i>その工程の丈のオフ（頭・尾）</span>
    <span><i class="lg-sw lg-off" style="background:${offSwatch(COLOR.edgeOff, OFF_LOOK.now)};border-color:${cssHex(COLOR.edgeOffEdge)}"></i>その工程の両エッジのオフ</span>
    <span><i class="lg-sw lg-off" style="background:${offSwatch(COLOR.lengthOff, OFF_LOOK.past)};border-color:${cssHex(COLOR.lengthOffEdge)}"></i>前工程までのオフ（その外側・淡く）</span>
    <span><i class="lg-flow">→</i>次の工程へ（巻き替えで頭⇄尾）</span><span><i class="lg-dash">┄</i>間隔の広がり</span>
    <span><i class="lg-sw" style="background:${cssRgba(COLOR.glassOuter, 0.35)};border:1px solid ${cssHex(COLOR.rimInner)}"></i>テール（最後端＝尾）: 巻取り後の姿。上巻き＝上・下巻き＝下から上流の側へ回り込み、先は中心の高さ</span>
    <span class="lg-note">板の長さ・厚さ・幅と径は全工程で同じ縮尺（長さ・厚さ・幅は平方根ほどに縮めて比べやすく）・工程の中の位置は実寸の比・2 本線の間隔は拡大（工程間の比は実寸）・巻き数は圧縮</span>`,
  pitch: `<span><i class="lg-line"></i><i class="lg-line"></i><i class="lg-line"></i>ロールの跡（ピッチごと）</span>
    <span><i class="lg-sw lg-divider"></i>板の左半分＝入側（前の工程の出側ピッチ）・右半分＝出側（その工程のピッチ）</span>
    <span><i class="lg-flow">→</i>次の工程へ（板厚の比でピッチが伸びる）</span>
    <span class="lg-note">板の長さ・厚さ・幅は全工程で同じ縮尺（長さ・厚さ・幅は平方根ほどに縮めて比べやすく）・跡の間隔は発見設備を基準にした実寸の比</span>`,
};
function setLegend(mode) {
  const el = view && ui.stage.querySelector(".x-legend");
  if (el && el.dataset.mode !== mode) { el.dataset.mode = mode; el.innerHTML = LEGEND[mode]; }
}

function requestRender() {
  if (!view || view.frame) return;
  view.frame = requestAnimationFrame(() => {
    view.frame = 0;
    const damping = view.controls.update();
    view.anims.forEach((f) => { if (f() === false) view.anims.delete(f); });
    view.renderer.render(view.scene, view.camera);
    view.labels.render(view.scene, view.camera);
    if (damping || view.anims.size) requestRender();
  });
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    if (o.isCSS2DObject) o.element.remove();
  });
  g.clear();
}

/* ---------------------------------------------------------------- three.js: 部品 */
const mat = (color, opacity = 1, extra = {}) => new THREE.MeshStandardMaterial({
  color, transparent: opacity < 1, opacity, roughness: 0.55, metalness: 0.2,
  depthWrite: opacity >= 1, side: THREE.DoubleSide, ...extra,
});
function label(text, cls, pos, parent) {
  const el = document.createElement("div");
  el.className = "x-label " + (cls || "");
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.copy(pos);
  parent.add(o);
  return o;
}
function box(parent, lx, ly, lz, color, opacity, x, y, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(lx, ly, lz), mat(color, opacity));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function line(parent, points, color, opacity = 1) {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  parent.add(l);
  return l;
}
/* 曲線に沿った矢印（管＋先端の円すい） */
function arrowAlong(parent, points, color, radius = 0.018) {
  const curve = new THREE.CatmullRomCurve3(points);
  parent.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 2), radius, 8, false), mat(color, 1, { emissive: color, emissiveIntensity: 0.25 })));
  const tip = curve.getPoint(1), tan = curve.getTangent(1).normalize();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(radius * 3.2, radius * 9, 16), mat(color, 1, { emissive: color, emissiveIntensity: 0.25 }));
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
  cone.position.copy(tip).addScaledVector(tan, radius * 3);
  parent.add(cone);
}
/* 円弧の点列（中心・半径・面）。plane: "xy" は奥行き一定 */
function arcPoints(center, r, a0, sweep, n = 64) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + sweep * i / n;
    return new THREE.Vector3(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r, center.z);
  });
}
function dot(parent, pos, r = 0.055) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat(COLOR.defect, 1, { emissive: COLOR.defect, emissiveIntensity: 0.5 }));
  m.position.copy(pos);
  parent.add(m);
  return m;
}

/* ---------------------------------------------------------------- three.js: 工程の流れ */
/* 板の長さ・厚さの見かけ（全工程で共通の縮尺）。転写とピッチの両方の場面で同じ物差しを使う。 */
function stripScale(flow) {
  const maxLen = Math.max(...flow.map((p) => Math.max(+p.after_length_m || 0, 1)));
  const maxT = Math.max(...flow.map((p) => Math.max(+p.thickness || 0, 0.001)));
  const hs = (p) => Math.max(1, +p.horizontal_split || 1);
  const prev = (p) => flow.find((x) => x.no === p.no - 1);
  const maxW = Math.max(1, ...flow.map((p) => Math.max(+p.width * hs(p) || 0, +prev(p)?.width || 0)));
  const widOf = (mm) => Math.max(LAYOUT.widthMin, LAYOUT.depth * Math.pow(Math.max(+mm || 0, 0.1) / maxW, LAYOUT.widthPow));
  return {
    widOf,     // 幅（mm）→ 見かけの幅＝コイルの奥行き。細い条も奥行きが読めるように累乗で縮める（順番は実寸どおり）
    lenOf: (p) => Math.max(LAYOUT.stripMin, LAYOUT.stripLen * Math.pow(Math.max(+p.after_length_m || 0, 1) / maxLen, LAYOUT.lenPow)),
    thOf: (p) => Math.max(LAYOUT.thickMin, LAYOUT.thickMax * Math.pow(Math.max(+p.thickness || 0, 0.001) / maxT, LAYOUT.thickPow)),
  };
}
/* 場面を描き始める（前の描画を片付け、凡例を合わせる）。WebGL が使えなければ案内を出して null */
function beginScene(mode) {
  let v;
  try { v = ensureView(); } catch (e) {
    ui.stage.innerHTML = `<div class="x-empty">この PC では 3D を表示できません（WebGL が使えません）。右の説明をご覧ください。</div>`;
    return null;
  }
  ui.stage.querySelector(".x-empty")?.remove();
  disposeGroup(v.group);
  v.stations = new Map();
  setLegend(mode);
  return v;
}
/* 描き終える: 床の格子（z は奥行きの中ほど）と、工程ごとの置き場（カメラが寄る先）。flat は板だけの場面 */
function finishScene(v, placed, cursor, { gridZ, coilZ, flat }) {
  const span = cursor + 4;
  const grid = new THREE.GridHelper(Math.ceil(span / 2) * 2, Math.ceil(span / 2) * 2, COLOR.gridMajor, COLOR.gridMinor);
  grid.position.set(cursor / 2 - 1, FLOOR - 0.002, gridZ);
  v.group.add(grid);
  placed.forEach((st) => v.stations.set(st.p.no, st));
  v.coilZ = coilZ;
  v.flat = flat;
}
/* 展開した板の本体と輪郭（中心 cx・sy） */
function stripBody(parent, len, th, W, cx, sy, opacity) {
  box(parent, len, th, W, COLOR.strip, opacity, cx, sy);
  outlineBox(parent, len, th, W, cx, sy, 0, COLOR.stripEdge);
}
function buildScene() {
  const v = beginScene("transfer");
  if (!v) return;
  const origin = data.origin;
  const stepOf = new Map(origin.steps.map((s) => [s.no, s]));    // 仮の発生設備から下流の再現（サーバの値）
  const flow = data.stations;                                    // 上流 → 下流（発生前の工程も並べる）

  // 幅・径は全工程で共通の縮尺。長さは工程ごと（下の kl）
  const hsOf = (p) => Math.max(1, +p.horizontal_split || 1);
  const prevOf = (p) => data.res.processes.find((x) => x.no === p.no - 1) || null;
  const outerR = (p) => { const r = p.inner_diameter_mm / 2; return Math.sqrt(r * r + Math.max(0, p.after_length_m) * p.thickness * 1000 / Math.PI); };
  const maxR = Math.max(...flow.map(outerR));
  const kr = LAYOUT.coilR / maxR;
  // 長さ・厚さ・幅も全工程で共通の縮尺（工程どうしで比べられる）。短い・薄い・細い工程が消えないよう累乗で縮める
  const { lenOf, thOf, widOf } = stripScale(flow);
  const cz = -(LAYOUT.depth + LAYOUT.rowGap);      // コイルの列（奥）。板の列は z = 0（手前）

  let cursor = 0;
  const placed = [];
  flow.forEach((p) => {
    const st = new THREE.Group(), detail = new THREE.Group();
    v.group.add(st); st.add(detail);
    const s = stepOf.get(p.no) || null;              // null = 仮の発生設備より上流（発生前）
    const before = !s, prev = prevOf(p), hs = hsOf(p);
    const isFound = p.equipment_flag === 2, isOrigin = p.no === origin.no;

    // ---- 手前: 展開した板（頭 → 尾 を左 → 右）。オフは頭側に前オフ・尾側に後オフ。その外に前工程までのオフ（淡く）
    const offH = p.total_off_front_m || 0, offT = p.total_off_back_m || 0;
    const len = lenOf(p);
    const kl = len / Math.max(p.after_length_m, 1);              // 工程の中の位置は実寸の比
    const lenOff = (m) => (m > 0 ? Math.max(m * kl, LAYOUT.minMark) : 0);
    const past = earlierOffs(p, data.res.processes);
    const pastLen = (g) => Math.max(g.frac * len, LAYOUT.minMark);     // その工程の全長に対する割合
    const pastH = past.head.reduce((a, g) => a + pastLen(g), 0), pastT = past.tail.reduce((a, g) => a + pastLen(g), 0);
    const sx = cursor + pastH + lenOff(offH);
    const W = widOf(p.width);
    const th = thOf(p), sy = FLOOR + th / 2;
    stripBody(st, len, th, W, sx + len / 2, sy, before ? 0.5 : 1);
    const slitW = hs > 1 ? widOf(p.width * hs) : W;
    if (hs > 1) box(st, len, th * 0.5, slitW, COLOR.strip, 0.35, sx + len / 2, sy - th * 0.3);
    const half = Math.max(slitW, W) / 2;
    // この工程のオフ（板と同じ厚さ・淡い色・点線）
    if (offH > 0) offStrip(st, lenOff(offH), th, half * 2, sx - lenOff(offH) / 2, sy, 0, COLOR.lengthOff, COLOR.lengthOffEdge);
    if (offT > 0) offStrip(st, lenOff(offT), th, half * 2, sx + len + lenOff(offT) / 2, sy, 0, COLOR.lengthOff, COLOR.lengthOffEdge);
    const edgeMm = s ? s.edge_trim_mm : (prev ? Math.max(0, (prev.width - p.width * hs) / 2) : 0);
    let zOut = half;                                                   // いちばん外の両エッジのオフの外側
    if (edgeMm > 0) {
      // 見かけのエッジのオフ＝（入ってきた幅の見かけ − 残った幅の見かけ）÷ 2（幅と同じ縮尺）
      const e = Math.max((widOf(p.width * hs + 2 * edgeMm) - slitW) / 2, LAYOUT.minEdge), full = len + lenOff(offH) + lenOff(offT);
      [-1, 1].forEach((k) => offStrip(st, full, th, e, sx - lenOff(offH) + full / 2, sy, k * (half + e / 2), COLOR.edgeOff, COLOR.edgeOffEdge));
      zOut += e;
    }
    // 前工程までのオフ（さらに外側・さらに淡く）: 丈は頭側・尾側の先へ新しい工程から順に、幅はその工程の板の幅で
    let xh = sx - lenOff(offH), xt = sx + len + lenOff(offT);
    past.head.forEach((g) => { const l = pastLen(g); offStrip(st, l, th, widOf(g.k.width * Math.max(1, +g.k.horizontal_split || 1)), xh - l / 2, sy, 0, COLOR.lengthOff, COLOR.lengthOffEdge, true); xh -= l; });
    past.tail.forEach((g) => { const l = pastLen(g); offStrip(st, l, th, widOf(g.k.width * Math.max(1, +g.k.horizontal_split || 1)), xt + l / 2, sy, 0, COLOR.lengthOff, COLOR.lengthOffEdge, true); xt += l; });
    past.edge.forEach((g) => {
      const e = Math.max((widOf(g.w + 2 * g.mm) - widOf(g.w)) / 2, LAYOUT.minEdge), full = xt - xh;
      [-1, 1].forEach((k) => offStrip(st, full, th, e, xh + full / 2, sy, k * (zOut + e / 2), COLOR.edgeOff, COLOR.edgeOffEdge, true));
      zOut += e;
    });

    // 汚れ 2 か所: 位置は「頭から」（A 側の端が頭か尾かは工程ごとに入れ替わる＝板の上で左右に移る）
    let pairMid = null;
    if (s) {
      const clampX = (m) => sx + Math.min(Math.max(m, 0), p.after_length_m) * kl;
      const x1 = clampX(s.marks[0].from_head_m);
      const sign = Math.sign(s.marks[1].from_head_m - s.marks[0].from_head_m) || 1;
      let gapX = Math.min(LAYOUT.pairBase * s.ratio_to_origin, len * 0.45);
      let x2 = x1 + sign * gapX;
      if (x2 < sx || x2 > sx + len) x2 = x1 - sign * gapX;       // 板の外に出るなら反対側へ（見かけだけ）
      [x1, x2].forEach((x) => defectLine(st, x, sy + th * 0.9, half * 2 + 0.12));
      const yb = FLOOR + 0.2;
      dimension(st, Math.min(x1, x2), Math.max(x1, x2), yb, isOrigin ? COLOR.arrow : COLOR.defect);
      pairMid = new THREE.Vector3((x1 + x2) / 2, yb, 0);
      label(isOrigin ? `発生: 1 周 ${fmt(s.spacing_m, 3)} m` : isFound ? `ラップ長さ（予測）${fmt(s.spacing_m, 3)} m` : `間隔 ${fmt(s.spacing_m, 3)} m（×${fmt(s.ratio_to_origin, 2)}）`,
        "red pair", new THREE.Vector3((x1 + x2) / 2, yb + 0.28, 0), st);
      label(`A 側＝${s.a_end}・頭から ${fmt(s.marks[0].from_head_m, 1)} m`, "muted", new THREE.Vector3(x1, FLOOR + 0.02, half + 0.55), detail);
    } else {
      label(`発生前`, "muted", new THREE.Vector3(sx + len / 2, FLOOR + 0.15, 0), st);
    }

    // ---- 奥: コイル（アイ・トゥ・ウォール）。頭が内側。汚れは肉厚の位置（内径からの厚み）に置く
    const rIn = p.inner_diameter_mm / 2 * kr;
    const rOut = Math.max(outerR(p) * kr, rIn + 0.04);
    const D = W;                                         // コイルの奥行き＝板の幅（同じ縮尺）
    const cx = sx + len / 2, cy = FLOOR + rOut;
    const wind = windingOf(p);
    const { zf, tail } = drawCoil(st, { cx, cy, cz, rIn, rOut, D, dim: before, wind, th });
    const coilTop = tail ? Math.max(tail.topY, cy + rOut) : cy + rOut;     // 上巻きの浮いたテールと札を重ねない
    if (s) {
      const rAt = (mm) => Math.min(rIn + Math.max(mm, 0) * kr, rOut);
      const r1 = rAt(s.marks[0].wall_mm);
      const up = Math.PI / 2;
      glowDot(st, new THREE.Vector3(cx, cy + r1, cz), isOrigin ? 0.06 : 0.05);    // 汚れのある肉厚の位置
      if (isOrigin) {
        // 仮の発生設備だけ: 汚れのある巻きと、そこから 1 周して 1 巻き外側へ写る矢印・写った先
        const r2 = Math.max(rAt(s.marks[1].wall_mm), r1 + 0.05);
        const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(arcPoints(new THREE.Vector3(cx, cy, cz), r1, 0, Math.PI * 2, 96).slice(0, 96)),
          new THREE.LineBasicMaterial({ color: COLOR.defect, transparent: true, opacity: 0.35 }));
        st.add(ring);
        glowDot(st, new THREE.Vector3(cx, cy + r2, cz), 0.045);
        arrowAlong(st, arcPoints(new THREE.Vector3(cx, cy, cz), (r1 + r2) / 2, up - 0.1, -(Math.PI * 2 - 0.3), 80), COLOR.arrow, 0.018);
        label(`肉厚 ${fmt(s.marks[0].wall_mm, 1)} mm で混入 → 1 周 ${fmt(s.spacing_m, 3)} m で写る`, "red",
          new THREE.Vector3(cx - rOut - 1.25, cy + rOut * 0.35, zf), st);
      } else {
        // 以降の設備: 圧延・巻き替えで「1 周」の関係は崩れる。汚れのある肉厚の位置に 1 点だけ
        label(`汚れの肉厚 ${fmt(s.marks[0].wall_mm, 1)} mm`, "muted", new THREE.Vector3(cx - rOut - 0.8, cy + rOut * 0.35, zf), detail);
      }
    }
    arrowAlong(detail, [new THREE.Vector3(cx + rOut * 0.6, FLOOR + 0.04, zf), new THREE.Vector3(cx + rOut * 0.9, FLOOR + 0.12, (zf - half) / 2),
      new THREE.Vector3(cx + rOut * 1.1, FLOOR + 0.05, -half - 0.05)], COLOR.spiral, 0.01);
    label(`展開`, "muted", new THREE.Vector3(cx + rOut * 1.25, FLOOR + 0.1, (zf - half) / 2), detail);

    // ---- 札
    const role = isOrigin ? "（仮の発生）" : isFound ? "（発見）" : "";
    const title = label(`${p.no} ${p.equipment}${role}`, "title" + (isOrigin ? " origin" : isFound ? " found" : before ? " before" : ""),
      new THREE.Vector3(cx, coilTop + 0.28, cz), st);
    label(`内径 ${fmt(p.inner_diameter_mm, 0)}／外径 ${fmt(outerR(p) * 2, 0)} mm・内側が頭`, "muted",
      new THREE.Vector3(cx - (wind ? wind.side : 1) * (rOut + 1.3), cy - rOut * 0.55, cz), detail);   // テールと反対の横（下流）
    if (wind) {
      // 札はテールの最後端（上流の側の中心の高さ）の外。先端には「尾」、その外に向きの説明
      const tip = tail.tip;
      label("尾", "muted tip", new THREE.Vector3(tip.x + wind.side * 0.14, tip.y + wind.tipUp * 0.12, cz + D / 2), st);
      label(`テール: ${wind.top ? "上" : "下"}巻き・${wind.top ? "上" : "下"}から${wind.side > 0 ? "右" : "左"}（上流）へ・先は${wind.tipUp > 0 ? "上" : "下"}向き`, "muted",
        new THREE.Vector3(tip.x + wind.side * 1.1, cy - rOut - 0.1, cz), detail);   // コイルの下の高さ（汚れの肉厚の札は中心より上）
    } else {
      label(`巻取方向の登録なし（テールは描きません）`, "muted", new THREE.Vector3(cx, FLOOR + 0.05, cz - D / 2 - 0.3), detail);
    }
    const zNear = zOut + 0.3;
    label(`頭`, "muted", new THREE.Vector3(sx, FLOOR, zNear), detail);
    label(`尾`, "muted", new THREE.Vector3(sx + len, FLOOR, zNear), detail);
    label(`全長 ${fmt(p.after_length_m, 0)} m ・ 板厚 ${fmt(p.thickness, 3)} mm ・ 幅 ${fmt(p.width, p.width < 100 ? 2 : 1)} mm${hs > 1 ? ` × ${hs} 条` : ""}`, "",
      new THREE.Vector3(sx + len * 0.33, FLOOR, zNear + 0.3), detail);
    if (edgeMm > 0) label(`両エッジのオフ 各 ${fmt(edgeMm, 1)} mm`, "edge", new THREE.Vector3(sx + len * 0.78, FLOOR, zNear + 0.3), detail);
    if (offH > 0) label(`前オフ ${fmt(offH, 1)} m`, "off", new THREE.Vector3(sx - lenOff(offH) / 2, FLOOR + 0.35, 0), detail);
    if (offT > 0) label(`後オフ ${fmt(offT, 1)} m${p.off_back_source === "auto" ? "（エンドバック・自動）" : ""}`, "off",
      new THREE.Vector3(sx + len + lenOff(offT) / 2, FLOOR + 0.35, 0), detail);
    const pastLenText = (g) => `${g.k.no} ${g.k.equipment} ${g.what} ${fmt(g.m, 1)} m`;
    if (past.head.length) label(pastOffText("頭側", past.head, pastLenText), "off past", new THREE.Vector3((xh + sx - lenOff(offH)) / 2, FLOOR + 0.8, 0), detail);
    if (past.tail.length) label(pastOffText("尾側", past.tail, pastLenText), "off past", new THREE.Vector3((sx + len + lenOff(offT) + xt) / 2, FLOOR + 0.8, 0), detail);
    if (past.edge.length) label(pastOffText("両エッジ", past.edge, (g) => `${g.k.no} ${g.k.equipment} 各 ${fmt(g.mm, 1)} mm`), "edge past",
      new THREE.Vector3(sx + len * 0.78, FLOOR, zNear + 0.6), detail);

    const xEnd = xt;
    placed.push({ p, s, st, detail, title, x0: cursor, x1: xEnd, cx, cy, rOut, pairMid });
    cursor = xEnd + LAYOUT.gap;
  });

  // ---- 工程から次の工程へ: 巻き替え（頭⇄尾）と板厚・丈の倍率。汚れの広がりは破線
  placed.forEach((a, i) => {
    const b = placed[i + 1];
    if (!b) return;
    const c45 = Math.SQRT1_2;                        // 中心の高さのテール（上流の側）を避け、斜め上（45°）から出入りする
    const from = new THREE.Vector3(a.cx + (a.rOut + 0.12) * c45, a.cy + (a.rOut + 0.12) * c45, cz);
    const to = new THREE.Vector3(b.cx - (b.rOut + 0.12) * c45, b.cy + (b.rOut + 0.12) * c45, cz);
    const mid = from.clone().lerp(to, 0.5).setY(Math.max(from.y, to.y) + 0.3);
    arrowAlong(v.group, [from, mid, to], COLOR.flow, 0.02);
    const r = b.p.thickness ? a.p.thickness / b.p.thickness : 1;
    const rewind = (b.p.equipment || "").trim().startsWith("AN") ? "巻き替えなし" : "巻き替え: 頭⇄尾";
    label(`${rewind}・板厚 ${fmt(a.p.thickness, 3)}→${fmt(b.p.thickness, 3)} mm・丈 ×${fmt(r, 2)}`, "flow", mid.clone().setY(mid.y + 0.25), v.group);
    if (a.pairMid && b.pairMid) {
      const c = new THREE.QuadraticBezierCurve3(a.pairMid, a.pairMid.clone().lerp(b.pairMid, 0.5).setY(0.9), b.pairMid);
      const dash = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(60)),
        new THREE.LineDashedMaterial({ color: COLOR.defect, dashSize: 0.1, gapSize: 0.08, transparent: true, opacity: 0.7 }));
      dash.computeLineDistances();
      v.group.add(dash);
    }
  });

  finishScene(v, placed, cursor, { gridZ: cz / 2, coilZ: cz, flat: false });
}

/* コイル（アイ・トゥ・ウォール）: 透明な巻きを何層か重ね、中の汚れが透けて見えるように描く。
   外周・内周の縁は明るい線で締め、床に接地の影を落とす。戻り値は手前の面の z */
/* 巻き取りの向き（設備マスタの巻取方向・ライン方向）。
   上巻き: 板は上から入る／下巻き: 下から入る。ライン→: 板は左から右へ流れる。
   回る向き: 上巻き＋→ と 下巻き＋← は時計回り（手前から見て）、ほかは反時計回り。
   渦巻きは頭（内）→ 尾（外）へ、回る向きと逆に進む。
   テールは巻取り後の姿: 板の入る所（上巻き＝上・下巻き＝下）から、巻きが外へ進む向きに 90° 回り込んだ所が最後端で、
   そこは上流の側（板が来た側）の中心の高さ（endAngle）。先は上巻きなら下・下巻きなら上を向く。
   例: 下巻き＋←（右から左）なら、テールは下から右へ回り込み、先は右の中心の高さで上を向く（4 通りとも同じ決まり）。
   side: 最後端のある側＝上流（右 +1／左 −1）。tipUp: 先の上下（上 +1／下 −1）。
   downAngle: 下流の横（回る向きの矢印を置く・テールと重ならない）。登録が無ければ null。 */
export function windingOf(p) {
  const rw = String(p.rewind_master || "").trim(), ld = String(p.line_direction || "").trim();
  if (!["上", "下"].includes(rw) || !["←", "→"].includes(ld)) return null;
  const top = rw === "上", lineRight = ld === "→";
  const clockwise = top === lineRight;
  const dir = clockwise ? 1 : -1, entry = top ? Math.PI / 2 : -Math.PI / 2;   // 板の入る所（上／下）
  return { top, lineRight, clockwise, dir, endAngle: entry + dir * Math.PI / 2,
    side: lineRight ? -1 : 1, tipUp: top ? -1 : 1, downAngle: lineRight ? 0 : Math.PI };
}
function drawCoil(parent, { cx, cy, cz, rIn, rOut, D, dim, wind, th = 0.026 }) {
  const k = dim ? 0.55 : 1;                     // 発生前は淡く
  const glass = (opacity, color = COLOR.steel) => new THREE.MeshPhysicalMaterial({
    color, metalness: 0.15, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08,
    transparent: true, opacity: opacity * k, depthWrite: false, side: THREE.DoubleSide,
  });
  const shell = (r, m, order) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, D, 96, 1, true), m);
    c.rotation.x = Math.PI / 2;
    c.position.set(cx, cy, cz);
    c.renderOrder = order;
    parent.add(c);
  };
  // 巻きの層（内側ほど淡く）・外周・内周（芯）。巻取方向が分かれば、外周の最後の 1 巻きはテールとして描く（drawTail）
  const t = Math.min(Math.max(th, TAIL.tMin), (rOut - rIn) / 5);
  const rBody = wind ? rOut - 2 * t : rOut;
  const layers = 6;
  for (let i = 1; i < layers; i++) shell(rIn + (rBody - rIn) * i / layers, glass(0.06 + 0.02 * i, COLOR.glassLayer), 1);
  if (!wind) shell(rOut, glass(...GLASS.outer), 2);
  shell(rIn, glass(0.4, COLOR.core), 2);
  // 手前・奥の面（ドーナツ形のガラス）
  if (!wind) [1, -1].forEach((s) => {
    const face = new THREE.Mesh(new THREE.RingGeometry(rIn, rOut, 96), glass(s > 0 ? 0.12 : 0.08, COLOR.glassFace));
    face.position.set(cx, cy, cz + s * D / 2);
    face.renderOrder = 3;
    parent.add(face);
  });
  const tail = wind ? drawTail(parent, { cx, cy, cz, rIn, rOut, D, wind, t, glass, k }) : null;
  // 縁の線（明るい金属の縁）。テールがあるときの外周の縁はテールの側で描く
  (wind ? [[rIn, COLOR.rimInner, 0.8]] : [[rOut, COLOR.rimOuter, 0.95], [rIn, COLOR.rimInner, 0.8]]).forEach(([r, color, op]) => {
    [1, -1].forEach((s) => {
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(arcPoints(new THREE.Vector3(cx, cy, cz + s * D / 2), r, 0, Math.PI * 2, 120).slice(0, 120)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: op * k }));
      parent.add(loop);
    });
  });
  // 巻いた長い板の渦巻き（手前の面、巻き数は圧縮）
  // 頭（内）→ 尾（外）。巻き取りの向きが分かれば、回る向きと逆に進み、最後端が板の入る所（上／下）で終わる
  const zf = cz + D / 2 + 0.004;
  const sp = [], N = LAYOUT.turns * 48;
  const endA = wind ? wind.endAngle : 0, dir = wind ? wind.dir : 1;
  const rSp = wind ? rBody : rOut;         // 渦巻きの線は胴まで（最後の 1 巻きはテールの面そのもの）
  for (let i = 0; i <= N; i++) {
    const a = endA + dir * (i - N) / 48 * Math.PI * 2, r = rIn + (rSp - rIn) * i / N;
    sp.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, zf));
  }
  line(parent, sp, COLOR.spiral, 0.55 * k);
  if (wind) {
    // 回る向き（巻き取るときの回転）を外周の少し外に弧の矢印で。テール（上か下）と重ならない下流の横に置く
    const rr = rOut + 0.1, a0 = wind.downAngle + wind.dir * 0.45;
    arrowAlong(parent, arcPoints(new THREE.Vector3(cx, cy, zf), rr, a0, -wind.dir * 0.9, 24), COLOR.flow, 0.012);
  }
  // 接地の影
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(rOut * 1.5, D + 0.18), new THREE.MeshBasicMaterial({ color: 0x1b2733, transparent: true, opacity: 0.1 * k, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(cx, FLOOR + 0.001, cz);
  parent.add(shadow);
  return { zf, tail };
}

/* テール（巻き終わり）: 外周の最後の 1 巻きを厚みのある板として描く。
   参考のアルミニウムコイル 3D モデルの作り（最後の巻き・浮き・舌形の最後端・角 R・端面の丸み）を、
   この場面の座標（コイルの軸 = z、断面 = x-y）と透明なコイルへ移したもの。
   - 巻きの角 θ（0〜2π。2π が最後端）→ 画面の角 a = endAngle + dir·(θ − 2π)。
     最後端は上流の側の中心の高さ（endAngle＝右 0／左 π）に来て、dir（回る向き）で先が上／下を向く（windingOf）。
   - 最後端の手前 liftDeg の範囲で板が浮く（外へ 2 次曲線で）。最後端は幅の中央が先に出た舌形で、両隅は角 R。
   - 浮いた板が床にもぐる所は床に沿わせる（外の面を床に置き、厚みは保つ）。
   - テールも胴と同じガラス（外周・端面・帯と同じ透過率と色。テールだけ濃くしない）。
   戻り値: 最後端の先（札の位置）と、テールのいちばん上の高さ */
function drawTail(parent, { cx, cy, cz, rIn, rOut, D, wind, t, glass, k }) {
  const TAU = Math.PI * 2;
  const Rc = rOut - 2 * t;                                  // 最後の巻きの下の面（θ = 0）
  const phi = TAIL.liftDeg * Math.PI / 180, L = Math.min(TAIL.liftMax, rOut * TAIL.liftK);
  const rb = (a) => Rc + t * a / TAU;                       // 最後の巻きの下の面
  const lift = (a) => (a > TAU - phi ? L * ((a - (TAU - phi)) / phi) ** 2 : 0);
  const ain = (a) => rb(a) + lift(a), aout = (a) => ain(a) + t;
  const ang = (a) => wind.endAngle + wind.dir * (a - TAU);
  // s: 厚みの中の位置（0 = 内の面・1 = 外の面）。s があれば床より下へは行かせない
  const P3 = (r, a, x, s = null) => {
    const w = ang(a);
    let y = cy + Math.sin(w) * r;
    if (s !== null) y = Math.max(y, FLOOR + 0.002 + (1 - s) * t);
    return [cx + Math.cos(w) * r, y, cz + x];
  };
  // 舌形の最後端: 幅の中央が 2π、両エッジは tailArc だけ手前。隅は角 R（半径 rc）で丸める
  const Rref = rOut + L, rc = Math.min(D * TAIL.cornerK, D / 2), arc = TAIL.arcDeg * Math.PI / 180;
  const XV = (v) => 0.5 - 0.5 * Math.cos(Math.PI * v);     // 両エッジほど細かく刻む
  const XW = (v) => (XV(v) - 0.5) * D;
  const tailTheta = (v) => {
    const q = XV(v), d = Math.min(q, 1 - q) * D;
    let a = TAU - arc * (2 * q - 1) ** 2;
    if (rc > 0 && d < rc) a -= (rc - Math.sqrt(Math.max(0, rc * rc - (rc - d) ** 2))) / Rref;
    return a;
  };
  const aEdge = tailTheta(0), a1 = TAU - phi;
  const NT = 144, NX = 24, NL = Math.max(24, Math.round(NT * phi / TAU));
  const add = (geo, m, order, name) => { const o = new THREE.Mesh(geo, m); o.renderOrder = order; o.name = name || ""; parent.add(o); return o; };

  // 最後の巻きの外の面: 胴に巻き付いた所から浮いた所・最後端まで 1 枚で（外周と同じガラス）
  add(surfaceGrid(NT, NX, (u, v) => { const a = u * tailTheta(v); return P3(aout(a), a, XW(v), 1); }), glass(...GLASS.outer), 2, "tailOuter");
  // 浮いた所: 最後の巻きの裏（端面と同じ薄さ）と、その下に見える 1 つ内の巻きの面
  if (L > 0) {
    add(surfaceGrid(NL, NX, (u, v) => { const a = a1 + u * Math.max(0, tailTheta(v) - a1); return P3(ain(a), a, XW(v), 0); }), glass(...GLASS.under), 2, "tailUnder");
    add(surfaceGrid(NL, NX, (u, v) => { const a = a1 + u * phi; return P3(rb(a), a, (v - 0.5) * D); }), glass(0.26, COLOR.glassOuter), 2);
  }
  // 最後端の切り口: 厚みの向きに丸め、隅の R に沿って丸みを消す
  const NB = 10, eR = t / 2, h = 1e-3;
  add(surfaceGrid(NB, NX, (u, v) => {
    const a = tailTheta(v), b = u * Math.PI, rmid = ain(a) + t / 2;
    const ds = (tailTheta(Math.min(1, v + h)) - tailTheta(Math.max(0, v - h))) * Rref, dx = XW(Math.min(1, v + h)) - XW(Math.max(0, v - h));
    const ns = Math.abs(dx) / (Math.hypot(ds, dx) || 1);
    const s = (1 - Math.cos(b)) / 2;
    return P3(rmid - (t / 2) * Math.cos(b), a + eR * Math.sin(b) * ns / rmid, XW(v), s);
  }), glass(...GLASS.cut), 3, "tailCut");
  // 両側の端面: 胴（内径 → 最後の巻きの下）と、最後の巻きの帯
  [D / 2, -D / 2].forEach((x, i) => {
    add(surfaceGrid(NT, 1, (u, v) => { const a = u * TAU; return P3(rIn + v * (rb(a) - rIn), a, x); }), glass(i ? 0.08 : 0.12, COLOR.glassFace), 3);
    add(surfaceGrid(NT, 1, (u, v) => { const a = u * aEdge; return P3(ain(a) + v * t, a, x, v); }), glass(i ? 0.14 : 0.2, COLOR.glassLayer), 3);
  });
  // 輪郭の線: 最後端の舌形と、最後の巻きの外の縁（両側）。透明でも形が読めるように
  const opq = (color, op) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: op * k });
  const pts = (n, f) => Array.from({ length: n + 1 }, (_, i) => new THREE.Vector3(...f(i / n)));
  // 線の色も外周の縁（明るい金属の縁）と同じ
  const tipLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts(NX * 2, (v) => { const a = tailTheta(v); return P3(aout(a), a, XW(v), 1); })), opq(COLOR.rimOuter, 0.95));
  tipLine.name = "tailTip";
  parent.add(tipLine);
  [D / 2, -D / 2].forEach((x) => {
    parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts(NT, (u) => { const a = u * aEdge; return P3(aout(a), a, x, 1); })), opq(COLOR.rimOuter, 0.95)));
  });
  const tip = new THREE.Vector3(...P3(aout(TAU), TAU, 0, 1));
  let topY = cy + rOut;
  for (let i = 0; i <= 24; i++) { const a = a1 + (TAU - a1) * i / 24; topY = Math.max(topY, P3(aout(a), a, 0, 1)[1]); }
  return { tip, topY };
}
/* 格子の面（u: 周・v: 幅など）。fn(u, v) → [x, y, z] */
function surfaceGrid(nu, nv, fn) {
  const pos = [], idx = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) pos.push(...fn(i / nu, j / nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* 光る汚れの点（芯＋にじみ）。透明なコイルの中でも目に入るように */
function glowDot(parent, pos, r) {
  dot(parent, pos, r);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(r * 2.3, 20, 14),
    new THREE.MeshBasicMaterial({ color: COLOR.defect, transparent: true, opacity: 0.22, depthWrite: false }));
  halo.position.copy(pos);
  halo.renderOrder = 5;
  parent.add(halo);
}

/* 板を横切る汚れの線（2 本のうち 1 本） */
function defectLine(parent, x, y, width) {
  box(parent, 0.03, 0.02, width, COLOR.defect, 1, x, y);
}
/* 2 本線の間隔を示す寸法線（両端に矢じり） */
function dimension(parent, xa, xb, y, color) {
  const w = xb - xa;
  if (w <= 0) return;
  line(parent, [new THREE.Vector3(xa, y, 0), new THREE.Vector3(xb, y, 0)], color);
  [xa, xb].forEach((x) => line(parent, [new THREE.Vector3(x, FLOOR + 0.03, 0), new THREE.Vector3(x, y + 0.06, 0)], color, 0.8));
  const tip = Math.min(0.08, w / 3);
  [[xa, 1], [xb, -1]].forEach(([x, s]) => {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.025, tip, 12), mat(color));
    cone.rotation.z = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    cone.position.set(x + s * tip / 2, y, 0);
    parent.add(cone);
  });
}
/* 落としたオフ: 板と同じ厚さで、板の色にオフの色（丈＝橙・両エッジ＝青）を混ぜた半透明の面と、点線の輪郭。
   同じ板の一部で、落とした所だと分かるようにする。past: 前工程までのオフ（さらに淡く） */
function offStrip(parent, lx, th, lz, x, sy, z, color, edgeColor, past = false) {
  const look = past ? OFF_LOOK.past : OFF_LOOK.now;
  box(parent, lx, th, lz, new THREE.Color(COLOR.strip).lerp(new THREE.Color(color), look.mix).getHex(), look.opacity, x, sy, z);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(lx, th, lz)),
    new THREE.LineDashedMaterial({ color: edgeColor, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: look.line }));
  e.computeLineDistances();
  e.position.set(x, sy, z);
  parent.add(e);
}
/* 前工程までのオフが、この工程 p の頭側・尾側・両エッジのどれに当たるか（新しい工程ほど内側＝先頭）。
   頭と尾は巻き替えのたびに入れ替わる（焼鈍 AN は巻き替えない。calculator._trace_back と同じ決まり）ので、
   工程 k の前オフ（k の頭）が p の頭側か尾側かは、k より後から p までの巻き替えの回数（偶数なら同じ側）で決まる。
   長さは工程 k の全長に対する割合（frac）で、両エッジは工程 k の幅と落とした幅（mm）で持つ。 */
export function earlierOffs(p, all) {
  const out = { head: [], tail: [], edge: [] };
  const byNo = new Map(all.map((x) => [x.no, x]));
  const annealing = (x) => (x.equipment || "").trim().startsWith("AN");
  let swaps = 0, next = p;
  all.filter((k) => k.no < p.no).sort((a, b) => b.no - a.no).forEach((k) => {
    if (!annealing(next)) swaps++;                  // next で巻き替える＝k の頭と尾が入れ替わる
    const same = swaps % 2 === 0, L = Math.max(+k.after_length_m || 0, 1);
    const f = +k.total_off_front_m || 0, b = +k.total_off_back_m || 0;
    if (f > 0) out[same ? "head" : "tail"].push({ k, m: f, frac: f / L, what: "前オフ" });
    if (b > 0) out[same ? "tail" : "head"].push({ k, m: b, frac: b / L, what: "後オフ" });
    const pk = byNo.get(k.no - 1), w = +k.width * Math.max(1, +k.horizontal_split || 1);
    const mm = pk ? Math.max(0, (+pk.width - w) / 2) : 0;
    if (mm > 0) out.edge.push({ k, mm, w });
    next = k;
  });
  return out;
}
/* 前工程までのオフの札（頭側・尾側・両エッジで1つずつ。多いときは4つまで） */
function pastOffText(where, list, fmtOne) {
  const items = list.slice(0, 4).map(fmtOne).join("・") + (list.length > 4 ? ` ほか ${list.length - 4}` : "");
  return `前工程までのオフ（${where}）: ${items}`;
}
function outlineBox(parent, lx, ly, lz, x, y, z, color) {
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(lx, ly, lz)), new THREE.LineBasicMaterial({ color }));
  e.position.set(x, y, z);
  parent.add(e);
}

/* 見ている工程へカメラを移し、その工程の詳しい札だけを出す */
function focusStation(no, instant) {
  if (!view || !view.stations.size) return;
  view.stations.forEach((s, k) => {
    s.detail.visible = k === no;
    s.title.element.classList.toggle("active", k === no);
  });
  const s = view.stations.get(no);
  // 奥のコイルと手前の板の両方が入るよう、2 列の中ほどを見下ろす
  const center = new THREE.Vector3((s.x0 + s.x1) / 2, view.flat ? 0.1 : 0.45, view.coilZ / 2);
  const width = (s.x1 - s.x0) * 1.15 + 1.2;
  const dist = Math.max(5.5, width / (2 * Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2)) * view.camera.aspect) * 1.05);
  const look = view.flat ? new THREE.Vector3(-0.1, 0.75, 0.66) : new THREE.Vector3(-0.2, 0.5, 0.84);
  const camTo = center.clone().add(look.normalize().multiplyScalar(dist * (view.flat ? 0.9 : 1.1)));   // 少し左斜め前から（コイルの厚みが見える）
  const cam = view.camera, ctl = view.controls;
  if (instant) {
    cam.position.copy(camTo); ctl.target.copy(center); ctl.update(); requestRender(); return;
  }
  const p0 = cam.position.clone(), t0 = ctl.target.clone(), start = performance.now();
  const anim = () => {
    const k = Math.min(1, (performance.now() - start) / 550), e = 1 - (1 - k) ** 3;
    cam.position.lerpVectors(p0, camTo, e);
    ctl.target.lerpVectors(t0, center, e);
    return k < 1;
  };
  view.anims.add(anim);
  requestRender();
}


/* =========================================================================
   ピッチ計算（表が「入力＋ピッチ計算」のとき）。転写とは別物:
     出側ピッチ ＝ 発見ピッチ × 発見板厚 ÷ その工程の板厚（板厚の比で伸び縮み）
     径 ＝ ピッチ ÷ π、入側ピッチ ＝ 前の工程の出側ピッチ
     候補ロール ＝ 設備が同じ・入出位置が合う・径が ±誤差 % に入るロール（calculator._candidates）
   板だけで描き、コイルは描かない。跡の間隔は発見設備を基準にした実寸の比。
   ========================================================================= */
const PITCH = { stripLen: 5.0, gap: 1.4, base: 0.55, maxMarks: 40 };

function showPitch(res, tolerance) {
  const stations = res && res.processes ? res.processes.filter((p) => (p.equipment || "").trim()).sort((a, b) => a.no - b.no) : [];
  if (!stations.length) { showEmpty(res); return; }
  const found = stations.find((p) => p.equipment_flag === 2) || stations[0];
  const keepFocus = data && data.mode === "pitch" && stations.some((p) => p.no === data.focusNo) ? data.focusNo : found.no;
  data = { mode: "pitch", res, stations, found, focusNo: keepFocus, tolerance, pitch: +res.inputs.found_pitch_mm || 0 };
  renderControls();
  renderPitchText();
  buildPitchScene();
  focus(keepFocus, true);
}
const pitchTarget = (p) => !(p.equipment || "").trim().startsWith("AN") && p.pitch_out_mm > 0;

function renderPitchMenu() {
  ui.menu.className = "explain-menu pitch";
  ui.menu.innerHTML = `<div class="m-head">工程<small>候補ロールの数（押すとその工程を見る）</small></div>`
    + data.stations.map((p) => {
      const n = (p.roll_candidates || []).length;
      const cls = ["m-item", p.no === data.focusNo ? "active" : "", p.equipment_flag === 2 ? "found" : ""].join(" ");
      const sub = !pitchTarget(p) ? "対象外（焼鈍）"
        : p.pitch_in_mm > 0 ? `入側 ${fmt(p.pitch_in_mm, 0)}・出側 ${fmt(p.pitch_out_mm, 0)} mm` : `出側 ${fmt(p.pitch_out_mm, 0)} mm`;
      return `<button type="button" class="${cls}" data-focus="${p.no}"><span class="m-rank">${p.no}</span>
        <span class="m-name">${esc(p.equipment)}${p.equipment_flag === 2 ? "（発見）" : ""}<small>${sub}</small></span><span class="m-val">${pitchTarget(p) ? `${n} 本` : "―"}</span></button>`;
    }).join("")
    + `<div class="m-note">出側ピッチ ＝ 発見ピッチ × 発見板厚 ÷ その工程の板厚。径（ピッチ ÷ π）が ±${fmt(data.tolerance, 1)} % に入るロールを候補にします。</div>`;
  ui.menu.querySelectorAll("[data-focus]").forEach((b) => { b.onclick = () => focus(+b.dataset.focus); });
}

function renderPitchText() {
  const res = data.res, f = data.found, tf = res.found_thickness_mm, P = data.pitch;
  const p = data.stations.find((x) => x.no === data.focusNo) || f;
  const rows = data.stations.map((x) => `<tr class="${x.equipment_flag === 2 ? "found" : x.no === p.no ? "origin" : ""}"><td>${x.no} ${esc(x.equipment)}</td>`
    + `<td>${fmt(x.thickness, 3)}</td><td>${pitchTarget(x) ? fmt(x.pitch_out_mm, 0) : "―"}</td><td>${pitchTarget(x) ? fmt(x.diameter_out_mm, 0) : "―"}</td>`
    + `<td>${x.diameter_in_mm ? fmt(x.diameter_in_mm, 0) : "―"}</td><td>${pitchTarget(x) ? (x.roll_candidates || []).length : "―"}</td></tr>`).join("");
  const cands = (p.roll_candidates || []).map((c) => `<li>${esc(c.name)}（${esc(c.location)}・径 ${fmt(c.diameter_max_mm, 0)} mm${c.reference ? `・${esc(c.reference)}` : ""}）</li>`).join("");
  ui.text.innerHTML = `<h3>ピッチ計算: 発見 ${f.no} ${esc(f.equipment)}・発見ピッチ ${fmt(P, 0)} mm</h3>
    <div class="sub">転写（汚れの巻き）とは別の計算。ロールの跡の間隔が、板厚の比で伸び縮みする</div>
    <ol>
      <li>各工程の出側ピッチ ＝ ${fmt(P, 0)} × 発見板厚 ${fmt(tf, 3)} ÷ その工程の板厚（薄くなるほど伸びる）。入側ピッチは前の工程の出側ピッチ。</li>
      <li>3D では板を真ん中で分け、左半分を入側・右半分を出側として、それぞれのピッチでロールの跡を描きます（板は左から右へ流れる）。</li>
      <li>ロールの径 ＝ ピッチ ÷ π。設備が同じで、入出位置が合い（入側は入側径、それ以外は出側径）、径が ±${fmt(data.tolerance, 1)} % に入るロールが候補。
        <table class="x-spread"><thead><tr><th>工程</th><th>板厚 mm</th><th>出側ピッチ</th><th>出側径</th><th>入側径</th><th>候補</th></tr></thead><tbody>${rows}</tbody></table></li>
      <li>${p.no} ${esc(p.equipment)}: ${pitchTarget(p)
        ? `出側ピッチ <span class="v">${fmt(p.pitch_out_mm, 0)} mm</span> → 径 <span class="v">${fmt(p.diameter_out_mm, 0)} mm</span>${p.diameter_in_mm ? `・入側径 <span class="v">${fmt(p.diameter_in_mm, 0)} mm</span>` : ""}。
          ${cands ? `候補ロール<ul>${cands}</ul>` : "ロールマスタに径の合うロールはありません。"}`
        : "焼鈍はロールの跡の対象外。"}</li>
    </ol>`;
}

/* 板の半分（入側 x0〜中央 ／ 中央〜出側 x1）に、そのピッチの間隔でロールの跡を描き、寸法・径・候補ロールを添える。
   候補ロールは入出位置で分ける（入側のロールは入側径、ほかは出側径で選ばれている: calculator._candidates）。 */
function pitchHalf(st, detail, p, side, x0, x1, sy, th, W, P, isFound) {
  const inSide = side === "in";
  const pitch = inSide ? p.pitch_in_mm : p.pitch_out_mm, dia = inSide ? p.diameter_in_mm : p.diameter_out_mm;
  const mid = (x0 + x1) / 2, name = inSide ? "入側" : "出側";
  label(name, "side", new THREE.Vector3(mid, sy + th / 2 + 0.05, -W / 2 - 0.12), st);
  if (!(pitch > 0)) {
    label("前の工程のピッチなし", "muted", new THREE.Vector3(mid, FLOOR + 0.15, 0), st);
    return;
  }
  const gap = PITCH.base * pitch / P;
  const n = Math.min(PITCH.maxMarks / 2, Math.floor((x1 - x0 - 0.15) / Math.max(gap, 0.02)));
  for (let i = 0; i <= n; i++) defectLine(st, x0 + 0.1 + i * gap, sy + th * 0.9, W + 0.08);
  // 寸法は半分の外側の端（入側は左端・出側は右端）に置き、真ん中の工程名から離す
  const yb = FLOOR + 0.22, found = isFound && !inSide;
  const da = inSide ? x0 + 0.1 : x0 + 0.1 + Math.max(n - 1, 0) * gap, db = da + gap;
  dimension(st, da, db, yb, found ? COLOR.arrow : COLOR.defect);
  label(`${found ? "発見ピッチ" : `${name}ピッチ`} ${fmt(pitch, 0)} mm（×${fmt(pitch / P, 2)}）`, "red pair",
    new THREE.Vector3((da + db) / 2, yb + 0.28, 0), st);
  label(`${name}径 ＝ ${fmt(pitch, 0)} ÷ π ＝ ${fmt(dia, 0)} mm`, "", new THREE.Vector3(mid, FLOOR + 0.02, W / 2 + 0.35), detail);
  const cands = (p.roll_candidates || []).filter((c) => (c.location === "入側") === inSide);
  const names = cands.slice(0, 4).map((c) => `${c.name}（φ${fmt(c.diameter_max_mm, 0)}）`);
  label(names.length ? names.join(" ／ ") + (cands.length > 4 ? ` ほか ${cands.length - 4} 本` : "") : `${name}の候補ロールなし`,
    names.length ? "cand-list" : "muted", new THREE.Vector3(mid, FLOOR + 0.02, W / 2 + 0.7), detail);
}
function buildPitchScene() {
  const v = beginScene("pitch");
  if (!v) return;
  const flow = data.stations, P = data.pitch || 1;
  const { lenOf, thOf, widOf } = stripScale(flow);
  let cursor = 0;
  const placed = [];
  flow.forEach((p) => {
    const st = new THREE.Group(), detail = new THREE.Group();
    v.group.add(st); st.add(detail);
    const isFound = p.equipment_flag === 2, target = pitchTarget(p);
    // 板の長さ・厚さ・幅は工程どうしで比べられる共通の縮尺（転写の場面と同じ物差し）
    const len = Math.max(lenOf(p), PITCH.stripLen * 0.5), W = widOf(p.width), th = thOf(p), sy = FLOOR + th / 2;
    const sx = cursor, cx = sx + len / 2;
    if (target) {
      // 板を真ん中で分ける: 左＝入側（前の工程の出側ピッチ）・右＝出側（この工程のピッチ）。板は左から右へ流れる
      const hasIn = p.pitch_in_mm > 0;
      stripBody(st, len / 2, th, W, sx + len / 4, sy, hasIn ? 1 : 0.5);
      stripBody(st, len / 2, th, W, cx + len / 4, sy, 1);
      box(st, 0.014, th * 2.4, W + 0.14, COLOR.flow, 0.9, cx, sy);          // 仕切り
      pitchHalf(st, detail, p, "in", sx, cx, sy, th, W, P, isFound);
      pitchHalf(st, detail, p, "out", cx, sx + len, sy, th, W, P, isFound);
    } else {
      stripBody(st, len, th, W, cx, sy, 0.5);
      label("焼鈍（対象外）", "muted", new THREE.Vector3(cx, FLOOR + 0.15, 0), st);
    }
    const title = label(`${p.no} ${p.equipment}${isFound ? "（発見）" : ""}`, "title" + (isFound ? " found" : ""),
      new THREE.Vector3(cx, FLOOR + 0.75, 0), st);
    // 板の寸法は奥側に（手前は入側・出側の径と候補ロールの場所）
    label(`全長 ${fmt(p.after_length_m, 0)} m・板厚 ${fmt(p.thickness, 3)} mm・幅 ${fmt(p.width, p.width < 100 ? 2 : 1)} mm`, "muted", new THREE.Vector3(cx, FLOOR + 0.02, -W / 2 - 0.45), st);
    placed.push({ p, st, detail, title, x0: sx, x1: sx + len });
    cursor = sx + len + PITCH.gap;
  });
  placed.forEach((a, i) => {
    const b = placed[i + 1];
    if (!b) return;
    const from = new THREE.Vector3(a.x1 + 0.1, FLOOR + 0.1, 0), to = new THREE.Vector3(b.x0 - 0.1, FLOOR + 0.1, 0);
    const mid = from.clone().lerp(to, 0.5).setY(FLOOR + 0.45);
    arrowAlong(v.group, [from, mid, to], COLOR.flow, 0.018);
    const r = b.p.thickness ? a.p.thickness / b.p.thickness : 1;
    label(`板厚 ${fmt(a.p.thickness, 3)}→${fmt(b.p.thickness, 3)}・ピッチ ×${fmt(r, 2)}`, "flow", mid.clone().setY(mid.y + 0.22), v.group);
  });
  finishScene(v, placed, cursor, { gridZ: 0, coilZ: 0, flat: true });   // 板だけ: カメラは低い中心から見下ろす（focusStation）
}
