// 2026-10「一覧の表示の設定（個人の分）を書き出す・読み込む・初期設定にする（開発者）」の置き場を比べる 5 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-profile.mjs --states list,viewmenu,appmenu,columns
// 再現は近似: 操作の置き場と見え方を比べるためのもの（押しても動かない）。撮るのは開発者の PC（初期設定にするが出る）。
// 案ごとに見る状態: P1・P5 は viewmenu、P2 は appmenu、P3 は columns、P4 は list（開いたところ）。

// 4 つの操作（どの案も同じ中身）
const ITEMS = `
  <button class="pf-i"><b>書き出し…</b><small>表示列・スライサー・並び・見せ方・登録した条件を 1 つのファイルに</small></button>
  <button class="pf-i"><b>読み込み…</b><small>書き出したファイルから、この PC の表示を置き換える</small></button>
  <button class="pf-i"><b>初期設定に戻す</b><small>開発者が配った見せ方（10/08 user）に戻す</small></button>
  <button class="pf-i pf-dev"><b>今の表示を初期設定にする <i>開発者</i></b><small>新しく入れた PC が最初に開いたときの見せ方になる</small></button>`;
const CSS = `
  .pf-box{display:grid;gap:2px;background:var(--surface);font-size:12.5px}
  .pf-i{display:grid;gap:1px;text-align:left;border:0;background:none;border-radius:7px;padding:6px 10px;cursor:pointer;color:var(--ink);font:inherit}
  .pf-i:hover{background:var(--surface-4)}.pf-i b{font-size:13px}.pf-i small{color:var(--muted);font-size:11.5px}
  .pf-i i{font-style:normal;font-size:10.5px;background:#efe8ff;color:#5b3fb0;border-radius:999px;padding:0 6px;margin-left:4px}
  .pf-dev{border-top:1px solid var(--line);border-radius:0 0 7px 7px;margin-top:4px;padding-top:8px}
  .pf-pop{position:fixed;z-index:90;width:330px;padding:6px;border:1px solid var(--pop-line);border-radius:10px;box-shadow:0 14px 36px var(--pop-shadow)}`;

export const PROPOSALS = [
  { key: "P0", name: "今の形（表示列の窓で表示列だけ書き出せる）", css: "", ops: [] },
  {
    key: "P1", name: "表の見せ方の一番下に「この PC の表示の設定」",
    css: CSS + `.pf-sec{border-top:1px solid var(--line);margin-top:8px;padding-top:8px}.pf-sec h4{margin:0 0 4px;font-size:13px}`,
    ops: [["script", `new MutationObserver((_, o) => { const m = document.querySelector("#llViewMenu:not([hidden])"); if (m && !m.querySelector(".pf-sec")) { m.insertAdjacentHTML("beforeend", '<section class="pf-sec"><h4>この PC の表示の設定</h4><div class="pf-box">${ITEMS.replace(/\n/g, "")}</div></section>'); m.scrollTop = m.scrollHeight; } }).observe(document.body, { subtree: true, attributes: true, childList: true });`]],
  },
  {
    key: "P2", name: "右上の「アプリ」のメニューに「一覧の表示の設定」",
    css: CSS + `.pf-am{border-top:1px solid var(--line);margin-top:6px;padding-top:6px}.pf-am h4{margin:0 10px 4px;font-size:12px;color:var(--muted)}`,
    ops: [["script", `new MutationObserver(() => { const m = document.querySelector("#appMenu:not(.hidden)"); if (m && !m.querySelector(".pf-am")) m.insertAdjacentHTML("beforeend", '<div class="pf-am"><h4>一覧の表示の設定</h4><div class="pf-box">${ITEMS.replace(/\n/g, "")}</div></div>'); }).observe(document.body, { subtree: true, attributes: true, childList: true });`]],
  },
  {
    key: "P3", name: "表示列の窓の「保存した設定・書き出し」を、表示全体の書き出しに広げる",
    css: CSS + `#lcPresets{width:360px}.pf-cw h4{margin:6px 0 2px;font-size:12px;color:var(--muted)}`,
    ops: [["script", `let done = false; new MutationObserver(() => { const b = document.querySelector("#llColumnPanel:not([hidden]) #lcMore"), p = document.querySelector("#lcPresets"); if (b && p && !done) { done = true; p.querySelectorAll(".lc-presets-acts")[1].outerHTML = '<div class="pf-cw"><h4>この PC の表示の設定（スライサー・並び・見せ方も）</h4><div class="pf-box">${ITEMS.replace(/\n/g, "")}</div></div>'; b.click(); } }).observe(document.body, { subtree: true, attributes: true, childList: true });`]],
  },
  {
    key: "P4", name: "道具の行に「表示の設定 ▾」（表の見せ方の右）",
    css: CSS + `.pf-btn{white-space:nowrap}`,
    ops: [["insert", '<button type="button" class="pf-btn" aria-expanded="true">表示の設定 ▾</button>', "afterend", "#llViewBtn"],
      ["script", `const b = document.querySelector(".pf-btn"); const r = b.getBoundingClientRect(); document.body.insertAdjacentHTML("beforeend", '<div class="pf-pop pf-box" style="top:' + (r.bottom + 6) + 'px;left:' + (r.right - 330) + 'px">${ITEMS.replace(/\n/g, "")}</div>');`]],
  },
  {
    key: "P5", name: "表の見せ方の見出しの行に［書き出し］［読み込み］［初期設定 ▾］",
    css: CSS + `.pf-hd{display:flex;gap:4px;align-items:center;margin-left:auto}.pf-hd button{height:24px!important;font-size:12px!important;padding:0 8px!important}
      .pf-hd .pf-dev2{border-color:#cdbdf3!important;color:#5b3fb0!important}`,
    ops: [["script", `new MutationObserver(() => { const m = document.querySelector("#llViewMenu:not([hidden])"); const h = m && m.firstElementChild; if (h && !m.querySelector(".pf-hd")) { h.style.display = "flex"; h.style.alignItems = "center"; h.insertAdjacentHTML("beforeend", '<span class="pf-hd"><button>書き出し…</button><button>読み込み…</button><button>初期設定に戻す</button><button class="pf-dev2">初期設定にする ▾</button></span>'); } }).observe(document.body, { subtree: true, attributes: true, childList: true });`]],
  },
];
