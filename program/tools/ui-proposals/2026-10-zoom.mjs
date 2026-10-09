// 2026-10「一覧の拡大のつまみ」に目盛り（刻み）を付け、刻みを変えられるようにする 5 案。
//   node program/tools/ui-variants.mjs 出力フォルダ program/tools/ui-proposals/2026-10-zoom.mjs --states list
// 再現は近似: 置き場と見え方を比べるためのもの（刻みは既定の 10%。60〜200% なら 14 目盛り）。拡大は 120% の状態で比べる。

// 目盛り: つまみの下に、刻みごとの細い線（100% は少し長く）
const TICKS = `
  const r = document.querySelector('#llZoomRange'); r.value = 120; r.dispatchEvent(new Event('input', { bubbles: true }));
  const box = document.createElement('span'); box.className = 'zx-track'; r.before(box); box.append(r);
  const t = document.createElement('span'); t.className = 'zx-ticks';
  for (let v = 60; v <= 200; v += 10) t.insertAdjacentHTML('beforeend', '<i class="' + (v === 100 ? 'is-100' : '') + '" style="left:' + ((v - 60) / 140 * 100) + '%"></i>');
  box.append(t);`;
const BASE = `
  .zx-track{position:relative;display:inline-block;padding-bottom:6px}
  .zx-track input{width:150px!important;display:block}
  .zx-ticks{position:absolute;left:8px;right:8px;bottom:0;height:6px}
  .zx-ticks i{position:absolute;bottom:0;width:1px;height:4px;background:#8193a4}
  .zx-ticks i.is-100{height:7px;width:2px;background:var(--h-input)}
  .zx-pop{position:absolute;z-index:40;background:var(--surface);border:1px solid var(--pop-line);border-radius:9px;box-shadow:0 14px 36px var(--pop-shadow);padding:10px 12px;display:grid;gap:6px;font-size:12.5px;color:var(--ink)}
  .zx-pop b{font-size:12px;color:var(--muted)}
  .zx-seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
  .zx-seg button{border:0!important;border-radius:0!important;height:26px!important;padding:0 10px!important;background:var(--surface)!important;color:var(--ink)!important}
  .zx-seg button.is-on{background:var(--h-input)!important;color:#fff!important;font-weight:700}
  .ll-zoom{position:relative}`;
const SEG = '<span class="zx-seg">' + [5, 10, 20, 25].map((s) => `<button class="${s === 10 ? "is-on" : ""}">${s}%</button>`).join("") + "</span>";

export const PROPOSALS = [
  { key: "Z0", name: "今の形（目盛りなし・刻みは 10% 固定）", css: "", ops: [["script", `const r = document.querySelector('#llZoomRange'); r.value = 120; r.dispatchEvent(new Event('input', { bubbles: true }));`]] },
  {
    key: "Z1", name: "目盛り＋値の右に「刻み 10% ▾」",
    css: BASE + `.zx-step{height:24px!important;font-size:11.5px!important;color:var(--muted)!important}`,
    ops: [["script", TICKS], ["insert", '<select class="zx-step" aria-label="刻み"><option>刻み 5%</option><option selected>刻み 10%</option><option>刻み 20%</option><option>刻み 25%</option></select>', "afterend", "#llZoomValue"]],
  },
  {
    key: "Z2", name: "目盛り＋値を押すと刻み・よく使う倍率の小窓",
    css: BASE + `#llZoomValue{cursor:pointer;border-bottom:1px dashed var(--h-input)}.zx-pop{right:110px;top:30px;width:250px}
      .zx-quick{display:flex;gap:4px;flex-wrap:wrap}.zx-quick button{height:24px!important;padding:0 8px!important}`,
    ops: [["script", TICKS], ["insert", `<div class="zx-pop"><b>刻み</b>${SEG}<b>よく使う倍率</b><div class="zx-quick"><button>80%</button><button>100%</button><button>125%</button><button>150%</button><button>200%</button></div></div>`, "beforeend", "#llZoom"]],
  },
  {
    key: "Z3", name: "目盛り＋つまみの左右に −・＋（刻みずつ）。刻みは表の見せ方で",
    css: BASE + `.zx-pm{width:26px!important;padding:0!important;font-size:15px!important;font-weight:700}`,
    ops: [["script", TICKS], ["insert", '<button class="zx-pm" title="10% 小さく">−</button>', "beforebegin", ".zx-track"], ["insert", '<button class="zx-pm" title="10% 大きく">＋</button>', "afterend", ".zx-track"]],
  },
  {
    key: "Z4", name: "数字つきの目盛り（60・100・150・200）＋「10%刻み」の札",
    css: BASE + `.zx-track{padding-bottom:14px}.zx-ticks{bottom:8px}.zx-lab{position:absolute;left:8px;right:8px;bottom:-4px;height:12px;font-size:10px;color:var(--muted)}
      .zx-lab span{position:absolute;transform:translateX(-50%)}.zx-chip{height:22px!important;border-radius:999px!important;font-size:11px!important;color:var(--muted)!important}`,
    ops: [["script", TICKS + `box.insertAdjacentHTML('beforeend', '<span class="zx-lab">' + [60, 100, 150, 200].map((v) => '<span style="left:' + ((v - 60) / 140 * 100) + '%">' + v + '</span>').join('') + '</span>');`],
      ["insert", '<button class="zx-chip" title="押すと刻みを選べます">10%刻み ▾</button>', "afterend", "#llZoomValue"]],
  },
  {
    key: "Z5", name: "目盛り＋歯車で刻みの小窓（刻みを選ぶ・目盛りに吸い付く）",
    css: BASE + `.zx-gear{width:26px!important;padding:0!important}.zx-pop{right:110px;top:30px;width:230px}`,
    ops: [["script", TICKS], ["insert", '<button class="zx-gear" title="刻みを変える">⚙</button>', "afterend", "#llZoomValue"],
      ["insert", `<div class="zx-pop"><b>刻み（つまみが止まる間隔）</b>${SEG}<small style="color:var(--muted)">↑↓ キー・ホイールでも刻みずつ動きます</small></div>`, "beforeend", "#llZoom"]],
  },
];
