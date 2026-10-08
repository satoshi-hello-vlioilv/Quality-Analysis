// 2026-10「表示列の設定」の作り直しで比べる案（今の画面への CSS と DOM の組み替えで再現する近似）。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-columns.mjs --states columns,columns-detail
// 窓は開いたときに作られ、触るたびに描き直されるので、組み替えは MutationObserver で描き直しのたびに当て直す（watch）。

/** 描き直しのたびに fn を当てる（窓ができる前でもよい） */
const watch = (fn) => `
  const apply = () => { const p = document.querySelector("#llColumnPanel"); if (p && !p.hidden) { obs.disconnect(); try { (${fn})(p); } finally { obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] }); } } };
  const obs = new MutationObserver(apply); obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });`;

// 共通: 0 件の札・長い説明を出さない（どの案でも同じに直す所）
const QUIET = `.lc-lead { display: none; } #lcChips .lc-chip:disabled { display: none; } .lc-listhead > span:first-of-type { font-size: 0; }
  .lc-listhead > span:first-of-type::before { content: "列（ドラッグで並べ替え）"; font-size: 11.5px; } .lc-grip { color: #6b7a86; }`;

export const PROPOSALS = [
  {
    key: "C0", name: "今の形",
    css: "", ops: [],
  },
  {
    key: "C1", name: "磨き上げ（段は畳む・保存を主に）",
    css: QUIET + `
      .lc-step:not(.is-open) > :not(h4) { display: none; }
      .lc-step h4 { cursor: pointer; } .lc-step h4::after { content: "▸"; margin-left: auto; color: var(--muted); }
      .lc-step.is-open h4::after { content: "▾"; }
      .lc-presets { display: none; }
      .lc-foot #lcSave { height: 36px; padding: 0 26px; font-size: 14px; }
      .lc-foot .lc-more { order: -1; }`,
    ops: [["script", watch(`(p) => {
      p.querySelectorAll(".lc-step").forEach((s, i) => { if (!s.dataset.v) { s.dataset.v = 1; if (i === 0) s.classList.add("is-open"); } });
      const f = p.querySelector(".lc-foot"); if (!f.querySelector(".lc-more")) f.insertAdjacentHTML("afterbegin", '<button class="lc-more">保存した設定・書き出し ▾</button>');
    }`)]],
  },
  {
    key: "C2", name: "右をタブに（見せ方｜書式｜読み替え｜式）",
    css: QUIET + `
      .lc-tabs { display: flex; gap: 2px; border-bottom: 2px solid var(--line); margin: -4px 0 10px; position: sticky; top: -12px; background: var(--surface-1); z-index: 2; }
      .lc-tabs b { padding: 8px 14px; font-size: 13px; color: var(--muted); border-bottom: 3px solid transparent; margin-bottom: -2px; }
      .lc-tabs b.on { color: var(--h-input); border-color: var(--h-input); }
      .lc-step:not(:first-of-type) { display: none; } .lc-result { display: grid !important; }
      .lc-presets { display: none; }`,
    ops: [["script", watch(`(p) => {
      const r = p.querySelector("#lcDetail"), card = r.querySelector(".lc-card");
      if (card && !r.querySelector(".lc-tabs")) card.insertAdjacentHTML("afterend", '<div class="lc-tabs"><b class="on">見せ方</b><b>値の整え方</b><b>読み替え</b><b>式</b></div>');
    }`)]],
  },
  {
    key: "C3", name: "表一体（列ごとの行で直接変える）",
    css: QUIET + `
      .lc-body { grid-template-columns: minmax(0, 1fr) !important; } .lc-right { display: none; }
      .lc-listhead { grid-template-columns: 28px 230px 170px 110px 120px 150px minmax(0, 1fr) !important; }
      .lc-row { grid-template-columns: 22px 18px 214px 170px 110px 120px 150px minmax(0, 1fr) !important; }
      .lc-row .lc-x1 { height: 26px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; display: flex; align-items: center; font-size: 12.5px; color: var(--muted); background: var(--surface); }
      .lc-presets { display: none; }`,
    ops: [["script", watch(`(p) => {
      const h = p.querySelector(".lc-listhead");
      if (h && !h.dataset.v) { h.dataset.v = 1; h.querySelectorAll("span")[1].remove(); h.insertAdjacentHTML("beforeend", "<span>表示名</span><span>幅</span><span>揃え</span><span>値の整え方</span><span>見え方（実データ）</span>"); }
      p.querySelectorAll(".lc-row").forEach((row) => {
        if (row.dataset.v) return; row.dataset.v = 1;
        const sample = row.lastElementChild; const name = row.querySelector(".lc-name")?.textContent.trim() || "";
        sample.insertAdjacentHTML("beforebegin", '<span class="lc-x1">' + name + '</span><span class="lc-x1">自動</span><span class="lc-x1">自動 ▾</span><span class="lc-x1">そのまま ▾</span>');
      });
    }`)]],
  },
  {
    key: "C4", name: "一覧を主に・詳細は右から引き出す",
    css: QUIET + `
      .lc-body { grid-template-columns: minmax(0, 1fr) !important; position: relative; }
      .lc-right { position: absolute; right: 0; top: 0; bottom: 0; width: 460px; box-shadow: -12px 0 28px rgba(12, 34, 48, .18); border-left: 1px solid var(--line); z-index: 3; }
      .lc-presets { display: none; }`,
    ops: [],
  },
  {
    key: "C5", name: "段取り型（① 列と並び → ② 1列の見え方 → ③ 保存）",
    css: QUIET + `
      .lc-steps { display: flex; gap: 0; padding: 10px 16px 0; background: var(--surface); }
      .lc-steps b { flex: 1; padding: 9px 12px; border-bottom: 3px solid var(--line); color: var(--muted); font-size: 13px; }
      .lc-steps b.on { color: var(--h-input); border-color: var(--h-input); }
      .lc-steps b i { font-style: normal; display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--line); color: var(--ink); margin-right: 6px; font-size: 11px; }
      .lc-steps b.on i { background: var(--h-input); color: var(--on-fill); }
      .lc-body { grid-template-columns: minmax(0, 1fr) !important; }
      #llColumnPanel:not(.is-detail) .lc-right { display: none; }
      #llColumnPanel.is-detail .lc-left { display: none; }
      .lc-presets { display: none; }`,
    ops: [["script", watch(`(p) => {
      if (!p.querySelector(".lc-steps")) p.querySelector(".lc-body").insertAdjacentHTML("beforebegin", '<div class="lc-steps"><b class="on"><i>1</i>出す列と並び</b><b><i>2</i>1 列の見え方</b><b><i>3</i>保存・ほかの PC へ</b></div>');
      const sel = !!p.querySelector(".lc-row.is-focus[data-col='発生日']");
      p.classList.toggle("is-detail", sel);
      p.querySelectorAll(".lc-steps b").forEach((b, i) => b.classList.toggle("on", i === (sel ? 1 : 0)));
    }`)]],
  },
];

// ---- 2 回目の複合案（1 回目は C1 と C2 が僅差） ----
// 畳んだ段・タブに「いまの値」を添える（段の中の選ばれた札・入れた値から作る）
const SUMMARY = `(p) => {
  const sum = (s) => { const r = s.querySelector("input[type=radio]:checked"); const t = s.querySelector("textarea, input[type=text]");
    const v = r ? r.closest("label")?.textContent.trim() : t && t.value ? t.value : ""; return v || "既定のまま"; };
  return [...p.querySelectorAll(".lc-step")].map((s) => [s, sum(s)]);
}`;
const OPEN_FIRST = `p.querySelectorAll(".lc-step").forEach((s, i) => { if (!s.dataset.v) { s.dataset.v = 1; if (i === 0) s.classList.add("is-open"); } });`;
const FOLD_CSS = `.lc-step:not(.is-open) > :not(h4) { display: none; }
  .lc-step h4 { cursor: pointer; } .lc-step h4::after { content: "▸"; margin-left: 8px; color: var(--muted); }
  .lc-step.is-open h4::after { content: "▾"; }
  .lc-step h4 .lc-now { margin-left: auto; font-weight: 400; font-size: 12px; color: var(--ll-teal-dark); background: var(--ll-pale); border-radius: 999px; padding: 1px 9px; }
  .lc-presets { display: none; }
  .lc-foot #lcSave { height: 36px; padding: 0 26px; font-size: 14px; }`;
const FOLD_OPS = (extra = "") => [["script", watch(`(p) => {
  ${OPEN_FIRST}
  (${SUMMARY})(p).forEach(([s, v]) => { const h = s.querySelector("h4"); let c = h.querySelector(".lc-now"); if (!c) { c = document.createElement("span"); c.className = "lc-now"; h.append(c); } if (c.textContent !== v) c.textContent = v; });
  const f = p.querySelector(".lc-foot"); if (!f.querySelector(".lc-more")) f.insertAdjacentHTML("afterbegin", '<button class="lc-more">保存した設定・書き出し ▾</button>');
  ${extra}
}`)]];

PROPOSALS.push(
  {
    key: "X1", name: "C1＋畳んだ段に「いまの値」",
    css: QUIET + FOLD_CSS, ops: FOLD_OPS(),
  },
  {
    key: "X2", name: "X1＋一覧に変えた印・表示名をその場で",
    css: QUIET + FOLD_CSS + `
      .lc-row { grid-template-columns: 22px 18px minmax(0, 1fr) 150px minmax(0, .8fr) !important; }
      .lc-listhead { grid-template-columns: 28px minmax(0, 1fr) 150px minmax(0, .8fr) !important; }
      .lc-row .lc-inl { height: 24px; border: 1px solid transparent; border-radius: 6px; padding: 0 6px; display: flex; align-items: center; font-size: 12.5px; color: var(--muted); }
      .lc-row:hover .lc-inl, .lc-row.is-focus .lc-inl { border-color: var(--line); background: var(--surface); }
      .lc-row .lc-chg { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); display: inline-block; margin-left: 6px; }`,
    ops: FOLD_OPS(`
      const h = p.querySelector(".lc-listhead"); if (h && !h.dataset.v) { h.dataset.v = 1; h.lastElementChild.insertAdjacentHTML("beforebegin", "<span>表示名</span>"); }
      p.querySelectorAll(".lc-row").forEach((row, i) => { if (row.dataset.v) return; row.dataset.v = 1;
        const n = row.querySelector(".lc-name"); row.lastElementChild.insertAdjacentHTML("beforebegin", '<span class="lc-inl">' + n.textContent.trim() + '</span>');
        if (i === 1 || i === 4) n.insertAdjacentHTML("beforeend", '<i class="lc-chg" title="この列は見え方を変えています"></i>'); });`),
  },
  {
    key: "X3", name: "C2＋タブに「いまの値」・結果はいつも下",
    css: QUIET + `
      .lc-tabs { display: flex; gap: 2px; border-bottom: 2px solid var(--line); margin: -4px 0 10px; }
      .lc-tabs b { padding: 6px 12px; font-size: 13px; color: var(--muted); border-bottom: 3px solid transparent; margin-bottom: -2px; display: grid; }
      .lc-tabs b small { font-weight: 400; font-size: 11px; color: var(--ll-teal-dark); }
      .lc-tabs b.on { color: var(--h-input); border-color: var(--h-input); }
      .lc-step:not(:first-of-type) { display: none; } .lc-result { display: grid !important; }
      .lc-presets { display: none; }`,
    ops: [["script", watch(`(p) => {
      const r = p.querySelector("#lcDetail"), card = r.querySelector(".lc-card"); if (!card) return;
      const vals = (${SUMMARY})(p).map(([, v]) => v);
      const html = '<div class="lc-tabs">' + ["見せ方", "式", "値の整え方", "読み替え"].map((t, i) => '<b class="' + (i ? "" : "on") + '">' + t + '<small>' + (vals[i] || "") + '</small></b>').join("") + '</div>';
      const old = r.querySelector(".lc-tabs"); if (!old) card.insertAdjacentHTML("afterend", html); else if (old.outerHTML !== html) old.outerHTML = html;
    }`)]],
  },
);
