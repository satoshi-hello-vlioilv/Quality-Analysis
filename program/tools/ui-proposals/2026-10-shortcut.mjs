// 2026-10 の「ショートカットを作る入口」で比べた 5 案を、今の画面（右上の「アプリ」＋欠けたときの点。版 3.13.0 で採った S6）への
// CSS と DOM の組み替えで再現する。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-shortcut.mjs --states list,appmenu
// 再現は近似: 置き場・常に見えるか・目立たせ方の違いを見るためのもので、押しても動かない（見た目だけ）。

const NO_APP = "#appBtn, #appMenu { display: none !important; }";
const STATUS = '<span class="sc-st">デスクトップ <b class="ng">✕ ありません</b>　スタート <b class="ok">✓ あります</b></span>';
const BASE = `.sc-st { display: flex; gap: 12px; font-size: 13px; } .sc-st .ok { color: var(--ok-ink); } .sc-st .ng { color: var(--danger); }
  .sc-chip { height: 32px; border-radius: 999px; border: 1px solid #f0c060; background: var(--accent); color: var(--accent-ink); font-weight: 800; padding: 0 12px; font-size: 13px; }`;

export const PROPOSALS = [
  {
    key: "S1", name: "見出しにいつも「ショートカット」",
    css: NO_APP + BASE,
    ops: [["insert", '<button class="btn-ghost on-dark">ショートカット</button>', "beforebegin", "#masterBtn"]],
  },
  {
    key: "S2", name: "更新履歴の窓にいつも行",
    css: NO_APP + BASE,
    ops: [["script", `document.querySelector("#verBadge").addEventListener("click", () => setTimeout(() => {
      const box = document.querySelector("#clUpdate"); box.className = "cl-update tone-info";
      box.innerHTML = '<div class="cl-update-row"><div class="cl-update-text"><b>ショートカット</b>${STATUS}</div><button class="btn-ghost">ショートカットを作る</button></div>';
    }, 300));`]],
  },
  {
    key: "S3", name: "権限の札の小窓に「この PC」",
    css: NO_APP + BASE,
    ops: [["script", `document.querySelector("#meChip").addEventListener("click", () => setTimeout(() => document.querySelector("#mePop").insertAdjacentHTML("beforeend",
      '<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:8px"><b>この PC のショートカット</b>${STATUS}<button class="btn-ghost">ショートカットを作る</button></div>'), 50));`]],
  },
  {
    key: "S4", name: "「アプリ」メニュー（点なし）",
    css: BASE + "#appDot { display: none !important; }",
    ops: [],
  },
  {
    key: "S5", name: "欠けたときだけ黄色の札",
    css: NO_APP + BASE,
    ops: [["insert", '<button class="sc-chip">⚠ ショートカットを作る</button>', "beforebegin", "#modeBadge"]],
  },
  {
    key: "S6", name: "「アプリ」メニュー＋欠けたときの点（採った案）",
    css: "",
    ops: [],
  },
];
