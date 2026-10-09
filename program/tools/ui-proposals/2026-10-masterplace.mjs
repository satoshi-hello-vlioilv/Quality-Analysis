// 2026-10「マスタの置き場（共有フォルダ）を画面から変える」入口と形の 5 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-masterplace.mjs --states master,master-paths
// 再現は近似: 入口の場所と、開いたときの形（配布の置き場を変えると同じ「場所＋名前・木・写す」）を比べる。押しても動かない。

const FORM = `
  <div class="mp-form">
    <div class="mp-cur"><span>いまの置き場</span><b>この PC の中だけ（手元のみ）</b></div>
    <div class="mp-grid"><label>置く場所（上のフォルダ）<input class="ps-input" value="\\\\\\\\nlmsrvngy03\\\\工場内共有\\\\検査データ"></label><span>\\\\</span>
      <label>フォルダの名前<input class="ps-input" value="Masters"></label></div>
    <ul class="mp-tree"><li>📁 \\\\\\\\nlmsrvngy03\\\\工場内共有\\\\検査データ<ul><li class="is-new">📁 <b>Masters</b><em>← この PC のマスタを写す（6 ファイル・84 KB）</em></li></ul></li></ul>
    <p class="mp-ok">✓ 書き込めます。写したあと、全員の PC が次に開いたとき（5 秒ごとに確かめます）から新しい置き場を見ます。</p>
    <div class="mp-acts"><button class="btn-primary">写して、この置き場に変える</button><button class="pz-btn">やめる</button></div>
  </div>`.replace(/\n/g, "");
const CSS = `
  .mp-form{display:grid;gap:8px;font-size:13px}
  .mp-cur{display:flex;gap:10px;align-items:center}.mp-cur span{color:var(--muted);font-size:12px}
  .mp-grid{display:grid;grid-template-columns:1fr auto 220px;gap:8px;align-items:end}.mp-grid label{display:grid;gap:3px;color:var(--muted);font-size:12px}
  .mp-tree{list-style:none;margin:0;padding:8px 12px;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;font-size:12.5px}
  .mp-tree ul{list-style:none;padding-left:18px;margin:2px 0}.mp-tree .is-new b{color:var(--h-input)}.mp-tree em{font-style:normal;color:var(--h-input);margin-left:8px;font-size:12px}
  .mp-ok{margin:0;color:var(--ok-ink);font-size:12.5px}.mp-acts{display:flex;gap:8px}`;
const onTab = (tab, fn) => `new MutationObserver(() => { const t = document.querySelector('#masterTabs .tab.active'); if (t && t.dataset.tab === '${tab}') (${fn})(); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });`;

export const PROPOSALS = [
  { key: "Q0", name: "今の形（参照先の一番下に置き場を出すだけ・設定ファイルで変える）", css: "", ops: [] },
  {
    key: "Q1", name: "参照先の先頭に「マスタの置き場」のカード（押すと形が開く）",
    css: CSS + `.mp-card{border-left-color:var(--h-input)!important}`,
    ops: [["script", onTab("paths", `() => { const b = document.querySelector('#masterSettings'); if (!b || b.querySelector('.mp-card')) return; const lead = b.querySelector('.ps-lead'); lead.insertAdjacentHTML('afterend', '<section class="ps-card mp-card"><div class="ps-head"><b>マスタの置き場（共有フォルダ）</b><span class="ps-badge default">手元のみ</span></div>${FORM}</section>'); }`)]],
  },
  {
    key: "Q2", name: "見出しの帯の「手元のみ ▾」を押すと、帯の下に形が開く",
    css: CSS + `.mp-band{grid-column:1/-1;padding:12px 18px;background:#eef4fa;border-bottom:1px solid var(--line)}.place-tag::after{content:" ▾"}`,
    ops: [["script", `new MutationObserver(() => { const h = document.querySelector('#masterOverlay:not(.hidden) .master-head'); if (h && !document.querySelector('.mp-band')) h.insertAdjacentHTML('afterend', '<div class="mp-band">${FORM}</div>'); }).observe(document.body, { subtree: true, childList: true, attributes: true });`]],
  },
  {
    key: "Q3", name: "左のナビの「管理」に「マスタの置き場」の頁",
    css: CSS + `.mp-page{grid-column:2/4;grid-row:2/4;padding:18px;overflow:auto;background:var(--surface)}.mp-page h3{margin:0 0 10px;font-size:15px}
      .mp-nav{color:var(--h-input)!important;background:var(--input-soft)!important;border-left-color:var(--h-input)!important}`,
    ops: [["script", `new MutationObserver(() => { const t = document.querySelector('#masterTabs'); if (t && !t.querySelector('.mp-nav')) { t.querySelector('[data-tab="access"]')?.insertAdjacentHTML('beforebegin', '<button class="tab mp-nav">マスタの置き場</button>'); } const p = document.querySelector('#masterOverlay:not(.hidden) .master-panel'); if (p && !p.querySelector('.mp-page')) p.insertAdjacentHTML('beforeend', '<section class="mp-page"><h3>マスタの置き場</h3>${FORM}</section>'); }).observe(document.body, { subtree: true, childList: true });`]],
  },
  {
    key: "Q4", name: "見出しの帯に「置き場を変える…」→ 小窓",
    css: CSS + `.mp-modal{position:fixed;inset:0;z-index:80;background:rgba(15,30,45,.45);display:grid;place-items:center}
      .mp-modal > div{width:720px;background:var(--surface);border-radius:12px;padding:16px 18px;box-shadow:var(--shadow)}.mp-modal h3{margin:0 0 10px}
      .mp-hbtn{height:24px;border:1px solid var(--on-dark-line);border-radius:6px;background:var(--on-dark-fill);color:var(--on-fill);font-size:12px;padding:0 10px}`,
    ops: [["script", `new MutationObserver(() => { const pl = document.querySelector('#masterOverlay:not(.hidden) #masterPlace'); if (pl && !document.querySelector('.mp-modal')) { pl.insertAdjacentHTML('beforeend', '<button class="mp-hbtn">置き場を変える…</button>'); document.body.insertAdjacentHTML('beforeend', '<div class="mp-modal"><div><h3>マスタの置き場を変える</h3>${FORM}</div></div>'); } }).observe(document.body, { subtree: true, childList: true });`]],
  },
  {
    key: "Q5", name: "参照先の一番下のカードに、形をそのまま開く（今の場所のまま）",
    css: CSS,
    ops: [["script", onTab("paths", `() => { const b = document.querySelector('#masterSettings'); const c = b && [...b.querySelectorAll('.ps-card.is-readonly')][0]; if (!c || c.querySelector('.mp-form')) return; c.querySelector('.ps-hint').outerHTML = '${FORM}'; b.scrollTop = b.scrollHeight; }`)]],
  },
];
