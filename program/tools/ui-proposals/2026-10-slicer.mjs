// 2026-10「スライサー」（任意の列の重複なしの値を並べ、押して絞り込む）で比べる 5 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-slicer.mjs --states list
// 再現は近似: スライサーの見た目と置き場を比べるためのもので、押しても一覧は絞られない（値と件数は試験用の品質データ 1500 行の本物）。
// 状態: 「設備」で CR1・L-1 を選び（387 件）、「不良名」はその絞り込みのもとでの件数を出している。

const SLICERS = [
  { col: "設備", values: [["CR1", 190, 1], ["DL2", 195], ["L-1", 197, 1], ["L-2", 186], ["LS3", 206], ["TLV", 176], ["ＣＲ２", 175], ["ﾛｰﾙ1", 175]] },
  { col: "不良名", values: [["キズ", 56], ["ロール跡", 39], ["打痕", 49], ["汚れ", 43], ["異物", 58], ["ﾍｺﾐ", 42], ["（空欄）", 100]] },
];

/** 共通: スライサーの枠を組み立てて置く。layout は値の並べ方、place は置き場 */
const build = (layout, place, extra = "") => `
  const S = ${JSON.stringify(SLICERS)};
  const card = (s) => '<section class="sx-card"><header><b>' + s.col + '</b>'
    + (s.values.some((v) => v[2]) ? '<span class="sx-n">' + s.values.filter((v) => v[2]).length + ' 選択</span><button class="sx-clr" title="この列の選択を外す">×</button>' : '')
    + '</header><div class="sx-vals">' + s.values.map((v) => '<button class="sx-v' + (v[2] ? ' is-on' : '') + '"><span>' + v[0] + '</span><i>' + v[1] + '</i></button>').join('') + '</div></section>';
  const head = '<div class="sx-head"><b>スライサー</b><span class="sx-place">' + ['左', '右', '上'].map((p) => '<button class="' + (p === '${place}' ? 'is-on' : '') + '">' + p + '</button>').join('') + '</span></div>';
  const pane = document.createElement('aside'); pane.className = 'sx-pane sx-${layout} sx-at-${place}';
  pane.innerHTML = head + S.map(card).join('') + '<button class="sx-add">＋ 列を足す</button>';
  const wrap = document.querySelector('.ll-grid-wrap'), row = document.createElement('div'); row.className = 'sx-row sx-row-${place}';
  wrap.before(row); row.append(pane, wrap);
  document.querySelector('#llCount').textContent = '387件 / 全 1,500件';
  ${extra}`;

const ENTRY = ["insert", '<button type="button" class="sx-entry is-on">▦ スライサー <b>1</b></button>', "afterend", "#llAdhocToggle"];
const BASE = `
  .sx-entry{background:var(--ll-pale)!important;border-color:var(--h-xfer)!important;color:var(--ll-teal-dark)!important;font-weight:700}
  .sx-entry b{display:inline-grid;place-items:center;min-width:18px;height:18px;border-radius:9px;background:var(--h-xfer);color:#fff;font-size:11px;margin-left:4px}
  .sx-row{flex:1;min-height:0;display:flex;gap:0;margin:8px 16px 12px}
  .sx-row .ll-grid-wrap{flex:1;min-width:0;margin:0!important}
  .sx-pane{flex:0 0 auto;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:10px;overflow:auto}
  .sx-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .sx-head b{font-size:13.5px}
  .sx-place{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
  .sx-place button{border:0;background:var(--surface);padding:3px 10px;font-size:12px;color:var(--muted);cursor:pointer}
  .sx-place button.is-on{background:var(--h-input);color:#fff;font-weight:700}
  .sx-card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px}
  .sx-card header{display:flex;align-items:center;gap:6px;margin-bottom:6px}
  .sx-card header b{font-size:13px}
  .sx-n{margin-left:auto;font-size:11.5px;color:var(--h-input);font-weight:700}
  .sx-clr{border:1px solid var(--line);background:var(--surface);border-radius:6px;width:22px;height:22px;cursor:pointer;color:var(--muted)}
  .sx-v{display:flex;align-items:center;justify-content:space-between;gap:6px;border:1px solid var(--line);background:var(--surface);border-radius:6px;padding:3px 8px;font-size:12.5px;cursor:pointer;color:var(--ink)}
  .sx-v i{font-style:normal;color:var(--muted);font-variant-numeric:tabular-nums;font-size:11.5px}
  .sx-v.is-on{background:var(--h-input);border-color:var(--h-input);color:#fff;font-weight:700}
  .sx-v.is-on i{color:#dbe7f3}
  .sx-add{border:1px dashed var(--line);background:none;border-radius:7px;padding:6px;color:var(--h-input);cursor:pointer;font-size:12.5px}
  .sx-row-右{flex-direction:row-reverse}.sx-row-右 .sx-pane{margin-left:10px}.sx-row-左 .sx-pane{margin-right:10px}
  .sx-row-上{flex-direction:column}.sx-row-上 .sx-pane{margin-bottom:10px}`;

export const PROPOSALS = [
  { key: "N0", name: "今の形（スライサー無し）", css: "", ops: [] },
  {
    key: "N1", name: "左の縦帯・値を 1 行ずつ（Excel 型）",
    css: BASE + `.sx-list{width:230px}.sx-list .sx-vals{display:flex;flex-direction:column;gap:3px}`,
    ops: [ENTRY, ["script", build("list", "左")]],
  },
  {
    key: "N2", name: "左の縦帯・値をタイル（2 列の格子）",
    css: BASE + `.sx-tile{width:250px}.sx-tile .sx-vals{display:grid;grid-template-columns:1fr 1fr;gap:4px}
      .sx-tile .sx-v{flex-direction:column;align-items:flex-start;gap:0;padding:4px 8px}`,
    ops: [ENTRY, ["script", build("tile", "左")]],
  },
  {
    key: "N3", name: "上の横帯・値をチップで折り返す",
    css: BASE + `.sx-chip{flex-direction:row;align-items:flex-start;flex-wrap:wrap}.sx-chip .sx-head{flex-direction:column;align-items:flex-start;width:90px}
      .sx-chip .sx-card{flex:0 1 420px}.sx-chip .sx-vals{display:flex;flex-wrap:wrap;gap:4px}.sx-chip .sx-v{border-radius:999px}
      .sx-chip .sx-add{align-self:center}`,
    ops: [ENTRY, ["script", build("chip", "上")]],
  },
  {
    key: "N4", name: "左の縦帯・畳めるカード＋件数の行に選んだ値の札",
    css: BASE + `.sx-fold{width:220px}.sx-fold .sx-vals{display:flex;flex-direction:column;gap:2px}
      .sx-fold .sx-card:not(:first-of-type) .sx-vals{display:none}.sx-fold .sx-card header::after{content:"▾";color:var(--muted);margin-left:4px}
      .sx-fold .sx-card:not(:first-of-type) header::after{content:"▸"}
      .sx-sum{display:inline-flex;gap:4px;align-items:center;margin-left:10px}.sx-sum i{font-style:normal;background:var(--input-soft);color:var(--h-input);border-radius:999px;padding:1px 10px;font-weight:700;font-size:12px}`,
    ops: [ENTRY, ["script", build("fold", "左", `document.querySelector('#llCount').insertAdjacentHTML('afterend', '<span class="sx-sum"><i>設備: CR1・L-1 ×</i></span>');`)]],
  },
  {
    key: "N5", name: "表の上に浮かぶスライサーの小窓（動かせる）",
    css: BASE + `.sx-float{position:fixed;left:60px;top:300px;width:230px;z-index:60;box-shadow:0 18px 40px rgba(10,30,45,.28);max-height:620px}
      .sx-float .sx-vals{display:flex;flex-direction:column;gap:3px}.sx-row .sx-float{margin:0}`,
    ops: [ENTRY, ["script", build("float", "左")]],
  },
];
