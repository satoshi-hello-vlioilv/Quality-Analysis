"use strict";
/* =========================================================================
   TransferPitchAnalyzer（転写距離・ピッチ解析）フロントエンド
   - 機能タブは「入力＋転写計算」「入力＋ピッチ計算」の2パターンのみ。
   - 「列表示」で列を個別に表示/非表示（既定で参考値は非表示）。localStorage保存。
   - 入力できる欄（左の解析条件・表のセル）はどれを変えても即時に再計算(サーバ /api/calculate)。
     個々の欄に結ばず、入れ物（左パネル・表）で input/change を受ける。欄を足しても結び忘れが起きない。
   - 心拍で利用状況（だれがどの版を使っているか）を伝え、つながっているか（接続 ●）を見る。
   - デスクトップ版（窓）だけで動く。終了は窓が答える（版 3.0.0 でブラウザ版を外した）。
   ========================================================================= */
/* ---------------- 版が混ざっていないか（最初に確かめる） ----------------
   前から動いていた古いサーバーの古い画面（HTML）に、入れ替えた新しい JS が読み込まれると、画面が途中で止まって真っ白になる
   （2026-09-29 の不具合）。画面の指紋（<meta name="tpa-build">）と、この JS を読んだ URL の指紋（?v=）が違えば、
   先へ進まず、何が起きたかと直し方（再起動）を出す。動いているあいだに program を入れ替えると起こり得る。 */
/* アプリの名前（app/brand.json → 画面の <meta name="tpa-app">）。案内の文で使う（名前をじかに書かない） */
const APP = (() => {
  const m = document.querySelector('meta[name="tpa-app"]');
  return { name: m ? m.content : "", exe: m ? m.dataset.exe : "", subtitle: m ? m.dataset.subtitle : "" };
})();
const APP_EXE = APP.exe || "アプリの exe";
(function checkPageBuild() {
  const meta = document.querySelector('meta[name="tpa-build"]');
  let mine = "";
  try { mine = new URL(document.currentScript.src).searchParams.get("v") || ""; } catch (_) { /* 読めなければ比べない */ }
  if (meta && meta.content && meta.content === mine) return;
  // 見た目はこの場に書く（版が混ざったときは、読み込まれた CSS がこの JS と合っている保証が無い）
  const box = document.createElement("div");
  box.id = "staleBuild";
  box.setAttribute("role", "alertdialog");
  box.style.cssText = "position:fixed;inset:0;z-index:2000;display:grid;place-items:center;background:rgba(15,31,46,.45);font-family:'Segoe UI','Yu Gothic UI',Meiryo,sans-serif";
  box.innerHTML = `<div style="width:min(520px,92vw);background:#fff;border-radius:14px;padding:20px 22px;box-shadow:0 18px 50px rgba(10,30,50,.3);color:#1c2b36;line-height:1.7">
      <h3 style="margin:0 0 8px;font-size:18px">アプリの版が混ざっています</h3>
      <p style="margin:0 0 14px;font-size:14px">前から動いていたアプリが、新しく入れ替えたプログラムと一緒に使われています。
        このままでは画面が正しく動きません。<b>「アプリを再起動する」</b>を押すとアプリが閉じるので、<b>${APP_EXE}</b> で開き直してください。</p>
      <div style="text-align:right"><button id="staleRestart" style="height:34px;border:0;border-radius:8px;background:#2b5f79;color:#fff;font-weight:700;padding:0 18px;cursor:pointer">アプリを再起動する</button></div>
      <p id="staleMsg" style="margin:10px 0 0;font-size:13px;color:#5a6b7c"></p></div>`;
  document.body.appendChild(box);
  document.getElementById("staleRestart").onclick = async () => {
    try { await fetch("/api/shutdown", { method: "POST" }); } catch (_) { /* 止まれば届かない */ }
    document.getElementById("staleMsg").textContent = `閉じない場合は、窓を閉じてから ${APP_EXE} で開き直してください。`;
  };
  throw new Error("page/script build mismatch: page=" + (meta ? meta.content : "(none)") + " script=" + mine);
})();

const { $, esc } = TPA;   // esc: 表のセル（innerHTML）・入力欄の値に入れる文字。LotDsp・マスタから来た値は HTML として読ませない
const DEFAULT_MAX_ROWS = 25;
/* 表の行数（設定 ui_defaults.max_rows。読めなければ 25） */
const maxRows = () => Math.max(1, +(state.config && state.config.max_rows) || DEFAULT_MAX_ROWS);
const LS_KEY = "tpa.colOverrides.v1";
const LS_ORDER = "tpa.colOrder.v1";   // 列の並び（タブごと）: {view: [key...]}
const state = { rows: [], lot: {}, result: null, config: null, view: "transfer", colOverride: {}, quitting: false,
  calcSeq: 0, calcPending: false, connected: true };

/* ---------------- 整形 ---------------- */
function fmt(v, d = 3) {
  if (v === "" || v === null || v === undefined || Number.isNaN(Number(v))) return "";
  return Number(v).toLocaleString("ja-JP", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
/* 頭尾・判定の文言と色。表と CSV が同じ物を使う（以前は CSV だけ AN の行を「対象外」と書いていた） */
const HEAD_TAIL = { 1: ["頭", "ht-h"], 0: ["尾", "ht-t"] };
function matchOf(p) {
  if (!p) return null;
  if (p.equipment_flag === 2) return ["発見", "na"];
  if (p.equipment_flag === 1) return ["AN", "na"];
  if (p.transfer_match === undefined || p.transfer_match === null) return null;
  return p.transfer_match ? ["一致", "ok"] : ["対象外", "no"];
}
const htFmt = (v) => (HEAD_TAIL[v] ? `<span class="ht ${HEAD_TAIL[v][1]}">${HEAD_TAIL[v][0]}</span>` : "");
const matchFmt = (p) => { const m = matchOf(p); return m ? `<span class="badge ${m[1]}">${m[0]}</span>` : ""; };
const candFmt = (arr) => (arr && arr.length)
  ? arr.map((x) => `<span class="chip" title="径 φ${fmt(x.diameter_max_mm, 1)}${x.reference ? " / 基準 " + esc(x.reference) : ""}">${esc(x.name)}（${esc(x.location)}）</span>`).join(" ")
  : '<span class="na-text">該当なし</span>';

/* ---------------- 列定義 ---------------- */
// kind: no | et(text) | en(num) | es(select) | rt(取り込んだ値・直さない) | calc | match | cands
// hc  : ヘッダ色 (input/xfer/pitch/meta)
// w   : 列の最小幅 px（表は横幅いっぱいに広げ、足りない画面でだけ横スクロール）
const COLS = [
  { key: "no", name: "No.", unit: "", hc: "meta", kind: "no", w: 40 },
  { key: "equipment", name: "設備", unit: "名称", hc: "meta", kind: "et", w: 78 },
  { key: "unwind", name: "巻出", unit: "方向", hc: "meta", kind: "es", opts: ["", "上", "下"], w: 56 },
  { key: "rewind_master", name: "巻取", unit: "方向", hc: "input", kind: "es", opts: ["", "上", "下", "-"], blank: "自動", w: 60 },   // 空欄＝設備マスタ（AUTO_COLS）
  { key: "line_direction", name: "ライン", unit: "方向", hc: "meta", kind: "calc", fmt: esc, w: 50 },
  { key: "face_state", name: "面", unit: "", hc: "meta", kind: "calc", fmt: esc, w: 40 },
  { key: "side_state", name: "側", unit: "", hc: "meta", kind: "calc", fmt: esc, w: 40 },

  { key: "thickness", name: "板厚", unit: "mm", hc: "input", kind: "en", step: "0.001", w: 70 },
  { key: "width", name: "板幅", unit: "mm", hc: "input", kind: "en", step: "1", w: 72 },
  { key: "weight", name: "作業後重量", unit: "kg", hc: "input", kind: "en", step: "0.1", w: 78 },
  { key: "work_date", name: "作業日", unit: "", hc: "meta", kind: "rt", w: 136 },   // LotDsp の実績の日付（直さない）
  { key: "design_split", name: "分割数", unit: "設計", hc: "input", kind: "en", step: "1", w: 54 },
  { key: "horizontal_split", name: "横割", unit: "数", hc: "input", kind: "en", step: "1", w: 48 },
  { key: "vertical_split", name: "縦割", unit: "数", hc: "input", kind: "en", step: "1", w: 48 },
  { key: "off_front_m", name: "総オフ前", unit: "m", hc: "input", kind: "en", step: "0.1", w: 64 },
  { key: "off_back_m", name: "総オフ後", unit: "m", hc: "input", kind: "en", step: "0.1", w: 64 },

  { key: "after_length_m", name: "作業後全長", unit: "m", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 0), w: 72 },
  { key: "inner_diameter_mm", name: "内径", unit: "mm", hc: "input", kind: "en", step: "1", w: 64 },   // 空欄＝自動（AUTO_COLS）
  { key: "inner_length_m", name: "内巻長さ", unit: "m", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 1), w: 70 },
  { key: "inner_thickness_mm", name: "内巻肉厚", unit: "mm", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 1), w: 70 },
  { key: "width_loss_kg", name: "幅落ち", unit: "kg", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 0), w: 62 },
  { key: "length_loss_kg", name: "丈落ち", unit: "kg", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 0), w: 62 },
  { key: "length_loss_m", name: "丈落ち", unit: "m", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 0), w: 62 },
  { key: "position_from_a_m", name: "汚れ位置A", unit: "m", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 1), w: 76 },
  { key: "transfer_distance_m", name: "転写距離", unit: "計算 m", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 3), w: 80 },
  { key: "agreement_percent", name: "一致率", unit: "%", hc: "xfer", kind: "calc", fmt: (v) => fmt(v, 2), w: 62 },
  { key: "head_tail", name: "頭尾", unit: "", hc: "xfer", kind: "calc", fmt: htFmt, w: 46 },
  { key: "transfer_match", name: "判定", unit: "", hc: "xfer", kind: "match", w: 76 },

  { key: "pitch_in_mm", name: "入側ピッチ", unit: "mm", hc: "pitch", kind: "calc", fmt: (v) => fmt(v, 0), w: 76 },
  { key: "diameter_in_mm", name: "入側径", unit: "mm", hc: "pitch", kind: "calc", fmt: (v) => fmt(v, 0), w: 70 },
  { key: "pitch_out_mm", name: "出側ピッチ", unit: "mm", hc: "pitch", kind: "calc", fmt: (v) => fmt(v, 0), w: 76 },
  { key: "diameter_out_mm", name: "出側径", unit: "mm", hc: "pitch", kind: "calc", fmt: (v) => fmt(v, 0), w: 70 },
  { key: "roll_candidates", name: "候補ロール", unit: "マスタ検索", hc: "pitch", kind: "cands", w: 260 },
];
const COL = Object.fromEntries(COLS.map((c) => [c.key, c]));
const EDIT_NUM = new Set(["thickness", "width", "weight", "design_split", "horizontal_split", "vertical_split", "off_front_m", "off_back_m", "inner_diameter_mm"]);
/* 空欄なら計算側の自動値を欄に出す列（「自動」の印・斜体）。手で入れればその値を使い、消せば自動に戻る。
   source: 計算結果の出どころ（"auto" のとき自動値を使っている）・auto: 自動値・digits: 欄に出す桁 */
const AUTO_COLS = {
  off_back_m: { source: "off_back_source", auto: "auto_off_back_m", digits: 1, unit: "m",
    why: "エンドバック（自動）: 前工程との重量差から", manual: "重量差からの自動値は" },
  inner_diameter_mm: { source: "inner_diameter_source", auto: "auto_inner_diameter_mm", digits: 0, unit: "mm",
    why: "内径（自動）: 設備ごとの既定", manual: "自動の値は" },
  rewind_master: { source: "rewind_source", auto: "auto_rewind_master", digits: null, unit: "",   // 字の値（上・下・-）
    why: "巻取方向（自動）: 設備マスタの値", manual: "設備マスタの値は" },
};

/* ---------------- 機能ビュー ----------------
   ベースは「入力画面＋転写計算表示」「入力画面＋ピッチ計算表示」の2パターン。
   どちらも同じ入力列(作業実績)を含み、その右に計算結果が続くため、
   タブを切り替えずに入力しながら結果を確認できる。
   列が多くなりすぎないよう、参考値は既定で非表示にし「列表示」から呼び出せる。 */
const BASE = ["no", "equipment"];
const INPUT_COLS = ["unwind", "thickness", "width", "weight", "work_date", "design_split", "horizontal_split", "vertical_split", "off_front_m", "off_back_m"];
const XFER_INPUT = ["inner_diameter_mm"];   // 転写だけで使う入力（コイルの内径）
const XFER_META = ["rewind_master", "line_direction", "face_state", "side_state"];
const XFER_CALC = ["after_length_m", "inner_length_m", "inner_thickness_mm", "width_loss_kg", "length_loss_kg", "length_loss_m", "position_from_a_m", "transfer_distance_m", "agreement_percent", "head_tail", "transfer_match"];
const PITCH_CALC = ["pitch_in_mm", "diameter_in_mm", "pitch_out_mm", "diameter_out_mm", "roll_candidates"];

const VIEWS = {
  transfer: {
    label: "入力＋転写計算",
    cols: [...BASE, ...INPUT_COLS, ...XFER_INPUT, ...XFER_META, ...XFER_CALC],
    groups: [
      { label: "基礎情報", keys: BASE },
      { label: "作業実績入力", keys: [...INPUT_COLS, ...XFER_INPUT] },
      { label: "巻方向・面/側", keys: XFER_META },
      { label: "転写計算結果", keys: XFER_CALC },
    ],
    defaultHidden: ["line_direction", "face_state", "side_state", "width_loss_kg", "length_loss_kg", "length_loss_m", "position_from_a_m"],
  },
  pitch: {
    label: "入力＋ピッチ計算",
    cols: [...BASE, ...INPUT_COLS, ...PITCH_CALC],
    groups: [
      { label: "基礎情報", keys: BASE },
      { label: "作業実績入力", keys: INPUT_COLS },
      { label: "ピッチ計算結果", keys: PITCH_CALC },
    ],
    defaultHidden: [],
  },
};
const VIEW_ORDER = ["transfer", "pitch"];

function loadOverrides() { state.colOverride = TPA.local.get(LS_KEY, null) || {}; state.colOrder = TPA.local.get(LS_ORDER, null) || {}; }
function saveOverrides() { TPA.local.set(LS_KEY, state.colOverride); }
function colVisible(view, key) {
  const ov = state.colOverride[view] || {};
  if (key in ov) return ov[key] !== false;
  return !VIEWS[view].defaultHidden.includes(key);
}
/* 列の並び: まとまり（基礎情報・作業実績入力・…）の順は変えず、まとまりの中だけ並べ替える（見出しの色帯と境の線を保つ）。
   覚えた並びに無い列（あとで足した列）は、そのまとまりの後ろに元の順で入る。No.・設備は固定（左に張り付く列）。 */
const FIXED_COLS = new Set(["no", "equipment"]);
function orderedKeys(view) {
  const saved = state.colOrder[view] || [];
  const rank = (k) => { const i = saved.indexOf(k); return i < 0 ? Infinity : i; };
  return VIEWS[view].groups.flatMap((g) => g.keys.slice().sort((a, b) => (rank(a) - rank(b)) || (g.keys.indexOf(a) - g.keys.indexOf(b))));
}
const groupOfKey = (view, key) => VIEWS[view].groups.findIndex((g) => g.keys.includes(key));
/* key を同じまとまりの target の前（after なら後ろ）へ動かして覚える */
function moveCol(view, key, target, after = false) {
  if (key === target || FIXED_COLS.has(key) || FIXED_COLS.has(target) || groupOfKey(view, key) !== groupOfKey(view, target)) return false;
  const order = orderedKeys(view).filter((k) => k !== key);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, key);
  state.colOrder[view] = order;
  TPA.local.set(LS_ORDER, state.colOrder);
  return true;
}
function resetColOrder(view) { delete state.colOrder[view]; TPA.local.set(LS_ORDER, state.colOrder); }
function viewCols() {
  return orderedKeys(state.view).filter((k) => colVisible(state.view, k));
}

/* ---------------- 状態表示 ---------------- */
function setStatus(t, cls = "") { const s = $("#status"); s.textContent = t; s.className = "pill " + cls; }
function fail(m) { const e = $("#error"); e.textContent = m; e.classList.remove("hidden"); setStatus("エラー", "err"); }
function clearError() { $("#error").classList.add("hidden"); }

/* ================= 起動 ================= */
async function boot() {
  loadOverrides();
  try {
    const r = await fetch("/api/config");
    state.config = await r.json();
    const d = state.config.defaults || {};
    $("#query").value = loadLastLot() || d.query || "";
    if (d.found_pitch_mm != null) $("#pitch").value = d.found_pitch_mm;
    if (d.soil_a_m != null) $("#soilA").value = d.soil_a_m;
    if (d.soil_b_m != null) $("#soilB").value = d.soil_b_m;
    if (d.tolerance_percent != null) $("#tolerance").value = d.tolerance_percent;
  } catch (e) { /* 既定のまま */ }
  paintLotdspRoute();
  loadMe();
  buildViewTabs();
  bindEditors();
  setExplainOpen(explainOpenSaved());
  emptyRows();
  buildTable();
  startHeartbeat();
  pollUpdate();
  loadInstall();
  // 起動時は検索しない（検索は LotDsp を読みに行くので、利用者が「検索」を押したときだけ）
  // 最初の画面は異常ロット一覧
  showScreen("list");
}

/* ---------------- 版・自分の権限・切断（WaveLog と同じ管理。判定はサーバーの services/access.py の1箇所） ----------------
   - 見出しの版の札（押すと更新履歴）。その横の札は1つで、版のことを1か所にまとめる:
       新しい版を取り込み済み（窓の更新の係 /__desktop/update）なら「更新あり」→ 更新履歴の窓で「更新して開き直す」
       ほかの人がもっと新しい版を使っている（心拍の答え）だけなら「新しい版あり」→ 取り込めない理由と次にすること
   - 自分の区分の札（押すとログインID・PC名・マスタ編集）。マスタ管理を開けない区分なら入口を隠す
   - 切断されている（管理する人が一時的に止めた）ときは上に帯 */
state.me = null;
async function loadMe() {
  try { state.me = await (await fetch("/api/access/me")).json(); } catch (_) { return; }
  const me = state.me, chip = $("#meChip");
  chip.textContent = me.role;
  chip.className = `pill me-chip role-${TPA.roleKey(me.role)}`;
  chip.title = `${me.loginId || "（ログインID 不明）"} ／ ${me.pcName || "（PC名 不明）"}・${me.role}・マスタ編集「${me.masterEdit}」`;
  $("#masterBtn").classList.toggle("hidden", !me.canOpenMaster);
  paintRevoked(me.revoked);
}
let mePopOff = null;
function closeMePop() { $("#mePop").classList.add("hidden"); if (mePopOff) mePopOff(); mePopOff = null; }
$("#meChip").onclick = () => {
  const pop = $("#mePop"), me = state.me;
  if (!me || !pop.classList.contains("hidden")) { closeMePop(); return; }
  pop.innerHTML = `<dl><dt>ログインID</dt><dd>${esc(me.loginId || "（取れません）")}</dd>
      <dt>PC名</dt><dd>${esc(me.pcName || "（取れません）")}<small>（${esc(me.pcNameSource || "-")}）</small></dd>
      <dt>権限区分</dt><dd>${esc(me.role)}</dd><dt>マスタ編集</dt><dd>${esc(me.masterEdit)}</dd><dt>版</dt><dd>${esc(me.version)}</dd></dl>
    <div class="me-note">権限は「マスタ管理」の「アクセス権限」で決まります（ログインID・PC名の組）。登録が無ければ一般ユーザーです。自分の区分は自分では変えられません。</div>`;
  pop.classList.remove("hidden");
  mePopOff = TPA.dismissable(pop, closeMePop, { keep: $("#meChip") });
};
function paintRevoked(r) {
  const bar = $("#revokedBar");
  bar.classList.toggle("hidden", !r);
  if (r) bar.textContent = `この PC は ${r.by || "管理する人"}${r.byPc ? `（${r.byPc}）` : ""} により一時的に切断されています（あと約 ${Math.ceil((r.remainingSec || 0) / 60)} 分）。`
    + "そのあいだマスタは読むだけです。" + (r.reason ? ` 理由: ${r.reason}` : "");
}
function paintBeat(d) {
  state.versionNotice = (d && d.version) || null;
  paintVersionNotice();
  if (d && "revoked" in d) paintRevoked(d.revoked);
}
function paintVersionNotice() {
  const v = state.versionNotice, u = state.update, btn = $("#verNew");
  const ready = u && u.state === "ready", outdated = v && v.outdated, back = ready && u.direction === "down";
  btn.classList.toggle("hidden", !(ready || outdated));
  btn.classList.toggle("is-ready", !!ready);
  btn.textContent = back ? `配る版 ${u.ready} に戻す` : ready ? `更新あり ${u.ready}` : v && v.distributed ? `配る版 ${v.latestVersion}` : "新しい版あり";
  btn.title = back ? `配る版が ${u.ready} に戻されました（取り込み済み）。押すと「${u.ready} で開き直す」`
    : ready ? `新しい版 ${u.ready} を取り込みました。押すと「更新して開き直す」（開き直すまでは今の版のまま）`
    : outdated ? (v.distributed ? `配る版は ${v.latestVersion}・いまの版は ${v.myVersion} です。押すと更新のこと`
      : `ほかの人が新しい版（${v.latestVersion}）を使っています。いまの版は ${v.myVersion} です。押すと更新のしかた`) : "";
  if (!$("#changelogModal").classList.contains("hidden")) paintUpdateBox();
}
/* 更新の係（窓の Rust・desktop/src/update.rs）の今。取り込み中は短い間隔で、ふだんは 1 分ごとに尋ねる */
let updTimer = null;
async function pollUpdate() {
  clearTimeout(updTimer);
  try {
    const r = await fetch("/__desktop/update", { cache: "no-store" });
    if (!r.ok) return;                       // 窓の外（開発で python -m app から見るとき）では更新の係が無い
    state.update = await r.json();
  } catch (_) { return; }
  paintVersionNotice();
  const busy = ["checking", "staging", "idle"].includes(state.update.state);
  updTimer = setTimeout(pollUpdate, busy ? 2000 : 60000);
}
async function checkUpdateNow() {
  try { await fetch("/__desktop/update/check", { method: "POST" }); } catch (_) { return; }
  setTimeout(pollUpdate, 500);
}
/* 更新履歴の窓の上: 版のこと（取り込んだ新しい版・取り込めない理由・置き場）と、次にすること */
function updateText() {
  const u = state.update, v = state.versionNotice, outdated = v && v.outdated;
  const lines = (...xs) => xs.filter(Boolean).join("<br>");
  const newer = !outdated ? "" : v.distributed ? `<b>配る版は ${esc(v.latestVersion)} です（いまの版 ${esc(v.myVersion)}）。</b>`
    : `<b>新しい版（${esc(v.latestVersion)}）を使っている人がいます。</b>`;
  const dist = u && u.distributed ? `配る版 ${esc(u.distributed.version)}（${esc(u.distributed.setAt || "")} ${esc(u.distributed.setBy || "")}）` : "";
  if (!u) return outdated ? { tone: "warn", html: newer + "アプリを終了し、新しい版の ZIP を展開したフォルダから開いてください。" } : null;
  const place = u.found || u.source;
  const where = place ? `更新の置き場: <code>${esc(place)}</code>${u.adjusted ? "（この PC での BOX の見え方に合わせて探しました）" : ""}`
    + `${u.checkedAt ? `（${esc(u.checkedAt)} に確かめた）` : ""}${dist ? `・${dist}` : ""}` : "";
  const failed = (u.failed || []).length ? `版 ${esc(u.failed.join("・"))} は起動できなかったため使っていません（前の版で開いています）。` : "";
  switch (u.state) {
    case "ready": return u.direction === "down"
      ? { tone: "ready", act: true, label: `${u.ready} で開き直す`, html: lines(`<b>配る版が ${esc(u.ready)} に戻されました（取り込み済み）。</b>`
        + `「${esc(u.ready)} で開き直す」でその版になります。このまま使い続けても、次に開いたときに ${esc(u.ready)} で開きます。`, dist, failed) }
      : { tone: "ready", act: true, html: lines(`<b>新しい版 ${esc(u.ready)} を取り込みました。</b>「更新して開き直す」で新しい版になります。`
        + "このまま使い続けても、次に開いたときに新しい版で開きます。", failed) };
    case "staging": return { tone: "info", html: `版 ${esc(u.detail)} を取り込んでいます…（そのまま使えます）` };
    case "checking": case "idle": return { tone: "info", html: "更新の置き場を確かめています…" };
    case "error": return { tone: "warn", html: lines(`<b>更新を取り込めません。</b>${esc(u.problem || u.detail)}`, where, failed) };
    case "off": return outdated ? { tone: "warn", html: newer + "「マスタ管理」→「参照先」の「更新の置き場」に、配る ZIP を置くフォルダを入れると、各 PC が自動で取り込みます。" } : null;
    default: // latest: 置き場の最新を使っている
      if (outdated) return { tone: "warn", html: lines(newer + (v.distributed ? "開き直すと配る版になります。"
        : `置き場にまだありません。「マスタ管理」→「アプリの配布」で、配る ZIP（${esc(APP.name)}-${esc(v.latestVersion)}-windows.zip）を置いて配ってください。`), where, failed) };
      return failed ? { tone: "info", html: failed } : null;
  }
}
/* 更新履歴の窓の上の枠: 版のこと・この PC へ写した版の知らせ・ショートカットが無ければ作る入口（「今後たずねない」にしても、ここから作れる） */
function paintUpdateBox() {
  const box = $("#clUpdate"), t = updateText(), u = state.update || {}, inst = state.install;
  const rows = [];
  if (t) rows.push(`<div class="cl-update-row"><div class="cl-update-text">${t.html}</div>`
    + (t.act ? `<button type="button" id="clApply" class="btn-primary">${esc(t.label || "更新して開き直す")}</button>` : "") + "</div>");
  if ((u.notes || []).length) rows.push(`<div class="cl-update-row"><div class="cl-update-text">${u.notes.map(esc).join("<br>")}</div></div>`);
  const noLink = inst && inst.installed && !((inst.shortcut || {}).links || []).length;
  if (noLink) rows.push(`<div class="cl-update-row"><div class="cl-update-text">ショートカットがありません${inst.shortcut.declined ? "（「今後たずねない」にしてあります）" : ""}。`
    + `作ると、デスクトップとスタートからこの PC の物（<code>${esc(inst.appDir)}</code>）を開けます。</div><button type="button" id="clShortcut" class="btn-ghost">ショートカットを作る</button></div>`);
  box.classList.toggle("hidden", !rows.length);
  if (!rows.length) return;
  box.className = `cl-update tone-${t ? t.tone : "info"}`;
  box.innerHTML = rows.join("");
  if (t && t.act) $("#clApply").onclick = applyUpdate;
  if (noLink) $("#clShortcut").onclick = () => { closeChangelog(); openShortcut(); };
}
async function applyUpdate() {
  const btn = $("#clApply"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "開き直しています…";
  TPA.saveUiState();
  try {
    const r = await fetch("/__desktop/update/apply", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "開き直せませんでした");
    state.quitting = true;                   // 窓はこのあと閉じ、新しい版の窓が開く
    if (hbTimer) clearInterval(hbTimer);
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    fail(e.message);
  }
}
/* この PC で動かす・ショートカット（デスクトップ版の desktop/src/install.rs）。共有・BOX の exe で開いても、起動に要る物は
   窓が尋ねずにこの PC へ写してから開く。ショートカット（この PC の exe を指し、作業フォルダもこの PC）が 1 つも無ければ、起動のたびに尋ねる。
   「今後たずねない」は窓が install.json に覚える（この PC の記録。画面の設定ではない）。更新履歴の窓からはいつでも作れる。 */
const LEGACY_NEVER = "tpa.install.never";    // 版 3.4.0 までの「この PC に入れる」を断った印（ショートカットを断ったものとして引き継ぐ）
const desktopPost = async (url) => {   // 窓（/__desktop/*）へ POST し、断られたら理由で失敗する
  const r = await fetch(url, { method: "POST" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "できませんでした");
  return d;
};
async function loadInstall() {
  try {
    const r = await fetch("/__desktop/install", { cache: "no-store" });
    if (!r.ok) return;                       // 窓の外（開発で python -m app から見るとき）
    state.install = await r.json();
  } catch (_) { return; }
  const sc = state.install.shortcut || {};
  if (!sc.ask) return;
  if (TPA.local.get(LEGACY_NEVER, false)) {
    try { await desktopPost("/__desktop/shortcut/decline"); TPA.local.remove(LEGACY_NEVER); sc.ask = false; sc.declined = true; } catch (_) { /* 次の起動で */ }
    return;
  }
  openShortcut();
}
function openShortcut() {
  const i = state.install;
  if (!i) return;
  const sc = i.shortcut || {};
  $("#scBody").innerHTML = `<div>デスクトップとスタートに「${esc(i.name)}」を作ると、次からはそこから開けます（スタートの検索で「${esc(i.name)}」と打つと出ます）。</div>
    <ul><li><b>この PC の物が開きます</b>。共有・BOX につながっていなくても開けます（起動に要る物はもうこの PC へ写してあります）。</li>
      <li>新しい版は、これまでどおり自動で入れ替わります（ショートカットはそのまま使えます）。</li></ul>
    <div class="sc-where">ショートカットが開く物: <code>${esc(i.appDir)}</code>（作業フォルダも同じ）<br>作る場所: ${(sc.places || []).map((p) => `<code>${esc(p)}</code>`).join("<br>") || "（場所が分かりません）"}</div>
    <div class="sc-msg hidden" id="scMsg" aria-live="polite"></div>`;
  const go = $("#scGo");
  go.disabled = false; go.textContent = "作る"; go.onclick = makeShortcut;
  $("#scNever").hidden = $("#scLater").hidden = false;
  $("#shortcutModal").classList.remove("hidden");
  go.focus();
}
const closeShortcut = () => $("#shortcutModal").classList.add("hidden");
async function makeShortcut() {
  const go = $("#scGo"), msg = $("#scMsg");
  const say = (cls, html) => { msg.className = `sc-msg ${cls}`; msg.innerHTML = html; };
  go.disabled = true; go.textContent = "作っています…";
  try {
    const d = await desktopPost("/__desktop/shortcut");
    const bad = d.problems || [];
    say(bad.length ? "ng" : "ok", `ショートカットを作りました: ${(d.made || []).map((p) => `<code>${esc(p)}</code>`).join("<br>") || "なし"}`
      + (bad.length ? `<br>作れなかったもの: ${bad.map(esc).join("<br>")}` : ""));
    state.install.shortcut = { ...state.install.shortcut, ask: false, declined: false, links: d.made || [] };
    $("#scNever").hidden = $("#scLater").hidden = true;
    go.disabled = false; go.textContent = "閉じる"; go.onclick = closeShortcut; go.focus();
  } catch (e) {
    go.disabled = false; go.textContent = "作る";
    say("ng", "✕ " + esc(e.message));
  }
}
$("#scLater").onclick = closeShortcut;
$("#scClose").onclick = closeShortcut;
$("#scNever").onclick = async () => {
  try { await desktopPost("/__desktop/shortcut/decline"); state.install.shortcut.declined = true; } catch (e) { fail(e.message); }
  closeShortcut();
};
TPA.layer($("#shortcutModal"), closeShortcut);

async function openChangelog() {
  const d = await (await fetch("/api/changelog")).json();
  $("#clSub").innerHTML = `いまの版: <b class="cl-ver">${esc(d.version)}</b>`;
  paintUpdateBox();
  $("#clBody").innerHTML = d.entries.map((e) => `<div class="cl-entry"><h4>${esc(e.version)}<small>${esc(e.date || "")}</small>${e.version === d.version ? '<span class="cl-now">いまの版</span>' : ""}</h4>
    <ul>${(e.notes || []).map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`).join("");
  $("#changelogModal").classList.remove("hidden");
  $("#clClose").focus();
}
$("#verBadge").onclick = openChangelog;
$("#verNew").onclick = openChangelog;
const closeChangelog = () => $("#changelogModal").classList.add("hidden");
$("#clClose").onclick = closeChangelog;
TPA.layer($("#changelogModal"), closeChangelog);
// マスタ管理（master.js）からの合図。master.js はこのファイルの変数・関数に触らない
document.addEventListener("tpa:masters-closed", loadMe);          // 権限を直したかもしれない → 引き直す
document.addEventListener("tpa:error", (e) => fail(e.detail));
document.addEventListener("tpa:masters-changed", () => {          // マスタが変わった → 表に工程があれば計算し直す
  if (state.rows.some((r) => (r.equipment || "").trim())) recalc();
});

/* ---------------- 心拍（利用状況・接続） ----------------
   数秒ごとに /api/heartbeat へ送る。答えで「接続 ●」と、見出しの版の札（新しい版あり・切断）を決める。
   以前は、ブラウザを閉じたかを推し量ってサーバーを止めるのにも使っていた（版 3.0.0 で外した。窓を閉じれば中身も終わる）。 */
let hbTimer = null, hbFailCount = 0;
function startHeartbeat() {
  const interval = Math.max(1, +((state.config || {}).heartbeat_interval_seconds || 3)) * 1000;
  const beat = async () => {
    if (state.quitting) return;
    try {
      const r = await fetch("/api/heartbeat", { method: "POST", cache: "no-store" });
      if (!r.ok) throw new Error("bad");
      hbFailCount = 0; setConn(true);
      try { paintBeat(await r.json()); } catch (_) { /* 版・切断の答えが無くても続ける */ }
    } catch (e) {
      hbFailCount++; if (hbFailCount >= 2) setConn(false);
    }
  };
  beat();
  hbTimer = setInterval(beat, interval);
}
/* 接続が切れた→戻ったとき、切れている間に入れた値でもう一度計算する。 */
function setConn(ok) {
  const was = state.connected;
  state.connected = ok;
  if (ok && !was && state.calcPending) scheduleRecalc();
  const el = $("#conn");
  el.className = "pill " + (ok ? "conn-ok" : "conn-bad");
  el.textContent = ok ? "接続 ●" : "未接続 ○";
  el.title = ok ? "アプリの中身（Python）と接続中" : "アプリの中身（Python）と接続できません。少し待っても戻らなければ、アプリを開き直してください。";
}

/* ---------------- ビュータブ / 列メニュー ---------------- */
/* 左の「解析条件」と「結果サマリ」は、表のタブ（転写／ピッチ）で使う欄だけを出す（data-for）。値は保つので戻せばそのまま。 */
function paintViewInputs() {
  document.querySelectorAll("#leftPanel [data-for]").forEach((el) => el.classList.toggle("hidden", el.dataset.for !== state.view));
  $("#condSub").textContent = `${state.view === "pitch" ? "ピッチ" : "転写"}の条件・入力で即時再計算`;
}
function buildViewTabs() {
  paintViewInputs();
  $("#viewTabs").innerHTML = VIEW_ORDER.map((v) =>
    `<button class="tab${v === state.view ? " active" : ""}" data-view="${v}">${VIEWS[v].label}</button>`).join("");
  $("#viewTabs").querySelectorAll(".tab").forEach((b) => b.onclick = () => {
    state.view = b.dataset.view;
    buildViewTabs(); buildColPanel(); buildTable();   // 3D も buildTable → paintResults → explainUpdate で転写／ピッチに切り替わる
    if (!state.result) explainUpdate(null);
  });
}
function buildColPanel() {
  const panel = $("#colPanel");
  const view = state.view;
  const order = orderedKeys(view);
  panel.innerHTML = `<div class="cp-head">「${VIEWS[view].label}」で表示する列<small>ドラッグか ▲▼ で並べ替え（まとまりの中）</small></div>` +
    VIEWS[view].groups.map((g) => {
      const keys = order.filter((k) => g.keys.includes(k) && !FIXED_COLS.has(k));
      if (!keys.length) return "";
      return `<div class="cp-group">${g.label}</div>` + keys.map((k, i) => {
        const c = COL[k]; const on = colVisible(view, k);
        return `<div class="cp-row" draggable="true" data-col="${k}"><span class="cp-grip" aria-hidden="true">⋮⋮</span>
          <label><input type="checkbox" data-col="${k}"${on ? " checked" : ""}> ${c.name}${c.unit ? " (" + c.unit + ")" : ""}</label>
          <button type="button" class="cp-move" data-move="-1" data-col="${k}"${i ? "" : " disabled"} aria-label="${c.name}を上へ">▲</button>
          <button type="button" class="cp-move" data-move="1" data-col="${k}"${i < keys.length - 1 ? "" : " disabled"} aria-label="${c.name}を下へ">▼</button></div>`;
      }).join("");
    }).join("")
    + `<div class="cp-foot"><button type="button" class="cp-reset"${state.colOrder[view] ? "" : " disabled"}>並びを元に戻す</button></div>`;
  const redraw = () => { buildColPanel(); buildTable(); };
  panel.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.onchange = () => {
    const k = cb.dataset.col;
    state.colOverride[view] = state.colOverride[view] || {};
    state.colOverride[view][k] = cb.checked;
    saveOverrides(); buildTable();
  });
  panel.querySelectorAll(".cp-move").forEach((b) => b.onclick = () => {
    const k = b.dataset.col, row = b.closest(".cp-row");
    const next = +b.dataset.move < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (next && next.dataset.col && moveCol(view, k, next.dataset.col, +b.dataset.move > 0)) {
      redraw(); panel.querySelector(`.cp-move[data-col="${k}"][data-move="${b.dataset.move}"]`)?.focus();
    }
  });
  panel.querySelector(".cp-reset").onclick = () => { resetColOrder(view); redraw(); };
  TPA.dragSort(panel, ".cp-row", { axis: "vertical", canDrop: sameGroup, onDrop: (k, target, after) => moveCol(view, k, target, after) && redraw() });
}
/* 並べ替えのドラッグ（列表示の窓の行・表の見出しで同じ）。同じまとまりの上にだけ落とせる */
function sameGroup(a, b) { return groupOfKey(state.view, a) === groupOfKey(state.view, b); }
let colPanelOff = null;
function closeColPanel() { $("#colPanel").classList.add("hidden"); if (colPanelOff) colPanelOff(); colPanelOff = null; }
$("#colBtn").onclick = () => {
  if (!$("#colPanel").classList.contains("hidden")) { closeColPanel(); return; }
  buildColPanel(); $("#colPanel").classList.remove("hidden");
  colPanelOff = TPA.dismissable($("#colPanel"), closeColPanel, { keep: $("#colBtn") });
};

/* ---------------- 行データ ---------------- */
function emptyRow(no) {
  return { no, equipment: "", unwind: "", thickness: "", width: "", weight: "", off_front_m: "", off_back_m: "",
    off_front_thickness_mm: 0, off_back_thickness_mm: 0, work_date: "", design_split: 1, horizontal_split: 1, vertical_split: 1,
    inner_diameter_mm: "", rewind_master: "" };
}
function emptyRows() { state.rows = Array.from({ length: maxRows() }, (_, i) => emptyRow(i + 1)); }

/* ---------------- テーブル生成 ---------------- */
function hcCls(hc) { return "hc-" + hc; }
/* セルの class（見出しと本文で共通）: 固定列・まとまりの境 */
function cellCls(c, gStart) {
  const stick = c.kind === "no" ? " sticky-l c-no" : (c.key === "equipment" ? " sticky-l c-eq" : "");
  return stick + (gStart.has(c.key) ? " g-start" : "");
}
/* 表示中の列のうち、まとまり（基礎情報／作業実績入力／…）が変わる最初の列 */
function groupStarts(cols) {
  const groupOf = {};
  VIEWS[state.view].groups.forEach((g, i) => g.keys.forEach((k) => { groupOf[k] = i; }));
  const out = new Set();
  cols.forEach((c, i) => { if (i && groupOf[c.key] !== groupOf[cols[i - 1].key]) out.add(c.key); });
  return out;
}
function buildHeader(cols, gStart) {
  $("#wsHead").innerHTML = "<tr>" + cols.map((c) => {
    const drag = FIXED_COLS.has(c.key) ? "" : ` draggable="true" data-col="${c.key}" title="ドラッグで並べ替え（同じまとまりの中）"`;
    return `<th class="${hcCls(c.hc)}${cellCls(c, gStart)}"${drag}><span class="th-name">${c.name}</span>${c.unit ? `<span class="th-unit">${c.unit}</span>` : ""}</th>`;
  }).join("") + "</tr>";
  TPA.dragSort($("#wsHead"), "th[data-col]", { canDrop: sameGroup, onDrop: (k, target, after) => moveCol(state.view, k, target, after) && buildTable() });
}
/* 設備の列を No. の実際の幅だけ右に固定する（表が横に伸びると No. の幅も変わるため測る） */
function pinStickyColumns() {
  const no = $("#wsHead th.c-no");
  if (!no) return;
  $("#ws").style.setProperty("--eq-left", no.getBoundingClientRect().width + "px");
}
window.addEventListener("resize", pinStickyColumns);
function buildTable() {
  const cols = viewCols().map((k) => COL[k]);
  const gStart = groupStarts(cols);
  buildHeader(cols, gStart);
  // colgroup の幅は最小幅。table は width:100% なので余りは各列へ比例して配られる
  const colgroup = "<colgroup>" + cols.map((c) => `<col style="width:${c.w}px">`).join("") + "</colgroup>";
  const ws = $("#ws");
  const old = ws.querySelector("colgroup"); if (old) old.remove();
  ws.insertAdjacentHTML("afterbegin", colgroup);
  ws.style.minWidth = cols.reduce((a, c) => a + c.w, 0) + "px";

  $("#wsBody").innerHTML = state.rows.map((row, idx) => {
    let tds = "";
    cols.forEach((c) => {
      const cls = cellCls(c, gStart);
      if (c.kind === "no") { tds += `<td class="${cls.trim()}">${row.no}</td>`; return; }
      if (c.key === "equipment") { tds += `<td class="${cls.trim()}"><input type="text" data-idx="${idx}" data-key="equipment" value="${esc(row.equipment)}"></td>`; return; }
      if (c.kind === "es") {
        const opts = c.opts.map((o) => `<option value="${o}"${(row[c.key] || "") === o ? " selected" : ""}>${o || c.blank || "―"}</option>`).join("");
        tds += `<td class="edit${cls}"><select data-idx="${idx}" data-key="${c.key}">${opts}</select></td>`; return;
      }
      if (c.kind === "rt") { tds += `<td class="calc ro${cls}" title="LotDsp から取り込んだ値（直しません）">${esc(row[c.key])}</td>`; return; }
      if (c.kind === "et" || c.kind === "en") {
        const t = c.kind === "en" ? "number" : "text";
        const step = c.step ? ` step="${c.step}"` : "";
        tds += `<td class="edit${cls}"><input type="${t}"${step} data-idx="${idx}" data-key="${c.key}" value="${esc(row[c.key])}"></td>`; return;
      }
      const extra = c.kind === "cands" ? " cands" : "";
      tds += `<td class="calc${extra}${cls}" id="c-${row.no}-${c.key}"></td>`;
    });
    return `<tr data-no="${row.no}">${tds}</tr>`;
  }).join("") + `<tr class="fold-row hidden"><td colspan="${cols.length}"><button type="button" class="fold-btn"></button></td></tr>`;
  applyFold();
  pinStickyColumns();
  if (state.result) paintResults(state.result);
}

/* ---------------- 編集（即時反映） ----------------
   入れ物で受ける（イベント委譲）。表は列表示の切替で作り直すが、tbody は同じ要素なので結び直し不要。
   input: 打つたび／change: 選択・スピン・貼り付け・自動入力の確定。どちらでも同じ処理にする。 */
let timer = null;
const RECALC_DELAY_MS = 180;
function scheduleRecalc() { state.calcPending = true; clearTimeout(timer); timer = setTimeout(recalc, RECALC_DELAY_MS); }
function onCellEdit(e) {
  const el = e.target;
  if (!el.matches("input[data-key],select[data-key]")) return;
  const idx = +el.dataset.idx, key = el.dataset.key;
  let v = el.value;
  if (EDIT_NUM.has(key)) v = v === "" ? "" : Number(v);
  if (state.rows[idx][key] === v && e.type === "change") return;   // input で反映済み
  state.rows[idx][key] = v;
  if (AUTO_COLS[key]) { el.classList.remove("auto"); el.closest("td").classList.remove("has-auto"); }   // 手で打った＝手入力
  if (key === "equipment") { fillDefaultUnwind(idx); refreshFoundSelect(); applyFold(); }
  else if (key === "thickness") refreshFoundSelect();   // 板厚が入る＝実績のある工程になり、発見設備に選べる
  scheduleRecalc();
}
function onConditionEdit(e) {
  if (e.target.matches("input.in,select.in")) scheduleRecalc();
}
function bindEditors() {
  ["input", "change"].forEach((type) => {
    $("#wsBody").addEventListener(type, onCellEdit);
    $("#leftPanel").addEventListener(type, onConditionEdit);
  });
}

/* ---------------- 最終設備（KEN）以降の折りたたみ ----------------
   最後に入っている設備が最終設備（検査 KEN）なら、その後に工程は来ない。以降の空き行は畳み、
   表の下の余白を説明パネルへ回す。畳んだ行は 1 行の「開く」で出せる（手で工程を足す場合）。 */
const FINAL_EQUIPMENT = new Set(["KEN"]);
function foldStart() {
  let last = -1;
  state.rows.forEach((r, i) => { if ((r.equipment || "").trim()) last = i; });
  if (last < 0 || last === state.rows.length - 1) return -1;
  return FINAL_EQUIPMENT.has(state.rows[last].equipment.trim().toUpperCase()) ? last + 1 : -1;
}
function applyFold() {
  const start = foldStart();
  const open = !!state.foldOpen;
  const trs = $("#wsBody").querySelectorAll("tr[data-no]");
  trs.forEach((tr, i) => tr.classList.toggle("hidden", start >= 0 && i >= start && !open));
  const fold = $("#wsBody tr.fold-row");
  if (!fold) return;
  fold.classList.toggle("hidden", start < 0);
  if (start < 0) return;
  trs[start - 1].after(fold);
  const n = state.rows.length - start;
  fold.querySelector(".fold-btn").textContent = open
    ? `▴ ${state.rows[start - 1].equipment} 以降の空き行 ${n} 行を畳む`
    : `▾ ${state.rows[start - 1].equipment} で最終工程です（以降の空き行 ${n} 行を畳んでいます）— 開く`;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#wsBody .fold-btn")) return;
  state.foldOpen = !state.foldOpen;
  applyFold();
});

/* 設備を入れた行の巻出し方向が空なら初期値（上）を入れる。表示中のセレクトもそろえる。 */
function fillDefaultUnwind(idx) {
  const row = state.rows[idx];
  const def = (state.config && state.config.default_unwind) || "";
  if (!def || row.unwind || !(row.equipment || "").trim()) return;
  row.unwind = def;
  const sel = $(`#wsBody select[data-idx="${idx}"][data-key="unwind"]`);
  if (sel) sel.value = def;
}

/* ---------------- 発見設備セレクト ---------------- */
/* 発見設備No.: 手ではどの（実績のある）設備でも選べる。自動では「実績の設備のうち、設備マスタで検査計が『有』の最後の設備」
   （検査計のある設備がどこにも無ければ、最後の実績の設備）。自動が働くのは、取り込んだばかり・手でまだ選んでいないとき。
   検査計の有無は設備名の読み替え（同一工程）ごとサーバーに尋ねる（state.meter に覚える）。 */
state.meter = {};            // 設備名 → 検査計があるか
state.foundManual = false;   // 利用者が手で選んだ（取り込み直すまで自動で変えない）
let meterAsking = null;
/* 取り込むときは先に検査計の有無を尋ねてから選ぶ（選んでから選び直して計算を2回しない）。 */
async function ensureMeter(names) {
  const unknown = [...new Set(names.map((n) => String(n || "").trim()).filter(Boolean))].filter((n) => !(n in state.meter));
  if (!unknown.length) return;
  try {
    const d = await (await fetch("/api/equipment/inspection", TPA.json("POST", { names: unknown }))).json();
    Object.assign(state.meter, d.inspection || {});
  } catch (_) { /* 分からなければ検査計なしとして選ぶ */ }
  unknown.forEach((n) => { if (!(n in state.meter)) state.meter[n] = false; });
}
function refreshFoundSelect() {
  const sel = $("#foundEquipment");
  const prev = sel.value;
  const named = state.rows.filter((r) => (r.equipment || "").trim());
  const nameOf = (r) => r.equipment.trim();
  // 設備名だけの行（まだ実績が無い工程）は発見設備にできない（そこでは見つけようがない）。並べるが選べなくする
  const done = (r) => +r.thickness > 0;
  const unknown = [...new Set(named.map(nameOf))].filter((n) => !(n in state.meter));
  sel.innerHTML = named.map((r) => `<option value="${esc(`${r.no}:${r.equipment}`)}"${done(r) ? "" : " disabled"}>${r.no}: ${esc(r.equipment)}`
    + `${done(r) ? "" : "（未実績）"}${state.meter[nameOf(r)] ? "　◉ 検査計" : ""}</option>`).join("");
  const active = named.filter(done);
  const meters = active.filter((r) => state.meter[nameOf(r)]);
  const auto = meters[meters.length - 1] || active[active.length - 1];
  const keep = state.foundManual && active.some((r) => `${r.no}:${r.equipment}` === prev);
  if (keep) sel.value = prev;
  else if (auto) sel.value = `${auto.no}:${auto.equipment}`;
  sel.title = `自動: 実績の設備のうち検査計がある最後の設備${meters.length ? "" : "（検査計のある設備が無いため、最後の実績の設備）"}。手ではどの設備でも選べます（設備マスタの「検査計」）`;
  if (unknown.length && !meterAsking) {
    // 裏で尋ね（尋ね方は取り込み時と同じ ensureMeter）、分かったら選び直す
    meterAsking = ensureMeter(unknown).then(() => {
      const before = $("#foundEquipment").value;
      refreshFoundSelect();
      if ($("#foundEquipment").value !== before) scheduleRecalc();   // 自動で選び直したら計算し直す
    }).finally(() => { meterAsking = null; });
  }
}
$("#foundEquipment").addEventListener("change", () => { state.foundManual = true; });
// 設備マスタを閉じたら検査計の有無を引き直す（直したかもしれない）
document.addEventListener("tpa:masters-closed", () => {
  state.meter = {};
  const before = $("#foundEquipment").value;
  refreshFoundSelect();
  if ($("#foundEquipment").value !== before) scheduleRecalc();
});

/* ---------------- ロットの適用 ---------------- */
function applyLot(d) {
  state.lot = d;
  state.foundManual = false;      // 新しいロットでは発見設備を自動で選び直す
  paintCalcTabLot();
  // 狭い欄でも全文を確かめられるよう、値を title にも入れる
  const set = (id, v) => { const el = $("#" + id); if (el) el.title = el.textContent = (v === "" || v == null) ? "-" : v; };
  set("v_lot_no", d.lot_no); set("v_inspection_no", d.inspection_no); set("v_casting_no", d.casting_no);
  set("v_order_no", d.order_no); set("v_use_code", d.use_code); set("v_use_name", d.use_name);
  set("v_material", d.material); set("v_temper", d.temper);
  set("v_product_thickness", d.product_thickness != null ? fmt(d.product_thickness, 3) : "-");
  set("v_product_width", d.product_width != null ? fmt(d.product_width, 1) : "-");
  set("v_product_length", d.product_length != null ? fmt(d.product_length, 1) : "-");
  paintDensity(+d.density > 0 ? d.density : null, +d.density > 0 ? "lot" : "");
  emptyRows();
  (d.processes || []).slice(0, maxRows()).forEach((p, i) => {
    const row = emptyRow(i + 1);
    Object.keys(row).forEach((k) => { if (p[k] !== undefined && p[k] !== null && p[k] !== "") row[k] = p[k]; });
    // 取込の「後ｵﾌ」が空欄（0）の行は空欄のまま＝エンドバックの自動値を使う（手で入れた 0 とは区別する）
    if (!+row.off_back_m) row.off_back_m = "";
    // まだ実績が無い工程（LotDsp で設計の設備名だけ）: 設備名のほかは空欄のまま＝見て「未実績」と分かる
    if (p.equipment && p.thickness == null) {
      ["unwind", "design_split", "horizontal_split", "vertical_split", "off_front_m", "off_back_m"].forEach((k) => { row[k] = ""; });
    }
    row.no = i + 1; state.rows[i] = row;
  });
}

/* ---------------- 検索 = LotDsp 進度情報から取込 ----------------
   検索ボタンは1つ。押すと入力したロット番号で LotDsp の進度情報を読み、工程を取り込む。
   LotDsp は別サイトで、表はブラウザの中で描かれる。読む道は上から順に試す（runSearch）:
   - LotDsp の API（ログインなし・LotSearch と同じ道。/api/lots/fetch-lotdsp-api・lotdsp_api.py）: 項目名を学び終えたあと
     （画面で読めるたびに同じロットを API でも引いて学ぶ）だけ。速く（1秒ほど）、Edge も要らない。読めなければ次の道へ回す。
   - 見えない Edge（既定・社内のログイン不要な範囲）: アプリがこの PC の Edge を画面に出さずに動かして読む
     （/api/lots/fetch-lotdsp・lotdsp_direct.py）。ログインの欄が出たら押さずに引き返す（kind: login）。
   - LotDsp の窓（ログインが要るとき・VPN）: アプリが Edge を見える窓で開き、利用者がその窓でログインする
     （アプリは ID・パスワードに触れない。ロット番号だけ欄に入れておく）。済めば、続きの検索・読み取りはアプリが行う
     （login_window: true）。ログインが要ったことは覚え、次からは最初から窓で読む（空振りを省く）。
   - どれも使えないとき: 貼り付け（Ctrl+A → Ctrl+C → Ctrl+V）か、保存した HTML ファイル。理由をダイアログで言う。
   どの道も HTML の読み方はサーバー（lotdsp_progress.py）の1箇所。
   以前はブラウザ版だけ、Edge 拡張 LotData-Link の道もあった（版 3.0.0 で外した。窓の道で同じことができる）。 */
const LS_LAST_LOT = "tpa.lastLot.v1";
const LS_ROUTE = "tpa.lotdsp.route.v2";   // {v: "win", at} … ログインが要った（VPN）ので LotDsp の窓を先に使う
const ROUTE_TTL_MS = 12 * 3600 * 1000;      // 覚えておく長さ（VPN の1日のあいだ。社内に戻れば次の日には見えない Edge に戻る）
const directEnabled = () => !state.config || state.config.lotdsp_direct !== false;
/* ログインが要るとき、LotDsp の窓（利用者がログインし、続きはアプリが読む）を使えるか */
const loginWindowOn = () => directEnabled() && !!(state.config && state.config.lotdsp_login_window);
const LOGIN_WINDOW_HINT = "開いた LotDsp の窓で、ID・パスワードを入れてログイン（VPN の画面では「検索」）を押してください。"
  + "ロット番号は入れてあります。済めば、続きはこのアプリが読みます（ID・パスワードはこのアプリでは扱いません）。";
/* LotDsp の API で読める状態か（項目名を学び終えたか）。サーバーが /api/config と取込のあとの状態確認で教える */
const apiReady = () => !!(state.config && state.config.lotdsp_api && state.config.lotdsp_api.ready && state.config.lotdsp_api.enabled);
async function refreshApiStatus() {
  try {
    const r = await fetch("/api/lots/lotdsp-api/status", { cache: "no-store" });
    if (r.ok) { state.config = Object.assign(state.config || {}, { lotdsp_api: await r.json() }); paintLotdspRoute(); }
  } catch (_) { /* 次の取込のあとで確かめる */ }
}
/* 「ログインが要った」をアプリを開き直しても覚える（毎回、見えない Edge で LotDsp を開いてログイン画面を見てから
   窓へ回す空振りを省く）。見えない Edge で読めたら消す。前の版で覚えた "ext"（LotData-Link）は覚えていないものとして扱う。 */
function routeGet() {
  const r = TPA.local.get(LS_ROUTE, null);
  return r && r.v === "win" && Date.now() - r.at < ROUTE_TTL_MS ? r.v : "";
}
function routeSet(v) { v ? TPA.local.set(LS_ROUTE, { v, at: Date.now() }) : TPA.local.remove(LS_ROUTE); }
/* いま「検索」を押すとどの道で読むか。検索欄の下には書かず（画面を静かに保つ）、見出しの「データ元」の札と
   「検索」ボタンのツールチップで言う。貼り付けしか無いとき（設定で切った）だけ札を目立たせる。 */
function paintLotdspRoute() {
  const direct = directEnabled(), win = loginWindowOn();
  const winFirst = win && routeGet() === "win";
  const vpnWay = win ? "LotDsp の窓を開きます（その窓でログインすると、続きはこのアプリが読みます）" : "貼り付けで取り込みます";
  $("#searchBtn").title = (winFirst ? "LotDsp の窓で読みます（ログインが要ったため。ログイン済みならそのまま読みます）"
    : direct ? `このアプリで LotDsp を読みます（社内・ログイン不要）。ログインが要るとき（VPN）は${vpnWay}`
    : "LotDsp の画面を貼り付けて取り込みます（このアプリで読む設定が切ってあります）") + "（Enter でも検索）";
  const badge = $("#modeBadge");
  const api = state.config && state.config.lotdsp_api;
  badge.textContent = apiReady() ? "データ元: LotDsp（API・ログインなし）" : winFirst ? "データ元: LotDsp（窓・ログインは利用者）"
    : direct ? "データ元: LotDsp（直接）" : "データ元: LotDsp（貼り付け）";
  badge.title = apiReady() ? "LotDsp の API をログインなしで読みます（Edge も要りません）。読めないときは、見えない Edge → LotDsp の窓 → 貼り付け の順に回ります。"
    : direct ? (api && api.enabled ? `LotDsp の API を学習中です（画面で読めるたびに同じロットを API でも引いて項目名を覚えます。まだ: ${(api.missing || []).slice(0, 4).join("、") || "—"}）。\n` : "")
      + "社内（ログイン不要）では、このアプリが Edge を画面に出さずに動かして LotDsp を読みます。"
      + (win ? "ログインが要るとき（VPN）は、LotDsp の窓を開きます。その窓でログインすると、続きはこのアプリが読みます（ID・パスワードはこのアプリでは扱いません）。"
        : "ログインが要るとき（VPN）は、貼り付けで取り込みます。")
    : "このアプリで LotDsp を読む設定（lotdsp_import.direct.enabled）が切ってあるため、LotDsp の画面を貼り付けて取り込みます";
  badge.classList.toggle("paste-only", !direct);
}
function loadLastLot() { return TPA.local.getRaw(LS_LAST_LOT, "") || ""; }
function saveLastLot(v) { TPA.local.setRaw(LS_LAST_LOT, v); }
/* 検索欄の下は1行だけ。要ることはアイコンと件数に縮め、中身は畳む（押すと開く）。
   note({ tone: busy|ok|warn, lot, text, chips: [{icon, n, tone, title}], details: [html…], title, open }) */
function note({ tone = "ok", lot = "", text = "", chips = [], details = [], title = "", open = false }) {
  const icon = { busy: '<span class="imp-spin" aria-hidden="true"></span>', ok: '<span class="imp-ic ok" aria-hidden="true">✓</span>',
    warn: '<span class="imp-ic warn" aria-hidden="true">⚠</span>' }[tone] || "";
  const head = `${icon}${lot ? `<b>${esc(lot)}</b>` : ""}<span class="imp-text">${text}</span>`
    + chips.map((c) => `<span class="imp-chip ${c.tone || ""}" title="${esc(c.title)}">${c.icon}${c.n != null ? `<i>${c.n}</i>` : ""}</span>`).join("");
  const t = title ? ` title="${esc(title)}"` : "";
  showImportNote(details.length
    ? `<details class="imp ${tone}"${open ? " open" : ""}><summary${t}>${head}<span class="imp-more" aria-hidden="true"></span></summary><ul>${details.map((d) => `<li>${d}</li>`).join("")}</ul></details>`
    : `<div class="imp ${tone}"${t}>${head}</div>`);
}
function showImportNote(html) { const n = $("#importNote"); n.innerHTML = html; n.classList.remove("hidden"); }
function hideImportNote() { $("#importNote").classList.add("hidden"); }
function lotdspLotNo() { return $("#query").value.trim().toUpperCase(); }

$("#searchBtn").onclick = runSearch;
/* ---------------- 画面の切り替え（最初は異常ロット一覧） ----------------
   一覧でロット番号を押す → 計算画面へ移り、検索欄に入れて「検索」と同じ流れで取り込む。
   計算画面の検索欄からは、これまでどおり直接ロット問い合わせもできる。 */
const SCREENS = { list: { tab: "#tabList", panel: "#lotListScreen" }, calc: { tab: "#tabCalc", panel: "#calcScreen" } };
state.screen = null;
function showScreen(name, { focus = true } = {}) {
  if (!SCREENS[name] || state.screen === name) return;
  const prev = state.screen;
  state.screen = name;
  Object.entries(SCREENS).forEach(([k, v]) => {
    $(v.panel).classList.toggle("hidden", k !== name);
    $(v.tab).setAttribute("aria-selected", k === name ? "true" : "false");
    $(v.tab).tabIndex = k === name ? 0 : -1;
  });
  if (prev === "list") window.LotList.deactivate();
  if (name === "list") {
    window.LotList.activate({ currentLot: (state.lot && state.lot.lot_no) || "" });
    if (focus) window.LotList.focus();
  } else if (focus) { $("#query").focus(); $("#query").select(); }
}
Object.entries(SCREENS).forEach(([k, v]) => { $(v.tab).onclick = () => showScreen(k); });
// タブの並びは ← → でも移れる（WAI-ARIA のタブの作法）。Alt+1 / Alt+2 でどこからでも切り替える
$(".screen-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const next = state.screen === "list" ? "calc" : "list";
  showScreen(next); $(SCREENS[next].tab).focus();
});
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "1") { e.preventDefault(); showScreen("list"); }
  else if (e.key === "2") { e.preventDefault(); showScreen("calc"); }
});
function paintCalcTabLot() {
  const lot = (state.lot && state.lot.lot_no) || "";
  $("#tabCalcLot").textContent = lot;
  $("#tabCalc").title = (lot ? `いま取り込んでいるロット: ${lot}\n` : "") + "転写・ピッチ計算。検索欄でロット番号を直接問い合わせることもできます（Alt+2）";
}
window.LotList.mount({ onPick: (lotNo) => {
  if ($("#searchBtn").disabled) { fail("いまほかのロットを取り込み中です。終わってからもう一度ロット番号を押してください。"); return; }
  showScreen("calc", { focus: false });
  $("#query").value = lotNo; runSearch();
} });
// Enter の続き（keypress）が、開いたモーダルの「中止」を押してしまわないよう既定の動作を止める
$("#query").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("#searchBtn").disabled) { e.preventDefault(); runSearch(); } });
/* LotDsp の API で読む（ログインなし）。読めたら true。該当なしはそのまま言って true（ほかの道でも同じ答え）。
   読めなければ false（呼んだ側が次の道へ回す。理由は画面に出さず、札の学習状態で分かる）。 */
async function fetchViaApi(lotNo) {
  // 速くても数秒かかるので、読んでいるあいだは進行の窓（段階・経過秒・中止）を出す（ほかの道と同じ窓）
  const ctl = new AbortController();
  let cancelled = false;
  clearError(); hideImportNote(); setStatus("LotDsp 取得中", "busy"); $("#searchBtn").disabled = true;
  fetchModal.open(lotNo, "api", "LotDsp の API（ログインなし）", () => { cancelled = true; $("#fetchCancel").disabled = true; ctl.abort(); });
  $("#fetchCancel").disabled = false;
  fetchModal.stage("call");
  let r = null, d = {};
  try {
    r = await fetch("/api/lots/fetch-lotdsp-api", Object.assign(TPA.json("POST", { lot_no: lotNo }), { signal: ctl.signal }));
    d = await r.json();
  } catch (_) { d = { kind: cancelled ? "cancelled" : "network" }; }
  $("#searchBtn").disabled = false;
  if (cancelled) { fetchModal.close(); setStatus("中止", ""); return true; }      // 中止は、ほかの道へ回さない
  if (r && r.ok) {
    fetchModal.stage("import");
    await applyImported(d, lotNo, `LotDsp API・ログインなし・${d.seconds} 秒`);
    fetchModal.close(); return true;
  }
  fetchModal.close();
  if (d.kind === "not_found") { setStatus("待機中"); fail(d.error); return true; }
  setStatus("待機中");
  if (d.kind === "not_ready") refreshApiStatus();      // 学び終えたのに画面が知らなかった／学習が決め直しになった
  return false;
}

async function runSearch() {
  const lotNo = lotdspLotNo();
  if (!lotNo) { fail("ロット番号を入力してください（LotDsp はロット番号で検索します）。"); $("#query").focus(); return; }
  $("#query").value = lotNo;
  if (apiReady() && await fetchViaApi(lotNo)) return;
  if (directEnabled()) fetchDirect(lotNo, routeGet() === "win" && loginWindowOn());
  else openLotdspDialog();
}

/* このアプリだけで読む（サーバーが Edge を画面に出さずに動かす）。読めなければ理由（kind）で次の道へ回す。 */
/* ---- 問い合わせ中のモーダル ----
   読んでいるあいだは画面のほかの所を触れない（inert）。段階・経過秒・つまずいたときの案内・「中止」を出す。
   段階の名前はサーバー（lotdsp_direct.STAGES）に合わせる。 */
const FETCH_STEPS = {
  api: [["call", "LotDsp の API に問い合わせ"], ["import", "取り込み・計算"]],
  direct: [["reach", "LotDsp に届くか"], ["open", "見えない Edge を起動"], ["load", "LotDsp を開く"],
    ["search", "ロット番号で検索"], ["read", "進度情報を読む"], ["import", "取り込み・計算"]],
  win: [["reach", "LotDsp に届くか"], ["open", "LotDsp の窓を開く"], ["load", "LotDsp を開く"], ["login", "窓でログイン（あなた）"],
    ["search", "ロット番号で検索"], ["read", "進度情報を読む"], ["import", "取り込み・計算"]],
};
const fetchModal = {
  t0: 0, timer: 0, onCancel: null, keys: [],
  open(lotNo, route, routeText, onCancel) {
    this.t0 = Date.now(); this.onCancel = onCancel;
    $("#fetchLot").textContent = lotNo;
    this.route(route, routeText);
    $("#fetchHint").classList.add("hidden");
    document.querySelectorAll("body > *:not(#fetchModal)").forEach((el) => { el.inert = true; });
    $("#fetchModal").classList.remove("hidden");
    $("#fetchCancel").disabled = false;       // 前の「中止」で止めたままにしない（止めたボタンにはフォーカスが移らない）
    $("#fetchCancel").focus();
    clearInterval(this.timer);
    const tick = () => { $("#fetchTime").textContent = `${Math.floor((Date.now() - this.t0) / 1000)} 秒`; };
    tick(); this.timer = setInterval(tick, 500);
  },
  route(route, text) {
    this.keys = FETCH_STEPS[route].map((x) => x[0]);
    $("#fetchRoute").textContent = text;
    $("#fetchSteps").innerHTML = FETCH_STEPS[route].map(([k, label]) => `<li data-k="${k}"><i aria-hidden="true"></i>${label}</li>`).join("");
  },
  /* その段階まで済み・その段階が今。skip は飛ばした段階（使い回しで要らなかった）。 */
  stage(key, skip = []) {
    const at = this.keys.indexOf(key);
    if (at < 0) return;
    $("#fetchSteps").querySelectorAll("li").forEach((li, i) => {
      li.className = i < at ? (skip.includes(li.dataset.k) ? "skip" : "done") : i === at ? "now" : "";
    });
  },
  hint(html) { const h = $("#fetchHint"); h.innerHTML = html; h.classList.toggle("hidden", !html); },
  close() {
    clearInterval(this.timer); this.onCancel = null;
    $("#fetchModal").classList.add("hidden");
    document.querySelectorAll("body > *").forEach((el) => { el.inert = false; });
  },
};
// 開いた直後（0.3 秒）の「中止」は受けない（検索を始めた操作の続きで押されてしまうのを防ぐ）
$("#fetchCancel").onclick = () => { if (fetchModal.onCancel && Date.now() - fetchModal.t0 > 300) fetchModal.onCancel(); };
// Esc で中止（フォーカスがどこにあっても。モーダルが出ているときだけ）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#fetchModal").classList.contains("hidden")) return;
  e.preventDefault(); e.stopPropagation(); $("#fetchCancel").click();
}, true);

/* このアプリだけで読む（サーバーが Edge を動かす）。読めなければ理由（kind）で次の道へ回す。
   win: LotDsp の窓で読む（ログインが要れば、窓を前に出して利用者のログインを待つ）。 */
async function fetchDirect(lotNo, win = false) {
  let cancelled = false, sawLogin = false;
  clearError(); hideImportNote(); setStatus("LotDsp 取得中", "busy"); $("#searchBtn").disabled = true;
  fetchModal.open(lotNo, win ? "win" : "direct", win ? "LotDsp の窓（ログインはあなた・続きはこのアプリ）" : "このアプリで直接（社内・ログイン不要）", () => {
    cancelled = true; $("#fetchCancel").disabled = true;
    fetch("/api/lots/fetch-lotdsp/cancel", { method: "POST" }).catch(() => {});
  });
  $("#fetchCancel").disabled = false;
  fetchModal.stage("reach");
  // 段階はサーバーに 0.5 秒ごとに尋ねる（使い回しのときは 接続・起動 を飛ばす）
  const poll = setInterval(async () => {
    try {
      const st = await (await fetch("/api/lots/fetch-lotdsp/status")).json();
      if (!(st.busy && st.stage)) return;
      if (st.stage === "login" && !sawLogin) { sawLogin = true; fetchModal.hint(`🔑 ${esc(LOGIN_WINDOW_HINT)}`); }
      if (sawLogin && st.stage !== "login") fetchModal.hint("");
      // 使い回しのときは 接続・起動 を、ログイン済みなら ログイン を飛ばした段階として見せる
      fetchModal.stage(st.stage, [...(st.reused ? ["reach", "open"] : []), ...(sawLogin ? [] : ["login"])]);
    } catch (_) { /* 次で尋ねる */ }
  }, 500);
  let r = null, d = {};
  try {
    r = await fetch("/api/lots/fetch-lotdsp", TPA.json("POST", { lot_no: lotNo, login_window: win }));
    d = await r.json();
  } catch (e) { d = { error: "アプリに届きません: " + e.message, kind: "network" }; }
  clearInterval(poll);
  $("#searchBtn").disabled = false;
  if (r && r.ok) {
    if (!win) routeSet("");                         // 見えない Edge で読めた＝社内。窓を先に使う覚えは消す
    paintLotdspRoute();
    fetchModal.stage("import", sawLogin ? [] : ["login"]); fetchModal.hint("");
    await applyImported(d, lotNo, `${win ? "LotDsp の窓" : "このアプリで直接"}・${d.seconds} 秒`);
    fetchModal.close(); return;
  }
  const why = d.error || "LotDsp を読めませんでした";
  if (cancelled || d.kind === "cancelled") { fetchModal.close(); setStatus("中止", ""); return; }
  // 該当なし・形の違い・取込中・読み違い は、ほかの道でも同じ答えになるので、そのまま言う
  if (["not_found", "invalid", "busy", "parse", "network"].includes(d.kind)) { fetchModal.close(); fail(why); return; }
  // ログインが要る: LotDsp の窓（利用者がログイン）へ回し、次から最初から窓で読む
  if (d.kind === "login" && !win && loginWindowOn()) { routeSet("win"); paintLotdspRoute(); fetchDirect(lotNo, true); return; }
  fetchModal.close(); setStatus("待機中");
  openLotdspDialog(d.kind === "login"
    ? (win ? `${why}。LotDsp の画面の写しから取り込みます（もう一度「検索」を押すと、LotDsp の窓をまた開きます）。`
      : "LotDsp にログインが要ります（VPN）。このアプリはパスワードを扱わないため、LotDsp の画面の写しから取り込みます。")
    : `このアプリでは読めませんでした（${why}）。LotDsp の画面の写しから取り込みます。`);
}

async function importLotdspHtml(html, lotNo, via) {
  clearError(); setStatus("取込中", "busy");
  try {
    const r = await fetch("/api/lots/import-lotdsp", TPA.json("POST", { html, lot_no: lotNo || "" }));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "取込に失敗しました");
    return await applyImported(d, lotNo, via);
  } catch (e) { hideImportNote(); fail(e.message); return false; }
}
/* 読めたロット（{lot, report}）を表と計算へ。どの道で読んでも同じ。 */
async function applyImported(d, lotNo, via) {
  clearError();
  if (!apiReady() && !String(via).startsWith("LotDsp API")) setTimeout(refreshApiStatus, 4000);   // サーバーが裏で API の項目名を学ぶ（学び終えたら札が変わる）
  await ensureMeter((d.lot.processes || []).map((p) => p.equipment));
  applyLot(d.lot); $("#query").value = d.lot.lot_no || lotNo; saveLastLot($("#query").value);
  refreshFoundSelect(); buildTable(); await recalc();
  paintImportReport(d.report, via);
  setStatus("取込完了", "ok");
  return true;
}

/* 取込の結果は1行: 「✓ ロット n工程」と、気にすべきことだけアイコン＋件数（⚠ 取り込まなかった行・◌ 未実績・⇄ 読み替え）。
   中身は畳む（押すと開く）。出どころ・時刻・巻出し方向の初期値はツールチップ。 */
function paintImportReport(rep, via) {
  const now = new Date();
  const hm = `${TPA.pad2(now.getHours())}:${TPA.pad2(now.getMinutes())}`;
  const list = (xs, f) => xs.map(f).join("、");
  const renamed = rep.renamed || [];
  const skipped = rep.skipped || [], planned = rep.planned || [], warnings = rep.warnings || [];
  const chips = [], details = [];
  if (skipped.length || warnings.length) {
    chips.push({ icon: "⚠", n: skipped.length + warnings.length, tone: "warn", title: "取り込まなかった行・注意（開くと中身）" });
  }
  if (skipped.length) details.push(`<span class="warn">⚠ 取り込まなかった行（設備マスタに無い）: ${list(skipped, (x) => `№${x.no} ${esc(x.equipment)}`)}。要るならマスタ管理で設備を足して取り込み直す</span>`);
  warnings.forEach((w) => details.push(`<span class="warn">⚠ ${esc(w)}</span>`));
  if (planned.length) {
    chips.push({ icon: "◌", n: planned.length, tone: "plan", title: "未実績（設計の設備名だけ入れた行）" });
    details.push(`◌ 未実績（設計の設備名だけ）: ${list(planned, (x) => `№${x.no} ${esc(x.equipment)}`)}`);
  }
  if (renamed.length) {
    chips.push({ icon: "⇄", n: renamed.length, tone: "alias", title: "同一工程として読み替えた設備（設備マスタの「同一工程」）" });
    details.push(`⇄ 読み替え: ${list(renamed, (x) => `№${x.no} ${esc(x.from)}→<b>${esc(x.to)}</b>`)}`);
  }
  note({ tone: skipped.length || warnings.length ? "warn" : "ok", lot: rep.lot_no, text: `${rep.imported.length}工程`, chips, details,
    title: `LotDsp 進度情報（${via}・${hm}）・実績 ${rep.actual_rows} 行・巻出し方向は初期値「${rep.default_unwind}」（違う工程は表で直す）` });
}

/* ---- このアプリで読めないとき: 貼り付け・保存した HTML ---- */
const LOTDSP_DIALOG_WHY = "LotDsp の画面の写しから取り込みます。";
function openLotdspDialog(why) {
  $("#lotdspDialogWhy").innerHTML = why ? esc(why) : LOTDSP_DIALOG_WHY;
  $("#lotdspDialogLot").textContent = lotdspLotNo();
  $("#lotdspPaste").value = "";
  $("#lotdspDialog").classList.remove("hidden");
  $("#lotdspPaste").focus();
}
function closeLotdspDialog() { $("#lotdspDialog").classList.add("hidden"); $("#lotdspFile").value = ""; }
$("#lotdspDialogClose").onclick = closeLotdspDialog;
TPA.layer($("#lotdspDialog"), closeLotdspDialog, { backdrop: false });
$("#lotdspOpenBtn").onclick = () => {
  const url = (state.config && state.config.lotdsp_url) || "";
  if (!url) { fail("LotDsp の場所（appsettings.json の lotdsp_import.url）が設定されていません。"); return; }
  window.open(url, "_blank", "noopener");
};
/* 表のコピーは text/html を優先。無ければタブ区切りの文字を表として渡す（ロットの見出し項目は読めない）。 */
function tsvToTable(text) {
  const rows = String(text || "").split(/\r?\n/).filter((l) => l.includes("\t"));
  return "<table>" + rows.map((l) => "<tr>" + l.split("\t").map((c) => `<td>${esc(c)}</td>`).join("") + "</tr>").join("") + "</table>";
}
$("#lotdspPaste").addEventListener("paste", async (e) => {
  e.preventDefault();
  const cd = e.clipboardData;
  const html = cd.getData("text/html") || tsvToTable(cd.getData("text/plain"));
  if (await importLotdspHtml(html, lotdspLotNo(), "貼り付け")) closeLotdspDialog();
});
$("#lotdspFile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (await importLotdspHtml(await f.text(), lotdspLotNo(), "保存ファイル")) closeLotdspDialog();
});

/* ---------------- 再計算 ---------------- */
const numOrNull = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));
/* 計算に使う工程: 設備名と板厚がある行。設備名だけの行（LotDsp でまだ実績が無い工程）は表に出すだけで計算しない。 */
function activeProcesses() {
  return state.rows.filter((r) => (r.equipment || "").trim() && +r.thickness > 0).map((r) => ({
    no: r.no, equipment: r.equipment, unwind: r.unwind || "",
    thickness: +r.thickness || 0, width: +r.width || 0, weight: +r.weight || 0,
    // 総オフ後: 空欄はサーバが決める（冷延設備で重量が減っていればエンドバックの自動値）。0 は入力として送る
    off_front_m: +r.off_front_m || 0, off_back_m: numOrNull(r.off_back_m),
    inner_diameter_mm: numOrNull(r.inner_diameter_mm),   // 空欄はサーバが決める（設備ごとの既定）
    rewind_master: r.rewind_master || "",                // 空欄はサーバが決める（設備マスタの巻取方向）
    off_front_thickness_mm: +r.off_front_thickness_mm || 0, off_back_thickness_mm: +r.off_back_thickness_mm || 0,
    work_date: r.work_date || "", design_split: +r.design_split || 1,
    horizontal_split: +r.horizontal_split || 1, vertical_split: +r.vertical_split || 1,
  }));
}
/* 応答は届いた順ではなく、頼んだ順の最新だけを使う（速く打つと古い応答が後から届くことがある）。 */
async function recalc() {
  clearTimeout(timer);
  const seq = ++state.calcSeq;
  const procs = activeProcesses();
  if (!procs.length) { setStatus("待機中"); state.result = null; state.calcPending = false; return; }
  const foundVal = $("#foundEquipment").value || `${procs[0].no}:${procs[0].equipment}`;
  clearError(); setStatus("計算中", "busy");
  try {
    const lot = Object.assign({}, state.lot, { processes: procs });   // 比重は取り込んだロットの値（無ければサーバが既定）
    const inputs = {
      found_equipment: foundVal, found_pitch_mm: +$("#pitch").value,
      soil_a_m: numOrNull($("#soilA").value), soil_b_m: numOrNull($("#soilB").value),
      tolerance_percent: +$("#tolerance").value,
    };
    const r = await fetch("/api/calculate", TPA.json("POST", { lot, inputs }));
    const d = await r.json();
    if (seq !== state.calcSeq) return;
    if (!r.ok) throw new Error(d.error || "計算に失敗しました");
    state.calcPending = false;
    state.result = d; paintResults(d); setStatus("解析完了", "ok");
  } catch (e) {
    if (seq !== state.calcSeq) return;
    // 通信そのものの失敗（バックエンド停止）は、つながり次第やり直す（calcPending を残す）
    if (e instanceof TypeError) { setConn(false); fail("アプリの中身（Python）に接続できません。つながると入力中の値で自動で再計算します（戻らないときはアプリを開き直してください）。"); }
    else { state.calcPending = false; fail(e.message); }
  }
}
/* 自動の列（AUTO_COLS）が空欄の行は、サーバが出した自動値を入力欄に入れて「自動」と示す。
   手で打てば手入力の値、消せば自動に戻る（row の値は空のまま＝自動のまま）。 */
function paintAuto(row, p, key) {
  const el = document.querySelector(`#wsBody [data-idx="${row.no - 1}"][data-key="${key}"]`);
  if (!el || document.activeElement === el) return;
  const a = AUTO_COLS[key], blank = row[key] === "" || row[key] == null, autoV = p ? p[a.auto] : null;
  const show = (v) => (a.digits == null ? String(v) : fmt(v, a.digits));          // 字の値はそのまま・数は桁をそろえる
  const unit = a.unit ? ` ${a.unit}` : "";
  const auto = !!p && p[a.source] === "auto" && blank;
  el.classList.toggle("auto", auto);
  el.closest("td").classList.toggle("has-auto", auto);
  if (auto) {
    el.value = a.digits == null ? autoV : Math.round(autoV * 10 ** a.digits) / 10 ** a.digits;
    el.title = `${a.why} ${show(autoV)}${unit}。手で入れるとその値を使います（${a.digits == null ? "「自動」を選ぶ" : "消す"}と自動に戻ります）`;
  } else if (blank) {
    el.value = ""; el.title = "";
  } else {
    el.title = autoV != null && autoV !== "" ? `手入力の値を使っています（${a.manual} ${show(autoV)}${unit}）` : "";
  }
}
/* 比重（基本情報）: 取り込んだ値。無ければ計算の既定値を「既定」の印つきで出す（入力はしない） */
function paintDensity(value, source) {
  const el = $("#v_density");
  el.textContent = value != null ? fmt(value, 3) : "-";
  el.nextElementSibling.textContent = source === "default" ? "既定" : "";
  el.title = source === "lot" ? "LotDsp から取り込んだ比重" : source === "default" ? "取り込んだロットに比重が無いため、設定の既定値で計算しています" : "";
}
const resultByNo = (res) => Object.fromEntries(res.processes.map((p) => [p.no, p]));
function paintResults(res) {
  const byNo = resultByNo(res);
  const foundNo = parseInt($("#foundEquipment").value, 10);
  const cols = viewCols().map((k) => COL[k]);
  state.rows.forEach((row) => {
    const p = byNo[row.no];
    const tr = $(`#wsBody tr[data-no="${row.no}"]`);
    cols.forEach((c) => {
      if (!(c.kind === "calc" || c.kind === "match" || c.kind === "cands")) return;
      const el = document.getElementById(`c-${row.no}-${c.key}`);
      if (!el) return;
      if (!p) { el.innerHTML = ""; el.classList.add("dim"); return; }
      el.classList.remove("dim");
      if (c.kind === "match") el.innerHTML = matchFmt(p);
      else if (c.kind === "cands") el.innerHTML = candFmt(p.roll_candidates);
      else el.innerHTML = c.fmt ? c.fmt(p[c.key], p) : esc(p[c.key]);
    });
    if (tr) { tr.classList.toggle("row-found", !!p && p.no === foundNo); tr.classList.toggle("row-match", !!p && p.transfer_match === true); }
    Object.keys(AUTO_COLS).forEach((k) => paintAuto(row, p, k));
  });
  $("#v_found_thickness").textContent = res.found_thickness_mm ? fmt(res.found_thickness_mm, 3) : "-";
  paintDensity(res.density, res.density_source);
  const matches = res.processes.filter((p) => p.transfer_match === true).length;
  const cands = res.processes.reduce((a, p) => a + (p.roll_candidates ? p.roll_candidates.length : 0), 0);
  $("#k_actual").textContent = res.soil_positions_ready ? fmt(res.actual_transfer_distance_m, 3) : "-";
  $("#k_match").textContent = matches;
  explainUpdate(res);
  $("#k_cand").textContent = cands;
}


/* ---------------- 計算の考え方（3D） ----------------
   表の下の余白に畳み込むパネル。開いている間だけ Three.js（同梱・約 750KB）を読み込む。
   表の行を押すと、その設備を仮の発生設備としたシミュレーションに切り替わる。開閉は利用者ごとに覚える。 */
const LS_EXPLAIN = "tpa.explainOpen.v1";
const explain = { mod: null, loading: null, open: true, selectedNo: null };
function explainOpenSaved() { return TPA.local.getRaw(LS_EXPLAIN) !== "0"; }
function setExplainOpen(open) {
  explain.open = open;
  $(".sheet").classList.toggle("explain-closed", !open);
  $("#explainToggle").setAttribute("aria-expanded", String(open));
  TPA.local.setRaw(LS_EXPLAIN, open ? "1" : "0");
  if (open) explainUpdate(state.result); else if (explain.mod) explain.mod.pause();
}
async function explainModule() {
  if (explain.mod) return explain.mod;
  if (!explain.loading) {
    explain.loading = import(window.EXPLAIN3D_URL).then((m) => {
      explain.mod = m;
      m.mount({ stage: $("#explainStage"), text: $("#explainText"), steps: $("#explainSteps"), menu: $("#explainMenu"),
        onSelect: (no) => { explain.selectedNo = no; } });
      return m;
    });
  }
  return explain.loading;
}
async function explainUpdate(res) {
  if (!explain.open) return;
  try {
    const m = await explainModule();
    const mode = state.view === "pitch" ? "pitch" : "transfer";
    $("#explainSub").textContent = mode === "pitch" ? "ロールの跡のピッチを板でたどり、径の合うロールを絞る（3D）" : "汚れをコイルと展開した板でたどる（3D）";
    m.show(res || null, { selectedNo: explain.selectedNo, tolerance: +$("#tolerance").value, mode });
  } catch (e) {
    $("#explainStage").innerHTML = `<div class="x-empty">3D 表示を読み込めませんでした（${esc(e.message)}）</div>`;
  }
}
$("#explainToggle").onclick = () => setExplainOpen(!explain.open);
/* 右の説明は既定で畳む（文字が多いので、見たいときだけ開く）。開閉は覚える */
const LS_EXPLAIN_TEXT = "tpa.explainText.v1";
function setExplainText(open) {
  $("#explainBody").classList.toggle("text-closed", !open);
  const b = $("#explainTextToggle");
  b.setAttribute("aria-expanded", String(open));
  b.textContent = open ? "説明を閉じる ◂" : "説明を開く ▸";
  TPA.local.setRaw(LS_EXPLAIN_TEXT, open ? "1" : "0");
}
$("#explainTextToggle").onclick = () => setExplainText($("#explainBody").classList.contains("text-closed"));
setExplainText(TPA.local.getRaw(LS_EXPLAIN_TEXT) === "1");
$("#wsBody").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-no]");
  if (!tr || e.target.closest("input,select") || !explain.open) return;
  if (state.view === "pitch") { if (explain.mod) explain.mod.focusTo(+tr.dataset.no); return; }   // ピッチ: その工程を見る
  explain.selectedNo = +tr.dataset.no;                                                             // 転写: 仮の発生設備を切り替え
  explainUpdate(state.result);
});

/* ---------------- CSV 出力（現在の表示列） ---------------- */
$("#exportCsv").onclick = () => {
  if (!state.result) return;
  const byNo = resultByNo(state.result);
  const cols = viewCols().map((k) => COL[k]);
  const head = cols.map((c) => (c.name + (c.unit ? " " + c.unit : "")).trim());
  const lines = [head.join(",")];
  state.rows.forEach((row) => {
    if (!(row.equipment || "").trim()) return;
    const p = byNo[row.no] || {};
    const cells = cols.map((c) => {
      let v;
      if (c.kind === "no") v = row.no;
      else if (["et", "en", "es", "rt"].includes(c.kind)) {
        v = row[c.key];
        // 自動の列は、空欄で自動値を使っている行だけ、表に出ている自動値を書き出す（自動値の無い空欄は空欄のまま）
        const a = AUTO_COLS[c.key];
        if (a && (v === "" || v == null) && p[a.source] === "auto") v = typeof p[c.key] === "number" ? Math.round(p[c.key] * 1000) / 1000 : p[c.key];
      }
      else if (c.key === "roll_candidates") v = (p.roll_candidates || []).map((x) => x.name).join(" / ");
      else if (c.key === "head_tail") v = (HEAD_TAIL[p.head_tail] || [""])[0];
      else if (c.key === "transfer_match") v = (matchOf(p) || [""])[0];
      else { v = p[c.key]; if (typeof v === "number") v = Math.round(v * 1000) / 1000; }
      return `"${v != null ? String(v).replace(/"/g, '""') : ""}"`;
    });
    lines.push(cells.join(","));
  });
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  TPA.download(blob, `転写ピッチ解析_${state.lot.lot_no || "result"}_${state.view}.csv`);
};

/* ---------------- 終了 ----------------
   窓（Rust）が /api/shutdown に答えてから自分で閉じる。中身（Python）は入力が閉じて自分で終わる。 */
$("#quitBtn").onclick = async () => {
  if (!confirm("アプリを終了します。よろしいですか？")) return;
  state.quitting = true;
  if (hbTimer) clearInterval(hbTimer);
  TPA.saveUiState();
  try { await fetch("/api/shutdown", { method: "POST", keepalive: true }); } catch (e) { /* 閉じれば届かない */ }
};

/* 参照先マスタで LotDsp の URL などが変わったら、設定を取り直す（「LotDsp を開く」がすぐ新しい場所を開く）。
   更新の置き場を変えたら、その場で確かめる（ほかの PC は次に確かめるとき＝30 分以内か次の起動で） */
document.addEventListener("tpa:settings-changed", async (e) => {
  if (String((e.detail || {}).key || "").startsWith("update.")) checkUpdateNow();
  try { const r = await fetch("/api/config"); if (r.ok) state.config = await r.json(); } catch (_) { /* 次の起動で読む */ }
  paintLotdspRoute();
});

/* 起動 */
boot();
