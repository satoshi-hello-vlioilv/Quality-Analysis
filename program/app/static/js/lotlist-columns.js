"use strict";
/* =========================================================================
   異常ロット一覧の表示列（WaveLog の「表示列」＝ static/js/list/list-columns.js と WL.columnLayout と同じ作り）
   - 1つの表（対象 `lotlist:<表>`）ごとに「列の設定」を持つ:
       { order, hidden, widths, locks, names, formats, aligns }
   - 3層で持つ: saved（保存した形）／draft（窓で触っている途中。保存するまで元に戻せる）／live（見出しをドラッグ中）
     画面に出すのは {...saved, ...draft, ...live}（キーごとに上書き）。
   - 入口: 「表示列」の窓（出す列・並び・表示名・幅・揃え・値の整え方・保存した設定・書き出し/読み込み・既定に戻す）、
           見出し（ドラッグで並べ替え・右端の取っ手で幅・ダブルクリックで自動）、見出しの右クリック（隠す・幅・色・隠した列）、
           「表の見せ方」（行間・セルの余白・入り切らない文字・左に固定する列・表示件数）。
   - 列の並びに決まりは無い（ロット番号の列もどこへでも動かせる）。まだ並べていない表だけ、ロット番号を先頭に出す。
     ロット番号の列は押して検索する列なので、隠せない。
   - 左に固定する列は「先頭から n 列」（並べ替えた結果の先頭。ロット番号に限らない）。
   - 覚える場所はこの PC（localStorage）。色は WaveLog と同じく一時的な目印（sessionStorage）。
   ========================================================================= */
(function () {
  const { $, $$, esc, textWidth } = TPA;
  const LS = TPA.local, SS = TPA.session;
  const KEY = {
    layouts: "tpa.lotlist.layout.v1",
    presets: "tpa.lotlist.colPresets.v1",
    tint: "tpa.lotlist.tint.v1",
    rowGap: "tpa.lotlist.rowGap.v1",
    rect: "tpa.lotlist.colPanelRect.v1",
    cellPad: "tpa.lotlist.cellPad.v1",     // セルの左右の余白（px）
    overflow: "tpa.lotlist.overflow.v1",   // 入り切らない文字: ellipsis（…で切る）／clip（記号なしで切る）／wrap（折り返す）
    freeze: "tpa.lotlist.freeze.v1",       // 左に固定する列の数（先頭から）
  };
  const KEYS = ["order", "hidden", "widths", "locks", "names", "formats", "aligns", "formulas", "rules"];
  const empty = () => ({ order: [], hidden: [], widths: {}, locks: [], names: {}, formats: {}, aligns: {}, formulas: {}, rules: {} });
  const W_MIN = 20, W_MAX = 900, AUTO_MIN = 30, AUTO_MAX = 320, GRIP_SETTLE_MS = 300;
  const TINTS = [
    ["gray", "灰", "#8a96a0", "目立たせない"], ["stone", "石", "#a39585", "参考"], ["teal", "青緑", "#2f7d78", "転写・注目"],
    ["aqua", "水", "#3aa6b9", "確認中"], ["blue", "青", "#3a78c2", "情報"], ["indigo", "藍", "#3f5a91", "入力"],
    ["green", "緑", "#3f8d55", "良い・完了"], ["lime", "黄緑", "#86a83a", "軽い"], ["yellow", "黄", "#d1a92b", "注意"],
    ["orange", "橙", "#dc7f2a", "要対応"], ["brown", "茶", "#8b5e3c", "保留"], ["red", "赤", "#c0392b", "停止・異常"],
    ["pink", "桃", "#d35d8e", "特記"], ["purple", "紫", "#7b5ab5", "別扱い"],
  ];
  const DATE_PRESETS = ["yyyy/MM/dd", "yyyy/MM/dd HH:mm", "yyyy/MM/dd HH:mm:ss", "yy/MM/dd HH:mm", "MM/dd", "M月d日", "yyyy年M月d日(ddd)", "HH:mm"];
  const WIDTH_MODE_NOTE = {
    auto: "見出しと実データの先頭40行から幅を決め直します。",
    manual: "入れた幅にします。入り切らない文字は「…」で切り、元の値はマウスを乗せると出ます。",
    locked: "幅を動かしません。見出しの右端の取っ手も掴めなくなります。",
  };

  /* ================= 層（saved / draft / live） ================= */
  const saved = LS.get(KEY.layouts, {});
  const draft = {}, live = {};
  function norm(l) { const e = empty(); KEYS.forEach((k) => { if (l && l[k] != null) e[k] = TPA.clone(l[k]); }); return e; }
  function get(t) {
    const out = norm(saved[t]);
    [draft[t], live[t]].forEach((layer) => { if (layer) KEYS.forEach((k) => { if (k in layer) out[k] = TPA.clone(layer[k]); }); });
    return out;
  }
  const writeSaved = () => LS.set(KEY.layouts, saved);
  function stage(t, patch) { draft[t] = Object.assign(draft[t] || {}, patch); }
  function discard(t) { delete draft[t]; }
  function isDirty(t) { return !!draft[t] && Object.keys(draft[t]).length > 0; }
  function save(t) { saved[t] = get(t); delete draft[t]; writeSaved(); }
  function patch(t, p) { saved[t] = Object.assign(norm(saved[t]), p); writeSaved(); }
  function hold(t, p) { live[t] = Object.assign(live[t] || {}, p); }
  function release(t) { delete live[t]; }

  /* ================= 計算列・読み替え（式は WaveLog と同じ list-formula.js） =================
     値の段取り（WaveLog の cellFormat と同じ）: 作り方の式 → 読み替え（当たればその言葉で確定）→ 当たらなければ値の整え方。
     計算列は表示だけの列。並べ替え・絞り込みは元のデータの列で行う（できないことは見出しに書く）。 */
  const srcCols = {};                                  // 対象ごとの元のデータの列（setContext が入れる）
  const compiled = (src) => (src ? window.LotListRules.compile(src) : null);   // 読み解いた式は読み替えルール側の1箇所に覚える
  function allColumns(t, source) {
    srcCols[t] = source.slice();
    const f = get(t).formulas, extra = Object.keys(f).filter((c) => !source.includes(c));
    return source.concat(extra);
  }
  const isComputed = (t, c) => (c in get(t).formulas) && !(srcCols[t] || []).includes(c);
  /* 式が見る行: 元の値に計算列の値を足し、表示名でも引けるようにする（[表示名] でも [元の名前] でも書ける） */
  function baseRow(t, row) {
    const l = get(t), byName = {};
    Object.entries(l.names).forEach(([c, n]) => { byName[n] = c; });
    return new Proxy({}, {
      get(_, k) {
        if (typeof k !== "string") return undefined;
        const key = k in row ? k : (byName[k] || k);
        if (key in l.formulas && String(l.formulas[key]).trim()) {
          const c = compiled(l.formulas[key]);
          if (c) return c.run(Object.assign({}, row));      // 計算列から計算列は1段だけ（輪にならないように）
        }
        return row[key];
      },
      has(_, k) { return typeof k === "string" && (k in row || k in byName || k in l.formulas); },
    });
  }
  function rawOf(t, c, row) {
    const f = get(t).formulas[c];
    if (f !== undefined && String(f).trim() !== "") { const cc = compiled(f); return cc ? cc.run(baseRow(t, row)) : null; }
    return row[c];
  }
  /* 読み替えの条件が見る行。mode=raw は元のデータ（式の列は式の結果）、shown は値の整え方の後。[この列] はこの列の値。 */
  function ruleRow(t, row, c, mode) {
    const val = (k) => { const v = rawOf(t, k, row); return mode === "shown" ? format(t, k, v) : v; };
    const l = get(t), byName = {};
    Object.entries(l.names).forEach(([k, n]) => { byName[n] = k; });
    return new Proxy({}, {
      get(_, k) {
        if (typeof k !== "string") return undefined;
        if (k === window.LotListRules.SELF_KEY) return val(c);
        return val(k in row || k in l.formulas ? k : (byName[k] || k));
      },
      has(_, k) { return typeof k === "string"; },
    });
  }
  function cellWith(t, c, row, rulesOrName, mode) {
    const raw = rawOf(t, c, row), R = window.LotListRules;
    const rawText = raw == null ? "" : String(raw);
    if (rulesOrName && R) {
      const m = mode || (Array.isArray(rulesOrName) ? "raw" : R.selfMode(rulesOrName));
      const rr = ruleRow(t, row, c, m), hit = R.match(rulesOrName, rr, c);
      if (hit) {
        const txt = R.textOf(hit, rr);
        return { raw: rawText, text: txt === "" || txt == null ? format(t, c, raw) : String(txt), color: hit.color || "" };
      }
    }
    return { raw: rawText, text: format(t, c, raw), color: "" };
  }
  const cell = (t, c, row) => cellWith(t, c, row, get(t).rules[c] || "");
  /* ルールを使っている列（保存した設定と、いま触っている途中の設定から）。 */
  function ruleUsage(name) {
    const out = [];
    const targets = new Set([...Object.keys(saved), ...Object.keys(draft)]);
    targets.forEach((t) => Object.entries(get(t).rules).forEach(([c, n]) => { if (n === name) out.push(`${t.replace(/^lotlist:/, "")}・${label(t, c)}`); }));
    return out;
  }

  /* ================= 列の顔ぶれ・並び ================= */
  function ordered(t, cols, lotCol) {
    const l = get(t), known = new Set(cols);
    const out = l.order.filter((c) => known.has(c));
    cols.forEach((c) => { if (!out.includes(c)) out.push(c); });     // 新しい列は後ろへ
    // ロット番号は、まだ並べていない（並びに入っていない）ときだけ先頭へ。並べたあとは置いた場所のまま
    if (lotCol && out.includes(lotCol) && !l.order.includes(lotCol)) { out.splice(out.indexOf(lotCol), 1); out.unshift(lotCol); }
    return out;
  }
  function visible(t, cols, lotCol) {
    const h = new Set(get(t).hidden);
    return ordered(t, cols, lotCol).filter((c) => c === lotCol || !h.has(c));
  }
  const label = (t, c) => get(t).names[c] || c;

  /* ================= 値の整え方（WaveLog の cellFormat と同じ段取り: 書式 → だめなら元の値） ================= */
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  function parseDateTime(v) {
    const s = String(v == null ? "" : v).trim();
    let m = s.match(/^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) m = s.match(/^(\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) { const k = s.match(/^(\d{4})(\d{2})(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/); if (k) m = k; }
    if (m) {
      let y = +m[1]; if (y < 100) y += 2000;
      const d = new Date(y, +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      return d.getMonth() === +m[2] - 1 ? { d, time: m[4] != null } : null;
    }
    const tm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (tm) return { d: new Date(2000, 0, 1, +tm[1], +tm[2], +(tm[3] || 0)), time: true, timeOnly: true };
    return null;
  }
  function formatDate(d, pattern) {
    const p2 = TPA.pad2;
    return String(pattern || "yyyy/MM/dd").replace(/'([^']*)'|yyyy|yy|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g, (tok, lit) => {
      if (lit !== undefined) return lit;
      const H = d.getHours(), h12 = H % 12 || 12;
      return {
        yyyy: d.getFullYear(), yy: p2(d.getFullYear() % 100), MM: p2(d.getMonth() + 1), M: d.getMonth() + 1,
        dddd: DOW[d.getDay()] + "曜日", ddd: DOW[d.getDay()], dd: p2(d.getDate()), d: d.getDate(),
        HH: p2(H), H, hh: p2(h12), h: h12, mm: p2(d.getMinutes()), m: d.getMinutes(), ss: p2(d.getSeconds()), s: d.getSeconds(),
        tt: H < 12 ? "午前" : "午後",
      }[tok];
    });
  }
  function formatValue(f, v) {
    if (v == null || String(v).trim() === "" || !f || !f.kind) return v == null ? "" : String(v);
    const raw = String(v);
    const wrap = (x) => `${f.prefix || ""}${x}${f.suffix || ""}`;
    if (f.kind === "number") {
      const n = Number(raw.replace(/,/g, "").trim());
      if (!Number.isFinite(n)) return raw;
      const dec = f.decimals === "" || f.decimals == null ? null : +f.decimals;
      const opt = { useGrouping: !!f.thousands };
      if (dec != null) { opt.minimumFractionDigits = dec; opt.maximumFractionDigits = dec; } else opt.maximumFractionDigits = 20;
      return wrap(n.toLocaleString("ja-JP", opt));
    }
    if (f.kind === "datetime") {
      const p = parseDateTime(raw);
      return p ? wrap(formatDate(p.d, f.pattern || "yyyy/MM/dd")) : raw;
    }
    if (f.kind === "text") return wrap(raw.trim());
    return raw;
  }
  function format(t, c, v) { return formatValue(get(t).formats[c], v); }
  function alignOf(t, c) {
    const l = get(t), a = l.aligns[c] || {}, f = l.formats[c] || {};
    const data = a.data || (f.kind === "number" ? "right" : "left");
    const head = a.head === "follow" ? data : (a.head || "center");
    return { data, head };
  }
  function formatSummary(f) {
    if (!f || !f.kind) return "";
    if (f.kind === "number") return `数値${f.decimals !== "" && f.decimals != null ? `・小数${f.decimals}桁` : ""}${f.thousands ? "・3桁区切り" : ""}${f.prefix || f.suffix ? `・単位 ${f.prefix || ""}〜${f.suffix || ""}` : ""}`;
    if (f.kind === "datetime") return `日付・時刻（${f.pattern || "yyyy/MM/dd"}）`;
    return `文字${f.prefix || f.suffix ? `（${f.prefix || ""}〜${f.suffix || ""}）` : ""}`;
  }
  /* 段ごとの「いまの値」（設定の窓の段の見出しに出す。畳んでいても、どこを変えたかが開かずに分かる）。
     既定のままなら set=false（札を淡くする）。一覧の「変えた列」の点も同じ言葉を使う（changes）。 */
  const ALIGN_NAME = { left: "左", center: "中央", right: "右", follow: "データに合わせる" };
  function stepLook(t, c) {
    const l = get(t), a = l.aligns[c] || {}, parts = [];
    if (l.names[c]) parts.push(`表示名「${l.names[c]}」`);
    if (l.locks.includes(c)) parts.push(`幅 固定 ${l.widths[c] || ""}px`); else if (l.widths[c]) parts.push(`幅 ${l.widths[c]}px`);
    if (a.data) parts.push(`揃え ${ALIGN_NAME[a.data]}`);
    if (a.head) parts.push(`見出し ${ALIGN_NAME[a.head]}`);
    return { text: parts.join("・") || "自動", set: parts.length > 0 };
  }
  function stepFx(t, c) {
    const src = String(get(t).formulas[c] || "").trim();
    if (isComputed(t, c)) return { text: !src ? "式を入れてください" : window.WL.formula.check(src).ok ? "式で作る列" : "式に誤り", set: true };
    return src ? { text: "式で作り替え", set: true } : { text: "元の値のまま", set: false };
  }
  function stepFmt(t, c) { const s = formatSummary(get(t).formats[c]); return { text: s || "そのまま", set: !!s }; }
  function stepRule(t, c) { const r = get(t).rules[c]; return { text: r ? `「${r}」` : "しない", set: !!r }; }
  /** 既定から変えたこと（名前の並び）。一覧の「変えた列」の点と、その説明に使う */
  function changes(t, c) {
    return [["見せ方", stepLook(t, c)], ["作り方", isComputed(t, c) ? { set: false } : stepFx(t, c)], ["値の整え方", stepFmt(t, c)], ["読み替え", stepRule(t, c)]]
      .filter(([, s]) => s.set).map(([n, s]) => `${n}（${s.text}）`);
  }

  /* ================= 幅 ================= */
  function estimate(t, c, rows) {
    const font = '13.5px "Yu Gothic UI","Meiryo UI",sans-serif', hfont = '700 13px "Yu Gothic UI","Meiryo UI",sans-serif';
    const ws = rows.slice(0, 40).map((r) => textWidth(cell(t, c, r).text, font)).sort((a, b) => a - b);
    const p90 = ws.length ? ws[Math.min(ws.length - 1, Math.floor(ws.length * 0.9))] : 0;
    // 余白はいまのセルの余白（左右）。見出しは並べ替えの印のぶん少し足す。+4 は字の端の丸め（ここを詰めると「…」が出やすい）
    const pad = cellPad() * 2;
    const head = textWidth(label(t, c), hfont) + pad + 10;
    return Math.round(Math.min(AUTO_MAX, Math.max(AUTO_MIN, Math.max(p90 + pad + 4, head))));
  }
  function widthOf(t, c, rows) { const w = get(t).widths[c]; return w ? w : estimate(t, c, rows); }

  /* ================= 色（この端末だけ・一時的） ================= */
  const tints = () => SS.get(KEY.tint, {});
  function setTint(t, c, key) { const all = tints(); all[t] = all[t] || {}; if (key) all[t][c] = key; else delete all[t][c]; SS.set(KEY.tint, all); }
  function clearTints(t) { const all = tints(); delete all[t]; SS.set(KEY.tint, all); }
  function tintCss(t, cols, scope) {
    const map = (tints()[t]) || {};
    return cols.map((c, i) => {
      const k = map[c]; if (!k) return "";
      const hex = (TINTS.find((x) => x[0] === k) || [])[2]; if (!hex) return "";
      const n = i + 1;
      return `${scope} thead th:nth-child(${n}){background:${hex};box-shadow:inset 0 -3px 0 color-mix(in srgb,${hex} 60%,#000)}`
        + `${scope} tbody td:nth-child(${n}){background:color-mix(in srgb,${hex} 14%,#fff)!important}`;
    }).join("");
  }

  /* ================= 行間 ================= */
  const GAP = [["いちばん詰める", 1], ["詰める", 2], ["ふつう", 4], ["広め", 7], ["いちばん広い", 11]];
  const rowGap = () => Math.min(5, Math.max(1, +LS.get(KEY.rowGap, 3) || 3));
  function setRowGap(n) { LS.set(KEY.rowGap, n); }
  const rowPad = () => GAP[rowGap() - 1][1];

  /* ================= セルの余白・入り切らない文字・左に固定する列（この PC） =================
     列を狭めると出る「…」は、字の幅＋左右の余白が列の幅を超えたところで出る。余白を詰める・記号を出さずに切る（記号のぶん
     1〜2字多く見える）・折り返す、のどれかで、もう少し詰めても読めるようにする。 */
  const PAD_MAX = 14, PAD_DEFAULT = 10, FREEZE_MAX = 4;
  const OVERFLOWS = [["ellipsis", "「…」で切る", "入り切らない字を「…」に替えます（元の値はマウスを乗せると出ます）"],
    ["clip", "記号なしで切る", "「…」を出さずに列の端で切ります（記号のぶん1〜2字多く見えます）"],
    ["wrap", "折り返して全部出す", "入り切らない字を次の行へ折り返します（行が高くなります）"]];
  const cellPad = () => { const v = +LS.get(KEY.cellPad, PAD_DEFAULT); return Number.isFinite(v) ? Math.min(PAD_MAX, Math.max(0, v)) : PAD_DEFAULT; };
  const setCellPad = (n) => LS.set(KEY.cellPad, Math.min(PAD_MAX, Math.max(0, Math.round(+n || 0))));
  const overflow = () => { const v = LS.get(KEY.overflow, "ellipsis"); return OVERFLOWS.some((o) => o[0] === v) ? v : "ellipsis"; };
  const setOverflow = (v) => LS.set(KEY.overflow, v);
  const freeze = () => { const v = +LS.get(KEY.freeze, 1); return Number.isFinite(v) ? Math.min(FREEZE_MAX, Math.max(0, v)) : 1; };
  const setFreeze = (n) => LS.set(KEY.freeze, Math.min(FREEZE_MAX, Math.max(0, Math.round(+n || 0))));
  /* 先頭から n 列を左に固定する CSS（列の幅の和で left を決める）。背景は :where で弱くし、行の縞・ホバーの色を活かす */
  function freezeCss(scope, widths) {
    const n = Math.min(freeze(), widths.length);
    let left = 0, css = "";
    for (let i = 0; i < n; i++) {
      const k = i + 1, last = i === n - 1;
      css += `${scope} th:nth-child(${k}),${scope} td:nth-child(${k}){position:sticky;left:${left}px}`
        + `${scope} tbody td:nth-child(${k}){z-index:1}${scope} thead th:nth-child(${k}){z-index:3}`
        + `:where(${scope}) tbody td:nth-child(${k}){background-color:var(--surface)}`
        + (last ? `${scope} th:nth-child(${k}),${scope} td:nth-child(${k}){box-shadow:1px 0 0 var(--line)}` : "");
      left += widths[i];
    }
    return css;
  }

  /* ================= 見出しの操作（ドラッグで並べ替え・取っ手で幅・右クリック） ================= */
  let ctx = null;             // { target, columns, rows, lotColumn, rerender(), grid }
  function setContext(c) { ctx = c; if (panel && !panel.hidden) renderPanel(); }
  function bindHeader(thead) {
    // 取っ手で幅
    thead.addEventListener("mousedown", (e) => {
      const grip = e.target.closest(".col-resize"); if (!grip || !ctx) return;
      e.preventDefault(); e.stopPropagation();
      const th = grip.closest("th"), c = th.dataset.col, t = ctx.target;
      if (get(t).locks.includes(c)) return;
      // 幅は CSS の px（一覧を拡大していても offsetWidth は拡大前）。マウスの動きは拡大の倍率で割って同じ尺にする
      const x0 = e.clientX, w0 = th.offsetWidth, k = th.getBoundingClientRect().width / (th.offsetWidth || 1) || 1;
      const colEl = ctx.grid.querySelector(`col[data-col="${CSS.escape(c)}"]`);
      document.body.classList.add("ll-resizing");
      const move = (ev) => {
        const w = Math.round(Math.min(W_MAX, Math.max(W_MIN, w0 + (ev.clientX - x0) / k)));
        if (colEl) colEl.style.width = w + "px";
        hold(t, { widths: Object.assign({}, get(t).widths, { [c]: w }) });
        fitTableWidth();
      };
      const up = () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        document.body.classList.remove("ll-resizing");
        const w = (live[t] && live[t].widths || {})[c];
        setTimeout(() => { release(t); if (w) patch(t, { widths: Object.assign({}, get(t).widths, { [c]: w }) }); ctx.rerender(); }, GRIP_SETTLE_MS);
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    thead.addEventListener("dblclick", (e) => {
      const grip = e.target.closest(".col-resize"); if (!grip || !ctx) return;
      const c = grip.closest("th").dataset.col, l = get(ctx.target);
      if (l.locks.includes(c)) return;
      const widths = Object.assign({}, l.widths); delete widths[c];
      patch(ctx.target, { widths }); ctx.rerender();
    });
    // ドラッグで並べ替え（どの列もどこへでも。ロット番号の列も）
    let dragCol = null;
    thead.addEventListener("dragstart", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th || e.target.closest(".col-resize")) { e.preventDefault(); return; }
      dragCol = th.dataset.col; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragCol);
      th.classList.add("is-dragging");
    });
    thead.addEventListener("dragover", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th || !dragCol) return;
      e.preventDefault();
      const r = th.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
      $$("th", thead).forEach((x) => x.classList.remove("col-drop-before", "col-drop-after"));
      th.classList.add(after ? "col-drop-after" : "col-drop-before");
    });
    thead.addEventListener("dragleave", (e) => { const th = e.target.closest("th"); if (th) th.classList.remove("col-drop-before", "col-drop-after"); });
    thead.addEventListener("drop", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th || !dragCol) return;
      e.preventDefault();
      const after = th.classList.contains("col-drop-after"), to = th.dataset.col;
      $$("th", thead).forEach((x) => x.classList.remove("col-drop-before", "col-drop-after", "is-dragging"));
      if (to !== dragCol) {
        const order = ordered(ctx.target, ctx.columns, ctx.lotColumn).filter((c) => c !== dragCol);
        order.splice(order.indexOf(to) + (after ? 1 : 0), 0, dragCol);
        patch(ctx.target, { order }); ctx.rerender();
      }
      dragCol = null;
    });
    thead.addEventListener("dragend", () => { dragCol = null; $$("th", thead).forEach((x) => x.classList.remove("col-drop-before", "col-drop-after", "is-dragging")); });
    // 右クリックのメニュー
    thead.addEventListener("contextmenu", (e) => {
      const th = e.target.closest("th[data-col]"); if (!th || !ctx) return;
      e.preventDefault(); openHeaderMenu(th.dataset.col, e.clientX, e.clientY);
    });
  }
  function fitTableWidth() {
    if (!ctx) return;
    const cols = $$("col", ctx.grid);
    ctx.grid.style.width = cols.reduce((s, c) => s + (parseFloat(c.style.width) || 0), 0) + "px";
  }

  let menuEl = null, menuOff = null;
  function closeMenu() { menuEl?.remove(); menuEl = null; if (menuOff) menuOff(); menuOff = null; }
  /* メニューの中の矢印・Home・End で項目を移る（外側・Esc で閉じるのは TPA.dismissable） */
  function onMenuKey(e) {
    const items = $$("button:not(:disabled)", menuEl), i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
  }
  function openHeaderMenu(c, x, y) {
    closeMenu();
    const t = ctx.target, l = get(t), isLot = c === ctx.lotColumn;
    const mode = l.locks.includes(c) ? "固定（動かさない）" : l.widths[c] ? "手で決めた幅" : "内容に合わせる（自動）";
    const hidden = ordered(t, ctx.columns, ctx.lotColumn).filter((k) => l.hidden.includes(k));
    const curTint = ((tints()[t]) || {})[c];
    const tintCount = Object.keys((tints()[t]) || {}).length;
    const m = document.createElement("div");
    m.className = "ll-colmenu"; m.setAttribute("role", "menu");
    m.innerHTML = `<p class="cm-head">${esc(label(t, c))}</p>`
      + `<button type="button" data-a="hide"${isLot ? ' disabled title="ロット番号の列は押して検索するので隠せません"' : ""}>この列を隠す</button>`
      + (ctx.levels && ctx.levels.can(c) ? (ctx.levels.has(c)
        ? '<button type="button" data-a="ungroup" title="この列でまとめるのをやめます（ほかの段はそのまま）">この列のまとめを外す</button>'
        : `<button type="button" data-a="group" title="この列の値が同じ行を続けて並べ、まとめます（いまの段の下に足します）">この列でまとめる（${ctx.levels.count() + 1}段目に足す）</button>`) : "")
      + `<p class="cm-label">幅: ${mode}</p>`
      + `<button type="button" data-a="auto">幅を内容に合わせる（自動）</button>`
      + `<button type="button" data-a="lock">${l.locks.includes(c) ? "幅の固定を解く" : "いまの幅で固定する"}</button>`
      + `<p class="cm-label">色: ${curTint ? (TINTS.find((x) => x[0] === curTint) || [])[1] : "なし"}<small>この端末だけ・一時的（列を動かすときの目印）</small></p>`
      + `<div class="cm-tints">${TINTS.map(([k, n, hex, mean]) => `<button type="button" class="cm-tint${curTint === k ? " is-on" : ""}" data-tint="${k}" style="--tint:${hex}" title="${n} — ${mean}" aria-label="${n}"></button>`).join("")}</div>`
      + (curTint ? '<button type="button" data-a="untint">この列の色を外す</button>' : "")
      + (tintCount ? `<button type="button" data-a="untintAll">すべての色を外す（${tintCount}列）</button>` : "")
      + (hidden.length ? `<p class="cm-label">隠している列（${hidden.length}）</p>`
        + hidden.slice(0, 10).map((k) => `<button type="button" data-show="${esc(k)}">「${esc(label(t, k))}」を出す</button>`).join("")
        + (hidden.length > 10 ? `<p class="cm-more">ほか${hidden.length - 10}件は「表示列」から</p>` : "")
        + '<button type="button" data-a="showAll">すべての列を表示</button>' : "")
      + '<button type="button" data-a="panel" class="cm-sep">表示列の設定を開く…</button>';
    document.body.append(m); menuEl = m;
    TPA.placeAt(m, x, y);
    m.addEventListener("keydown", onMenuKey);
    menuOff = TPA.dismissable(m, closeMenu, { event: "mousedown" });
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.disabled) return;
      const L = get(t), a = b.dataset.a;
      if (a === "hide") {
        if (visible(t, ctx.columns, ctx.lotColumn).length <= 1) return;
        patch(t, { hidden: [...new Set([...L.hidden, c])] });
      } else if (a === "auto") { const w = Object.assign({}, L.widths); delete w[c]; patch(t, { widths: w, locks: L.locks.filter((k) => k !== c) }); }
      else if (a === "lock") {
        if (L.locks.includes(c)) patch(t, { locks: L.locks.filter((k) => k !== c) });
        else {
          const th = ctx.grid.querySelector(`th[data-col="${CSS.escape(c)}"]`);
          const w = L.widths[c] || (th ? th.offsetWidth : 120);
          patch(t, { locks: [...L.locks, c], widths: Object.assign({}, L.widths, { [c]: w }) });
        }
      } else if (b.dataset.tint) setTint(t, c, b.dataset.tint);
      else if (a === "untint") setTint(t, c, "");
      else if (a === "untintAll") clearTints(t);
      else if (b.dataset.show) patch(t, { hidden: L.hidden.filter((k) => k !== b.dataset.show) });
      else if (a === "showAll") patch(t, { hidden: [] });
      else if (a === "panel") { closeMenu(); openPanel(); return; }
      else if (a === "group" || a === "ungroup") { closeMenu(); if (a === "group") ctx.levels.add(c); else ctx.levels.remove(c); return; }
      closeMenu(); ctx.rerender();
    });
    requestAnimationFrame(() => $("button:not(:disabled)", m)?.focus());
  }

  /* ================= 表示列の窓 ================= */
  let panel = null, win = null, sel = new Set(), anchor = null, focusCol = null, stateChip = "", nameQ = "";
  let openStep = "look";   // 右で開いている段（1 つだけ。列を替えても同じ段を開いたまま。"" は全部畳む）
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("section");
    panel.id = "llColumnPanel"; panel.className = "ll-colpanel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "表示列の設定");
    panel.innerHTML = `
      <div class="lc-head" data-drag>
        <div><small class="lc-eyebrow">一覧の見せ方</small><h3 id="lcTitle">表示列の設定</h3></div>
        <button type="button" class="lc-x" id="lcClose" title="閉じる（保存していない変更は元に戻ります）" aria-label="閉じる">×</button>
      </div>
      <div class="lc-body">
        <div class="lc-left">
          <div class="lc-tools">
            <input id="lcFilter" type="search" placeholder="列名で絞り込み" autocomplete="off" aria-label="列名で絞り込み">
            <button type="button" id="lcAddCol" title="元のデータの列から式で作る列を足します（表示だけの列）">＋ 列を作る</button>
            <button type="button" id="lcFitAll" title="いま並んでいる列の手で決めた幅を外して、内容に合わせます">幅を内容に合わせる</button>
          </div>
          <div class="lc-chips" id="lcChips"></div>
          <div class="lc-listhead"><label title="いま並んでいる列をまとめて出す／隠す"><input type="checkbox" id="lcAll"></label>
            <span title="上下にドラッグで並べ替え。Ctrl・Shift を押しながらクリックでまとめて選ぶ">列（ドラッグで並べ替え）</span><span>表示名</span><span>見え方（実データ 1 件）</span></div>
          <ol class="lc-list" id="lcList"></ol>
        </div>
        <div class="lc-right" id="lcDetail"></div>
      </div>
      <div class="lc-foot">
        <div class="lc-more">
          <button type="button" id="lcMore" aria-expanded="false" aria-controls="lcPresets">保存した設定・書き出し ▾</button>
          <div class="lc-presets" id="lcPresets" hidden>
            <label>保存した設定<select id="lcPresetSel"><option value="">（選ぶと読み込みます）</option></select></label>
            <div class="lc-presets-acts"><button type="button" id="lcPresetSave">名前を付けて登録</button><button type="button" id="lcPresetDel">削除</button></div>
            <div class="lc-presets-acts"><button type="button" id="lcExport">書き出し…</button><button type="button" id="lcImport">読み込み…</button></div>
          </div>
        </div>
        <span id="lcCount"></span><span id="lcNote" class="lc-note"></span><span class="lc-sp"></span>
        <button type="button" id="lcReset">既定に戻す</button>
        <button type="button" id="lcSave" class="lc-primary">保存</button>
      </div>`;
    document.body.append(panel);
    win = TPA.floatPanel(panel, { key: KEY.rect, w: 1240, h: 780, top: 40, minW: 820, minH: 460 });   // 見出しで動かす・4辺と4隅で大きさ。この PC に覚える
    win.place();
    bindPanel();
    return panel;
  }
  function openPanel() {
    if (!ctx) return;
    ensurePanel(); win.place();
    nameQ = ""; stateChip = ""; $("#lcFilter").value = "";
    sel = new Set(); focusCol = focusCol && ctx.columns.includes(focusCol) ? focusCol : visible(ctx.target, ctx.columns, ctx.lotColumn)[0];
    panel.hidden = false; renderPanel();
    requestAnimationFrame(() => $("#lcFilter").focus());
  }
  function closePanel({ keep = false } = {}) {
    if (!panel || panel.hidden) return;
    if (!keep && ctx) { discard(ctx.target); ctx.rerender(); }
    win.remember(); panel.hidden = true;      // 隠す前に覚える（隠したあとは大きさ 0 になる）
  }
  const toggle = () => (panel && !panel.hidden ? closePanel() : openPanel());
  function sampleRow(c) { return ctx.rows.find((x) => { const v = rawOf(ctx.target, c, x); return v != null && String(v).trim() !== ""; }) || null; }
  function listCols() {
    const t = ctx.target, l = get(t), hidden = new Set(l.hidden), q = nameQ.trim().toLowerCase();
    return ordered(t, ctx.columns, ctx.lotColumn).filter((c) => {
      if (stateChip === "shown" && hidden.has(c)) return false;
      if (stateChip === "src" && isComputed(t, c)) return false;
      if (stateChip === "calc" && !isComputed(t, c)) return false;
      if (stateChip === "hidden" && !hidden.has(c)) return false;
      return !q || c.toLowerCase().includes(q) || label(t, c).toLowerCase().includes(q);
    });
  }
  function renderPanel() {
    if (!panel || panel.hidden || !ctx) return;
    const t = ctx.target, l = get(t), all = ordered(t, ctx.columns, ctx.lotColumn), hidden = new Set(l.hidden);
    $("#lcTitle").textContent = `表示列の設定（異常ロット一覧：${t.replace(/^lotlist:/, "")}）`;
    const nShown = all.filter((c) => !hidden.has(c) || c === ctx.lotColumn).length;
    const nCalc = all.filter((c) => isComputed(t, c)).length;
    $("#lcChips").innerHTML = [["", `すべて ${all.length}`], ["src", `元データ ${all.length - nCalc}`], ["calc", `計算・操作 ${nCalc}`], ["shown", `表示中 ${nShown}`], ["hidden", `非表示中 ${all.length - nShown}`]]
      .map(([k, txt]) => { const n = { "": all.length, src: all.length - nCalc, calc: nCalc, shown: nShown, hidden: all.length - nShown }[k];
        // 0 件の札は出さない（押しても何も出ない札は読む量だけ増やす）。選んでいる札は 0 件でも外せるように残す
        return k && !n && stateChip !== k ? "" : `<button type="button" class="lc-chip${stateChip === k ? " is-on" : ""}" data-chip="${k}">${txt}</button>`; }).join("")
      + (nameQ.trim() ? `<span class="lc-q">「${esc(nameQ.trim())}」で絞り込み中（${all.length}列中${listCols().length}列）<button type="button" data-clearq>× 外す</button></span>` : "");
    const cols = listCols();
    const allBox = $("#lcAll"), shownIn = cols.filter((c) => !hidden.has(c) || c === ctx.lotColumn).length;
    allBox.checked = cols.length > 0 && shownIn === cols.length; allBox.indeterminate = shownIn > 0 && shownIn < cols.length;
    $("#lcList").innerHTML = cols.map((c) => {
      const isLot = c === ctx.lotColumn, sr = sampleRow(c), cl = sr ? cell(t, c, sr) : null, v = cl ? cl.raw : null, shown = cl ? cl.text : "";
      const calc = isComputed(t, c), chg = changes(t, c);
      const smp = v == null ? '<em class="lc-none">（値のある行がありません）</em>'
        : (shown !== String(v) ? `<s>${esc(v)}</s> ${esc(shown)}` : esc(shown));
      // 表示名: 選んでいる列はその場で直せる欄、ほかは付けた名前だけ（付けていなければ空ける＝読む字を増やさない）
      const inl = focusCol === c ? `<input value="${esc(l.names[c] || "")}" placeholder="${esc(c)}" maxlength="40" aria-label="「${esc(c)}」の表示名">` : esc(l.names[c] || "");
      return `<li class="lc-row${sel.has(c) ? " is-sel" : ""}${focusCol === c ? " is-focus" : ""}${hidden.has(c) && !isLot ? " is-hidden" : ""}" data-col="${esc(c)}">`
        + `<input type="checkbox" class="lc-vis"${!hidden.has(c) || isLot ? " checked" : ""}${isLot ? ' disabled title="ロット番号の列は押して検索するので、隠せません（並びはどこへでも動かせます）"' : ""} aria-label="「${esc(label(t, c))}」を出す">`
        + '<span class="lc-grip" title="ドラッグで並べ替え">⠿</span>'
        + `<span class="lc-name"><i class="lc-dot ${calc ? "is-calc" : "is-src"}" title="${calc ? "計算・操作（この画面で作った列）" : "元データ"}"></i>${esc(c)}`
        + `${chg.length ? `<i class="lc-chg" title="変えたこと: ${esc(chg.join("・"))}" aria-label="変えた列"></i>` : ""}</span>`
        + `<span class="lc-inl">${inl}</span>`
        + `<span class="lc-sample" title="${esc(v == null ? "" : v)}">${smp}</span></li>`;
    }).join("") || '<li class="lc-empty">当たる列がありません</li>';
    $("#lcCount").textContent = `${nShown} / ${all.length} 列` + (sel.size > 1 ? `／ ${sel.size}列を選択中（そのままドラッグでまとめて移動）` : "");
    const ps = LS.get(KEY.presets, []).filter((p) => p.table === ctx.table);
    const cur = $("#lcPresetSel").value;
    $("#lcPresetSel").innerHTML = '<option value="">（選ぶと読み込みます）</option>' + ps.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
    if (ps.some((p) => p.name === cur)) $("#lcPresetSel").value = cur;
    $("#lcPresetDel").disabled = !$("#lcPresetSel").value;
    $("#lcNote").textContent = isDirty(t) ? "一覧に反映しています（保存すると次に開いたときも同じ形で出ます）" : "";
    renderDetail();
  }
  function renderDetail() {
    const t = ctx.target, c = focusCol, box = $("#lcDetail");
    if (!c || !ctx.columns.includes(c)) { box.innerHTML = '<p class="lc-empty">左で列を選ぶと、ここで見え方を整えられます。</p>'; return; }
    const l = get(t), f = l.formats[c] || {}, a = l.aligns[c] || {};
    const calc = isComputed(t, c), fsrc = l.formulas[c] || "";
    const vals = ctx.rows.map((r) => rawOf(t, c, r)).filter((v) => v != null && String(v).trim() !== "");
    const kinds = { num: 0, date: 0, text: 0 };
    vals.forEach((v) => { if (parseDateTime(v)) kinds.date++; else if (Number.isFinite(Number(String(v).replace(/,/g, "")))) kinds.num++; else kinds.text++; });
    const guess = !vals.length ? "値がありません" : kinds.date >= vals.length * 0.8 ? "日付らしい値が多い" : kinds.num >= vals.length * 0.8 ? "数値らしい値が多い" : "文字が多い";
    const mode = l.locks.includes(c) ? "locked" : l.widths[c] ? "manual" : "auto";
    const distinctRows = []; const seenV = new Set();
    for (const r of ctx.rows) { const v = rawOf(t, c, r); const k = String(v ?? ""); if (k.trim() && !seenV.has(k)) { seenV.add(k); distinctRows.push(r); } if (distinctRows.length >= 3) break; }
    const fchk = String(fsrc).trim() ? window.WL.formula.check(fsrc) : null;
    const ruleNames = window.LotListRules ? window.LotListRules.names() : [];
    const dec = f.decimals == null ? "" : String(f.decimals);
    const nChanged = distinctRows.filter((r) => { const o = cell(t, c, r); return o.text !== o.raw; }).length;
    const stepResult = { text: !distinctRows.length ? "値がありません" : nChanged ? `${distinctRows.length} 件中 ${nChanged} 件が変わる` : "変わりません", set: nChanged > 0 };
    // 段: 見出しを押して開く・畳む（開くのは 1 つ）。見出しの右に今の値（変えていれば濃く）
    const step = (key, mark, title, sum) => `<section class="lc-step${openStep === key ? " is-open" : ""}" data-step="${key}">`
      + `<h4 role="button" tabindex="0" aria-expanded="${openStep === key}">${mark ? `<i>${mark}</i>` : ""}${title}`
      + `<span class="lc-now${sum.set ? " is-set" : ""}">${esc(sum.text)}</span><b class="lc-chev" aria-hidden="true"></b></h4>`;
    box.innerHTML = `
      <div class="lc-card"><b>${esc(label(t, c))}</b>
        <dl><dt>${calc ? "作った列" : "元の項目名"}</dt><dd>${esc(c)}${calc ? "（表示だけの列。並べ替え・絞り込みは元のデータの列で行います）" : ""}</dd><dt>値のある行</dt><dd>${vals.length} / ${ctx.rows.length}（空欄 ${ctx.rows.length - vals.length}）</dd>
        <dt>値の種類</dt><dd>${guess}</dd>${c === ctx.lotColumn ? "<dt>この列について</dt><dd>押すとそのロットを検索します。隠せません（並びはどこへでも動かせます）。</dd>" : ""}</dl></div>
      ${step("look", "1", "見せ方", stepLook(t, c))}
        <label>表示名<input id="lcName" value="${esc(l.names[c] || "")}" placeholder="${esc(c)}" maxlength="40"></label>
        <div class="lc-field"><span>幅</span>
          ${["auto", "manual", "locked"].map((k) => `<label class="lc-radio"><input type="radio" name="lcW" value="${k}"${mode === k ? " checked" : ""}>${{ auto: "自動", manual: "手で決める", locked: "固定" }[k]}</label>`).join("")}
          <input id="lcWidth" type="number" min="${W_MIN}" max="${W_MAX}" step="10" placeholder="自動" value="${l.widths[c] || ""}"${mode === "auto" ? " disabled" : ""}> px
          <small class="lc-hint">${WIDTH_MODE_NOTE[mode]}</small></div>
        <div class="lc-field"><span>データの揃え</span>${[["", "自動"], ["left", "左"], ["center", "中央"], ["right", "右"]].map(([k, n]) => `<label class="lc-radio"><input type="radio" name="lcAD" value="${k}"${(a.data || "") === k ? " checked" : ""}>${n}</label>`).join("")}</div>
        <div class="lc-field"><span>見出しの揃え</span>${[["", "中央（既定）"], ["follow", "データに合わせる"], ["left", "左"], ["right", "右"]].map(([k, n]) => `<label class="lc-radio"><input type="radio" name="lcAH" value="${k}"${(a.head || "") === k ? " checked" : ""}>${n}</label>`).join("")}</div>
      </section>
      ${step("fx", "式", "この列の作り方", stepFx(t, c))}
        <textarea id="lcFormula" rows="2" spellcheck="false" placeholder="例: [製造板厚] * [幅]　／　if([数量] > 100, '大', '小')">${esc(fsrc)}</textarea>
        <small id="lcFxState" class="lc-fxstate ${fchk && !fchk.ok ? "is-ng" : "is-ok"}">${!String(fsrc).trim() ? (calc ? "式を入れてください" : "元の値をそのまま出します") : fchk.ok ? `使える式です（使っている列: ${esc(fchk.columns.join("、") || "なし")}）` : esc(fchk.error)}</small>
        ${String(fsrc).trim() && fchk && fchk.ok ? `<div class="lc-fxtry"><span>先頭3件の結果</span>${ctx.rows.slice(0, 3).map((r) => `<code>${esc(String(rawOf(t, c, r) ?? "")) || "（空欄）"}</code>`).join("")}</div>` : ""}
        <details class="lc-help"><summary>書き方</summary><table>${window.WL.formula.help.map(([a, b]) => `<tr><td><code>${esc(a)}</code></td><td>${esc(b)}</td></tr>`).join("")}</table></details>
        ${calc ? '<button type="button" id="lcDelCol" class="lc-danger">この列を削除する</button>' : ""}
      </section>
      ${step("fmt", "2", "値の整え方", stepFmt(t, c))}
        <div class="lc-field"><span>種類</span>${[["", "そのまま"], ["number", "数値"], ["datetime", "日付・時刻"], ["text", "文字"]].map(([k, n]) => `<label class="lc-radio"><input type="radio" name="lcK" value="${k}"${(f.kind || "") === k ? " checked" : ""}>${n}</label>`).join("")}</div>
        ${f.kind === "number" ? `<div class="lc-field"><span>小数桁</span><select id="lcDec"><option value="">そのまま</option>${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${dec === String(n) ? " selected" : ""}>${n}桁</option>`).join("")}</select>
            <label class="lc-check"><input type="checkbox" id="lcThou"${f.thousands ? " checked" : ""}>3桁ごとに区切る（1,234）</label></div>` : ""}
        ${f.kind === "datetime" ? `<div class="lc-field"><span>形</span><select id="lcPreset">${DATE_PRESETS.map((p) => `<option value="${esc(p)}"${(f.pattern || "yyyy/MM/dd") === p ? " selected" : ""}>${esc(p)}</option>`).join("")}<option value="__custom"${f.pattern && !DATE_PRESETS.includes(f.pattern) ? " selected" : ""}>自分で指定</option></select>
            <input id="lcPattern" value="${esc(f.pattern || "yyyy/MM/dd")}" maxlength="60"><small class="lc-hint">y=年 M=月 d=日 H=時 m=分 s=秒 ddd=曜日（2つ重ねると0埋め）</small></div>` : ""}
        ${f.kind && f.kind !== "datetime" ? `<div class="lc-field"><span>単位</span><input id="lcPre" value="${esc(f.prefix || "")}" maxlength="8" placeholder="前（例: ¥）"><input id="lcSuf" value="${esc(f.suffix || "")}" maxlength="8" placeholder="後（例: mm）"></div>` : ""}
      </section>
      ${step("rule", "3", "読み替え", stepRule(t, c))}
        <div class="lc-field"><span>ルール</span><select id="lcRule"><option value="">しない</option>${ruleNames.map((n) => `<option value="${esc(n)}"${l.rules[c] === n ? " selected" : ""}>${esc(n)}</option>`).join("")}<option value="__new">＋ 新しいルールを作る…</option></select>
          <button type="button" id="lcRuleEdit"${l.rules[c] ? "" : " disabled"}>ルールを編集</button></div>
        <small class="lc-hint">読み替えが当たった行はその言葉で確定し、当たらなければ書式で整形します。どちらもできない値は元のまま表示します。</small>
      </section>
      ${step("result", "", "結果", stepResult)}
        ${distinctRows.length ? `<table><tr><th>元の値</th><th></th><th>一覧に出る値</th></tr>${distinctRows.map((r) => { const o = cell(t, c, r); return `<tr><td>${esc(o.raw)}</td><td>→</td><td class="${o.color ? "cell-" + o.color : ""}">${o.text === o.raw ? `${esc(o.text)} <small>変わりません</small>` : esc(o.text)}</td></tr>`; }).join("")}</table>` : '<p class="lc-empty">値のある行がありません</p>'}
      </section>`;
    const setL = (p) => { stage(t, p); ctx.rerender(); renderPanel(); };
    const setF = (p) => { const F = Object.assign({}, get(t).formats); F[c] = Object.assign({}, F[c] || {}, p); if (!F[c].kind) delete F[c]; setL({ formats: F }); };
    $("#lcName").addEventListener("change", (e) => setName(c, e.target.value));
    // 段を開く・畳む（描き直さずに印だけ替える＝押した手応えがすぐ返る）
    $$(".lc-step > h4", box).forEach((h) => {
      const flip = () => {
        const key = h.parentElement.dataset.step; openStep = openStep === key ? "" : key;
        $$(".lc-step", box).forEach((sct) => { const on = sct.dataset.step === openStep; sct.classList.toggle("is-open", on); $("h4", sct).setAttribute("aria-expanded", on); });
      };
      h.addEventListener("click", flip);
      h.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    });
    $$("input[name=lcW]", box).forEach((r) => r.addEventListener("change", () => {
      const L = get(t), W = Object.assign({}, L.widths); let locks = L.locks.filter((k) => k !== c);
      if (r.value === "auto") delete W[c];
      else {
        if (!W[c]) { const th = ctx.grid.querySelector(`th[data-col="${CSS.escape(c)}"]`); W[c] = th ? th.offsetWidth : 120; }   // 拡大前の幅
        if (r.value === "locked") locks = [...locks, c];
      }
      setL({ widths: W, locks });
    }));
    $("#lcWidth").addEventListener("change", (e) => { const W = Object.assign({}, get(t).widths); const v = Math.min(W_MAX, Math.max(W_MIN, +e.target.value || 0)); if (v) W[c] = v; setL({ widths: W }); });
    $$("input[name=lcAD]", box).forEach((r) => r.addEventListener("change", () => { const A = Object.assign({}, get(t).aligns); A[c] = Object.assign({}, A[c] || {}, { data: r.value }); setL({ aligns: A }); }));
    $$("input[name=lcAH]", box).forEach((r) => r.addEventListener("change", () => { const A = Object.assign({}, get(t).aligns); A[c] = Object.assign({}, A[c] || {}, { head: r.value }); setL({ aligns: A }); }));
    $$("input[name=lcK]", box).forEach((r) => r.addEventListener("change", () => setF({ kind: r.value, ...(r.value === "datetime" && !f.pattern ? { pattern: "yyyy/MM/dd" } : {}) })));
    $("#lcDec")?.addEventListener("change", (e) => setF({ decimals: e.target.value }));
    $("#lcThou")?.addEventListener("change", (e) => setF({ thousands: e.target.checked }));
    $("#lcPreset")?.addEventListener("change", (e) => { if (e.target.value !== "__custom") setF({ pattern: e.target.value }); else $("#lcPattern").focus(); });
    $("#lcPattern")?.addEventListener("change", (e) => setF({ pattern: e.target.value.slice(0, 60) || "yyyy/MM/dd" }));
    $("#lcPre")?.addEventListener("change", (e) => setF({ prefix: e.target.value.slice(0, 8) }));
    $("#lcSuf")?.addEventListener("change", (e) => setF({ suffix: e.target.value.slice(0, 8) }));
    // 作り方の式: 読めるあいだだけ当て直す（書きかけで一覧が空にならないように）。関数・列名の候補は WaveLog と同じ
    const fx = $("#lcFormula");
    window.WL.formula.suggest(fx, { columns: () => ctx.columns.map((k) => label(t, k)) });
    let fxTimer = null;
    fx.addEventListener("input", () => {
      const v = fx.value, chk = v.trim() ? window.WL.formula.check(v) : null, st = $("#lcFxState");
      st.textContent = !v.trim() ? (calc ? "式を入れてください" : "元の値をそのまま出します") : chk.ok ? `使える式です（使っている列: ${chk.columns.join("、") || "なし"}）` : chk.error;
      st.className = "lc-fxstate " + (chk && !chk.ok ? "is-ng" : "is-ok");
      clearTimeout(fxTimer);
      if (!v.trim() || chk.ok) fxTimer = setTimeout(() => {
        const Fm = Object.assign({}, get(t).formulas);
        if (v.trim() || calc) Fm[c] = v; else delete Fm[c];
        const pos = fx.selectionStart; setL({ formulas: Fm });
        const again = $("#lcFormula"); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 350);
    });
    $("#lcDelCol")?.addEventListener("click", () => {
      if (!confirm(`計算列「${label(t, c)}」を削除します（保存するまでは元に戻せます）。よろしいですか？`)) return;
      const L = get(t), drop = (o) => { const x = Object.assign({}, o); delete x[c]; return x; };
      focusCol = null;
      setL({ formulas: drop(L.formulas), names: drop(L.names), formats: drop(L.formats), aligns: drop(L.aligns), widths: drop(L.widths), rules: drop(L.rules),
        order: L.order.filter((k) => k !== c), hidden: L.hidden.filter((k) => k !== c), locks: L.locks.filter((k) => k !== c) });
    });
    // 読み替え: 選ぶ／新しく作る／編集する（編集の窓は lotlist-rules.js）
    const openRule = (name) => window.LotListRules.open({ name, column: c, source: ruleSource(), toFormula: (expr) => { $("#lcFormula").value = expr; $("#lcFormula").dispatchEvent(new Event("input")); },
      onDone: (saved) => { const Rr = Object.assign({}, get(t).rules); if (saved) Rr[c] = saved; else if (Rr[c] === name) delete Rr[c]; setL({ rules: Rr }); } });
    $("#lcRule").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "__new") { e.target.value = l.rules[c] || ""; openRule(""); return; }
      const Rr = Object.assign({}, get(t).rules); if (v) Rr[c] = v; else delete Rr[c]; setL({ rules: Rr });
    });
    $("#lcRuleEdit").addEventListener("click", () => { if (get(t).rules[c]) openRule(get(t).rules[c]); });
  }
  /** 列 c の表示名を v にする（空・元の名前と同じなら外す）。右の詳細と左の一覧の欄の両方から */
  function setName(c, v) {
    const t = ctx.target, N = Object.assign({}, get(t).names), name = String(v).trim().slice(0, 40);
    if (name && name !== c) N[c] = name; else delete N[c];
    stage(t, { names: N }); ctx.rerender(); renderPanel();
  }
  /* 読み替えの窓へ渡す「いまの一覧」（列・行・この列の見え方）。一覧のセルと同じ道で試す。 */
  function ruleSource() {
    const t = ctx.target;
    return {
      columns: () => ctx.columns, rows: () => ctx.rows,
      labelOf: (k) => (label(t, k) !== k ? `${label(t, k)}（${k}）` : k),
      ruleRow: (r, c, mode) => ruleRow(t, r, c, mode),
      cellWith: (r, c, rows, mode) => cellWith(t, c, r, rows, mode),
      usage: (name) => ruleUsage(name),
      toast: (m) => ctx.toast && ctx.toast(m),
    };
  }
  function bindPanel() {
    $("#lcClose").onclick = () => closePanel();
    const more = $("#lcMore"), pop = $("#lcPresets");
    const showMore = (on) => { pop.hidden = !on; more.setAttribute("aria-expanded", on); if (on) requestAnimationFrame(() => $("#lcPresetSel").focus()); };
    more.onclick = () => showMore(pop.hidden);
    panel.addEventListener("mousedown", (e) => { if (!pop.hidden && !e.target.closest(".lc-more")) showMore(false); });
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      if (!pop.hidden) { showMore(false); more.focus(); } else closePanel();   // Esc は内側から 1 段ずつ
    });
    $("#lcFilter").addEventListener("input", (e) => { nameQ = e.target.value; renderPanel(); });
    $("#lcChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chip]"); if (b) { stateChip = stateChip === b.dataset.chip ? "" : b.dataset.chip; renderPanel(); }
      if (e.target.closest("[data-clearq]")) { nameQ = ""; $("#lcFilter").value = ""; renderPanel(); }
    });
    $("#lcAll").addEventListener("change", (e) => {
      const t = ctx.target, cols = listCols().filter((c) => c !== ctx.lotColumn), H = new Set(get(t).hidden);
      cols.forEach((c) => (e.target.checked ? H.delete(c) : H.add(c)));
      stage(t, { hidden: [...H] }); ctx.rerender(); renderPanel();
    });
    $("#lcAddCol").onclick = () => {
      const t = ctx.target;
      let name = (prompt("計算列を作る\n新しい列の名前", "計算列") || "").trim().slice(0, 40);
      if (!name) return;
      const taken = new Set(ctx.columns);
      if (taken.has(name)) { let i = 2; while (taken.has(`${name}${i}`)) i++; name = `${name}${i}`; }
      const L = get(t), after = focusCol && ctx.columns.includes(focusCol) ? focusCol : null;
      const order = ordered(t, ctx.columns, ctx.lotColumn);
      order.splice(after ? order.indexOf(after) + 1 : order.length, 0, name);
      stage(t, { formulas: Object.assign({}, L.formulas, { [name]: "" }), order });
      focusCol = name; openStep = "fx"; ctx.rerender(); renderPanel();
      requestAnimationFrame(() => $("#lcFormula")?.focus());
    };
    $("#lcFitAll").onclick = () => {
      const t = ctx.target, L = get(t), cols = listCols(), W = Object.assign({}, L.widths);
      let n = 0; cols.forEach((c) => { if (W[c] && !L.locks.includes(c)) { delete W[c]; n++; } });
      stage(t, { widths: W }); ctx.rerender(); renderPanel();
      $("#lcNote").textContent = `${n}列の幅を内容に合わせました（保存するまでは元に戻せます）`;
    };
    const list = $("#lcList");
    list.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.closest(".lc-inl input")) { e.preventDefault(); e.target.blur(); } });
    list.addEventListener("change", (e) => {
      const nm = e.target.closest(".lc-inl input"); if (nm) { setName(nm.closest("li").dataset.col, nm.value); return; }
      const cb = e.target.closest(".lc-vis"); if (!cb) return;
      const t = ctx.target, c = cb.closest("li").dataset.col, H = new Set(get(t).hidden);
      if (cb.checked) H.delete(c); else H.add(c);
      stage(t, { hidden: [...H] }); ctx.rerender(); renderPanel();
    });
    // 選ぶ（クリック・Ctrl で足す・Shift で範囲）とドラッグで並べ替え（選んだ列はまとめて動く）
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-col]"); if (!li || e.target.closest("input")) return;
      const c = li.dataset.col, cols = listCols();
      if (e.shiftKey && anchor) {
        const a = cols.indexOf(anchor), b = cols.indexOf(c);
        sel = new Set(cols.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else if (e.ctrlKey || e.metaKey) { if (sel.has(c)) sel.delete(c); else sel.add(c); anchor = c; }
      else if (!sel.has(c)) { sel = new Set([c]); anchor = c; }
      focusCol = c;
      const y0 = e.clientY; let dragging = false, ghost = null, marker = null, target = null, after = false;
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientY - y0) < 4) return;
        if (!dragging) {
          dragging = true;
          ghost = document.createElement("div"); ghost.className = "lc-ghost";
          ghost.textContent = sel.size > 1 ? `${sel.size}列` : label(ctx.target, c); document.body.append(ghost);
          marker = document.createElement("div"); marker.className = "lc-dropline"; list.append(marker);
        }
        ghost.style.left = ev.clientX + 12 + "px"; ghost.style.top = ev.clientY + 8 + "px";
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("#lcList li[data-col]");
        if (over) {
          const r = over.getBoundingClientRect(); after = ev.clientY > r.top + r.height / 2; target = over.dataset.col;
          marker.style.top = (over.offsetTop + (after ? over.offsetHeight : 0) - 1) + "px"; marker.hidden = false;
        }
      };
      const up = () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        ghost?.remove(); marker?.remove();
        if (dragging && target && !sel.has(target)) {
          const t = ctx.target, full = ordered(t, ctx.columns, ctx.lotColumn);
          const moving = full.filter((k) => sel.has(k));
          const rest = full.filter((k) => !sel.has(k));
          rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, ...moving);
          stage(t, { order: rest }); ctx.rerender();
        }
        renderPanel();
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });
    $("#lcReset").onclick = () => {
      // 既定に戻す: 並び・表示・幅・表示名・書式・揃え・読み替えを戻す。作った計算列（式）は残す（WaveLog と同じ）
      stage(ctx.target, { order: [], hidden: [], widths: {}, locks: [], names: {}, formats: {}, aligns: {}, rules: {} });
      ctx.rerender(); renderPanel();
    };
    $("#lcSave").onclick = () => { save(ctx.target); closePanel({ keep: true }); ctx.rerender(); ctx.toast?.("列の設定を保存しました"); };
    // 保存した設定
    const presets = () => LS.get(KEY.presets, []);
    $("#lcPresetSel").onchange = (e) => {
      const p = presets().find((x) => x.table === ctx.table && x.name === e.target.value); $("#lcPresetDel").disabled = !p;
      if (!p) return;
      const skipped = applyBody(p.body);
      $("#lcNote").textContent = `「${p.name}」を読み込みました` + (skipped ? `（${skipped}列ぶんは飛ばしました）` : "");
    };
    $("#lcPresetSave").onclick = () => {
      const name = (prompt("この列の設定に名前を付けて登録します（同じ名前は上書き）", $("#lcPresetSel").value || "") || "").trim().slice(0, 40);
      if (!name) return;
      const list = presets().filter((x) => !(x.table === ctx.table && x.name === name));
      list.push({ table: ctx.table, name, body: get(ctx.target), savedAt: new Date().toISOString() });
      LS.set(KEY.presets, list); renderPanel(); $("#lcPresetSel").value = name; $("#lcPresetDel").disabled = false;
      $("#lcNote").textContent = `「${name}」として登録しました`;
    };
    $("#lcPresetDel").onclick = () => {
      const name = $("#lcPresetSel").value; if (!name || !confirm(`保存した設定「${name}」を削除します。よろしいですか？`)) return;
      LS.set(KEY.presets, presets().filter((x) => !(x.table === ctx.table && x.name === name))); renderPanel();
    };
    // 書き出し・読み込み（WaveLog と同じ形 {kind, version, savedAt, items:[{target, body}]}）
    $("#lcExport").onclick = () => {
      const scopeAll = confirm("すべての表の設定を書き出しますか？\n［OK］すべての一覧　［キャンセル］この一覧だけ");
      const items = scopeAll ? Object.keys(saved).map((t) => ({ target: t, body: saved[t] })) : [{ target: ctx.target, body: get(ctx.target) }];
      TPA.saveJson("tpa-lotlist-column-layouts", items, `異常ロット一覧_表示列_${scopeAll ? "すべて" : ctx.table}.json`);
    };
    $("#lcImport").onclick = async () => {
      try {
        const items = await TPA.pickJson(null, "表示列");   // 種類は問わない（前から読めていた形を読めなくしない）
        if (!items) return;
        const mine = items.find((x) => x.target === ctx.target) || (items.length === 1 ? items[0] : null);
        items.filter((x) => x !== mine && x.target && x.target !== ctx.target).forEach((x) => { saved[x.target] = norm(x.body); });
        writeSaved();
        const skipped = mine ? applyBody(mine.body) : 0;
        $("#lcNote").textContent = `読み込みました（${items.length}件）` + (skipped ? `。この一覧に無い ${skipped}列ぶんは飛ばしました` : "") + (mine ? "。保存すると確定します" : "");
      } catch (err) { $("#lcNote").textContent = "読み込めませんでした: " + err.message; }
    };
  }
  /* 設定の中身を今の一覧に当てる（今の一覧に無い列は飛ばして数える）。draft に入るので、保存するまで元に戻せる。 */
  function applyBody(body) {
    const b = norm(body), have = new Set(ctx.columns), mentioned = new Set();
    KEYS.forEach((k) => { const v = b[k]; (Array.isArray(v) ? v : Object.keys(v)).forEach((c) => mentioned.add(c)); });
    const keepArr = (a) => a.filter((c) => have.has(c));
    const keepObj = (o) => Object.fromEntries(Object.entries(o).filter(([c]) => have.has(c)));
    Object.keys(b.formulas).forEach((c) => have.add(c));          // 計算列は式そのものが列の元なので、いつも持ち込める
    stage(ctx.target, { formulas: b.formulas, order: keepArr(b.order), hidden: keepArr(b.hidden), locks: keepArr(b.locks), widths: keepObj(b.widths),
      names: keepObj(b.names), formats: keepObj(b.formats), aligns: keepObj(b.aligns), rules: keepObj(b.rules) });
    ctx.rerender(); renderPanel();
    return [...mentioned].filter((c) => !have.has(c)).length;
  }

  window.LotListColumns = {
    get, ordered, visible, label, alignOf, widthOf, tintCss, rowGap, setRowGap, rowPad, GAP,
    cellPad, setCellPad, overflow, setOverflow, OVERFLOWS, PAD_MAX, freeze, setFreeze, FREEZE_MAX, freezeCss,
    allColumns, isComputed, cell,
    setContext, bindHeader, toggle,
    // テスト・評価用
    _formatValue: formatValue, _parseDateTime: parseDateTime,
  };
})();
