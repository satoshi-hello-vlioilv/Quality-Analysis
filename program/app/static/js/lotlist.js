"use strict";
/* =========================================================================
   ロット一覧（品質データ SQLite の手元の写し）＋ 絞り込み
   - 元データの読み方は WaveLog の品質データと同じ（サーバーが共有を手元へ写し、写しだけを読む）。
   - 絞り込みの仕組みは WaveLog の汎用フィルタ（static/js/list/filters.js）と同じ:
       一覧を検索（全列の字）／プリセット（登録した条件の組み合わせを切り替え）／
       条件（効いている条件の面: 外す・☆で登録・足す・作る・全部外す）／
       列で絞り込む（列と比べ方は覚え、値はその場だけ。打つと 280ms 後に効く）／
       条件を作る（列・比べ方・値 → 適用／登録）／登録した条件とプリセット（組み合わせ名・いつも適用（固定））。
     比べ方の 12 種と SQL は WaveLog と同じで、絞り込みはサーバー（SQL）で行う。
   - ロット番号を押すと、転写計算の「検索」と同じ流れでそのロットを取り込む（onPick）。
   - 機能（「表の見せ方」でこの PC ごとに使う／使わないを切り替える）:
       ロット番号でまとめる … 同じロットの行を続けて並べ、2行以上のロットには見出し行（共通の値・件数・畳む）を付ける。
                              並びはサーバー（lot_list.grouped_rows）が決め、並べ替えは効いたまま、ページの境目でロットを切らない。
       行のダブルクリックでカード … その1行をカードで見る（lotlist-card.js）。
   ========================================================================= */
(function () {
  const { $, $$, esc } = TPA;
  const store = TPA.local;
  const KEY = {
    active: "tpa.lotlist.active.v1",      // 適用中の条件（表ごと。固定の条件は覚えない＝毎回導き直す）
    adhoc: "tpa.lotlist.adhoc.v1",        // 列で絞り込むの「列と比べ方」（表ごと。値は覚えない）
    adhocOpen: "tpa.lotlist.adhocOpen.v1",
    presets: "tpa.lotlist.presets.v1",    // 登録した条件（1条件ずつ。group が同じものが組み合わせ＝プリセット）
    presetSel: "tpa.lotlist.presetSel.v1",
    sorts: "tpa.lotlist.sorts.v1",
    pageSize: "tpa.lotlist.pageSize.v1",
    table: "tpa.lotlist.table.v1",
    features: "tpa.lotlist.features.v1",  // 機能の使う／使わない（この PC）
    collapsed: "tpa.lotlist.collapsed.v1", // 畳んだロット（表ごと・開いているあいだだけ）
  };
  /* 機能の既定: まとめるは使わない（今までの見え方のまま）、カードは使う（ダブルクリックは今まで何もしなかった操作） */
  const FEATURES = { group: false, card: true };
  const feat = Object.assign({}, FEATURES, store.get(KEY.features, {}));
  function setFeature(k, v) { feat[k] = !!v; store.set(KEY.features, feat); }
  const OPS = [
    ["contains", "含む"], ["not_contains", "含まない"], ["eq", "＝ 一致"], ["neq", "≠ 不一致"],
    ["starts", "前方一致"], ["ends", "後方一致"], ["gt", "> より大きい"], ["gte", ">= 以上"], ["lt", "< より小さい"], ["lte", "<= 以下"], ["empty", "空欄"], ["not_empty", "空欄以外"],
    // 日付と読める列だけ: 今日から数えて N 日（週・か月・年）以内（サーバーが ToDate(列) >= 今日−N で絞る）
    ["within_days", "日以内（今日から）"], ["within_weeks", "週間以内（今日から）"], ["within_months", "か月以内（今日から）"], ["within_years", "年以内（今日から）"],
  ];
  const REL_UNIT = { within_days: "日", within_weeks: "週間", within_months: "か月", within_years: "年" };
  const REL_PICKS = { within_days: [0, 1, 3, 7, 14, 30], within_weeks: [1, 2, 4], within_months: [1, 3, 6, 12], within_years: [1, 2, 3] };
  const isRel = (op) => op in REL_UNIT;
  const PAGE_SIZES = [200, 500, 1000, 2000];
  const ADHOC_DEBOUNCE_MS = 280;
  const SEARCH_DEBOUNCE_MS = 280;
  const SOURCE_POLL_MS = 20000;
  const MAX_SORTS = 4;
  const PRESET_NONE = "";

  const opLabel = (op) => (OPS.find((x) => x[0] === op) || [op, op])[1];
  const opShort = (op) => opLabel(op).split(" ")[0];
  const noValueOp = (op) => op === "empty" || op === "not_empty";
  const filterKey = (f) => [f.column, f.op, f.value].join("\u001f");
  const relText = (f) => `${f.value}${REL_UNIT[f.op]}以内` + (String(f.value) === "0" && f.op === "within_days" ? "（今日）" : "");
  const condLabel = (f) => isRel(f.op) ? `${f.column} ${relText(f)}`
    : noValueOp(f.op) ? `${f.column} ${opShort(f.op)}` : `${f.column} ${opShort(f.op)} ${f.value}`;
  const isDateCol = (c) => S.dateColumns.includes(c);
  /* 比べ方の選択欄: 日付の列でなければ「以内」を選べなくする（押しても何も当たらない物を出さない）。
     選んでいた比べ方が使えなくなったら「含む」へ戻す。 */
  function paintOpOptions(sel, column) {
    const date = isDateCol(column);
    [...sel.options].forEach((o) => {
      if (!isRel(o.value)) return;
      o.disabled = !date;
      o.title = date ? "今日から数えて、この期間に入る日付の行" : "日付と読める列だけで使えます";
    });
    if (isRel(sel.value) && !date) sel.value = "contains";
    return sel.value;
  }
  const colOption = (c) => `<option value="${esc(c)}">${esc(c)}${isDateCol(c) ? "（日付）" : ""}</option>`;
  const presetName = (f) => condLabel(f).slice(0, 60);

  const S = {
    table: store.get(KEY.table, ""), tables: [], columns: [], rows: [], count: 0, lotColumn: "",
    page: 1, pageSize: store.get(KEY.pageSize, 500), search: "", sorts: [],
    genericFilters: [], presets: store.get(KEY.presets, []), source: null, loadedAt: null, dateColumns: [],
    loading: false, error: "", seq: 0, currentLot: "", dateHints: [], today: "",
    groups: null, groupCount: 0, range: [0, 0], cardIdx: -1,
  };
  /* まとめるときのロットの見分け方（サーバーの lot_key と同じ: 大小・前後の空白は同じロット） */
  const lotKey = (r) => (S.lotColumn && r ? String(r[S.lotColumn] ?? "").trim().toUpperCase() : "");
  const grouped = () => !!(S.groups && S.lotColumn);
  const collapsed = () => new Set((TPA.session.get(KEY.collapsed, {})[S.table]) || []);
  function setCollapsed(set) { const all = TPA.session.get(KEY.collapsed, {}); all[S.table] = [...set]; TPA.session.set(KEY.collapsed, all); }
  let onPick = () => {};
  let root = null;

  /* ================= 読み込み ================= */
  function queryString() {
    const q = new URLSearchParams();
    if (S.table) q.set("table", S.table);
    q.set("page", S.page); q.set("page_size", S.pageSize);
    if (S.search) q.set("search", S.search);
    const list = S.genericFilters.map(({ column, op, value }) => ({ column, op, value })).concat(adhocFilters());
    if (list.length) q.set("filters", JSON.stringify(list));
    if (S.sorts.length) q.set("sorts", JSON.stringify(S.sorts));
    if (feat.group) q.set("group", "1");
    return q.toString();
  }
  async function load() {
    const seq = ++S.seq;
    S.loading = true; paintBusy();
    try {
      const r = await fetch("/api/lotlist?" + queryString(), { cache: "no-store" });
      const d = await r.json();
      if (seq !== S.seq) return;              // 追い越された古い答えは捨てる
      S.source = d.source || S.source;
      if (!r.ok) throw new Error(d.error || "ロット一覧を読めませんでした");
      S.table = d.table; S.tables = d.tables || []; S.columns = d.columns || []; S.rows = d.rows || [];
      S.count = d.count || 0; S.lotColumn = d.lotColumn || ""; S.error = ""; S.dateColumns = d.dateColumns || []; S.dateHints = d.dateHints || []; S.today = d.today || "";
      S.sorts = d.sorts || S.sorts;
      S.groups = d.groups || null; S.groupCount = d.groupCount || 0; S.range = d.range || [0, 0];
      S.loadedAt = (S.source && S.source.copiedAt) || null;
      store.set(KEY.table, S.table);
      // 表が初めて決まった（サーバーが既定の表を選んだ）ら、その表の覚えを戻して引き直す
      if (contextKey !== S.table && syncContext() && (S.genericFilters.length || S.sorts.length || adhocActive())) {
        S.loading = false; return load();
      }
    } catch (e) {
      if (seq !== S.seq) return;
      S.error = e.message; S.rows = []; S.count = 0; S.groups = null; S.range = [0, 0];
    }
    S.loading = false;
    renderAll();
  }

  /* ================= 表（コンテキスト）ごとの覚え ================= */
  let contextKey = null;
  function saveActive() {
    if (contextKey == null) return;
    const all = store.get(KEY.active, {});
    const keep = S.genericFilters.filter((f) => !f.locked).map((f) => ({ column: f.column, op: f.op, value: f.value }));
    if (keep.length) all[contextKey] = keep; else delete all[contextKey];
    store.set(KEY.active, all);
    const srt = store.get(KEY.sorts, {});
    if (S.sorts.length) srt[contextKey] = S.sorts; else delete srt[contextKey];
    store.set(KEY.sorts, srt);
  }
  /* 表が決まった（変わった）ら、その表の覚えを戻して「いつも適用（固定）」を当て直す。戻り値: 条件が変わったか */
  function syncContext(force) {
    if (!S.table) return false;
    if (S.table === contextKey && !force) return false;
    if (contextKey != null && contextKey !== S.table) saveActive();
    contextKey = S.table;
    S.genericFilters = (store.get(KEY.active, {})[S.table] || []).map((f) => ({ ...f }));
    S.sorts = (store.get(KEY.sorts, {})[S.table] || []).slice(0, MAX_SORTS);
    applyAlwaysOn();
    syncAdhocContext();
    S.page = 1;
    return true;
  }
  function tablePresets() { return S.presets.filter((p) => p.table === S.table); }
  function savePresets() { store.set(KEY.presets, S.presets); }
  /* 「いつも適用（固定）」は開くたびに入り、手で外せても開き直すと戻る（WaveLog §9.190 と同じ）。 */
  function applyAlwaysOn() {
    const seen = new Set(S.genericFilters.map(filterKey));
    tablePresets().filter((p) => p.always).forEach((p) => (p.filters || []).forEach((f) => {
      const k = filterKey(f);
      if (!seen.has(k)) { seen.add(k); S.genericFilters.push({ ...f, locked: true }); }
      else { const i = S.genericFilters.findIndex((x) => filterKey(x) === k); if (i >= 0) S.genericFilters[i].locked = true; }
    }));
  }

  /* ================= 条件の操作 ================= */
  function reload() { S.page = 1; saveActive(); renderBar(); load(); }
  function addFilter(f) {
    if (!S.genericFilters.some((x) => filterKey(x) === filterKey(f))) S.genericFilters.push({ column: f.column, op: f.op, value: f.value });
    reload();
  }
  function confirmLocked(list) {
    if (!list.length) return true;
    const desc = list.map(condLabel).join("、");
    return confirm(`「いつも適用（固定）」の条件があります（${desc}）。外すと、この一覧を開き直すまで条件が緩みます。\n本当に外しますか？`);
  }
  function removeFilterAt(i) {
    const f = S.genericFilters[i];
    if (!f || (f.locked && !confirmLocked([f]))) return;
    S.genericFilters.splice(i, 1); reload();
  }
  function dropAllFilters({ adhoc: withAdhoc = false } = {}) {
    const locked = S.genericFilters.filter((f) => f.locked);
    S.genericFilters = locked.length && !confirmLocked(locked) ? locked : [];
    if (withAdhoc) resetAdhoc();
  }
  function registeredPreset(f) {
    const k = filterKey(f);
    return tablePresets().find((p) => (p.filters || []).length === 1 && filterKey(p.filters[0]) === k) || null;
  }
  function saveOne(f) {
    if (registeredPreset(f)) return "dup";
    S.presets.unshift({ id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: presetName(f),
      table: S.table, filters: [{ column: f.column, op: f.op, value: f.value }], group: "", always: false });
    S.presets = S.presets.slice(0, 200); savePresets();
    return "saved";
  }

  /* ================= プリセット（登録した条件の組み合わせ・切り替え） ================= */
  function presetEntries() {
    const ps = tablePresets(), out = [], groups = new Map();
    ps.forEach((p) => { if (p.group) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); } });
    groups.forEach((list, g) => out.push({ kind: "combo", key: "g:" + g, name: g, conds: list.flatMap((p) => p.filters || []) }));
    ps.forEach((p) => out.push({ kind: "single", key: "p:" + p.id, name: p.name, conds: p.filters || [] }));
    return out;
  }
  function selectedPresetKey() {
    const k = (store.get(KEY.presetSel, {})[S.table]) || PRESET_NONE;
    return presetEntries().some((e) => e.key === k) ? k : PRESET_NONE;
  }
  function setSelectedPreset(k) { const m = store.get(KEY.presetSel, {}); if (k) m[S.table] = k; else delete m[S.table]; store.set(KEY.presetSel, m); }
  /* 切り替え＝入れ替え（足すのではない）。前のプリセットの条件を外し、新しいプリセットの条件を入れる。
     手で足した条件と「いつも適用（固定）」はそのまま。 */
  function switchPreset(key) {
    const entries = presetEntries();
    const prev = entries.find((e) => e.key === selectedPresetKey());
    const next = entries.find((e) => e.key === key);
    if (prev) {
      const drop = new Set(prev.conds.map(filterKey));
      S.genericFilters = S.genericFilters.filter((f) => f.locked || !drop.has(filterKey(f)));
    }
    if (next) {
      const seen = new Set(S.genericFilters.map(filterKey));
      next.conds.forEach((f) => { if (!seen.has(filterKey(f))) { seen.add(filterKey(f)); S.genericFilters.push({ column: f.column, op: f.op, value: f.value }); } });
    }
    setSelectedPreset(next ? key : PRESET_NONE);
    reload();
  }
  function presetButtonState() {
    const entries = presetEntries();
    const cur = entries.find((e) => e.key === selectedPresetKey());
    if (!cur) return { name: "なし", total: 0, off: 0, empty: !entries.length, note: "" };
    const active = new Set(S.genericFilters.map(filterKey));
    const off = cur.conds.filter((f) => !active.has(filterKey(f))).length;
    return { name: cur.name, total: cur.conds.length, off, empty: false, note: off ? `${off}件外し中` : "" };
  }

  /* ================= 列で絞り込む（登録しない・その場だけ） ================= */
  let adhoc = { column: "", op: "contains", value: "" };
  let adhocScope = null, adhocTimer = null, adhocColsSig = "";
  let adhocOpen = !!store.get(KEY.adhocOpen, false);
  function saveAdhocSetup() {
    if (adhocScope == null) return;
    const all = store.get(KEY.adhoc, {});
    if (adhoc.column) all[adhocScope] = { column: adhoc.column, op: adhoc.op }; else delete all[adhocScope];
    store.set(KEY.adhoc, all);
  }
  function syncAdhocContext() {
    if (S.table === adhocScope) return;
    if (adhocScope != null) saveAdhocSetup();
    const saved = store.get(KEY.adhoc, {})[S.table] || {};
    adhoc = { column: String(saved.column || ""), op: OPS.some((o) => o[0] === saved.op) ? saved.op : "contains", value: "" };
    adhocScope = S.table; adhocColsSig = "";
    const box = $("#llAdhocValue"); if (box) box.value = "";
  }
  const adhocColumnOk = () => !!adhoc.column && (!S.columns.length || S.columns.includes(adhoc.column));
  const adhocActive = () => adhocColumnOk() && (noValueOp(adhoc.op)
    || (isRel(adhoc.op) ? /^\d+$/.test(String(adhoc.value || "").trim()) : !!String(adhoc.value || "").trim()));
  const adhocFilters = () => adhocActive() ? [{ column: adhoc.column, op: adhoc.op, value: noValueOp(adhoc.op) ? "" : String(adhoc.value).trim() }] : [];
  const adhocLabel = () => adhoc.column ? condLabel({ column: adhoc.column, op: adhoc.op, value: String(adhoc.value || "").trim() }) : "";
  function applyAdhoc(now) {
    clearTimeout(adhocTimer); adhocTimer = null;
    const run = () => { S.page = 1; renderBar(); load(); };
    if (now) run(); else adhocTimer = setTimeout(run, ADHOC_DEBOUNCE_MS);
  }
  function resetAdhoc() { adhoc.value = ""; const b = $("#llAdhocValue"); if (b) b.value = ""; }
  function clearAdhoc() { resetAdhoc(); applyAdhoc(true); }
  function keepAdhoc() { const l = adhocFilters(); if (!l.length) return; resetAdhoc(); addFilter(l[0]); }
  function setAdhocOpen(v) {
    adhocOpen = !!v; store.set(KEY.adhocOpen, adhocOpen);
    if (adhocOpen) setBodyOpen(false);
    renderAdhocRow();
    if (adhocOpen) requestAnimationFrame(() => {
      const box = $("#llAdhocValue");
      (box && !box.disabled ? box : $("#llAdhocColumn"))?.focus();
    });
    else $("#llAdhocToggle")?.focus();
  }
  function setBodyOpen(v) {
    const body = $("#llFilterBody"); if (!body) return;
    body.hidden = !v;
    const t = $("#llFilterToggle .fb-act-name"); if (t) t.textContent = v ? "「条件を作る」の欄を閉じる" : "条件を作る・登録する";
    if (v && adhocOpen) { adhocOpen = false; store.set(KEY.adhocOpen, false); renderAdhocRow(); }
    if (v) requestAnimationFrame(() => $("#llFilterColumn")?.focus());
  }

  /* ================= フィルタのバー ================= */
  function buildBar() {
    const bar = $("#llFilterBar");
    bar.innerHTML = `
      <div class="filter-search-row">
        <label class="lt-search" title="この一覧の行を、どの列の字でも探します（打つとすぐ絞り込みます）">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14"/></svg>
          <input id="llSearch" type="search" autocomplete="off" placeholder="一覧を検索" aria-label="一覧を検索">
        </label>
        <button id="llPresetBtn" class="fb-preset-btn" type="button" aria-haspopup="true" aria-expanded="false">
          <span class="fb-preset-key">プリセット</span><b id="llPresetName">なし</b><em id="llPresetNote" hidden></em><i class="hd-caret" aria-hidden="true">▾</i>
        </button>
        <button id="llCondBtn" class="fb-cond-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="llCondMenu">
          <svg class="fb-cond-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 2.6h12.8L9.4 8.2v4.3l-2.8 1.6V8.2z"/></svg>
          <span class="fb-cond-key">条件</span><b id="llCondCount" class="fb-cond-n">0</b><i class="hd-caret" aria-hidden="true">▾</i>
        </button>
        <button id="llAdhocToggle" class="filter-adhoc-toggle" type="button" aria-expanded="false" aria-controls="llAdhocRow">列で絞り込む</button>
        <div class="filter-token-input" id="llTokenInput" hidden>
          <span class="filter-token-key" aria-hidden="true">＋条件</span>
          <input class="filter-token-search" id="llTokenSearch" autocomplete="off" placeholder="列名・値を打つと候補が出ます" aria-label="条件を検索して足す">
          <div class="filter-suggest" id="llSuggest" hidden></div>
        </div>
        <!-- 右端の群＝見せ方（WaveLog と同じ: 表示列 → 表の見せ方） -->
        <div class="filter-search-row-actions">
          <button id="llColBtn" type="button" class="ll-colbtn" title="この一覧に出す列・並び・幅・書式・読み替えをまとめて設定します">
            <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11M10.5 2.5v11"/></svg>表示列</button>
          <button id="llViewBtn" type="button" aria-haspopup="dialog" aria-expanded="false" title="行間・並び・表示件数と、機能（ロット番号でまとめる・カード）の使う／使わないを決めます">表の見せ方 ▾</button>
        </div>
        <div class="ll-viewmenu" id="llViewMenu" hidden role="dialog" aria-label="表の見せ方"></div>
        <div class="fb-cond-menu" id="llCondMenu" hidden role="menu" aria-label="条件">
          <div class="fb-cond-list" id="llCondList"></div>
          <div class="fb-cond-acts" role="group" aria-label="条件の操作">
            <button id="llAddCond" type="button" role="menuitem">条件を検索して足す<small>列名・値を打つと候補が出ます</small></button>
            <button id="llFilterToggle" type="button" role="menuitem"><span class="fb-act-name">条件を作る・登録する</span><small>列・比べ方・値を選んで、いまだけ当てるか登録します</small></button>
            <button id="llOpenPresets" type="button" role="menuitem">登録した条件とプリセット<small>条件の削除と、組み合わせ（プリセット）作り・いつも適用</small></button>
            <button id="llClearFilters" class="fb-cond-clear" type="button" role="menuitem">条件を全部外す<small>「固定」の条件は確かめてから外します</small></button>
          </div>
        </div>
      </div>
      <div class="filter-adhoc-row" id="llAdhocRow" hidden
           title="登録はしません。打っているあいだだけ効き、表を切り替えると入力は消えます（列と比べ方は覚えています）。">
        <select id="llAdhocColumn" class="filter-adhoc-col" title="この一覧の列から選びます。選んだ列は次に開いたときも覚えています"></select>
        <select id="llAdhocOp" class="filter-adhoc-op" title="選んだ列をどう比べるか">${OPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <input id="llAdhocValue" class="filter-adhoc-value" list="llAdhocList" autocomplete="off" type="search" title="打つとその場で絞り込みます。Enterですぐ、Escで解除">
        <datalist id="llAdhocList"></datalist>
        <button id="llAdhocKeep" type="button">条件に残す</button>
        <button id="llAdhocClear" type="button" title="入力を消して、この絞り込みを解除します">解除</button>
        <span class="filter-adhoc-state" id="llAdhocState"></span>
        <button id="llAdhocClose" class="fb-close" type="button" aria-label="列で絞り込むを閉じる" title="閉じます（Esc）。効いている絞り込みはそのまま残ります">✕</button>
      </div>
      <div class="filter-body" id="llFilterBody" hidden>
        <div class="filter-body-head"><b>条件を作る</b>
          <button id="llFilterBodyClose" class="fb-close" type="button" title="閉じます（Esc）">✕ 閉じる</button></div>
        <div class="filter-builder">
          <label>列<select id="llFilterColumn"></select></label>
          <label>比べ方<select id="llFilterOp">${OPS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label>値<input id="llFilterValue" list="llSuggestList" placeholder="値を入力/候補から選択"><datalist id="llSuggestList"></datalist></label>
          <div class="filter-builder-actions">
            <button id="llAddFilter" type="button" title="この条件を今の一覧へ追加します（保存はしません）">適用</button>
            <button id="llRegisterFilter" type="button" title="この条件を登録します（一覧へは適用しません）">登録</button>
          </div>
        </div>
        <p class="filter-builder-note" id="llBuilderNote">「適用」は今だけ効かせる／「登録」は次回も使えるように保存する。両方押せます。</p>
      </div>`;

    // 一覧を検索（打つとすぐ。待ってからまとめて1回）
    let st = null;
    $("#llSearch").addEventListener("input", (e) => {
      clearTimeout(st);
      st = setTimeout(() => { S.search = e.target.value.trim(); S.page = 1; load(); }, SEARCH_DEBOUNCE_MS);
    });
    $("#llSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(st); S.search = e.target.value.trim(); S.page = 1; load(); }
    });
    $("#llPresetBtn").onclick = (e) => openPresetMenu(e.currentTarget);
    $("#llCondBtn").onclick = () => toggleCondMenu();
    $("#llCondMenu").addEventListener("click", (e) => { if (e.target.closest(".fb-cond-acts button")) closeCondMenu(); });
    $("#llAddCond").onclick = () => openTokenSearch();
    $("#llFilterToggle").onclick = () => setBodyOpen($("#llFilterBody").hidden);
    $("#llFilterBodyClose").onclick = () => { setBodyOpen(false); $("#llCondBtn").focus(); };
    $("#llOpenPresets").onclick = openPresetModal;
    $("#llClearFilters").onclick = () => { dropAllFilters(); reload(); };

    // 列で絞り込む
    $("#llAdhocToggle").onclick = () => setAdhocOpen(!adhocOpen);
    $("#llAdhocClose").onclick = () => setAdhocOpen(false);
    $("#llAdhocColumn").onchange = () => { adhoc.column = $("#llAdhocColumn").value; saveAdhocSetup(); updateAdhocSuggestions(); renderAdhocRow(); applyAdhoc(true); };
    $("#llAdhocOp").onchange = () => { adhoc.op = $("#llAdhocOp").value; saveAdhocSetup(); renderAdhocRow(); applyAdhoc(true); };
    const box = $("#llAdhocValue");
    box.addEventListener("input", () => { adhoc.value = box.value; renderAdhocRow(); applyAdhoc(false); });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); adhoc.value = box.value; renderAdhocRow(); applyAdhoc(true); }
      else if (e.key === "Escape" && box.value) { e.preventDefault(); e.stopPropagation(); clearAdhoc(); }
    });
    box.addEventListener("focus", updateAdhocSuggestions);
    $("#llAdhocKeep").onclick = keepAdhoc;
    $("#llAdhocClear").onclick = clearAdhoc;

    // 条件を作る（適用と登録は入力を消さない：片方のあとにもう片方も押せる）
    $("#llFilterColumn").onchange = updateBuilderOp;
    $("#llFilterOp").onchange = updateBuilderOp;
    const NOTE = "「適用」は今だけ効かせる／「登録」は次回も使えるように保存する。両方押せます。";
    const note = (t) => { $("#llBuilderNote").textContent = t; };
    const builderFilter = () => {
      const f = { column: $("#llFilterColumn").value, op: $("#llFilterOp").value, value: $("#llFilterValue").value.trim() };
      if (!f.column) return null;
      if (!noValueOp(f.op) && !f.value) { $("#llFilterValue").focus(); return null; }
      if (isRel(f.op) && !/^\d+$/.test(f.value)) { note("「以内」の値は 0 以上の整数で入れてください（例: 7）"); $("#llFilterValue").focus(); return null; }
      if (noValueOp(f.op)) f.value = "";
      return f;
    };
    $("#llAddFilter").onclick = () => { const f = builderFilter(); if (!f) return; addFilter(f); note(`適用しました: ${condLabel(f)}　続けて「登録」も押せます`); };
    $("#llRegisterFilter").onclick = () => {
      const f = builderFilter(); if (!f) return;
      note(saveOne(f) === "saved" ? `登録しました: ${presetName(f)}　続けて「適用」も押せます` : `すでに登録済みです: ${presetName(f)}`);
      renderBar();
    };
    ["#llFilterColumn", "#llFilterOp", "#llFilterValue"].forEach((s) => $(s).addEventListener("input", () => note(NOTE)));
    bindTokenSearch();

    // Esc はバー全体で受け、1回で閉じるのは1枚だけ
    bar.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.target.closest("#llTokenInput,#llCondMenu")) return;
      if (!$("#llFilterBody").hidden) { e.preventDefault(); setBodyOpen(false); $("#llCondBtn").focus(); }
      else if (adhocOpen) { e.preventDefault(); setAdhocOpen(false); }
    });
  }

  function renderBar() {
    if (!$("#llFilterBar").firstChild) buildBar();
    const box = $("#llSearch"); if (box && document.activeElement !== box && box.value !== S.search) box.value = S.search;
    updateFilterColumns(); renderPresetButton(); renderActiveTokens(); renderAdhocRow();
  }
  function updateFilterColumns() {
    const sel = $("#llFilterColumn"); const cur = sel.value;
    const sig = S.columns.join("\u001f") + "|" + S.dateColumns.join("\u001f");
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = S.columns.map(colOption).join("");
      if (S.columns.includes(cur)) sel.value = cur;
    }
    updateBuilderOp();
  }
  /* 条件を作る: 列に合わせて比べ方を選べる／選べないを決め、値の欄の案内と候補を変える */
  function updateBuilderOp() {
    const op = paintOpOptions($("#llFilterOp"), $("#llFilterColumn").value);
    const v = $("#llFilterValue");
    v.disabled = noValueOp(op);
    v.placeholder = isRel(op) ? `数（例: 7 → 7${REL_UNIT[op]}以内。0＝今日から）` : "値を入力/候補から選択";
    updateFilterSuggestions();
  }
  const distinctValues = (col) => [...new Set(S.rows.map((r) => String(r[col] ?? "").trim()).filter(Boolean))].slice(0, 80);
  // 値の候補: ふつうは読み込んだ行の値、「以内」ならよく使う数（7日・1か月など）
  const valueOptions = (col, op) => (isRel(op) ? REL_PICKS[op].map((n) => `<option value="${n}" label="${n}${REL_UNIT[op]}以内"></option>`)
    : distinctValues(col).map((v) => `<option value="${esc(v)}"></option>`)).join("");
  function updateFilterSuggestions() {
    const col = $("#llFilterColumn").value;
    $("#llSuggestList").innerHTML = col ? valueOptions(col, $("#llFilterOp").value) : "";
  }
  function updateAdhocSuggestions() {
    const list = $("#llAdhocList");
    list.innerHTML = !adhoc.column || noValueOp(adhoc.op) ? "" : valueOptions(adhoc.column, adhoc.op);
  }
  function renderPresetButton() {
    const btn = $("#llPresetBtn"), st = presetButtonState();
    $("#llPresetName").textContent = st.name;
    const note = $("#llPresetNote"); note.textContent = st.note; note.hidden = !st.note;
    btn.classList.toggle("is-on", st.total > 0 && !st.off);
    btn.classList.toggle("is-partial", st.total > 0 && st.off > 0);
    btn.classList.toggle("is-none", !st.total);
    btn.title = st.empty
      ? "プリセット（登録した条件の組み合わせ）はまだありません。\n条件を登録して、「登録した条件とプリセット」で組み合わせに名前を付けると、ここで切り替えられます。"
      : st.total ? `プリセット「${st.name}」（条件${st.total}件${st.off ? `／うち${st.off}件は外しています` : ""}）\n押すと別のプリセットへ切り替えます。`
        : "プリセットを当てていません。押すと切り替えられます。";
  }
  function condRows() {
    const rows = S.genericFilters.map((f, i) => ({ kind: "cond", f, i, locked: !!f.locked }));
    if (adhocActive()) rows.push({ kind: "adhoc", label: adhocLabel() });
    return rows;
  }
  function renderActiveTokens() {
    const btn = $("#llCondBtn"), rows = condRows(), n = rows.length;
    $("#llCondCount").textContent = String(n);
    btn.classList.toggle("is-on", n > 0);
    btn.setAttribute("aria-label", `条件 ${n}つ`);
    btn.title = n ? "効いている条件 " + n + "つ\n" + rows.map((r) => r.kind === "adhoc" ? `列で絞り込み: ${r.label}` : condLabel(r.f)).join("\n")
      + "\n押すと中身を確かめたり、外したり、条件を足したりできます。"
      : "効いている条件はありません。押すと、条件を足す・作る入口が開きます。";
    renderCondMenu();
  }
  function renderCondMenu() {
    const menu = $("#llCondMenu"), list = $("#llCondList");
    if (menu.hidden) return;
    const rows = condRows();
    const line = (r) => {
      if (r.kind === "adhoc") return '<div class="fb-cond-row is-adhoc"><span class="fb-cond-badge" title="登録していない、いまだけの絞り込み（「列で絞り込む」）">一時</span>'
        + `<span class="fb-cond-text">${esc(r.label)}</span><button type="button" class="fb-cond-x" data-adhoc-clear title="列で絞り込みの入力を消して外します">×</button></div>`;
      const known = !!registeredPreset(r.f);
      return `<div class="fb-cond-row${r.locked ? " is-locked" : ""}">`
        + (r.locked ? '<span class="fb-cond-badge is-lock" title="いつも適用（固定）。一覧を開くたびに入ります">🔒 固定</span>' : "")
        + `<span class="fb-cond-text">${esc(r.f.column)} ${isRel(r.f.op) ? `<b>${esc(relText(r.f))}</b><em class="fb-cond-rel">今日から</em>`
          : `<b>${esc(opLabel(r.f.op))}</b>${noValueOp(r.f.op) ? "" : ` <em>${esc(r.f.value)}</em>`}`}</span>`
        + (r.locked ? "" : `<button type="button" class="fb-cond-save${known ? " is-saved" : ""}" data-cond-save="${r.i}" title="${known ? "登録済み（「登録した条件とプリセット」にあります）" : "この条件を登録します。登録すると組み合わせ（プリセット）に入れられます"}">${known ? "★" : "☆"}</button>`)
        + `<button type="button" class="fb-cond-x" data-cond-x="${r.i}" title="この条件を外します">×</button></div>`;
    };
    list.innerHTML = '<p class="fb-cond-head">効いている条件' + (rows.length ? `<small>${rows.length}つ。この一覧に当てている絞り込みです</small>` : "<small>まだありません。下のどれかで足せます</small>") + "</p>" + rows.map(line).join("");
    $$("[data-cond-x]", list).forEach((b) => { b.onclick = () => removeFilterAt(+b.dataset.condX); });
    $$("[data-cond-save]", list).forEach((b) => { b.onclick = () => { const f = S.genericFilters[+b.dataset.condSave]; if (f && !registeredPreset(f)) { saveOne(f); renderBar(); } }; });
    $("[data-adhoc-clear]", list)?.addEventListener("click", clearAdhoc);
    $("#llClearFilters").disabled = !S.genericFilters.length;
  }
  let condOff = null;
  function closeCondMenu(byEsc) {
    const m = $("#llCondMenu"); if (m.hidden) return;
    m.hidden = true; $("#llCondBtn").setAttribute("aria-expanded", "false");
    if (condOff) condOff(); condOff = null;
    if (byEsc) $("#llCondBtn").focus();
  }
  function toggleCondMenu() {
    const m = $("#llCondMenu"), btn = $("#llCondBtn");
    if (!m.hidden) { closeCondMenu(); return; }
    m.hidden = false; renderCondMenu();
    TPA.placeBelow(m, btn);
    btn.setAttribute("aria-expanded", "true");
    condOff = TPA.dismissable(m, closeCondMenu, { keep: btn });
  }
  function renderAdhocRow() {
    const row = $("#llAdhocRow"), toggle = $("#llAdhocToggle");
    if (!row) return;
    const colSel = $("#llAdhocColumn"), sig = S.columns.join("\u001f");
    if (sig !== adhocColsSig) {
      adhocColsSig = sig;
      const missing = adhoc.column && S.columns.length && !S.columns.includes(adhoc.column);
      colSel.innerHTML = '<option value="">列を選ぶ…</option>'
        + (missing ? `<option value="${esc(adhoc.column)}">${esc(adhoc.column)}（この一覧にありません）</option>` : "")
        + S.columns.map(colOption).join("");
    }
    if (colSel.value !== adhoc.column) colSel.value = adhoc.column;
    const opSel = $("#llAdhocOp"); if (opSel.value !== adhoc.op) opSel.value = adhoc.op;
    if (paintOpOptions(opSel, adhoc.column) !== adhoc.op && S.columns.length) { adhoc.op = opSel.value; saveAdhocSetup(); }
    const box = $("#llAdhocValue"), noVal = noValueOp(adhoc.op);
    box.disabled = noVal || !adhoc.column;
    box.placeholder = !adhoc.column ? "先に列を選んでください" : noVal ? "この条件では値は要りません"
      : isRel(adhoc.op) ? `数を打つと絞り込みます（例: 7 → 7${REL_UNIT[adhoc.op]}以内）` : "打つとその場で絞り込みます（Enterですぐ）";
    if (document.activeElement !== box && box.value !== adhoc.value) box.value = adhoc.value;
    const on = adhocActive();
    const keep = $("#llAdhocKeep");
    keep.disabled = !on;
    keep.title = on ? `「${adhocLabel()}」を上の条件へ移します（そのあと登録もできます）` : "効いている条件があるときだけ移せます";
    $("#llAdhocClear").disabled = !on && !String(adhoc.value || "").trim();
    const state = $("#llAdhocState");
    if (!adhoc.column) { state.className = "filter-adhoc-state"; state.textContent = "列と比べ方を選ぶと使えます"; }
    else if (!adhocColumnOk()) { state.className = "filter-adhoc-state is-warn"; state.textContent = `この一覧に「${adhoc.column}」の列がありません`; }
    else if (on) { state.className = "filter-adhoc-state is-on"; state.textContent = `効いています: ${adhocLabel()}`; }
    else if (isRel(adhoc.op) && String(adhoc.value || "").trim()) { state.className = "filter-adhoc-state is-warn"; state.textContent = "「以内」は 0 以上の整数で入れてください（例: 7）"; }
    else { state.className = "filter-adhoc-state"; state.textContent = "まだ効いていません（入力欄に打つと効きます）"; }
    state.title = state.textContent;
    row.hidden = !adhocOpen;
    // 畳んでいても効いていることを名乗る（見えない場所で絞り込みが効いている状態を作らない）
    toggle.textContent = on ? `列で絞り込み中: ${adhocLabel()}` : "列で絞り込む";
    toggle.classList.toggle("active", adhocOpen || on);
    toggle.classList.toggle("is-on", on);
    toggle.setAttribute("aria-expanded", adhocOpen ? "true" : "false");
    toggle.title = on ? `いま「${adhocLabel()}」で絞り込んでいます。押すと開いて直せます` : "列と比べ方を決めておき、値を打つとその場で絞り込みます（登録はしません）";
    renderCondMenu();
  }

  /* ---- 条件を検索して足す（再認 > 想起: 登録した条件・列・値の候補から選ぶ） ---- */
  function openTokenSearch() {
    const w = $("#llTokenInput"); w.hidden = false;
    const inp = $("#llTokenSearch"); inp.value = ""; renderSuggest(""); inp.focus();
  }
  function closeTokenSearch() { $("#llTokenInput").hidden = true; $("#llSuggest").hidden = true; }
  function suggestions(text) {
    const t = text.trim().toLowerCase(), out = [];
    if (!t) {
      tablePresets().slice(0, 8).forEach((p) => out.push({ group: "登録した条件", label: p.name, f: (p.filters || [])[0] }));
      return out.filter((x) => x.f);
    }
    tablePresets().filter((p) => p.name.toLowerCase().includes(t)).slice(0, 6)
      .forEach((p) => out.push({ group: "登録した条件", label: p.name, f: (p.filters || [])[0] }));
    S.columns.filter((c) => c.toLowerCase().includes(t)).slice(0, 5)
      .forEach((c) => out.push({ group: "列", label: `${c} …（比べ方と値を決める）`, build: c }));
    // 日付の列は「今日から」の決まった範囲をすぐ足せる
    S.dateColumns.filter((c) => c.toLowerCase().includes(t) || /日|以内|今日/.test(t)).slice(0, 2).forEach((c) => {
      [["within_days", "7"], ["within_months", "1"], ["within_months", "3"]].forEach(([op, v]) => {
        const f = { column: c, op, value: v };
        out.push({ group: "日付（今日から）", label: condLabel(f), f });
      });
    });
    const vals = [];
    for (const col of S.columns) {
      for (const v of distinctValues(col)) {
        if (v.toLowerCase().includes(t)) { vals.push({ group: "候補の値", label: `${col} ＝ ${v}`, f: { column: col, op: "eq", value: v } }); break; }
      }
      if (vals.length >= 8) break;
    }
    return out.concat(vals).filter((x) => x.f || x.build);
  }
  let suggestItems = [], suggestIdx = 0;
  function renderSuggest(text) {
    suggestItems = suggestions(text); suggestIdx = 0;
    const box = $("#llSuggest");
    if (!suggestItems.length) { box.innerHTML = `<p class="fs-empty">${text.trim() ? "当たる候補がありません（「条件を作る」で作れます）" : "登録した条件がまだありません。列名か値を打ってください"}</p>`; box.hidden = false; return; }
    let last = "";
    box.innerHTML = suggestItems.map((x, i) => {
      const head = x.group !== last ? `<p class="fs-sec">${esc(x.group)}</p>` : ""; last = x.group;
      return head + `<button type="button" class="fs-item${i === 0 ? " is-active" : ""}" data-i="${i}">${esc(x.label)}</button>`;
    }).join("");
    box.hidden = false;
    $$("[data-i]", box).forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); pickSuggest(+b.dataset.i); }; });
  }
  function pickSuggest(i) {
    const x = suggestItems[i]; if (!x) return;
    closeTokenSearch();
    if (x.build) { setBodyOpen(true); $("#llFilterColumn").value = x.build; updateFilterSuggestions(); $("#llFilterValue").focus(); return; }
    addFilter(x.f);
  }
  function bindTokenSearch() {
    const inp = $("#llTokenSearch");
    inp.addEventListener("input", () => renderSuggest(inp.value));
    inp.addEventListener("keydown", (e) => {
      const items = $$(".fs-item", $("#llSuggest"));
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); if (!items.length) return;
        suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((b, i) => b.classList.toggle("is-active", i === suggestIdx));
      } else if (e.key === "Enter") { e.preventDefault(); pickSuggest(suggestIdx); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeTokenSearch(); $("#llCondBtn").focus(); }
    });
    inp.addEventListener("blur", () => setTimeout(closeTokenSearch, 120));
  }

  /* ---- プリセットの切り替えメニュー ---- */
  let presetMenuEl = null, presetOff = null;
  function closePresetMenu() {
    presetMenuEl?.remove(); presetMenuEl = null;
    $("#llPresetBtn")?.setAttribute("aria-expanded", "false");
    if (presetOff) presetOff(); presetOff = null;
  }
  const pickHtml = (key, label, sub, on) => `<button type="button" role="menuitemradio" class="fb-preset-pick${on ? " is-current" : ""}" aria-checked="${on}" data-preset-key="${esc(key)}">`
    + `<i class="fb-preset-mark" aria-hidden="true"></i><span class="fb-preset-label">${esc(label)}</span><small class="fb-preset-sub">${esc(sub)}</small></button>`;
  function openPresetMenu(anchor) {
    if (presetMenuEl) { closePresetMenu(); return; }
    const entries = presetEntries(), cur = selectedPresetKey();
    const combos = entries.filter((e) => e.kind === "combo"), ones = entries.filter((e) => e.kind === "single");
    const sub = (e) => `${e.conds.length}条件 ／ ` + e.conds.map(condLabel).join(" ・ ");
    let body = '<p class="fb-preset-head">プリセット<small>登録した条件の組み合わせ。押すと切り替わります（足すのではなく入れ替え）</small></p>'
      + pickHtml(PRESET_NONE, "なし", "プリセットの条件を入れません", !cur);
    if (combos.length) body += '<p class="fb-preset-sec">組み合わせ</p>' + combos.map((e) => pickHtml(e.key, e.name, sub(e), e.key === cur)).join("");
    if (ones.length) body += '<p class="fb-preset-sec">登録した条件（1件ずつ当てる）</p>' + ones.map((e) => pickHtml(e.key, e.name, sub(e), e.key === cur)).join("");
    if (!entries.length) body += '<p class="fb-preset-empty">登録した条件がまだありません。条件を作って「登録」すると、ここに並びます。</p>';
    body += '<div class="fb-preset-foot"><button type="button" id="llPresetManage">登録した条件とプリセットを開く</button>'
      + "<small>「いつも適用（固定）」の条件は、切り替えても入ったままです。</small></div>";
    const menu = document.createElement("div");
    menu.className = "fb-preset-menu"; menu.setAttribute("role", "menu"); menu.innerHTML = body;
    root.append(menu); presetMenuEl = menu;
    TPA.placeBelow(menu, anchor);
    $$("[data-preset-key]", menu).forEach((b) => { b.onclick = () => { const k = b.dataset.presetKey; closePresetMenu(); switchPreset(k); }; });
    $("#llPresetManage", menu).onclick = () => { closePresetMenu(); openPresetModal(); };
    anchor.setAttribute("aria-expanded", "true");
    presetOff = TPA.dismissable(menu, closePresetMenu, { keep: anchor });
  }

  /* ---- 登録した条件とプリセット（組み合わせ名・いつも適用（固定）・削除） ---- */
  function openPresetModal() {
    const dlg = $("#llPresetModal");
    renderPresetModal(); dlg.hidden = false;
    requestAnimationFrame(() => $("#llPresetModalClose").focus());
  }
  function closePresetModal() { $("#llPresetModal").hidden = true; $("#llCondBtn")?.focus(); }
  function renderPresetModal() {
    const ps = tablePresets(), groups = [...new Set(ps.map((p) => p.group).filter(Boolean))];
    $("#llPresetGroups").innerHTML = groups.map((g) => `<option value="${esc(g)}"></option>`).join("");
    $("#llPresetTable").textContent = S.table || "-";
    const body = $("#llPresetRows");
    if (!ps.length) { body.innerHTML = '<tr><td colspan="5" class="ll-pm-empty">登録した条件はまだありません。「条件」→「条件を作る・登録する」か、効いている条件の ☆ で登録できます。</td></tr>'; return; }
    body.innerHTML = ps.map((p) => `<tr data-id="${esc(p.id)}">
        <td class="ll-pm-cond" title="${esc((p.filters || []).map(condLabel).join(" ・ "))}">${esc(p.name)}</td>
        <td><input class="ll-pm-group" list="llPresetGroups" value="${esc(p.group || "")}" placeholder="（組み合わせに入れない）" aria-label="プリセット（組み合わせ）の名前"></td>
        <td class="c"><label class="ll-pm-always"><input type="checkbox" class="ll-pm-lock"${p.always ? " checked" : ""}> いつも適用（固定）</label></td>
        <td class="c"><button type="button" class="row-btn ll-pm-apply">当てる</button></td>
        <td class="c"><button type="button" class="row-btn danger ll-pm-del">削除</button></td></tr>`).join("");
    $$("tr[data-id]", body).forEach((tr) => {
      const p = S.presets.find((x) => x.id === tr.dataset.id);
      $(".ll-pm-group", tr).onchange = (e) => { p.group = e.target.value.trim().slice(0, 40); savePresets(); renderPresetModal(); renderBar(); };
      $(".ll-pm-lock", tr).onchange = (e) => {
        p.always = e.target.checked; savePresets();
        // すぐ当て直す（開き直しを待たない）
        (p.filters || []).forEach((f) => {
          const i = S.genericFilters.findIndex((x) => filterKey(x) === filterKey(f));
          if (p.always) { if (i >= 0) S.genericFilters[i].locked = true; else S.genericFilters.push({ ...f, locked: true }); }
          else if (i >= 0) { const stillAlways = tablePresets().some((q) => q.always && (q.filters || []).some((g) => filterKey(g) === filterKey(f))); if (!stillAlways) delete S.genericFilters[i].locked; }
        });
        reload();
      };
      $(".ll-pm-apply", tr).onclick = () => { (p.filters || []).forEach((f) => { if (!S.genericFilters.some((x) => filterKey(x) === filterKey(f))) S.genericFilters.push({ ...f }); }); reload(); };
      $(".ll-pm-del", tr).onclick = () => {
        if (!confirm(`登録した条件「${p.name}」を削除します。よろしいですか？（効いている条件からは外しません）`)) return;
        S.presets = S.presets.filter((x) => x.id !== p.id); savePresets();
        S.genericFilters.forEach((f) => { if (f.locked && !tablePresets().some((q) => q.always && (q.filters || []).some((g) => filterKey(g) === filterKey(f)))) delete f.locked; });
        renderPresetModal(); renderBar();
      };
    });
  }

  /* ================= 一覧（表） ================= */
  /* ---- 表示列（lotlist-columns.js）へ渡す「いまの一覧」 ---- */
  const layoutTarget = () => "lotlist:" + (S.table || "");
  function columnContext() {
    return { target: layoutTarget(), table: S.table, columns: window.LotListColumns.allColumns(layoutTarget(), S.columns),
      sourceColumns: S.columns, rows: S.rows, lotColumn: S.lotColumn, grid: $("#llGrid"),
      rerender: () => renderGrid(), toast: (m) => flash(m) };
  }
  function flash(msg) {
    const n = $("#llFlash") || Object.assign(document.createElement("div"), { id: "llFlash", className: "ll-flash" });
    if (!n.isConnected) root.append(n);
    n.textContent = msg; n.classList.add("is-on");
    clearTimeout(flash.t); flash.t = setTimeout(() => n.classList.remove("is-on"), 2600);
  }
  /* ---- 表の見せ方（行間・並び・表示件数） ---- */
  function renderViewMenu() {
    const m = $("#llViewMenu"), LC = window.LotListColumns, g = LC.rowGap();
    const sorts = S.sorts.map((s, i) => `${"①②③④"[i]} ${esc(LC.label(layoutTarget(), s.column))} ${s.dir === "desc" ? "▼ 大きい順" : "▲ 小さい順"}`).join("<br>");
    m.innerHTML = `<p class="vm-head">表の見せ方</p>
      <label class="vm-row"><span>行間</span><input type="range" id="llGap" min="1" max="5" step="1" value="${g}"><b id="llGapLabel">${LC.GAP[g - 1][0]}</b></label>
      <div class="vm-row"><span>並び</span><div class="vm-sorts">${sorts || "並べ替えていません（見出しを押すと並べ替えます）"}
        ${S.sorts.length ? '<button type="button" id="llSortClear">並べ替えを外す</button>' : ""}</div></div>
      <label class="vm-row"><span>表示件数</span><select id="llPageSize">${PAGE_SIZES.map((n) => `<option value="${n}"${n === S.pageSize ? " selected" : ""}>${n}件ずつ</option>`).join("")}</select></label>
      <div class="vm-row"><span>機能</span><div class="vm-feats">
        <label class="vm-switch"${S.lotColumn ? "" : ' title="この表にはロット番号の列が無いので使えません"'}><input type="checkbox" id="llFeatGroup"${feat.group ? " checked" : ""}${S.lotColumn ? "" : " disabled"}>
          <b>ロット番号でまとめる</b><small>同じロットの行を続けて並べ、見出しで畳めます。並べ替え・絞り込みは効いたままで、ページの境目でロットを切りません</small></label>
        <label class="vm-switch"><input type="checkbox" id="llFeatCard"${feat.card ? " checked" : ""}>
          <b>行のダブルクリックでカードを開く</b><small>1行を読みやすいカードで見ます。カードの位置・大きさ・項目の配置は変えられます</small></label>
      </div></div>`;
    $("#llGap").oninput = (e) => { LC.setRowGap(+e.target.value); $("#llGapLabel").textContent = LC.GAP[+e.target.value - 1][0]; renderGrid(); };
    $("#llPageSize").onchange = (e) => { S.pageSize = +e.target.value; store.set(KEY.pageSize, S.pageSize); S.page = 1; load(); };
    $("#llSortClear")?.addEventListener("click", () => { S.sorts = []; S.page = 1; saveActive(); closeViewMenu(); load(); });
    $("#llFeatGroup").onchange = (e) => { setFeature("group", e.target.checked); S.page = 1; load(); };
    $("#llFeatCard").onchange = (e) => { setFeature("card", e.target.checked); if (!feat.card) window.LotListCard.close(); renderPager(); };
  }
  let viewOff = null;
  function closeViewMenu(byEsc) {
    const m = $("#llViewMenu"); if (!m || m.hidden) return;
    m.hidden = true; $("#llViewBtn").setAttribute("aria-expanded", "false");
    if (viewOff) viewOff(); viewOff = null;
    if (byEsc) $("#llViewBtn").focus();
  }
  function toggleViewMenu() {
    const m = $("#llViewMenu"), b = $("#llViewBtn");
    if (!m.hidden) { closeViewMenu(); return; }
    renderViewMenu(); m.hidden = false; b.setAttribute("aria-expanded", "true");
    TPA.placeBelow(m, b, "right");
    viewOff = TPA.dismissable(m, closeViewMenu, { keep: b, event: "mousedown" });   // つまみ・選択欄を触るので mousedown で見る
    requestAnimationFrame(() => $("#llGap").focus());
  }

  /* 「以内」で 0 件のとき、なぜ当たらないかを言う（サーバーが表全体で数えた dateHints）。
     いちばん新しい日付と元の値を並べるので、写しが古い・日付の読み違い（和暦の2桁の年など）・ほかの条件との重なりが見て分かる。 */
  function dateHintHtml() {
    const ymd = (s) => (s ? s.replace(/-/g, "/") : "-");
    const daysAgo = (s) => (s && S.today ? Math.round((Date.parse(S.today) - Date.parse(s)) / 86400000) : null);
    const items = (S.dateHints || []).map((h) => {
      const lab = condLabel(h), ago = daysAgo(h.newest);
      let why;
      if (!h.dated) why = `この列に日付と読める値がありません（値のある行 ${h.filled.toLocaleString()}件）。`;
      else if (h.alone > 0) why = `この条件だけなら <b>${h.alone.toLocaleString()}件</b>当たります。ほかの条件と重なって 0 件になっています。`;
      else why = `いちばん新しい日付が ${ymd(h.newest)}${ago != null ? `（今日から${ago >= 0 ? ` ${ago}日前` : ` ${-ago}日後`}）` : ""}なので、${ymd(h.cutoff)} 以降の行がありません。`;
      return `<li><b>${esc(lab)}</b>: ${why}<br><small>日付と読めた行 ${h.dated.toLocaleString()} / 値のある行 ${h.filled.toLocaleString()}・`
        + `いちばん新しい ${ymd(h.newest)}（元の値「${esc(h.newestRaw ?? "")}」）・いちばん古い ${ymd(h.oldest)}・今日 ${ymd(S.today)}・${ymd(h.cutoff)} 以降を探しました</small></li>`;
    });
    return items.length ? `<ul class="ll-datehints">${items.join("")}</ul>`
      + (S.source && S.source.at ? `<small>元データ（手元の写し）の時刻: ${hm(S.source.at)}。写しが古いときは右上の札から取り直せます。</small>` : "") : "";
  }
  /* ---- 行（ふつうの行・まとめたロットの中の行で同じ） ---- */
  const GROUP_LOT_EXTRA = 64;     // まとめるときのロット番号の列に足す幅（畳むボタンと件数）
  const lotButton = (raw, sub) => (raw ? `<button type="button" class="ll-lot${sub ? " is-sub" : ""}" data-lot="${esc(raw)}" title="押すと「${esc(raw)}」を検索します（転写計算の「検索」と同じ）">${esc(raw)}</button>` : "");
  const cellTd = (cell, al, extra = "") => {
    const tip = cell.raw !== cell.text ? `${cell.text}\n元の値: ${cell.raw}` : cell.text;
    return `<td class="al-${al}${cell.color ? " cell-" + cell.color : ""}${extra}" title="${esc(tip)}">${esc(cell.text)}</td>`;
  };
  function rowHtml(cols, aligns, r, i, cells, cls, attrs = "") {
    const lot = S.lotColumn ? String(r[S.lotColumn] ?? "") : "";
    const k = [cls, lot && lot.toUpperCase() === String(S.currentLot || "").toUpperCase() ? "is-current" : "", i === S.cardIdx ? "is-carded" : ""].filter(Boolean).join(" ");
    return `<tr data-i="${i}"${k ? ` class="${k}"` : ""}${attrs}>` + cols.map((c, ci) => (c === S.lotColumn
      ? `<td class="ll-lotcol">${lotButton(lot, cls.includes("g-child"))}</td>` : cellTd(cells[ci], aligns[ci]))).join("") + "</tr>";
  }
  /* ロットでまとめた本体。サーバーが同じロットの行を続けて返し、groups[i]=[そのロットの行数, 何行目] を添える。
     2行以上のロットには見出し行を付ける: ロット番号・件数・畳む、ほかの列はロットの中で同じ値ならその値、違えば「n通り」。
     見出し行も列の数は同じ（列の色づけ・幅がずれない）。帯（g-alt）はロットごとに交互。 */
  function groupedBody(cols, aligns, cellsOf) {
    const out = [], shut = collapsed();
    let g = 0;
    for (let i = 0; i < S.rows.length; g++) {
      const [n, at] = S.groups[i] || [1, 1];
      const len = Math.max(1, n - at + 1), rs = S.rows.slice(i, i + len), cells = rs.map(cellsOf);
      const alt = g % 2 ? " g-alt" : "";
      if (len < 2) { out.push(rowHtml(cols, aligns, rs[0], i, cells[0], "g-one" + alt)); i += len; continue; }
      const lot = String(rs[0][S.lotColumn] ?? ""), open = !shut.has(lotKey(rs[0]));
      out.push(`<tr class="ll-ghead${alt}" data-g="${g}" data-gkey="${esc(lotKey(rs[0]))}" aria-expanded="${open}">` + cols.map((c, ci) => {
        if (c === S.lotColumn) return `<td class="ll-lotcol"><button type="button" class="ll-gtog" aria-label="${open ? "畳む" : "開く"}" title="このロットの行を${open ? "畳みます" : "開きます"}">▾</button>`
          + `${lotButton(lot, false)}<span class="ll-gn" title="このロットの行">${len}件</span></td>`;
        const texts = new Set(cells.map((x) => x[ci].text));
        if (texts.size === 1) return cellTd(cells[0][ci], aligns[ci], " ll-gsame");
        return `<td class="al-${aligns[ci]} ll-gdiff" title="このロットの中で ${texts.size}通りの値があります（開くと1行ずつ見られます）">${texts.size}通り</td>`;
      }).join("") + "</tr>");
      rs.forEach((r, j) => out.push(rowHtml(cols, aligns, r, i + j, cells[j], `g-child${alt}${j === len - 1 ? " g-last" : ""}`, ` data-g="${g}"${open ? "" : " hidden"}`)));
      i += len;
    }
    return out.join("");
  }
  function toggleGroup(head, open = head.getAttribute("aria-expanded") !== "true") {
    head.setAttribute("aria-expanded", String(open));
    const tog = $(".ll-gtog", head); tog.setAttribute("aria-label", open ? "畳む" : "開く"); tog.title = `このロットの行を${open ? "畳みます" : "開きます"}`;
    $$(`tr[data-g="${head.dataset.g}"]:not(.ll-ghead)`, $("#llBody")).forEach((tr) => { tr.hidden = !open; });
  }
  function setAllGroups(open) {
    const heads = $$("tr.ll-ghead", $("#llBody")), shut = collapsed();
    heads.forEach((h) => { toggleGroup(h, open); if (open) shut.delete(h.dataset.gkey); else shut.add(h.dataset.gkey); });
    setCollapsed(shut);
  }
  /* カードで見ている行を一覧でも示す（描き直さずに印だけ替える） */
  function markCarded(i) {
    S.cardIdx = i;
    $$("#llBody tr.is-carded").forEach((tr) => tr.classList.remove("is-carded"));
    const tr = i >= 0 ? $(`#llBody tr[data-i="${i}"]`) : null;
    if (!tr) return;
    tr.classList.add("is-carded");
    if (tr.hidden) { const h = $(`#llBody tr.ll-ghead[data-g="${tr.dataset.g}"]`); if (h) { toggleGroup(h, true); const sh = collapsed(); sh.delete(h.dataset.gkey); setCollapsed(sh); } }
    tr.scrollIntoView({ block: "nearest" });
  }
  function renderGrid() {
    const head = $("#llHead"), body = $("#llBody"), note = $("#llNote");
    if (S.error) {
      head.innerHTML = ""; body.innerHTML = "";
      note.innerHTML = `<b>ロット一覧を読めませんでした。</b><br>${esc(S.error)}<br>`
        + `<small>元: ${esc((S.source && S.source.remote) || "（設定 lot_list.source）")}</small><div class="ll-note-acts"><button type="button" class="btn-primary" data-ll-refresh>共有から読み直す</button>`
        + ` <button type="button" data-ll-settings title="元ファイルの場所・名前を「マスタ管理」の「参照先」で直します">参照先を開く</button></div>`;
      note.hidden = false; return;
    }
    const filtered = new Set(S.genericFilters.map((f) => f.column).concat(adhocFilters().map((f) => f.column)));
    const t = layoutTarget(), LC = window.LotListColumns;
    LC.setContext(columnContext());
    const all = LC.allColumns(t, S.columns);
    const cols = LC.visible(t, all, S.lotColumn), L = LC.get(t);
    const sortIdx = (c) => S.sorts.findIndex((s) => s.column === c);
    // 幅: <colgroup> に置き、表の幅は列の和（table-layout:fixed）
    const widths = cols.map((c) => LC.widthOf(t, c, S.rows) + (c === S.lotColumn && grouped() ? GROUP_LOT_EXTRA : 0));
    $("#llCols").innerHTML = cols.map((c, i) => `<col data-col="${esc(c)}" style="width:${widths[i]}px">`).join("");
    $("#llGrid").style.width = widths.reduce((a, b) => a + b, 0) + "px";
    $("#llGrid").style.setProperty("--ll-row-pad", LC.rowPad() + "px");
    head.innerHTML = "<tr>" + cols.map((c) => {
      const i = sortIdx(c), s = S.sorts[i], calc = LC.isComputed(t, c), al = LC.alignOf(t, c);
      const mark = i < 0 ? "" : `<i class="ll-sort">${s.dir === "desc" ? "▼" : "▲"}${S.sorts.length > 1 ? "①②③④"[i] : ""}</i>`;
      const tip = calc ? `${LC.label(t, c)}（計算列）\n表示だけの列です。並べ替え・絞り込みは元のデータの列で行います`
        : `${LC.label(t, c)}${LC.label(t, c) !== c ? `（元: ${c}）` : ""}\nクリックで並び替え／ドラッグで列の入れ替え。Shift+クリックで並べ替えのキーを足します（最大${MAX_SORTS}つ）`;
      return `<th data-col="${esc(c)}" draggable="${c === S.lotColumn ? "false" : "true"}" class="${c === S.lotColumn ? "ll-lotcol " : ""}${filtered.has(c) ? "col-filtered " : ""}${calc ? "is-calc " : ""}al-h-${al.head}" title="${esc(tip)}">`
        + `<span>${esc(LC.label(t, c))}</span>${mark}${filtered.has(c) ? '<i class="col-filter-badge" title="この列にフィルタが適用されています">▼</i>' : ""}`
        + `<i class="col-resize${L.locks.includes(c) ? " is-locked" : ""}" title="${L.locks.includes(c) ? "この列は幅を固定しています（列の設定で解けます）" : "ドラッグで列幅を調整（ダブルクリックで既定へ）"}"></i></th>`;
    }).join("") + "</tr>";
    const aligns = cols.map((c) => LC.alignOf(t, c).data);
    const cellsOf = (r) => cols.map((c) => (c === S.lotColumn ? null : LC.cell(t, c, r)));
    body.innerHTML = grouped() ? groupedBody(cols, aligns, cellsOf)
      : S.rows.map((r, i) => rowHtml(cols, aligns, r, i, cellsOf(r), "")).join("");
    $("#llGrid").classList.toggle("is-grouped", grouped());
    $("#llTintStyle").textContent = LC.tintCss(t, cols, "#llGrid");
    if (!S.rows.length) {
      const conds = condRows();
      note.innerHTML = conds.length || S.search
        ? `<b>検索・絞り込みに当たる行がありません。</b><br>いま効いているもの: ${[S.search ? `一覧を検索「${esc(S.search)}」` : ""].concat(conds.map((r) => esc(r.kind === "adhoc" ? `列で絞り込み: ${r.label}` : condLabel(r.f)))).filter(Boolean).join(" ／ ")}`
          + dateHintHtml()
          + '<div class="ll-note-acts"><button type="button" class="btn-primary" data-ll-clear-all>条件を外して全件を見る</button></div>'
        : "<b>この表に行がありません。</b>";
      note.hidden = false;
    } else note.hidden = true;
    if (!S.lotColumn && S.rows.length) {
      note.innerHTML = "<b>ロット番号の列が見つかりません</b>（ロット番号・ﾛｯﾄ番号・ロット№・LTNO のどれか）。この表からは検索できません。";
      note.hidden = false;
    }
  }
  function renderPager() {
    const [from, to] = S.range;       // まとめるとページの行数は表示件数から少しずれる（ロットを切らない）ので、サーバーの答えのまま
    $("#llCount").textContent = `全 ${S.count.toLocaleString()}件` + (grouped() ? `・${S.groupCount.toLocaleString()}ロット` : "");
    const gb = $("#llGroupBar"), heads = grouped() ? $$("tr.ll-ghead", $("#llBody")).length : 0;
    gb.hidden = !grouped();
    gb.innerHTML = grouped() ? `<span class="ll-gchip" title="同じロットの行を続けて並べています。ロットの順は、並べ替えでそのロットのいちばん上に来る行の順です">ロット番号でまとめて表示中</span>`
      + (heads ? '<button type="button" data-gall="1">全部開く</button><button type="button" data-gall="0">全部畳む</button>' : "")
      + '<button type="button" data-goff title="まとめずに1行ずつ並べます（「表の見せ方」の「機能」でも切り替えられます）">まとめない</button>' : "";
    $("#llCardHint").hidden = !feat.card || !S.rows.length;
    $("#llRange").textContent = S.count ? `${from.toLocaleString()}–${to.toLocaleString()}` : "0";
    $("#llPrev").disabled = S.page <= 1;
    $("#llNext").disabled = !S.count || to >= S.count;
    const tsel = $("#llTable");
    tsel.hidden = S.tables.length <= 1;
    const sig = S.tables.join("\u001f");
    if (tsel.dataset.sig !== sig) { tsel.dataset.sig = sig; tsel.innerHTML = S.tables.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join(""); }
    tsel.value = S.table;
  }
  const hm = (sec) => {
    if (!sec) return "";
    const d = new Date(sec * 1000), p = TPA.pad2;
    return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  /* 元データの古さを言葉に（36 時間 → 「1日半前」ではなく「2日前」のように丸めすぎない: 48 時間未満は時間で） */
  const ageText = (h) => (h == null ? "" : h < 48 ? `${Math.round(h)}時間前` : `${Math.floor(h / 24)}日前`);
  /* 毎日更新されるはずの元データが古いとき、一覧の上に帯で言う（何が起きていそうか・次に何をするか）。 */
  function renderStale() {
    const el = $("#llStale"), s = S.source;
    if (!el) return;
    if (!s || !s.stale) { el.hidden = true; return; }
    el.innerHTML = `<b>元データが ${ageText(s.ageHours)}から更新されていません</b>（最後の更新 ${hm(s.at)}・${Math.round(s.staleHours)}時間を過ぎると警告）。`
      + `毎日更新されるはずの元ファイルの更新が止まっている可能性があります。最近の異常ロットは一覧に出ません。`
      + `<small>元: ${esc(s.remote || "-")}${s.unreachable ? "（いまは共有に届きません）" : ""}。更新する側（元データを作る PC・仕組み）を確かめてください。</small>`
      + `<button type="button" data-ll-refresh>共有から取り直す</button> <button type="button" data-ll-settings title="元ファイルの場所・名前が合っているかを「マスタ管理」の「参照先」で確かめます">参照先を開く</button>`;
    el.hidden = false;
  }
  function renderFresh() {
    const b = $("#llFresh"), s = S.source;
    b.className = "ll-fresh";
    if (!s) { b.textContent = "元データ 確認中"; return; }
    const newer = S.loadedAt && s.copiedAt && s.copiedAt > S.loadedAt + 0.5;
    renderStale();
    let text, cls = "";
    if (s.stale) { text = `元データが古い ${hm(s.at)}（${ageText(s.ageHours)}）`; cls = "is-warn"; }
    else if (!s.mirrored) { text = s.unreachable ? "共有に届きません（写しもまだありません）" : "共有を直接読んでいます（写しを作っています）"; cls = "is-warn"; }
    else if (newer) { text = `新しい版を取り込みました（${hm(s.at)}）・押すと表示を更新`; cls = "is-new"; }
    else if (s.unreachable) { text = `共有に届きません・前の写し（${hm(s.at)}）を表示中`; cls = "is-warn"; }
    else text = `元データ ${hm(s.at)}`;
    b.textContent = text; if (cls) b.classList.add(cls);
    b.title = [`元: ${s.remote || "-"}`, s.at ? `元データの更新: ${hm(s.at)}` : "", s.copiedAt ? `手元の写し: ${hm(s.copiedAt)} に取り込み` : "",
      s.checkedAt ? `最後に共有を確かめた: ${hm(s.checkedAt)}（${s.interval_sec}秒ごと）` : "", s.reason || "",
      newer ? "押すと、取り込んだ新しい版で一覧を出し直します。" : "押すと、共有から今すぐ取り直します（再読込）。"].filter(Boolean).join("\n");
  }
  function paintBusy() {
    root?.classList.toggle("is-loading", S.loading);
    // まだ1行も無いまま待っているとき（初めて開いた＝共有から写している最中）は、何を待っているかを言う
    const note = $("#llNote");
    if (S.loading && !S.rows.length && !S.error && note) {
      note.innerHTML = "<b>品質データを読んでいます…</b><br>初めて開いたときは、共有の元ファイルを手元へ写し終えるまで待ちます（大きいと数十秒）。";
      note.hidden = false;
    }
  }
  function renderAll() { renderBar(); renderGrid(); renderPager(); renderFresh(); paintBusy(); window.LotListCard.refresh(); }

  async function refreshFromShare() {
    const b = $("#llFresh"); b.disabled = true; b.textContent = "共有から取り直しています…";
    try {
      const r = await fetch("/api/lotlist/refresh", { method: "POST" });
      const d = await r.json(); S.source = d.source || S.source;
    } catch (_) { /* 一覧の読み直しで理由が出る */ }
    b.disabled = false; await load();
  }
  let pollTimer = null;
  async function pollSource() {
    try { const r = await fetch("/api/lotlist/source", { cache: "no-store" }); if (r.ok) { S.source = await r.json(); renderFresh(); } } catch (_) { /* 次の周回で */ }
  }

  function bindGrid() {
    window.LotListColumns.bindHeader($("#llHead"));
    $("#llHead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th || e.target.closest(".col-resize") || th.classList.contains("is-calc")) return;
      const col = th.dataset.col, i = S.sorts.findIndex((s) => s.column === col);
      if (e.shiftKey) {
        if (i >= 0) S.sorts[i].dir = S.sorts[i].dir === "asc" ? "desc" : "asc";
        else if (S.sorts.length < MAX_SORTS) S.sorts.push({ column: col, dir: "asc" });
      } else S.sorts = [{ column: col, dir: i >= 0 && S.sorts.length === 1 && S.sorts[0].dir === "asc" ? "desc" : "asc" }];
      S.page = 1; saveActive(); load();
    });
    $("#llBody").addEventListener("click", (e) => {
      const b = e.target.closest(".ll-lot");
      if (b) { S.currentLot = b.dataset.lot; onPick(b.dataset.lot); return; }
      const head = e.target.closest("tr.ll-ghead");     // 見出し行はどこを押しても畳む／開く
      if (head) {
        toggleGroup(head);
        const shut = collapsed(); if (head.getAttribute("aria-expanded") === "true") shut.delete(head.dataset.gkey); else shut.add(head.dataset.gkey);
        setCollapsed(shut);
      }
    });
    // 行のダブルクリック → カード（機能を使うときだけ）。ダブルクリックで字が選ばれないよう、2回目の押下は止める
    $("#llBody").addEventListener("mousedown", (e) => { if (feat.card && e.detail > 1 && e.target.closest("tr[data-i]")) e.preventDefault(); });
    $("#llBody").addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (feat.card && tr && !e.target.closest(".ll-lot")) window.LotListCard.show(+tr.dataset.i);
    });
    $("#llGroupBar").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.gall) setAllGroups(b.dataset.gall === "1");
      else if (b.hasAttribute("data-goff")) { setFeature("group", false); S.page = 1; load(); }
    });
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-ll-clear-all]")) { dropAllFilters({ adhoc: true }); S.search = ""; $("#llSearch").value = ""; reload(); }
      if (e.target.closest("[data-ll-refresh]")) refreshFromShare();
      if (e.target.closest("[data-ll-settings]") && window.openMasterAt) window.openMasterAt("paths");
    });
    $("#llPrev").onclick = () => { if (S.page > 1) { S.page--; load(); } };
    $("#llNext").onclick = () => { S.page++; load(); };
    $("#llColBtn").onclick = () => { closeViewMenu(); window.LotListColumns.toggle(); };
    $("#llViewBtn").onclick = () => toggleViewMenu();
    $("#llTable").onchange = (e) => { saveActive(); S.table = e.target.value; contextKey = null; syncContext(true); window.LotListCard.close(); load(); };
    $("#llFresh").onclick = () => {
      const s = S.source, newer = S.loadedAt && s && s.copiedAt && s.copiedAt > S.loadedAt + 0.5;
      if (newer) load(); else refreshFromShare();
    };
    $("#llPresetModalClose").onclick = closePresetModal;
    TPA.layer($("#llPresetModal"), closePresetModal, { backdrop: false });
  }

  /* ================= 画面に出す・下げる =================
     一覧は窓ではなく「最初の画面」。計算画面と行き来しても、ページ・条件・並べ替えはそのまま残す
     （戻るたびに1ページ目へ戻すと、どこまで見たかを思い出させることになる）。
     「いつも適用（固定）」はアプリを開いた最初の1回に当てる（外した固定は、アプリを開き直すと戻る）。 */
  let activatedOnce = false;
  function activate({ currentLot } = {}) {
    S.currentLot = currentLot || S.currentLot || "";
    if (!activatedOnce && S.table) syncContext(true);
    activatedOnce = true;
    renderAll(); load();          // 戻ってきたら今の写しで引き直す（ページはそのまま）
    clearInterval(pollTimer); pollTimer = setInterval(pollSource, SOURCE_POLL_MS);
  }
  function deactivate() {
    clearInterval(pollTimer); pollTimer = null;
    closePresetMenu(); closeCondMenu(); window.LotListCard.close();
    saveActive();
  }
  // 参照先マスタで元ファイルなどが変わったら、いまの一覧を読み直す（サーバーは保存と同時に切り替え済み）
  document.addEventListener("tpa:settings-changed", (e) => {
    if (String((e.detail || {}).key || "").startsWith("lot_list.")) { S.page = 1; load(); }
  });
  function mount(opts) {
    root = $("#lotListScreen");
    onPick = opts.onPick || onPick;
    buildBar(); bindGrid();
    window.LotListCard.mount({
      rows: () => S.rows, target: layoutTarget, lotColumn: () => S.lotColumn, lotKey,
      columns: () => window.LotListColumns.allColumns(layoutTarget(), S.columns),
      onPick: (lot) => { if (lot) { S.currentLot = lot; onPick(lot); } },
      onShow: markCarded,
    });
  }
  window.LotList = { mount, activate, deactivate, focus: () => $("#llSearch")?.focus() };
})();
