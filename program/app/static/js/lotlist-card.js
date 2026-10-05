"use strict";
/* =========================================================================
   異常ロット一覧のカード（行をダブルクリック → その1行を読みやすいカードで見る）
   - 窓は浮き窓（見出しを掴んで動かす・右下の取っ手で大きさ。位置と大きさはこの PC に覚える）。
     後ろの一覧は隠さず触れたまま（別の行をダブルクリックすると、カードの中身がその行に替わる）。
   - 項目の配置は表ごとに覚える: 並び（ドラッグ）・幅（1枠／2枠／1行）・隠す・列数（自動／1〜4）・文字の大きさ・空欄を隠す。
     まだ触っていない表は、一覧の「表示列」と同じ並び・同じ顔ぶれ（表で隠した列はカードでも隠す）。
   - 値の見え方（表示名・値の整え方・読み替えの色）は一覧のセルと同じもの（LotListColumns.cell）。
   - ◀ ▶（←→）で一覧の前後の行へ。同じロットの行が一覧にいくつかあれば、札でその行へ切り替える。
   ========================================================================= */
(function () {
  const { $, $$, esc } = TPA;
  const KEY = { layouts: "tpa.lotlist.card.v1", rect: "tpa.lotlist.cardRect.v1" };
  const COLS = [[0, "自動"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]];
  const SIZES = [["s", "小"], ["m", "中"], ["l", "大"]];
  const SPANS = [["1", "1枠"], ["2", "2枠"], ["row", "1行"]];
  const LC = () => window.LotListColumns;
  const layouts = TPA.local.get(KEY.layouts, {});

  let P = null;                          // 一覧から渡る「いまの一覧」（mount）
  let panel = null, win = null, editing = false;
  let row = null, rowSig = "", idx = -1;  // いま出している行（一覧が読み直されても、同じ行を探し直す）

  /* ---------------- 配置（表ごと） ---------------- */
  const blank = () => ({ order: [], hidden: null, spans: {}, cols: 0, size: "m", hideEmpty: false });
  const layout = () => Object.assign(blank(), layouts[P.target()] || {});
  function saveLayout(patch) { layouts[P.target()] = Object.assign(layout(), patch); TPA.local.set(KEY.layouts, layouts); render(); }
  function resetLayout() { delete layouts[P.target()]; TPA.local.set(KEY.layouts, layouts); render(); }
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

  /* ---------------- 窓 ---------------- */
  const seg = (name, list, cur, label) => `<span class="lk-seg" role="radiogroup" aria-label="${label}"><em>${label}</em>`
    + list.map(([v, l]) => `<button type="button" role="radio" data-${name}="${v}" aria-checked="${String(v) === String(cur)}">${l}</button>`).join("") + "</span>";
  function ensure() {
    if (panel) return;
    panel = document.createElement("section");
    panel.id = "llCard"; panel.className = "ll-cardwin"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "品質データのカード"); panel.tabIndex = -1;
    panel.innerHTML = `
      <div class="lc-head lk-head" data-drag title="見出しを掴んで動かせます。大きさは右下の角で変えられます">
        <div class="lk-title"><small class="lc-eyebrow">品質データのカード</small>
          <h3><span id="lkLot">-</span></h3><p class="lc-lead" id="lkSub"></p></div>
        <div class="lk-nav">
          <button type="button" id="lkPick" class="lk-pick" title="一覧でロット番号を押したときと同じく、計算画面でこのロットを取り込みます">計算画面で開く</button>
          <button type="button" id="lkPrev" title="一覧の前の行（←）" aria-label="前の行">◀</button>
          <button type="button" id="lkNext" title="一覧の次の行（→）" aria-label="次の行">▶</button>
        </div>
        <button type="button" class="lc-x" id="lkClose" title="閉じる（Esc）" aria-label="閉じる">×</button>
      </div>
      <div class="lk-sibs" id="lkSibs" hidden></div>
      <div class="lk-tools" id="lkTools"></div>
      <div class="lk-body"><div class="lk-grid" id="lkGrid"></div></div>
      <div class="lk-tray" id="lkTray" hidden></div>
      <div class="lc-foot lk-foot" id="lkFoot" hidden>
        <span class="lc-note">項目は掴んで並べ替え、幅は「1枠・2枠・1行」、要らない項目は「隠す」。配置はこの表ごとに、この PC に覚えます。</span>
        <span class="lc-sp"></span>
        <button type="button" id="lkReset" title="一覧の表示列と同じ並び・顔ぶれに戻します">既定に戻す</button>
        <button type="button" id="lkDone" class="lc-primary">編集を終える</button>
      </div>`;
    document.body.append(panel);
    win = TPA.floatPanel(panel, { key: KEY.rect, w: 760, h: 720, top: 70, align: "right" });
    TPA.layer(panel, close, { backdrop: false });
    $("#lkClose").onclick = close;
    $("#lkPrev").onclick = () => step(-1);
    $("#lkNext").onclick = () => step(1);
    $("#lkReset").onclick = resetLayout;
    $("#lkPick").onclick = () => { if (row) P.onPick(String(row[P.lotColumn()] ?? "")); };
    $("#lkDone").onclick = () => setEditing(false);
    $("#lkSibs").addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) show(+b.dataset.i); });
    $("#lkTools").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.cols != null) saveLayout({ cols: +b.dataset.cols });
      else if (b.dataset.size) saveLayout({ size: b.dataset.size });
      else if (b.id === "lkEdit") setEditing(!editing);
    });
    $("#lkTools").addEventListener("change", (e) => { if (e.target.id === "lkHideEmpty") saveLayout({ hideEmpty: e.target.checked }); });
    $("#lkGrid").addEventListener("click", (e) => {
      const f = e.target.closest(".lk-f"), b = e.target.closest("button"); if (!f || !b) return;
      if (b.dataset.span) { const L = layout(); saveLayout({ spans: Object.assign({}, L.spans, { [f.dataset.col]: b.dataset.span }) }); }
      else if (b.hasAttribute("data-hide")) setHidden(f.dataset.col, true);
    });
    $("#lkTray").addEventListener("click", (e) => { const b = e.target.closest("[data-show]"); if (b) setHidden(b.dataset.show, false); });
    // ←→ で前後の行（入力欄・ボタンの上の矢印は奪わない）
    panel.addEventListener("keydown", (e) => {
      if (e.target.closest("input,select,textarea") || e.altKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); step(e.key === "ArrowLeft" ? -1 : 1); }
    });
  }
  function setEditing(v) { editing = !!v; render(); }

  /* ---------------- 描く ---------------- */
  function render() {
    if (!panel || panel.hidden) return;
    const t = P.target(), lot = P.lotColumn(), rows = P.rows();
    const lotVal = row && lot ? String(row[lot] ?? "") : "";
    $("#lkLot").textContent = lotVal || "（ロット番号なし）";
    $("#lkSub").textContent = idx >= 0 ? `このページの ${idx + 1} / ${rows.length} 行目`
      : "この行はいまの一覧にありません（絞り込み・並べ替え・ページが変わりました）。表示は開いたときの値です";
    $("#lkPrev").disabled = idx <= 0;
    $("#lkNext").disabled = idx < 0 || idx >= rows.length - 1;
    // 同じロットの行（一覧のこのページにあるもの）
    const k = row ? P.lotKey(row) : "";
    const sibs = k ? rows.map((r, i) => [r, i]).filter(([r]) => P.lotKey(r) === k) : [];
    const sb = $("#lkSibs");
    sb.hidden = sibs.length < 2;
    sb.innerHTML = sibs.length < 2 ? "" : `<em>同じロットの行 ${sibs.length}件</em>`
      + sibs.map(([, i], n) => `<button type="button" data-i="${i}" aria-pressed="${i === idx}" title="一覧の ${i + 1} 行目">${n + 1}</button>`).join("");
    const { L, shown, hidden } = fields();
    $("#lkTools").innerHTML = seg("cols", COLS, L.cols, "列数") + seg("size", SIZES, L.size, "文字")
      + `<label class="lk-check"><input type="checkbox" id="lkHideEmpty"${L.hideEmpty ? " checked" : ""}>空欄の項目を隠す</label>`
      + `<button type="button" id="lkEdit" class="lk-edit" aria-pressed="${editing}" title="項目の並び・幅・隠す を変えます">${editing ? "配置の編集中" : "配置を編集"}</button>`;
    $("#lkPick").disabled = !lotVal;
    const grid = $("#lkGrid");
    grid.className = `lk-grid size-${L.size}${L.cols ? " is-fixed" : ""}${editing ? " is-editing" : ""}`;
    grid.style.setProperty("--lk-cols", L.cols || 1);
    const tiles = shown.map((c) => tile(t, c, L)).join("");
    grid.innerHTML = tiles || `<p class="lk-empty">${shown.length ? "空欄でない項目がありません（「空欄の項目を隠す」を外すと出ます）" : "出す項目がありません。「配置を編集」で隠した項目を戻せます。"}</p>`;
    if (editing) TPA.dragSort(grid, ".lk-f", { onDrop: move });
    const tray = $("#lkTray");
    tray.hidden = !editing;
    tray.innerHTML = `<em>隠した項目</em>` + (hidden.length ? hidden.map((c) => `<button type="button" data-show="${esc(c)}" title="カードに戻します">＋ ${esc(LC().label(t, c))}</button>`).join("")
      : "<small>ありません（項目の「隠す」でここへ移ります）</small>");
    $("#lkFoot").hidden = !editing;
    P.onShow(idx);
  }
  function tile(t, c, L) {
    const cell = row ? LC().cell(t, c, row) : { text: "", raw: "", color: "" };
    const empty = !String(cell.text ?? "").trim();
    if (empty && L.hideEmpty && !editing) return "";
    let sp = String(L.spans[c] || "1");
    if (L.cols && sp === "2" && L.cols < 2) sp = "1";       // 1列のときの2枠は1枠（はみ出さない）
    const style = sp === "row" ? "grid-column:1/-1" : sp === "2" ? "grid-column:span 2" : "";
    const tip = cell.raw !== cell.text ? `${cell.text}\n元の値: ${cell.raw}` : cell.text;
    return `<div class="lk-f${empty ? " is-empty" : ""}" data-col="${esc(c)}"${editing ? ' draggable="true"' : ""}${style ? ` style="${style}"` : ""}>`
      + `<span class="lk-l">${editing ? '<i class="lk-grip" aria-hidden="true">⠿</i>' : ""}${esc(LC().label(t, c))}</span>`
      + `<b class="lk-v${cell.color ? " cell-" + cell.color : ""}" title="${esc(tip)}">${empty ? "—" : esc(cell.text)}</b>`
      + (editing ? `<span class="lk-fe">${SPANS.map(([v, l]) => `<button type="button" data-span="${v}" aria-pressed="${v === sp}" title="幅: ${l}">${l}</button>`).join("")}`
        + '<button type="button" data-hide title="この項目をカードから隠します（下の「隠した項目」から戻せます）">隠す</button></span>' : "")
      + "</div>";
  }

  /* ---------------- 行 ---------------- */
  const sigOf = (r) => JSON.stringify(r);
  function show(i) {
    const rows = P.rows();
    if (!rows[i]) return;
    ensure();
    row = rows[i]; rowSig = sigOf(row); idx = i;
    if (panel.hidden) { win.place(); panel.hidden = false; }
    render();
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }
  function step(d) { if (idx >= 0) show(Math.max(0, Math.min(P.rows().length - 1, idx + d))); }
  /* 一覧が読み直された（絞り込み・並べ替え・ページ・表示列）: 同じ行を探し直し、無ければ開いたときの値のまま */
  function refresh() {
    if (!panel || panel.hidden) return;
    idx = P.rows().findIndex((r) => sigOf(r) === rowSig);
    if (idx >= 0) row = P.rows()[idx];
    render();
  }
  function close() {
    if (!panel || panel.hidden) return;
    win.remember(); panel.hidden = true; editing = false; idx = -1;
    P.onShow(-1);
  }
  window.LotListCard = {
    /** p: { rows(), target(), columns(), lotColumn(), lotKey(row), onPick(lot), onShow(index) } */
    mount(p) { P = p; ensure(); },     // 窓は最初に作る（Esc の重なり順: 後から開く窓（マスタ管理など）が上）
    show, refresh, close,
    isOpen: () => !!panel && !panel.hidden,
  };
})();
