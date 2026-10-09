/* =========================================================================
   異常ロット一覧のスライサー（Excel のスライサーと同じ: 列の重複なしの値を並べ、押して絞り込む）
   - 足した列ごとにカード。値は全部並べ（件数の帯つき）、多いときは「値を探す」で絞る。0 件の値も淡く並べる（押せる）
   - 件数は「ほかの絞り込み（検索・条件・列で絞り込む・ほかのスライサー）のもとで」の件数（自分の選択は除く）
   - 選んだ値は in の絞り込みとして一覧へ渡す（lot_list.build_filter_where / lotlist.rs）。空欄も選べる（値 ""）
   - 日付だけ・年月・年の書式で見せている列は、見えている値でまとめる（鍵は一覧と同じ levelKeyKind）
   - 置き場は左（既定）・右・上。足した列と選んだ値は表ごと、置き場と開閉は全体で、この PC に覚える
   一覧（lotlist.js）とは mount の引数だけでつながる: table・search・baseFilters・keyOf・label・onChange
   ========================================================================= */
(function () {
  "use strict";
  const { $, esc } = TPA;
  const KEY = "tpa.lotlist.slicer.v1";
  const PLACES = [["left", "左"], ["right", "右"], ["top", "上"]];
  const SEARCH_FROM = 6;        // 値がこの数以上なら「値を探す」の欄を出す（数個なら探すまでもない）
  const BLANK = "（空欄）";
  let host = null, seq = 0;
  const vals = {};              // 列 → { key, values: [{value, count, all}], truncated }（直近の答え）
  const qs = {};                // 列 → 「値を探す」に打った字（描き直しても残す）

  /* ---- 覚え: {open, place, tables: {表: [{column, key, sel: [...]}]}} ---- */
  const load = () => { const s = TPA.local.get(KEY, {}); return { open: !!s.open, place: PLACES.some((p) => p[0] === s.place) ? s.place : "left", tables: s.tables || {} }; };
  let st = load();
  const save = () => TPA.local.set(KEY, st);
  const cards = () => (st.tables[host.table()] || []);
  const setCards = (list) => { const t = host.table(); if (list.length) st.tables[t] = list; else delete st.tables[t]; save(); };
  const cardOf = (col) => cards().find((c) => c.column === col);

  /** 一覧へ渡す絞り込み（選んでいるカードだけ。except の列は除く＝その列自身の件数を数えるとき） */
  function filters(except = null) {
    // 列がまだ分からない（開いた直後）ときも渡す。無い列はサーバーが外す（safe_filters）
    const cs = host.columns();
    return cards().filter((c) => c.sel.length && c.column !== except && (!cs.length || cs.includes(c.column)))
      .map((c) => ({ column: c.column, op: "in", value: JSON.stringify(c.sel), ...(c.key ? { key: c.key } : {}) }));
  }
  const active = () => cards().filter((c) => c.sel.length).length;

  /* ---- 値を読む（カードごとに、自分の選択を除いた絞り込みで） ---- */
  async function refresh() {
    if (!host) return;
    paintEntry(); paintSum();
    if (!st.open) return;
    const my = ++seq, list = cards().filter((c) => host.columns().includes(c.column));
    // 書式が変わって鍵が変わった列は、前の鍵で選んだ値が当たらないので選び直してもらう
    let changed = false;
    list.forEach((c) => { const k = host.keyOf(c.column); if ((c.key || "") !== k) { c.key = k; if (c.sel.length) { c.sel = []; changed = true; } } });
    if (changed) { save(); host.onChange(); return; }
    await Promise.all(list.map(async (c) => {
      const q = new URLSearchParams({ column: c.column, table: host.table() });
      if (c.key) q.set("key", c.key);
      if (host.search()) q.set("search", host.search());
      const f = host.baseFilters().concat(filters(c.column));
      if (f.length) q.set("filters", JSON.stringify(f));
      try {
        const r = await fetch("/api/lotlist/slicer?" + q, { cache: "no-store" });
        const d = await r.json();
        if (my === seq && r.ok) vals[c.column] = { key: c.key || "", values: d.values || [], truncated: !!d.truncated };
      } catch (_) { /* 次の読み込みで */ }
    }));
    if (my === seq) render();
  }

  /* ---- 描く ---- */
  function render() {
    const pane = $("#llSlicer"), row = $("#llBodyRow");
    pane.hidden = !st.open;
    row.dataset.place = st.place;
    paintEntry(); paintSum();
    if (!st.open) return;
    const used = new Set(cards().map((c) => c.column));
    const addable = host.columns().filter((c) => !used.has(c));
    const head = `<div class="sx-head"><b>スライサー</b>
      <span class="sx-place" role="radiogroup" aria-label="置き場">${PLACES.map(([k, n]) => `<button type="button" role="radio" data-place="${k}" aria-checked="${st.place === k}" title="スライサーを表の${n}に置きます">${n}</button>`).join("")}</span>
      <button type="button" class="sx-close" data-close title="スライサーを閉じます（選んだ値はそのまま効きます）" aria-label="閉じる">×</button></div>`;
    const body = cards().filter((c) => host.columns().includes(c.column)).map(cardHtml).join("")
      || '<p class="sx-empty">列を足すと、その列の値（重複なし）と件数が並びます。押した値の行だけが一覧に出ます。</p>';
    const add = `<select id="llSlicerAdd" class="sx-add" aria-label="スライサーに列を足す"><option value="">＋ 列を足す…</option>${addable.map((c) => `<option value="${esc(c)}">${esc(host.label(c))}</option>`).join("")}</select>`;
    pane.innerHTML = head + `<div class="sx-cards">${body}${add}</div>`;
    pane.querySelectorAll(".sx-q").forEach((inp) => { const q = qs[inp.closest(".sx-card").dataset.col]; if (q) { inp.value = q; filterValues(inp); } });
  }
  function cardHtml(c) {
    const v = vals[c.column], sel = new Set(c.sel);
    const list = v ? v.values : [];
    const max = Math.max(1, ...list.map((x) => x.count));
    const search = list.length >= SEARCH_FROM ? `<input class="sx-q" type="search" placeholder="値を探す" aria-label="「${esc(host.label(c.column))}」の値を探す" autocomplete="off">` : "";
    const items = !v ? '<p class="sx-wait">読み込み中…</p>' : list.map((x) => {
      const on = sel.has(x.value), label = x.value === "" ? BLANK : x.value;
      return `<button type="button" class="sx-v${on ? " is-on" : ""}${x.count ? "" : " is-zero"}" data-v="${esc(x.value)}" data-n="${x.count}" aria-pressed="${on}"`
        + ` style="--w:${Math.round(x.count / max * 100)}%" title="${esc(label)}：${x.count} 件（絞り込みを外すと ${x.all} 件）"><span>${esc(label)}</span><i>${x.count}</i></button>`;
    }).join("") + (v.truncated ? `<p class="sx-more">値が多いため、先頭の ${list.length} 通りだけを並べています</p>` : "");
    return `<section class="sx-card" data-col="${esc(c.column)}">
      <div class="sx-ch"><b title="${esc(c.column)}">${esc(host.label(c.column))}</b>
        ${c.sel.length ? `<button type="button" class="sx-clr" data-clr title="この列の選択を外します">${c.sel.length} 選択 ×</button>` : ""}
        <button type="button" class="sx-rm" data-rm title="このスライサーを外します（選んだ値も外れます）">外す</button></div>
      ${search}<div class="sx-vals">${items}</div></section>`;
  }
  /** 道具の行の入口: 開いているか・選んでいるスライサーの数 */
  function paintEntry() {
    const b = $("#llSlicerBtn"); if (!b) return;
    const n = active();
    b.classList.toggle("is-on", st.open || n > 0);
    b.setAttribute("aria-expanded", st.open);
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="5" height="12" rx="1"/><path d="M9 3.5h5.5M9 6.5h5.5M9 9.5h5.5M9 12.5h5.5"/></svg>スライサー${n ? `<b>${n}</b>` : ""}`;
  }
  /** 件数の行の札: 「設備: CR1・L-1 ×」。スライサーを閉じても何で絞っているかが分かる */
  function paintSum() {
    const box = $("#llSlicerSum"); if (!box) return;
    const on = cards().filter((c) => c.sel.length && host.columns().includes(c.column));
    box.hidden = !on.length;
    box.innerHTML = on.map((c) => {
      const names = c.sel.map((v) => (v === "" ? BLANK : v));
      const text = names.length > 3 ? `${names.slice(0, 3).join("・")} ほか ${names.length - 3}` : names.join("・");
      return `<span class="sx-chip" title="${esc(host.label(c.column))}: ${esc(names.join("・"))}"><b>${esc(host.label(c.column))}:</b> ${esc(text)}`
        + `<button type="button" data-clear="${esc(c.column)}" aria-label="「${esc(host.label(c.column))}」のスライサーの選択を外す">×</button></span>`;
    }).join("");
  }

  /* ---- 操作 ---- */
  function toggleValue(col, v) {
    const c = cardOf(col); if (!c) return;
    c.sel = c.sel.includes(v) ? c.sel.filter((x) => x !== v) : c.sel.concat(v);
    save(); render(); host.onChange();
  }
  /** この表のスライサーの選択を全部外す（カードは残す）。引き直しは呼んだ側が行う */
  function clearAll() { cards().forEach((c) => { c.sel = []; }); save(); render(); }
  function clear(col) { const c = cardOf(col); if (!c || !c.sel.length) return; c.sel = []; save(); render(); host.onChange(); }
  function bind() {
    $("#llSlicerBtn").addEventListener("click", () => { st.open = !st.open; save(); render(); refresh(); });
    $("#llSlicerSum").addEventListener("click", (e) => { const b = e.target.closest("[data-clear]"); if (b) clear(b.dataset.clear); });
    const pane = $("#llSlicer");
    pane.addEventListener("click", (e) => {
      const t = e.target, card = t.closest(".sx-card"), col = card && card.dataset.col;
      const place = t.closest("button[data-place]");   // 枠（#llBodyRow）も data-place を持つので、ボタンに限る
      if (place) { st.place = place.dataset.place; save(); render(); return; }
      if (t.closest("[data-close]")) { st.open = false; save(); render(); $("#llSlicerBtn").focus(); return; }
      if (t.closest(".sx-v")) { toggleValue(col, t.closest(".sx-v").dataset.v); return; }
      if (t.closest("[data-clr]")) { clear(col); return; }
      if (t.closest("[data-rm]")) { const had = cardOf(col).sel.length; setCards(cards().filter((c) => c.column !== col)); delete vals[col]; render(); if (had) host.onChange(); }
    });
    pane.addEventListener("change", (e) => {
      if (e.target.id !== "llSlicerAdd" || !e.target.value) return;
      const col = e.target.value;
      setCards(cards().concat({ column: col, key: host.keyOf(col), sel: [] }));
      render(); refresh();
    });
    // 値を探す（変換中は絞らない）。描き直しても字は残す
    pane.addEventListener("input", (e) => {
      const inp = e.target.closest(".sx-q"); if (!inp || TPA.composing(e)) return;
      filterValues(inp);
    });
    pane.addEventListener("compositionend", (e) => { const inp = e.target.closest(".sx-q"); if (inp) filterValues(inp); });
  }
  function filterValues(inp) {
    qs[inp.closest(".sx-card").dataset.col] = inp.value;
    const q = inp.value.trim().toLowerCase();
    inp.closest(".sx-card").querySelectorAll(".sx-v").forEach((b) => { b.hidden = !!q && !b.textContent.toLowerCase().includes(q); });
  }

  function mount(h) { host = h; bind(); render(); }
  window.LotListSlicer = { mount, refresh, filters, render, clearAll };
})();
