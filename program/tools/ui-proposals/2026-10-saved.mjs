// 2026-10「書き出したファイルがどこに行ったか分からない」を直す、保存したあとの知らせ方の 5 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-saved.mjs --states profile
// 再現は近似: 「表示の設定 ▾」→「書き出し…」を押した直後の見え方を比べる（押しても動かない）。保存先は既定の「ダウンロード」。

const PATH = "C:\\\\Users\\\\user\\\\Downloads\\\\異常ロット一覧_表示の設定.json";
const CSS = `
  .sv-path{font-family:Consolas,"BIZ UDGothic",monospace;font-size:12px;word-break:break-all;background:var(--surface-4);border-radius:5px;padding:2px 6px}
  .sv-acts{display:flex;gap:6px}.sv-acts button{height:26px;border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:0 10px;font:inherit;font-size:12px;cursor:pointer}
  .sv-acts .is-main{background:var(--h-input);border-color:var(--h-input);color:var(--on-fill);font-weight:700}
  .sv-ok{color:var(--ok-ink);font-weight:700}`;
const BODY = `<span class="sv-ok">✓ 書き出しました（3 項目）</span><span class="sv-path">${PATH}</span><span class="sv-acts"><button class="is-main">フォルダを開く</button><button>パスをコピー</button></span>`;

export const PROPOSALS = [
  { key: "T0", name: "今の形（WebView2 の小さな保存の案内だけ・すぐ消える）", css: "", ops: [] },
  {
    key: "T1", name: "右下に知らせ（置いた場所・フォルダを開く。閉じるまで残る）",
    css: CSS + `.sv-toast{position:fixed;right:24px;bottom:24px;z-index:95;width:430px;display:grid;gap:6px;padding:12px 14px;background:var(--surface);border:1px solid var(--pop-line);
      border-left:4px solid var(--ok);border-radius:10px;box-shadow:0 14px 36px var(--pop-shadow);font-size:12.5px}.sv-x{position:absolute;right:8px;top:6px;border:0;background:none;color:var(--muted)}`,
    ops: [["script", `document.body.insertAdjacentHTML('beforeend', '<div class="sv-toast"><button class="sv-x">×</button>${BODY}</div>');`]],
  },
  {
    key: "T2", name: "開いているメニューの中に結果（置いた場所・フォルダを開く）",
    css: CSS + `.sv-in{display:grid;gap:5px;margin:4px 6px 2px;padding:8px 10px;background:var(--ok-bg);border-radius:8px;font-size:12.5px}`,
    ops: [["script", `new MutationObserver(() => { const m = document.querySelector('#llProfileMenu:not([hidden])'); if (m && !m.querySelector('.sv-in')) m.insertAdjacentHTML('beforeend', '<div class="sv-in">${BODY}</div>'); }).observe(document.body, { subtree: true, childList: true, attributes: true });`]],
  },
  {
    key: "T3", name: "保存しましたの小窓（中央。OK で閉じる）",
    css: CSS + `.sv-modal{position:fixed;inset:0;z-index:95;background:rgba(15,30,45,.4);display:grid;place-items:center}
      .sv-modal > div{width:520px;display:grid;gap:10px;background:var(--surface);border-radius:12px;padding:18px;box-shadow:var(--shadow);font-size:13px}`,
    ops: [["script", `document.body.insertAdjacentHTML('beforeend', '<div class="sv-modal"><div>${BODY}<span class="sv-acts"><button>OK</button></span></div></div>');`]],
  },
  {
    key: "T4", name: "書き出す前に保存先を選ぶ（フォルダと名前。前回の場所を覚える）",
    css: CSS + `.sv-modal{position:fixed;inset:0;z-index:95;background:rgba(15,30,45,.4);display:grid;place-items:center}
      .sv-modal > div{width:620px;display:grid;gap:10px;background:var(--surface);border-radius:12px;padding:18px;box-shadow:var(--shadow);font-size:13px}
      .sv-modal label{display:grid;gap:3px;color:var(--muted);font-size:12px}.sv-modal h3{margin:0;font-size:15px}`,
    ops: [["script", `document.body.insertAdjacentHTML('beforeend', '<div class="sv-modal"><div><h3>書き出す場所</h3><label>フォルダ（前回の場所）<input class="ps-input" value="C:\\\\\\\\Users\\\\\\\\user\\\\\\\\Documents\\\\\\\\Defect-Analyzer"></label><label>ファイルの名前<input class="ps-input" value="異常ロット一覧_表示の設定.json"></label><span class="sv-acts"><button class="is-main">ここに書き出す</button><button>フォルダを選ぶ…</button><button>やめる</button></span></div></div>');`]],
  },
  {
    key: "T5", name: "道具の行の下に、横いっぱいの帯（置いた場所・フォルダを開く）",
    css: CSS + `.sv-band{display:flex;align-items:center;gap:12px;margin:6px 16px 0;padding:8px 12px;background:var(--ok-bg);border:1px solid #bfe3cd;border-radius:8px;font-size:12.5px}`,
    ops: [["script", `document.querySelector('#llFilterBar').insertAdjacentHTML('afterend', '<div class="sv-band">${BODY}<button class="sv-x" style="margin-left:auto;border:0;background:none">×</button></div>');`]],
  },
];
