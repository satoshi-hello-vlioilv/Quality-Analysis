"use strict";
/* =========================================================================
   異常ロット一覧のカード（行をダブルクリック → その1行を読みやすいカードで見る）
   - 窓は浮き窓（見出しを掴んで動かす・4辺と4隅で大きさ。画面の端とほかのカードへ吸い付く。Alt+矢印で細かく動かす・
     Alt+Shift+矢印で細かく大きさ。位置と大きさはこの PC に覚える）。後ろの一覧は隠さず触れたまま。
   - いくつも開ける（組み合わせて見る）: ダブルクリックは「残す」にしていないカードの中身を替える。「残す」にしたカード
     はそのまま残り、次のダブルクリックは新しいカードに開く（Ctrl＋ダブルクリックはいつも新しいカード）。
     2枚以上のとき「並べる ▾」で並べ方を絵で選び（横に並べる・縦に積む・格子・右半分に・重ねる）、「違いを強調」でほかのカードと
     値が違う項目に印を付ける。開いているカードは一覧の件数の横の「棚」に札で並ぶ（押すと前へ・📌・×・並べる・全部閉じる）。
   - 項目の配置は表ごとに覚える（どのカードも同じ配置）: 並び（ドラッグ）・幅（1〜4枠／1行）・高さ（標準・2倍・3倍）・隠す・
     列数（自動／1〜4）・文字の大きさ・空欄を隠す。まだ触っていない表は、一覧の「表示列」と同じ並び・同じ顔ぶれ。
   - 値の見え方（表示名・値の整え方・読み替えの色）は一覧のセルと同じもの（LotListColumns.cell）。
   - ◀ ▶（←→）で一覧の前後の行へ。同じロットの行が一覧にいくつかあれば、札でその行へ切り替える。
   ========================================================================= */
(function () {
  const { $, $$, esc } = TPA;
  const KEY = { layouts: "tpa.lotlist.card.v1", rect: "tpa.lotlist.cardRect.v1", diff: "tpa.lotlist.cardDiff.v1" };
  const COLS = [[0, "自動"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]];
  const SIZES = [["s", "小"], ["m", "中"], ["l", "大"]];
  const SPANS = [["1", "1枠"], ["2", "2枠"], ["3", "3枠"], ["4", "4枠"], ["row", "1行"]];
  const HEIGHTS = [["1", "高さ標準"], ["2", "2倍"], ["3", "3倍"]];
  const TRACK_MIN = 180, GAP = 10;          // 列数が自動のときの1枠の最小の幅と間（CSS の .lk-grid と同じ）
  const MAX_CARDS = 8, CASCADE = 28, Z_BASE = 72;   // 表示列の窓（80）より下に重ねる
  const LC = () => window.LotListColumns;
  const layouts = TPA.local.get(KEY.layouts, {});

  let P = null;                          // 一覧から渡る「いまの一覧」（mount）
  const cards = [];                      // 開いているカード（開いた順）
  let zTop = Z_BASE, serial = 0;
  let diffOn = !!TPA.local.get(KEY.diff, false);    // 既定は使わない（違う項目が多いと、どれも目立って印の意味が薄れる）

  /* ---------------- 配置（表ごと・どのカードも同じ） ---------------- */
  const blank = () => ({ order: [], hidden: null, spans: {}, heights: {}, cols: 0, size: "m", hideEmpty: false });
  const layout = () => Object.assign(blank(), layouts[P.target()] || {});
  function saveLayout(patch) { layouts[P.target()] = Object.assign(layout(), patch); TPA.local.set(KEY.layouts, layouts); renderAll(); }
  function resetLayout() { delete layouts[P.target()]; TPA.local.set(KEY.layouts, layouts); renderAll(); }
  /* 項目の並びと顔ぶれ。hidden が null（まだ隠す・戻すをしていない）なら、一覧の表示列で隠した列を隠す */
  function fields() {
    const t = P.target(), lot = P.lotColumn(), L = layout();
    const all = LC().ordered(t, P.columns(), lot).filter((c) => c !== lot);   // ロット番号は見出しに出す
    const known = new Set(all);
    const order = L.order.filter((c) => known.has(c));
    all.forEach((c) => { if (!order.includes(c)) order.push(c); });           // 新しい列は後ろへ
    const hidden = new Set(L.hidden || LC().get(t).hidden);
    return { L, shown: order.filter((c) => !hidden.has(c)), hidden: order.filter((c) => hidden.has(c)) };
  }
  function move(key, target, after) {
    const { shown, hidden } = fields(), order = shown.concat(hidden).filter((c) => c !== key);
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, key);
    saveLayout({ order, hidden });
  }
  function setHidden(key, hide) {
    const { hidden } = fields(), set = new Set(hidden);
    if (hide) set.add(key); else set.delete(key);
    saveLayout({ hidden: [...set] });
  }

  /* ---------------- 1枚の窓 ---------------- */
  const seg = (name, list, cur, label) => `<span class="lk-seg" role="radiogroup" aria-label="${label}"><em>${label}</em>`
    + list.map(([v, l]) => `<button type="button" role="radio" data-${name}="${v}" aria-checked="${String(v) === String(cur)}">${l}</button>`).join("") + "</span>";
  function makeCard() {
    const el = document.createElement("section");
    const card = { el, win: null, row: null, sig: "", idx: -1, pinned: false, editing: false, no: ++serial, tracks: 0 };
    el.className = "ll-cardwin"; el.hidden = true; el.tabIndex = -1;
    el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "品質データのカード");
    el.innerHTML = `
      <div class="lc-head lk-head" data-drag title="見出しを掴んで動かせます（画面の端・ほかのカードへ吸い付きます。Alt を押すと吸い付きません）。&#10;大きさは4辺と4隅で変えられます。Alt+矢印＝動かす・Alt+Shift+矢印＝大きさ（Ctrl も押すと 1px ずつ）">
        <div class="lk-title"><small class="lc-eyebrow">品質データのカード<b class="lk-no" data-k="no"></b></small>
          <h3><span data-k="lot">-</span></h3><p class="lc-lead" data-k="sub"></p></div>
        <div class="lk-nav">
          <button type="button" class="lk-pin" data-card="pin" aria-pressed="false" title="このカードを残します。次のダブルクリックは新しいカードに開きます（組み合わせて見られます）">📌 残す</button>
          <button type="button" class="lk-tile" data-card="tile" hidden aria-haspopup="true" title="開いているカードの並べ方を、絵で選びます">並べる ▾</button>
          <button type="button" class="lk-pick" data-card="pick" title="一覧でロット番号を押したときと同じく、計算画面でこのロットを取り込みます">計算画面で開く</button>
          <button type="button" data-card="prev" title="一覧の前の行（←）" aria-label="前の行">◀</button>
          <button type="button" data-card="next" title="一覧の次の行（→）" aria-label="次の行">▶</button>
        </div>
        <button type="button" class="lc-x" data-card="close" title="このカードを閉じる（Esc）" aria-label="閉じる">×</button>
      </div>
      <div class="lk-sibs" data-k="sibs" hidden></div>
      <div class="lk-tools" data-k="tools"></div>
      <div class="lk-body"><div class="lk-grid" data-k="grid"></div></div>
      <div class="lk-tray" data-k="tray" hidden></div>
      <div class="lc-foot lk-foot" data-k="foot" hidden>
        <span class="lc-note">項目は掴んで並べ替え、幅は「1〜4枠・1行」、高さは「標準・2倍・3倍」、要らない項目は「隠す」。配置はこの表ごとに、この PC に覚えます（どのカードも同じ配置）。</span>
        <span class="lc-sp"></span>
        <button type="button" data-card="reset" title="一覧の表示列と同じ並び・顔ぶれに戻します">既定に戻す</button>
        <button type="button" data-card="done" class="lc-primary">編集を終える</button>
      </div>`;
    document.body.append(el);
    card.win = TPA.floatPanel(el, { key: KEY.rect, w: 760, h: 720, top: 70, align: "right", minW: 300, minH: 220 });
    const q = (k) => $(`[data-k="${k}"]`, el);
    card.q = q;
    el.addEventListener("mousedown", () => raise(card), true);
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const act = b.dataset.card;
      if (act === "close") closeCard(card);
      else if (act === "pin") { card.pinned = !card.pinned; renderAll(); }
      else if (act === "tile") openLayouts(b);
      else if (act === "pick") { if (card.row) P.onPick(String(card.row[P.lotColumn()] ?? "")); }
      else if (act === "prev" || act === "next") step(card, act === "prev" ? -1 : 1);
      else if (act === "reset") resetLayout();
      else if (act === "done") { card.editing = false; render(card); }
      else if (b.closest('[data-k="sibs"]') && b.dataset.i) setRow(card, +b.dataset.i);
      else if (b.closest('[data-k="tools"]')) {
        if (b.dataset.cols != null) saveLayout({ cols: +b.dataset.cols });
        else if (b.dataset.size) saveLayout({ size: b.dataset.size });
        else if (b.dataset.edit != null) { card.editing = !card.editing; render(card); }
      } else if (b.closest('[data-k="tray"]') && b.dataset.show) setHidden(b.dataset.show, false);
      else if (b.closest(".lk-f")) {
        const f = b.closest(".lk-f"), c = f.dataset.col, L = layout();
        if (b.dataset.span) saveLayout({ spans: Object.assign({}, L.spans, { [c]: b.dataset.span }) });
        else if (b.dataset.height) saveLayout({ heights: Object.assign({}, L.heights, { [c]: b.dataset.height }) });
        else if (b.hasAttribute("data-hide")) setHidden(c, true);
      }
    });
    el.addEventListener("change", (e) => { if (e.target.dataset.k === "hideEmpty") saveLayout({ hideEmpty: e.target.checked }); });
    // ←→ で前後の行（入力欄の矢印・Alt＝窓を動かす は奪わない）。Esc はこのカードだけを閉じる
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCard(card); return; }
      if (e.target.closest("input,select,textarea") || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); step(card, e.key === "ArrowLeft" ? -1 : 1); }
    });
    // 窓の幅が変わって、自動の列数が変わったら描き直す（枠の幅を列の数に収める）
    new ResizeObserver(() => { if (!el.hidden && layout().cols === 0 && trackCount(card) !== card.tracks) render(card); }).observe(el);
    return card;
  }
  function trackCount(card) {
    const L = layout(); if (L.cols) return L.cols;
    const w = card.q("grid").clientWidth;
    return w ? Math.max(1, Math.floor((w + GAP) / (TRACK_MIN + GAP))) : 4;
  }
  function raise(card) {
    if (+card.el.style.zIndex === zTop) return;
    zTop = Math.min(zTop + 1, Z_BASE + MAX_CARDS + 1);
    if (zTop >= Z_BASE + MAX_CARDS + 1) {   // 上限まで来たら、重なり順を保ったまま詰め直す
      cards.slice().sort((a, b) => (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0)).forEach((c, i) => { c.el.style.zIndex = Z_BASE + i; });
      zTop = Z_BASE + cards.length;
    }
    card.el.style.zIndex = zTop;
    renderShelf();                          // 棚の「前のカード」の印も合わせる
  }

  /* ---------------- 描く ---------------- */
  let sentinel = null;      // Esc の重なり順の代わり（カードが1枚でも開いていれば「見えている」。一覧に居るときの Esc は前のカードを閉じる）
  function renderAll() { if (sentinel) sentinel.hidden = !cards.length; cards.forEach(render); renderShelf(); P.onShow(cards.map((c) => c.idx), cards.length ? top().idx : -1); }
  const top = () => cards.reduce((a, c) => ((+c.el.style.zIndex || 0) >= (+a.el.style.zIndex || 0) ? c : a), cards[0]);
  /* 2枚以上のとき: ほかのカードと値が違う列 */
  function diffCols() {
    if (!diffOn || cards.length < 2) return null;
    const t = P.target(), out = new Set();
    const rowsShown = cards.map((c) => c.row).filter(Boolean);
    fields().shown.forEach((c) => { if (new Set(rowsShown.map((r) => LC().cell(t, c, r).text)).size > 1) out.add(c); });
    return out;
  }
  function render(card) {
    const { el, q, row, idx } = card;
    if (el.hidden) return;
    const t = P.target(), lot = P.lotColumn(), rows = P.rows();
    const lotVal = row && lot ? String(row[lot] ?? "") : "";
    q("no").textContent = cards.length > 1 ? `　${cards.indexOf(card) + 1} / ${cards.length}` : "";
    q("lot").textContent = lotVal || "（ロット番号なし）";
    q("sub").textContent = idx >= 0 ? `このページの ${idx + 1} / ${rows.length} 行目`
      : "この行はいまの一覧にありません（絞り込み・並べ替え・ページが変わりました）。表示は開いたときの値です";
    $('[data-card="prev"]', el).disabled = idx <= 0;
    $('[data-card="next"]', el).disabled = idx < 0 || idx >= rows.length - 1;
    const pin = $('[data-card="pin"]', el);
    pin.setAttribute("aria-pressed", String(card.pinned));
    pin.textContent = card.pinned ? "📌 残しています" : "📌 残す";
    pin.title = card.pinned ? "このカードは残しています。押すと残すのをやめ、次のダブルクリックでこのカードの中身が替わります"
      : "このカードを残します。次のダブルクリックは新しいカードに開きます（組み合わせて見られます）";
    el.classList.toggle("is-pinned", card.pinned);
    $('[data-card="tile"]', el).hidden = cards.length < 2;
    // 同じロットの行（一覧のこのページにあるもの）
    const k = row ? P.lotKey(row) : "";
    const sibs = k ? rows.map((r, i) => [r, i]).filter(([r]) => P.lotKey(r) === k) : [];
    const sb = q("sibs");
    sb.hidden = sibs.length < 2;
    sb.innerHTML = sibs.length < 2 ? "" : `<em>同じロットの行 ${sibs.length}件</em>`
      + sibs.map(([, i], n) => `<button type="button" data-i="${i}" aria-pressed="${i === idx}" title="一覧の ${i + 1} 行目">${n + 1}</button>`).join("");
    const { L, shown, hidden } = fields();
    q("tools").innerHTML = seg("cols", COLS, L.cols, "列数") + seg("size", SIZES, L.size, "文字")
      + `<label class="lk-check"><input type="checkbox" data-k="hideEmpty"${L.hideEmpty ? " checked" : ""}>空欄の項目を隠す</label>`
      + `<button type="button" data-edit class="lk-edit" aria-pressed="${card.editing}" title="項目の並び・幅・高さ・隠す を変えます">${card.editing ? "配置の編集中" : "配置を編集"}</button>`;
    $('[data-card="pick"]', el).disabled = !lotVal;
    const grid = q("grid");
    grid.className = `lk-grid size-${L.size}${L.cols ? " is-fixed" : ""}${card.editing ? " is-editing" : ""}`;
    grid.style.setProperty("--lk-cols", L.cols || 1);
    card.tracks = trackCount(card);
    const diff = diffCols();
    const tiles = shown.map((c) => tile1(card, t, c, L, diff)).join("");
    grid.innerHTML = tiles || `<p class="lk-empty">${shown.length ? "空欄でない項目がありません（「空欄の項目を隠す」を外すと出ます）" : "出す項目がありません。「配置を編集」で隠した項目を戻せます。"}</p>`;
    if (card.editing) TPA.dragSort(grid, ".lk-f", { onDrop: move });
    const tray = q("tray");
    tray.hidden = !card.editing;
    tray.innerHTML = `<em>隠した項目</em>` + (hidden.length ? hidden.map((c) => `<button type="button" data-show="${esc(c)}" title="カードに戻します">＋ ${esc(LC().label(t, c))}</button>`).join("")
      : "<small>ありません（項目の「隠す」でここへ移ります）</small>");
    q("foot").hidden = !card.editing;
  }
  function tile1(card, t, c, L, diff) {
    const cell = card.row ? LC().cell(t, c, card.row) : { text: "", raw: "", color: "" };
    const empty = !String(cell.text ?? "").trim();
    if (empty && L.hideEmpty && !card.editing) return "";
    const sp = String(L.spans[c] || "1"), ht = String(L.heights[c] || "1");
    const n = sp === "row" ? 0 : Math.min(+sp, card.tracks);      // 列の数を超える幅はその列の数に収める（はみ出さない）
    const style = (sp === "row" ? "grid-column:1/-1;" : n > 1 ? `grid-column:span ${n};` : "") + (ht !== "1" ? `--lk-h:${ht};` : "");
    const tip = cell.raw !== cell.text ? `${cell.text}\n元の値: ${cell.raw}` : cell.text;
    const isDiff = diff && diff.has(c);
    return `<div class="lk-f${empty ? " is-empty" : ""}${ht !== "1" ? " is-tall" : ""}${isDiff ? " is-diff" : ""}" data-col="${esc(c)}"${card.editing ? ' draggable="true"' : ""}${style ? ` style="${style}"` : ""}>`
      + `<span class="lk-l">${card.editing ? '<i class="lk-grip" aria-hidden="true">⠿</i>' : ""}${esc(LC().label(t, c))}${isDiff ? '<i class="lk-diff" title="ほかのカードと値が違います">違い</i>' : ""}</span>`
      + `<b class="lk-v${cell.color ? " cell-" + cell.color : ""}" title="${esc(tip)}">${empty ? "—" : esc(cell.text)}</b>`
      + (card.editing ? `<span class="lk-fe">${SPANS.map(([v, l]) => `<button type="button" data-span="${v}" aria-pressed="${v === sp}" title="幅: ${l}${v !== "row" && +v > card.tracks ? `（いまの列数 ${card.tracks} に収めて出します）` : ""}">${l}</button>`).join("")}`
        + `<i class="lk-fsep" aria-hidden="true"></i>${HEIGHTS.map(([v, l]) => `<button type="button" data-height="${v}" aria-pressed="${v === ht}" title="高さ: ${l}（長い字の項目に）">${l}</button>`).join("")}`
        + '<button type="button" data-hide title="この項目をカードから隠します（下の「隠した項目」から戻せます）">隠す</button></span>' : "")
      + "</div>";
  }

  /* ---------------- 行・枚数・並べる ---------------- */
  const sigOf = (r) => JSON.stringify(r);
  function setRow(card, i) {
    const rows = P.rows(); if (!rows[i]) return;
    card.row = rows[i]; card.sig = sigOf(card.row); card.idx = i;
    renderAll();
  }
  function openCard() {
    const card = makeCard(), prev = cards[cards.length - 1];
    cards.push(card);
    card.win.place();
    card.el.hidden = false;
    if (prev) {               // 前のカードから少しずらして重ねる（どれも見える）。覚えた位置は変えない
      const r = prev.win.rect();
      // 右へずらすと画面からはみ出すなら左へ（右寄せの窓が一覧の左側を覆わないように、少しずつ）
      const x = r.x + r.w + CASCADE <= innerWidth - 8 ? r.x + CASCADE : Math.max(8, r.x - CASCADE);
      const y = r.y + r.h + CASCADE <= innerHeight - 8 ? r.y + CASCADE : Math.max(60, r.y - CASCADE);
      card.win.setRect({ x, y, w: r.w, h: r.h }, false);
    }
    return card;
  }
  /* i 行目をカードで出す。another: いつも新しいカードに（Ctrl＋ダブルクリック） */
  function show(i, { another = false } = {}) {
    if (!P.rows()[i]) return;
    let card = another ? null : [...cards].reverse().find((c) => !c.pinned) || null;
    if (!card && cards.length >= MAX_CARDS) {
      card = cards.find((c) => !c.pinned) || null;
      if (!card) { P.toast?.(`カードは ${MAX_CARDS} 枚までです。どれかを閉じるか「残す」を外してください`); return; }
    }
    if (!card) card = openCard();
    raise(card);
    setRow(card, i);
    renderShelf();
    if (!card.el.contains(document.activeElement)) card.el.focus({ preventScroll: true });
  }
  function step(card, d) { if (card.idx >= 0) setRow(card, Math.max(0, Math.min(P.rows().length - 1, card.idx + d))); }
  /* ---------------- 並べ方（絵で選ぶ）と棚 ---------------- */
  const LAYOUTS = [
    ["row", "横に並べる", "左から右へ1列に並べます（比べるとき）"],
    ["col", "縦に積む", "上から下へ積みます"],
    ["grid", "格子", "縦横に敷き詰めます（枚数が多いとき）"],
    ["right", "右半分に", "画面の右半分に並べ、左の一覧を見えたままにします"],
    ["stack", "重ねる", "少しずつずらして重ねます（見出しが全部見える）"],
  ];
  const layoutPic = (k) => `<span class="lk-lay lk-lay-${k}" aria-hidden="true"><i></i><i></i><i></i>${k === "grid" ? "<i></i>" : ""}</span>`;
  /* 開いているカードを、一覧の画面の中に並べる（kind: LAYOUTS の鍵）。小さくなりすぎる並べ方は格子に替える */
  function tile(kind = "row") {
    const n = cards.length; if (n < 2) return;
    const scr = $("#lotListScreen"), top0 = scr ? Math.max(8, scr.getBoundingClientRect().top + 8) : 60;
    const gap = 8, area = { x: 8, y: top0, w: innerWidth - 16, h: innerHeight - top0 - 8 };
    if (kind === "right") { area.w = Math.round(innerWidth / 2) - 12; area.x = innerWidth - area.w - 8; }
    if (kind === "stack") {
      const w = Math.round(area.w * 0.55), h = Math.round(area.h * 0.8), step = 34;
      cards.forEach((c, k) => { c.win.setRect({ x: area.x + area.w - w - (n - 1 - k) * step, y: area.y + k * step, w, h }, false); raise(c); });
      return;
    }
    let cols = kind === "row" ? n : kind === "col" ? 1 : kind === "right" ? (n <= 3 ? 1 : 2) : Math.ceil(Math.sqrt(n));
    let rowsN = Math.ceil(n / cols);
    if ((area.w - gap * (cols - 1)) / cols < 300 || (area.h - gap * (rowsN - 1)) / rowsN < 220) { cols = Math.ceil(Math.sqrt(n)); rowsN = Math.ceil(n / cols); }
    const w = (area.w - gap * (cols - 1)) / cols, h = (area.h - gap * (rowsN - 1)) / rowsN;
    cards.forEach((c, k) => c.win.setRect({ x: area.x + (k % cols) * (w + gap), y: area.y + Math.floor(k / cols) * (h + gap), w, h }, false));
  }
  let layMenu = null, layOff = null;
  function closeLayouts() { layMenu?.remove(); layMenu = null; if (layOff) layOff(); layOff = null; }
  function openLayouts(anchor) {
    if (layMenu) { closeLayouts(); return; }
    layMenu = document.createElement("div");
    layMenu.className = "lk-laymenu"; layMenu.setAttribute("role", "menu");
    layMenu.innerHTML = `<p>並べ方<small>押すとすぐ並びます（${cards.length}枚）</small></p><div class="lk-lays">`
      + LAYOUTS.map(([k, name, tip]) => `<button type="button" role="menuitem" data-lay="${k}" title="${tip}">${layoutPic(k)}<span>${name}</span></button>`).join("") + "</div>";
    document.body.append(layMenu);
    TPA.placeBelow(layMenu, anchor, "right");
    layMenu.addEventListener("click", (e) => { const b = e.target.closest("[data-lay]"); if (b) { tile(b.dataset.lay); closeLayouts(); } });
    layOff = TPA.dismissable(layMenu, closeLayouts, { keep: anchor });
  }
  /* 棚: 一覧の件数の横に、開いているカードを札で並べる（どのカードがあるか・残しているか が一目で分かり、押すとそのカードが前に来る） */
  function renderShelf() {
    const sh = $("#llCardShelf"); if (!sh) return;
    sh.hidden = !cards.length;
    if (!cards.length) { sh.innerHTML = ""; return; }
    const lot = P.lotColumn(), front = top();
    sh.innerHTML = `<b class="lk-sh-n">カード ${cards.length}枚</b>` + cards.map((c, k) => {
      const name = c.row && lot ? String(c.row[lot] ?? "") || "（ロット番号なし）" : "-";
      return `<span class="lk-sh-c${c.pinned ? " is-pinned" : ""}${c === front ? " is-front" : ""}">`
        + `<button type="button" data-sh="pin" data-k="${k}" aria-pressed="${c.pinned}" title="${c.pinned ? "残しています（押すと残すのをやめます）" : "このカードを残します"}">📌</button>`
        + `<button type="button" data-sh="front" data-k="${k}" title="このカードを前に出します">${esc(name)}</button>`
        + `<button type="button" data-sh="x" data-k="${k}" title="このカードを閉じます" aria-label="閉じる">×</button></span>`;
    }).join("")
      + (cards.length > 1 ? `<button type="button" class="lk-sh-b" data-sh="lay" aria-haspopup="true" title="並べ方を絵で選びます">${layoutPic("row")}並べる ▾</button>`
        + `<button type="button" class="lk-sh-b lk-sh-diff" data-sh="diff" aria-pressed="${diffOn}" title="開いているカードの中で、値が違う項目に印を付けます">違いを強調</button>` : "")
      + '<button type="button" class="lk-sh-b" data-sh="all" title="開いているカードをすべて閉じます">全部閉じる</button>';
  }
  function bindShelf() {
    const sh = $("#llCardShelf"); if (!sh) return;
    sh.addEventListener("click", (e) => {
      const b = e.target.closest("[data-sh]"); if (!b) return;
      const c = cards[+b.dataset.k], a = b.dataset.sh;
      if (a === "front" && c) { raise(c); c.el.focus({ preventScroll: true }); c.el.classList.remove("is-flash"); void c.el.offsetWidth; c.el.classList.add("is-flash"); renderShelf(); }
      else if (a === "pin" && c) { c.pinned = !c.pinned; renderAll(); }
      else if (a === "x" && c) closeCard(c);
      else if (a === "lay") openLayouts(b);
      else if (a === "diff") { diffOn = !diffOn; TPA.local.set(KEY.diff, diffOn); renderAll(); }
      else if (a === "all") close();
    });
  }
  /* 一覧が読み直された（絞り込み・並べ替え・ページ・表示列）: 同じ行を探し直し、無ければ開いたときの値のまま */
  function refresh() {
    if (!cards.length) return;
    const rows = P.rows();
    cards.forEach((c) => { c.idx = rows.findIndex((r) => sigOf(r) === c.sig); if (c.idx >= 0) c.row = rows[c.idx]; });
    renderAll();
  }
  function closeCard(card) {
    const k = cards.indexOf(card); if (k < 0) return;
    if (cards.length === 1) card.win.remember();     // 最後の1枚の位置と大きさを、次に開くときの形にする
    card.el.hidden = true; card.el.remove();
    cards.splice(k, 1);
    renderAll();
    if (cards.length) top().el.focus({ preventScroll: true });
  }
  function close() { [...cards].forEach(closeCard); }
  window.LotListCard = {
    /** p: { rows(), target(), columns(), lotColumn(), lotKey(row), onPick(lot), onShow(行の番号の並び, いま前のカードの行), toast(文) } */
    mount(p) {
      P = p;
      // Esc の重なり順は最初に決める（後から開く窓＝マスタ管理などが上）。カードの窓は開くたびに作るので、目印の1つで受ける
      sentinel = document.createElement("i"); sentinel.hidden = true; document.body.append(sentinel);
      TPA.layer(sentinel, () => { if (cards.length) closeCard(top()); }, { backdrop: false });
      bindShelf();
    },
    show, refresh, close,
    isOpen: () => cards.length > 0,
  };
})();
