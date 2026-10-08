// 2026-10「マスタ管理」の作り直しで比べる案（今の画面への CSS と DOM の組み替えで再現する近似）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-master.mjs --states master,master-paths,master-access,master-presence,master-release
// タブ・表は押すたびに描き直されるので、組み替えは MutationObserver で描き直しのたびに当て直す（watch）。

/** 描き直しのたびに fn(窓) を当てる */
const watch = (fn) => `
  const opts = { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] };
  const apply = () => { const p = document.querySelector("#masterOverlay:not(.hidden) .master-panel"); if (p) { obs.disconnect(); try { (${fn})(p); } finally { obs.observe(document.body, opts); } } };
  const obs = new MutationObserver(apply); obs.observe(document.body, opts);`;

// 共通（どの案でも直す所）: 行の操作を中身のすぐ右に・「—」を読める濃さに・参照先の保存は変えたときだけ主の色に
const FIX = `
  table.master-table { width: auto; max-width: 100%; } table.master-table th.grow, table.master-table td.grow { width: 22em; }
  .m-none { color: #7d8b97; }
  .ps-save:not(.is-dirty) { background: var(--surface); color: var(--muted); border: 1px solid var(--line); }`;

// 区分: データ（取込・計算が使う）／つなぎ先（どこを読むか）／管理（だれが・どの版を）
const GROUPS = `{ equipment: "データ", rolls: "データ", paths: "つなぎ先", access: "管理", presence: "管理", release: "管理" }`;

export const PROPOSALS = [
  { key: "M0", name: "今の形", css: "", ops: [] },
  {
    key: "M1", name: "磨き上げ（タブを区分で区切る・操作を中身の横に）",
    css: FIX + `
      .master-tabs .mg-sep { width: 1px; background: var(--line); margin: 10px 10px; }
      .master-tabs .mg-lab { align-self: center; font-size: 11px; color: var(--muted); font-weight: 700; margin-right: 2px; }`,
    ops: [["script", watch(`(p) => {
      const t = p.querySelector("#masterTabs"); if (t.querySelector(".mg-lab")) return;
      const G = ${GROUPS}; let last = "";
      t.querySelectorAll(".tab").forEach((b) => { const g = G[b.dataset.tab]; if (g !== last) { b.insertAdjacentHTML("beforebegin", (last ? '<span class="mg-sep"></span>' : "") + '<span class="mg-lab">' + g + "</span>"); last = g; } });
    }`)]],
  },
  {
    key: "M2", name: "左の区分つきナビ（データ／つなぎ先／管理）",
    css: FIX + `
      .master-panel { display: grid !important; grid-template-columns: 210px minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
      .master-head { grid-column: 1 / -1; }
      .master-tabs { grid-column: 1; grid-row: 2 / 4; flex-direction: column; gap: 2px; padding: 12px 8px; border-bottom: 0; border-right: 1px solid var(--line); background: var(--surface-2); }
      .master-tabs .tab { border-bottom: 0; border-left: 3px solid transparent; justify-content: space-between; text-align: left; height: 36px; border-radius: 0 6px 6px 0; width: 100%; display: flex; align-items: center; }
      .master-tabs .tab.active { border-left-color: var(--h-input); background: var(--input-soft); }
      .master-tabs .mg-lab { font-size: 11px; color: var(--muted); font-weight: 700; padding: 12px 10px 4px; }
      .master-tabs .mg-lab:first-child { padding-top: 0; }
      .master-toolbar { grid-column: 2; grid-row: 2; }
      .master-table-wrap { grid-column: 2; grid-row: 3; }
      .master-settings { grid-column: 2; grid-row: 2 / 4; }`,
    ops: [["script", watch(`(p) => {
      const t = p.querySelector("#masterTabs"); if (t.querySelector(".mg-lab")) return;
      const G = ${GROUPS}; let last = "";
      t.querySelectorAll(".tab").forEach((b) => { const g = G[b.dataset.tab]; if (g !== last) { b.insertAdjacentHTML("beforebegin", '<span class="mg-lab">' + g + "</span>"); last = g; } });
    }`)]],
  },
  {
    key: "M3", name: "2 段のタブ（区分 → その中のタブ）",
    css: FIX + `
      .mseg { display: flex; gap: 4px; padding: 10px 18px 0; background: var(--surface); }
      .mseg b { padding: 6px 16px; border-radius: 999px; font-size: 13.5px; color: var(--muted); border: 1px solid var(--line); }
      .mseg b.on { background: var(--h-input); color: var(--on-fill); border-color: var(--h-input); }
      .master-tabs .tab.mg-hide { display: none; }`,
    ops: [["script", watch(`(p) => {
      const G = ${GROUPS}; const t = p.querySelector("#masterTabs");
      const cur = G[(t.querySelector(".tab.active") || {}).dataset?.tab] || "データ";
      t.querySelectorAll(".tab").forEach((b) => b.classList.toggle("mg-hide", G[b.dataset.tab] !== cur));
      let seg = p.querySelector(".mseg"); if (!seg) { t.insertAdjacentHTML("beforebegin", '<div class="mseg"></div>'); seg = p.querySelector(".mseg"); }
      const html = ["データ", "つなぎ先", "管理"].map((g) => '<b class="' + (g === cur ? "on" : "") + '">' + g + "</b>").join("");
      if (seg.innerHTML !== html) seg.innerHTML = html;
    }`)]],
  },
  {
    key: "M4", name: "一覧＋右に詳細（行を選ぶと右で直す）",
    css: FIX + `
      .master-panel { display: grid !important; grid-template-columns: minmax(0, 1fr) 380px; grid-template-rows: auto auto auto minmax(0, 1fr); }
      .master-head, .master-tabs, .master-toolbar { grid-column: 1 / -1; }
      .master-table-wrap { grid-column: 1; grid-row: 4; } .master-settings { grid-column: 1 / -1; grid-row: 3 / 5; }
      .mdetail { grid-column: 2; grid-row: 4; border-left: 1px solid var(--line); background: var(--surface-2); padding: 14px 16px; overflow: auto; }
      .mdetail h4 { margin: 0 0 10px; font-size: 15px; } .mdetail label { display: block; font-size: 12px; color: var(--muted); margin-top: 8px; }
      .mdetail .f { height: 30px; border: 1px solid var(--edit-line); background: var(--edit-field); border-radius: 6px; padding: 0 8px; display: flex; align-items: center; font-size: 13.5px; }
      .mdetail .acts { display: flex; gap: 8px; margin-top: 16px; } .mdetail .acts .del { margin-left: auto; color: var(--danger); border: 1px solid var(--danger-line); background: var(--surface); border-radius: 7px; padding: 0 12px; }
      table.master-table td.actions, table.master-table th.actions { display: none; }
      #masterBody tr:first-child td { background: var(--input-soft); }`,
    ops: [["script", watch(`(p) => {
      const wrap = p.querySelector(".master-table-wrap"); let d = p.querySelector(".mdetail");
      if (wrap.classList.contains("hidden")) { if (d) d.remove(); return; }
      const ths = [...p.querySelectorAll("#masterHead th:not(.actions)")].map((th) => th.textContent.trim());
      const tds = [...(p.querySelector("#masterBody tr") || { querySelectorAll: () => [] }).querySelectorAll("td:not(.actions)")].map((td) => td.textContent.trim() || "—");
      const html = "<h4>" + (tds[0] || "") + " を直す</h4>" + ths.map((h, i) => "<label>" + h + '</label><div class="f">' + (tds[i] || "") + "</div>").join("")
        + '<div class="acts"><button class="btn-primary">保存</button><button class="btn-ghost">元に戻す</button><button class="del">削除</button></div>';
      if (!d) { wrap.insertAdjacentHTML("afterend", '<aside class="mdetail"></aside>'); d = p.querySelector(".mdetail"); }
      if (d.innerHTML !== html) d.innerHTML = html;
    }`)]],
  },
  {
    key: "M5", name: "タブの頭に説明の帯（何のための所か＋要点）",
    css: FIX + `
      .mintro { display: flex; align-items: baseline; gap: 14px; padding: 10px 18px; background: var(--surface-2); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ro-ink); }
      .mintro b { font-size: 14.5px; color: var(--ink); }`,
    ops: [["script", watch(`(p) => {
      const T = { equipment: ["設備マスタ", "取込で設備名を読み替え、検査計のある設備を発見設備に選びます"], rolls: ["ロールマスタ", "設備ごとのロールの径・位置。転写ピッチの計算が使います"],
        paths: ["参照先", "一覧・検索が読みに行く場所。変えると全員の PC にすぐ効きます"], access: ["アクセス権限", "だれが・どの PC で・何をできるか"],
        presence: ["利用状況", "だれが・どの PC で・どの版を使っているか"], release: ["アプリの配布", "① 版を置く → ② 配る版を選ぶ → ③ 各 PC がそろう"] };
      const k = (p.querySelector("#masterTabs .tab.active") || {}).dataset?.tab; if (!k) return;
      let m = p.querySelector(".mintro"); if (!m) { p.querySelector("#masterTabs").insertAdjacentHTML("afterend", '<div class="mintro"></div>'); m = p.querySelector(".mintro"); }
      const html = "<b>" + T[k][0] + "</b><span>" + T[k][1] + "</span>"; if (m.innerHTML !== html) m.innerHTML = html;
    }`)]],
  },
];

// ---- 2 回目（1 回目は M2 左の区分つきナビ 75.0 と M4 一覧＋右に詳細 72.0 が僅差 → 複合案 3 つ＋上位 2 案）----
const byKey = (k) => PROPOSALS.find((p) => p.key === k);
const M2 = byKey("M2"), M4 = byKey("M4");
// 参照先を詰める: 説明は 1 行（続きは乗せると出る）、いま効いている値は見出しの横、カードの余白を小さく
const COMPACT = `
  .ps-card { padding: 8px 14px; margin-bottom: 8px; }
  .ps-hint { margin: 2px 0 6px; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
  .ps-card:hover .ps-hint { -webkit-line-clamp: unset; }
  .ps-now { margin-top: 4px; }`;
// 左のナビと右の詳細を同時に（3 列: ナビ｜一覧｜詳細）
const NAV_DETAIL = `
  .master-panel { grid-template-columns: 200px minmax(0, 1fr) 360px !important; grid-template-rows: auto auto minmax(0, 1fr) !important; }
  .master-tabs { grid-column: 1 !important; grid-row: 2 / 4 !important; }
  .master-toolbar { grid-column: 2 / 4 !important; grid-row: 2 !important; }
  .master-table-wrap { grid-column: 2 !important; grid-row: 3 !important; }
  .mdetail { grid-column: 3 !important; grid-row: 3 !important; }
  .master-settings { grid-column: 2 / 4 !important; grid-row: 2 / 4 !important; }`;
PROPOSALS.push(
  { key: "Y1", name: "左ナビ＋右に詳細（M2＋M4）", css: M2.css + M4.css + NAV_DETAIL, ops: [...M2.ops, ...M4.ops] },
  { key: "Y2", name: "左ナビ＋参照先を詰める（M2＋詰め）", css: M2.css + COMPACT, ops: M2.ops },
  { key: "Y3", name: "左ナビ＋右に詳細＋参照先を詰める", css: M2.css + M4.css + NAV_DETAIL + COMPACT, ops: [...M2.ops, ...M4.ops] },
);
