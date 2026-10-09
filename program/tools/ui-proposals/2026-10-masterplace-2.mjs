// 2026-10「マスタの置き場」2 回目（1 回目が僅差: Q3 80・Q1 76）。上位 2 案と複合 3 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-masterplace-2.mjs --states master,master-release,master-paths
// 頁の再現は「アプリの配布」の頁（同じ #masterSettings）を置き場の頁に差し替えて撮る（master-release の状態）。
import { PROPOSALS as R1 } from "./2026-10-masterplace.mjs";

const q = (k) => R1.find((p) => p.key === k);
const FORM = `
  <div class="mp-form">
    <div class="mp-grid"><label>置く場所（上のフォルダ）<input class="ps-input" value="\\\\\\\\nlmsrvngy03\\\\工場内共有\\\\検査データ"></label><span>\\\\</span>
      <label>フォルダの名前<input class="ps-input" value="Masters"></label></div>
    <ul class="mp-tree"><li>📁 \\\\\\\\nlmsrvngy03\\\\工場内共有\\\\検査データ<ul><li class="is-new">📁 <b>Masters</b><em>← この PC のマスタを写す（6 ファイル・84 KB）</em></li></ul></li></ul>
    <p class="mp-ok">✓ 書き込めます。写したあと、ほかの PC はマスタを読みに行くついでに（5 秒ごと）新しい置き場へ移ります。前の置き場のマスタは消しません。</p>
    <div class="mp-acts"><button class="btn-primary">写して、この置き場に変える</button></div>
  </div>`.replace(/\n/g, "");
const CUR = `<div class="mp-now"><span class="place-tag local">手元のみ</span><div><b>この PC の中だけ</b><small>アプリの data/ に保存。ほかの PC とは共有していません。共有するには、下で共有フォルダを選びます。</small></div></div>`;
const CSS = R1[1].css.replace(".mp-card{border-left-color:var(--h-input)!important}", "") + `
  .mp-page{display:grid;gap:14px;max-width:980px}.mp-page h3{margin:0;font-size:16px}.mp-page h4{margin:0;font-size:13.5px;color:var(--muted)}
  .mp-now{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px}
  .mp-now b{display:block;font-size:14px}.mp-now small{color:var(--muted);font-size:12.5px}
  .mp-sec{display:grid;gap:8px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .mp-hist{margin:0;padding-left:18px;color:var(--muted);font-size:12.5px}`;
const navActive = (label, before) => `const t = document.querySelector('#masterTabs'); if (t && !t.querySelector('.mp-nav')) { t.querySelectorAll('.tab').forEach((b) => b.classList.remove('active')); t.querySelector('[data-tab="${before}"]')?.insertAdjacentHTML('beforebegin', '<button class="tab active mp-nav">${label}</button>'); }`;
const page = (inner, label, before) => `new MutationObserver(() => { const a = document.querySelector('#masterTabs .tab.active'); if (!a || (a.dataset.tab !== 'release' && !a.classList.contains('mp-nav'))) return; const b = document.querySelector('#masterSettings'); if (!b || b.querySelector('.mp-page')) return; b.innerHTML = '<section class="mp-page">${inner}</section>'; ${navActive(label, before)} }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });`;
const PAGE = `<h3>マスタの置き場</h3>${CUR}<div class="mp-sec"><h4>置き場を変える</h4>${FORM}</div>`;
const HEAD_LINK = `new MutationObserver(() => { const pl = document.querySelector('#masterOverlay:not(.hidden) #masterPlace'); if (pl && !pl.querySelector('.mp-link')) pl.insertAdjacentHTML('beforeend', '<button class="mp-link">置き場を変える ›</button>'); }).observe(document.body, { subtree: true, childList: true });`;
const LINK_CSS = `.mp-link{height:24px;border:1px solid var(--on-dark-line);border-radius:999px;background:var(--on-dark-fill);color:var(--on-fill);font-size:12px;padding:0 10px;margin-left:8px;cursor:pointer}`;

export const PROPOSALS = [
  { key: "Q3", name: "（1 回目 1 位）ナビの「管理」に専用の頁", css: CSS, ops: [["script", page(PAGE, "マスタの置き場", "access")]] },
  { ...q("Q1"), name: "（1 回目 2 位）参照先の先頭にカード" },
  {
    key: "R1", name: "専用の頁＋見出しの帯の「置き場を変える ›」（頁へ飛ぶ）",
    css: CSS + LINK_CSS, ops: [["script", page(PAGE, "マスタの置き場", "access")], ["script", HEAD_LINK]],
  },
  {
    key: "R2", name: "専用の頁を「つなぎ先」に（参照先の隣）＋見出しの帯から飛ぶ",
    css: CSS + LINK_CSS, ops: [["script", page(PAGE, "マスタの置き場", "access").replace(`[data-tab="access"]`, `[data-tab="paths"]`)], ["script", HEAD_LINK]],
  },
  {
    key: "R3", name: "専用の頁（いまの置き場・変える・これまでの置き場）＋帯から飛ぶ＋ナビに状態の点",
    css: CSS + LINK_CSS + `.mp-nav::after{content:"手元";margin-left:auto;font-size:10.5px;padding:0 6px;border-radius:999px;background:#fff3d6;color:#8a5a00}`,
    ops: [["script", page(PAGE + `<div class="mp-sec"><h4>これまでの置き場（前の置き場のマスタは残してあります）</h4><ul class="mp-hist"><li>まだ変えていません</li></ul></div>`, "マスタの置き場", "access")], ["script", HEAD_LINK]],
  },
];
