"use strict";
/* =========================================================================
   読み替えルール（WaveLog の表示ルール＝ core/base.js displayRules と list/list-rules.js と同じ作り）
   「00」を「なし」と見せる類の置き換えを、利用者が名前を付けて登録し、複数の列から使い回す。

     上から順に見て、最初に当てはまったものを表示する。
     行＝上から順に試す。行の中の条件は「かつ（AND）」か「または（OR）」でつなぐ（join。無ければかつ）。
     かつ は または より先に結ぶ（ふつうの論理式と同じ）: A かつ B または C ＝（A かつ B）または C。
     かっこ＝まとまり { join, items: [...] }（中は条件かまた別のかっこ。3段まで）。かっこの中を先に決める: A かつ（B または C）。
     条件の無い行＝「どれにも当てはまらないとき」（既定）。

   条件の左辺: この列／他の列／式（式だけで真偽を決める）。右辺: 固定値／他の列／式。
   比べ方: ＝ ≠ 含む 始まる 終わる 空欄 空欄でない ＞ ≧ ＜ ≦ 範囲内 正規表現 （式が真なら）。
   出す字: 空欄なら元の値のまま、=で始めると式（例: =extract([この列],'[0-9]+')）。色: 良い・悪い・注意・目立たせない。
   列の値: 「元のデータ」か「表示の値」（式→値の整え方の後）で比べるかをルールごとに選ぶ。
   式は WaveLog と同じ list-formula.js（WL.formula）。eval は使わない。
   覚える場所はこの PC（localStorage `tpa.lotlist.rules.v1`）。
   ========================================================================= */
(function () {
  const { $, $$, esc } = TPA;
  const KEY = "tpa.lotlist.rules.v1", RECT = "tpa.lotlist.rulePanelRect.v1";
  const F = () => window.WL.formula;
  const SELF_KEY = "この列";

  /* ================= 置き場 ================= */
  let cache = null;
  function all() {
    if (!cache) cache = TPA.local.get(KEY, null) || {};
    return cache;
  }
  function write() { TPA.local.set(KEY, all()); }
  const names = () => Object.keys(all()).sort();
  const get = (name) => ((all()[name] || {}).rows) || [];
  const selfMode = (name) => ((all()[name] || {}).self === "shown" ? "shown" : "raw");
  function put(name, rows, opt) {
    if (rows && rows.length) all()[name] = { rows: TPA.clone(rows), self: (opt && opt.self) || "raw" };
    else delete all()[name];
  }

  /* ================= 判定（WaveLog displayRules と同じ） =================
     式を読み解いた結果は、ここに1つだけ覚える（計算列 lotlist-columns.js もこれを使う）。読めない式は null。 */
  const calcCache = new Map();
  function calcOf(src) {
    const k = String(src || "");
    if (calcCache.has(k)) return calcCache.get(k);
    let c = null;
    try { c = F().compile(k); } catch (_) { c = null; }
    if (calcCache.size > 200) calcCache.clear();
    calcCache.set(k, c);
    return c;
  }
  function runCalc(src, row) { const c = calcOf(src); if (!c) return null; const v = c.run(row); return v == null ? "" : v; }
  function operand(side, row, selfCol) {
    if (!side) return "";
    if (side.kind === "self") return row ? row[selfCol] : "";
    if (side.kind === "column") return row ? row[side.column] : "";
    if (side.kind === "calc") { const v = runCalc(side.expr, row); return v == null ? "" : v; }
    return side.value;
  }
  const compare = (a, b) => F().cmp(a, b);
  function test(cond, row, selfCol) {
    const L = operand(cond.left, row, selfCol), ls = String(L == null ? "" : L);
    if (cond.op === "empty") return ls.trim() === "";
    if (cond.op === "notEmpty") return ls.trim() !== "";
    if (cond.op === "formula") return !!(cond.left && cond.left.kind === "calc" && calcOf(cond.left.expr)) && F().truthy(L);
    const R = operand(cond.right, row, selfCol), rs = String(R == null ? "" : R);
    switch (cond.op) {
      case "eq": return ls === rs || compare(L, R) === 0;
      case "ne": return !(ls === rs || compare(L, R) === 0);
      case "contains": return rs !== "" && ls.includes(rs);
      case "startsWith": return rs !== "" && ls.startsWith(rs);
      case "endsWith": return rs !== "" && ls.endsWith(rs);
      case "gt": return compare(L, R) > 0;
      case "ge": return compare(L, R) >= 0;
      case "lt": return compare(L, R) < 0;
      case "le": return compare(L, R) <= 0;
      case "between": { const R2 = operand(cond.right2, row, selfCol); return compare(L, R) >= 0 && compare(L, R2) <= 0; }
      case "regex": try { return new RegExp(rs).test(ls); } catch (_) { return false; }
      default: return false;
    }
  }
  /* 行の中の条件を「または」で区切ったまとまり（それぞれの中は かつ）。先頭の条件の join は見ない */
  function orGroups(conds) {
    const out = [];
    (conds || []).forEach((c, i) => { if (i === 0 || c.join === "or") out.push([c]); else out[out.length - 1].push(c); });
    return out;
  }
  const isGroup = (it) => !!(it && Array.isArray(it.items));
  /* 条件とかっこの並びが当てはまるか（かっこは中を先に決める。空のかっこは当てはまる扱い＝画面では作らせない） */
  function holds(items, row, selfCol) {
    if (!items || !items.length) return true;
    return orGroups(items).some((g) => g.every((it) => (isGroup(it) ? holds(it.items, row, selfCol) : test(it, row, selfCol))));
  }
  /* 当たった行（色も使うので行ごと）。rows を渡せば下書きで判定する。 */
  function match(nameOrRows, row, selfCol) {
    const rows = Array.isArray(nameOrRows) ? nameOrRows : get(nameOrRows);
    for (const r of rows) {
      const conds = r.conditions || [];
      if (!conds.length || holds(conds, row, selfCol)) return r;
    }
    return null;
  }
  function textOf(hit, row) {
    const t = hit && hit.text;
    if (typeof t !== "string" || !t.startsWith("=")) return t;
    const v = runCalc(t.slice(1), row);
    return v == null ? "" : String(v);
  }
  /* ルールを同じ意味の式へ（行＝if の入れ子・条件＝and／or・既定＝最後の値）。WaveLog の toFormula と同じ。 */
  const NUM_LIT = /^-?(0|[1-9]\d*)(\.\d+)?$/;
  function lit(v, notes, asText) {
    const t = String(v == null ? "" : v);
    if (!asText && NUM_LIT.test(t)) return t;
    if (!t.includes("'")) return `'${t}'`;
    if (!t.includes('"')) return `"${t}"`;
    notes.add(`「${t}」は ' と " を両方含むので式にできません（' を外しました）`);
    return `'${t.replace(/'/g, "")}'`;
  }
  function toFormula(rows, opt) {
    const o = opt || {}, notes = new Set(), selfCol = String(o.column || ""), self = o.self || `[${selfCol}]`;
    const fixExpr = (e) => `(${String(e || "").split("[この列]").join(self)})`;
    const side = (sd, asText) => {
      if (!sd) return "''";
      if (sd.kind === "self") return self;
      if (sd.kind === "column") return `[${sd.column}]`;
      if (sd.kind === "calc") return fixExpr(sd.expr);
      return lit(sd.value, notes, asText);
    };
    const cond = (c) => {
      const L = side(c.left);
      switch (c.op) {
        case "formula": return L;
        case "empty": return `trim(${L}) = ''`;
        case "notEmpty": return `trim(${L}) <> ''`;
        case "eq": return `cmp(${L}, ${side(c.right, true)}) = 0`;
        case "ne": return `cmp(${L}, ${side(c.right, true)}) <> 0`;
        case "gt": return `cmp(${L}, ${side(c.right, true)}) > 0`;
        case "ge": return `cmp(${L}, ${side(c.right, true)}) >= 0`;
        case "lt": return `cmp(${L}, ${side(c.right, true)}) < 0`;
        case "le": return `cmp(${L}, ${side(c.right, true)}) <= 0`;
        case "between": return `(cmp(${L}, ${side(c.right, true)}) >= 0 and cmp(${L}, ${side(c.right2, true)}) <= 0)`;
        case "contains": case "startsWith": case "endsWith": case "regex": {
          const fn = { contains: "contains", startsWith: "startswith", endsWith: "endswith", regex: "match" }[c.op];
          const r = c.right || {};
          if (r.kind === "value") {
            const v = String(r.value == null ? "" : r.value);
            if (v === "" && c.op !== "regex") return "0";
            if (c.op === "regex") { try { new RegExp(v); } catch (_) { notes.add(`正規表現「${v}」は読めないので、この条件は「当たらない」にしました`); return "0"; } }
            return `${fn}(${L}, ${side(r, true)})`;
          }
          const R = side(r, true);
          return c.op === "regex" ? `${fn}(${L}, ${R})` : `(len(${R}) > 0 and ${fn}(${L}, ${R}))`;
        }
        default: notes.add(`知らない比べ方（${c.op}）は式にできません`); return "0";
      }
    };
    /* 並び → 式。または で区切ったまとまりを or、中を and、かっこは中を ( ) で包む */
    const logic = (items) => {
      const gs = orGroups(items).map((g) => g.map((it) => (isGroup(it) ? `(${it.items.length ? logic(it.items) : "1"})` : cond(it))).join(" and "));
      return gs.length > 1 ? gs.map((g) => `(${g})`).join(" or ") : gs[0];
    };
    const out = (r) => { const t = r && r.text; if (typeof t === "string" && t.startsWith("=")) return fixExpr(t.slice(1)); if (t === "" || t == null) return self; return lit(t, notes); };
    let tail = self; const body = [];
    for (const r of (rows || [])) {
      if (r.color) notes.add("色（●良い・悪い…）は式にできません。色が要るなら、式の列にも同じルールを付けてください");
      const cs = r.conditions || [];
      if (!cs.length) { tail = out(r); break; }
      body.push([logic(cs), out(r)]);
    }
    let expr = tail;
    for (let i = body.length - 1; i >= 0; i--) expr = `if(${body[i][0]}, ${body[i][1]}, ${expr})`;
    if (o.mode === "shown") notes.add("「表示の値」で見ているルールです。式は元のデータで比べます（作り方の式は元のデータから作るため）");
    return { expr, notes: [...notes] };
  }

  /* ================= 編集の窓（WaveLog list-rules.js と同じ並び） ================= */
  const OPS = [["eq", "＝ と等しい"], ["ne", "≠ と違う"], ["contains", "を含む"], ["startsWith", "で始まる"], ["endsWith", "で終わる"],
    ["empty", "が空欄"], ["notEmpty", "が空欄でない"], ["gt", "＞ より大きい"], ["ge", "≧ 以上"], ["lt", "＜ より小さい"], ["le", "≦ 以下"],
    ["between", "～ の範囲内"], ["regex", "正規表現に一致"], ["formula", "（式が真なら）"]];
  const NO_RIGHT = new Set(["empty", "notEmpty", "formula"]);
  const COLORS = [["", "色なし"], ["ok", "● 良い"], ["ng", "● 悪い"], ["warn", "● 注意"], ["muted", "● 目立たせない"]];
  const TRY_ROWS = 12;
  const blankCond = (join = "and") => ({ join, left: { kind: "self" }, op: "eq", right: { kind: "value", value: "" } });
  const blankRow = () => ({ conditions: [blankCond()], text: "", color: "" });
  const defaultRow = () => ({ conditions: [], text: "", color: "" });
  const isDefaultRow = (r) => !((r && r.conditions) || []).length;

  let panel = null, win = null, ruleName = "", draft = null, mode = "raw", selfColumn = "", src = null, onDone = null, toFormulaCb = null, hits = [];
  const srcColumns = () => (src && src.columns ? src.columns() : []);
  const labelOf = (c) => (src && src.labelOf ? src.labelOf(c) : c);
  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("section");
    panel.id = "llRulePanel"; panel.className = "ll-rulepanel"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "読み替えルール");
    panel.innerHTML = `
      <div class="lc-head" data-drag><div><small class="lc-eyebrow">読み替えルール</small><h3 id="lrTitle">表示ルール</h3>
        <small class="lr-usage" id="lrUsage"></small></div>
        <button type="button" class="lc-x" id="lrClose" title="閉じる（保存していない変更は捨てます）" aria-label="閉じる">×</button></div>
      <div class="lr-body">
        <aside class="lr-try" id="lrTry" aria-label="試した結果"></aside>
        <div class="lr-main">
          <div class="lr-head">
            <p class="lr-lead">上から順に見て、<b>最初に当てはまったもの</b>を表示します。行の中は「かつ」「または」でつなげ、「かつ」が先に結びます（A かつ B または C ＝（A かつ B）または C）。先に決めたい所は「＋ かっこ」か条件の「（ ）」でくくります（A かつ（B または C））。各行の「読み方」で確かめられます。</p>
            <div class="lr-mode" role="radiogroup" aria-label="条件が見る列の値"><span class="lr-mode-cap">列の値</span>
              <span class="lr-seg"><button type="button" data-mode="raw" role="radio">元のデータ</button><button type="button" data-mode="shown" role="radio">表示の値</button></span>
              <small class="lr-mode-note" id="lrModeNote"></small></div>
          </div>
          <div class="lr-rows" id="lrRows"></div>
          <div class="lr-adds">
            <button type="button" id="lrAddRow" class="lr-add">＋ 行を追加</button>
            <button type="button" id="lrAddDefault" class="lr-add">＋ どれにも当てはまらないとき</button>
            <button type="button" id="lrToFormula" class="lr-add" aria-expanded="false" title="このルールと同じ意味の式を作ります。「この列の作り方」の入力欄へそのまま入れられます">式にする</button>
          </div>
          <div class="lr-fx" id="lrFx" hidden></div>
        </div>
      </div>
      <div class="lc-foot"><button type="button" id="lrDelete" class="lr-delete">このルールを削除</button><span class="lc-sp"></span>
        <button type="button" id="lrCancel">やめる</button><button type="button" id="lrSave" class="lc-primary">保存</button></div>`;
    document.body.append(panel);
    $("#lrClose").onclick = close; $("#lrCancel").onclick = close; $("#lrSave").onclick = save; $("#lrDelete").onclick = remove;
    $("#lrAddRow").onclick = () => addRow(blankRow());
    $("#lrAddDefault").onclick = () => addRow(defaultRow());
    $$(".lr-mode [data-mode]", panel).forEach((b) => { b.onclick = () => { mode = b.dataset.mode; paintMode(); refreshCounts(); }; });
    $("#lrToFormula").onclick = () => { const box = $("#lrFx"); box.hidden = !box.hidden; $("#lrToFormula").setAttribute("aria-expanded", String(!box.hidden)); renderFx(); };
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close(); } });
    win = TPA.floatPanel(panel, { key: RECT, w: 1180, h: 760, top: 60 });   // 見出しで動かす・右下で大きさ。この PC に覚える
    return panel;
  }
  function addRow(row) {
    if (isDefaultRow(row) && draft.some(isDefaultRow)) { note("「どれにも当てはまらないとき」は1つだけです（2つ目は上のものに遮られて、決して使われません）"); return; }
    draft.push(row); render();
  }
  function note(t) { src && src.toast ? src.toast(t) : alert(t); }
  function calcWhy(expr) { if (!String(expr || "").trim()) return "式を入れてください"; const c = F().check(expr); return c.ok ? "" : c.error; }
  const exprOk = (which) => (which === "left" ? "使える式です（真なら当てはまる）" : "使える式です");
  function operandParts(side, which, path) {
    const kind = (side && side.kind) || (which === "left" ? "self" : "value");
    const at = `data-path="${path}" data-side="${which}"`;
    const kinds = which === "left" ? [["self", "この列"], ["column", "他の列"], ["calc", "式"]] : [["value", "固定値"], ["column", "他の列"], ["calc", "式"]];
    const kindSel = `<select class="lr-kind" ${at}>${kinds.map(([v, t]) => `<option value="${v}"${kind === v ? " selected" : ""}>${t}</option>`).join("")}</select>`;
    let detail;
    if (kind === "column") detail = `<select class="lr-col" ${at}>${srcColumns().map((c) => `<option value="${esc(c)}"${side && side.column === c ? " selected" : ""}>${esc(labelOf(c))}</option>`).join("")}</select>`;
    else if (kind === "value") detail = `<input type="text" class="lr-val" ${at} value="${esc((side && side.value) || "")}" placeholder="値" autocomplete="off">`;
    else if (kind === "calc") {
      const why = calcWhy(side && side.expr);
      detail = `<div class="lr-exprbox"><textarea class="lr-val lr-expr" ${at} rows="1" spellcheck="false" placeholder="${which === "left" ? "例: extract([この列],'[0-9]+') > 100 and [区分] <> 'X'" : "extract([この列],'[0-9]+')"}">${esc((side && side.expr) || "")}</textarea>`
        + `<small class="lr-expr-why${why ? " is-ng" : ""}">${esc(why || exprOk(which))}</small></div>`;
    } else detail = `<span class="lr-self">${esc(labelOf(selfColumn))}</span>`;
    return { kindSel, detail, kind };
  }
  /* ---- 条件とかっこ（場所は path＝"行.位置.位置…"。data-path で持つ） ---- */
  const PAREN_MAX = 3;                                   // かっこの入れ子は3段まで（読み取れる深さ）
  const depthOf = (path) => path.split(".").length - 2;  // 行のすぐ下＝0
  /* 前とのつなぎ。行の先頭は「もし」、かっこの中の先頭は空き（かっこの枠が始まりを示す） */
  function joinHtml(item, path, i, top) {
    if (i === 0) return top ? '<span class="lr-conj">もし</span>' : '<span class="lr-conj lr-conj-first" aria-hidden="true"></span>';
    const or = item.join === "or";
    return `<select class="lr-join${or ? " is-or" : ""}" data-path="${path}" aria-label="前とのつなぎ" title="かつ＝前と両方当てはまるとき／または＝ここから別のまとまり（どれかのまとまりが当てはまればよい）">`
      + `<option value="and"${or ? "" : " selected"}>かつ</option><option value="or"${or ? " selected" : ""}>または</option></select>`;
  }
  const addButtons = (path, depth) => `<button type="button" class="lr-cond-add" data-path="${path}" data-join="and" title="前と両方当てはまるときだけ、にします">＋ かつ</button>`
    + `<button type="button" class="lr-cond-add is-or" data-path="${path}" data-join="or" title="別のまとまりを足します。どれかのまとまりが当てはまればよい">＋ または</button>`
    + (depth < PAREN_MAX ? `<button type="button" class="lr-cond-add is-paren" data-path="${path}" data-join="and" title="かっこを足します。かっこの中を先に決めます（例: A かつ（B または C））">＋ かっこ</button>` : "");
  function itemsHtml(items, base, top) {
    return (items || []).map((it, i) => { const p = `${base}.${i}`; return isGroup(it) ? groupHtml(it, p, i, top) : condHtml(it, p, i, top); }).join("");
  }
  function groupHtml(g, path, i, top) {
    const d = depthOf(path), or = i > 0 && g.join === "or";
    return `<div class="lr-group depth-${d}${or ? " is-or" : ""}" data-path="${path}">
      <div class="lr-group-head">${joinHtml(g, path, i, top)}<span class="lr-paren" aria-hidden="true">（</span><span class="lr-group-cap">かっこ</span>
        <small class="lr-group-note">中を先に決めます</small><span class="lc-sp"></span>
        <button type="button" class="lr-unwrap" data-path="${path}" title="かっこだけを外します（中の条件は残ります）">かっこを外す</button>
        <button type="button" class="lr-cond-del" data-path="${path}" title="かっこを中の条件ごと消す" aria-label="かっこを中の条件ごと消す">×</button></div>
      <div class="lr-group-body">${itemsHtml(g.items, path, false)}</div>
      <div class="lr-group-foot">${addButtons(path, d + 1)}<span class="lc-sp"></span><span class="lr-paren" aria-hidden="true">）</span></div></div>`;
  }
  function condHtml(cond, path, i, top) {
    const L = operandParts(cond.left, "left", path), fx = cond.op === "formula" && L.kind === "calc";
    const right = NO_RIGHT.has(cond.op) ? "" : (() => {
      const R = operandParts(cond.right, "right", path), R2 = cond.op === "between" ? operandParts(cond.right2, "right2", path) : null;
      return `${R.kindSel}${R.detail}${R2 ? `<span class="lr-conj">〜</span>${R2.kindSel}${R2.detail}` : ""}`;
    })();
    const or = i > 0 && cond.join === "or";
    return `<div class="lr-cond${fx ? " is-fx" : ""}${or ? " is-or" : ""}">${joinHtml(cond, path, i, top)}${L.kindSel}${L.detail}`
      + (fx ? "" : `<select class="lr-op" data-path="${path}">${OPS.filter(([v]) => v !== "formula" || L.kind === "calc").map(([v, t]) => `<option value="${v}"${cond.op === v ? " selected" : ""}>${t}</option>`).join("")}</select><span class="lr-right">${right}</span>`)
      + (depthOf(path) < PAREN_MAX ? `<button type="button" class="lr-wrap" data-path="${path}" title="この条件をかっこでくくります（かっこの中に条件を足せます）" aria-label="かっこでくくる">（ ）</button>` : "")
      + `<button type="button" class="lr-cond-del" data-path="${path}" title="この条件を消す" aria-label="この条件を消す">×</button></div>`;
  }
  /* 読み方（ことばで1行）。明示のかっこは（ ）、かつ が先に結ぶ所は［ ］で示す（同じ段に かつ と または が混ざるときだけ） */
  const OP_READ = { eq: "＝", ne: "≠", gt: "＞", ge: "≧", lt: "＜", le: "≦", contains: "を含む", startsWith: "で始まる", endsWith: "で終わる",
    empty: "が空欄", notEmpty: "が空欄でない", between: "が範囲内", regex: "が正規表現に一致", formula: "" };
  function sideRead(sd) {
    if (!sd) return "";
    if (sd.kind === "self") return labelOf(selfColumn);
    if (sd.kind === "column") return labelOf(sd.column);
    if (sd.kind === "calc") return `式〔${String(sd.expr || "").slice(0, 24)}〕`;
    return `「${sd.value ?? ""}」`;
  }
  function condRead(c) {
    const L = sideRead(c.left), w = OP_READ[c.op] ?? c.op;
    if (c.op === "formula") return `${L} が真`;
    if (NO_RIGHT.has(c.op)) return `${L} ${w}`;
    if (c.op === "between") return `${L} が ${sideRead(c.right)}〜${sideRead(c.right2)}`;
    return /^[＝≠＞≧＜≦]$/.test(w) ? `${L} ${w} ${sideRead(c.right)}` : `${L} が ${sideRead(c.right)} ${w}`;
  }
  function readOf(items) {
    const gs = orGroups(items).map((g) => g.map((it) => (isGroup(it) ? `（${readOf(it.items)}）` : condRead(it))).join(" かつ "));
    const mixed = gs.length > 1 && orGroups(items).some((g) => g.length > 1);
    return gs.map((g, i) => (mixed && orGroups(items)[i].length > 1 ? `［${g}］` : g)).join(" または ");
  }
  function hitStat(ri) {
    if (draft.slice(0, ri).some(isDefaultRow)) return { dead: true, note: "この上に「どれにも当てはまらないとき」があるため、ここへは決して来ません" };
    const n = hits[ri];
    if (n == null) return { dead: false, note: "" };
    return n > 0 ? { dead: false, note: `試したデータのうち ${n}件がこの行になりました` } : { dead: false, note: "試したデータでは1件も当たりませんでした（データ側に無いだけかもしれません）" };
  }
  function rowHtml(row, ri) {
    const def = isDefaultRow(row), st = hitStat(ri);
    return `<div class="lr-row${def ? " lr-row-default" : ""}${st.dead ? " lr-row-dead" : ""}" data-row="${ri}">
      <div class="lr-row-rank"><span class="lr-rank-no">${ri + 1}</span>
        <button type="button" class="lr-up" data-row="${ri}" title="1つ上へ"${ri === 0 ? " disabled" : ""}>▲</button>
        <button type="button" class="lr-down" data-row="${ri}" title="1つ下へ"${ri === draft.length - 1 ? " disabled" : ""}>▼</button></div>
      <div class="lr-row-main"><div class="lr-row-conds">${def ? '<div class="lr-cond lr-cond-any"><span class="lr-conj">どれにも当てはまらないとき</span></div>' : itemsHtml(row.conditions, String(ri), true)}</div>
        ${def || !(row.conditions || []).length ? "" : `<div class="lr-read" data-row="${ri}" title="［ ］は「かつ」が先に結ぶ所、（ ）はかっこです"><b>読み方</b><span class="lr-read-text">${esc(readOf(row.conditions))}</span></div>`}
        <div class="lr-row-then"><span class="lr-conj">→ 表示</span>
          <input type="text" class="lr-text" data-row="${ri}" value="${esc(row.text || "")}" placeholder="元の値のまま（=で始めると式）" autocomplete="off" spellcheck="false" title="空欄なら元の値のまま。=で始めると式で作ります（例: =extract([この列],'[0-9]+') で数字の部分だけを出す）">
          <select class="lr-color" data-row="${ri}" aria-label="色">${COLORS.map(([v, t]) => `<option value="${v}"${(row.color || "") === v ? " selected" : ""}>${t}</option>`).join("")}</select>
          ${def ? "<span></span>" : addButtons(String(ri), 0)}
          <button type="button" class="lr-row-del" data-row="${ri}" title="この行を消す" aria-label="この行を消す">×</button></div>
        ${st.note ? `<div class="lr-row-stat${st.dead ? " is-dead" : ""}">${esc(st.note)}</div>` : ""}</div></div>`;
  }
  /* 実データの先頭 12 件を、この下書きのまま一覧のセルと同じ道で評価して数える（保存しないと試せない、にしない）。 */
  function recount() {
    const rows = (src && src.rows ? src.rows() : []).slice(0, TRY_ROWS);
    hits = draft.map(() => 0);
    return rows.map((r) => {
      const vr = src.ruleRow(r, selfColumn, mode);
      const hit = match(draft, vr, selfColumn), i = hit ? draft.indexOf(hit) : -1;
      if (i >= 0) hits[i]++;
      const out = src.cellWith(r, selfColumn, draft, mode);
      return { index: i, seen: vr[selfColumn], out };
    });
  }
  function render() {
    const box = $("#lrRows"); if (!box) return;
    const picked = recount();
    box.innerHTML = draft.map(rowHtml).join("") || '<p class="lc-empty">「＋ 行を追加」から作ります。</p>';
    bind(box); renderTry(picked); renderFx();
    $("#lrAddDefault").disabled = draft.some(isDefaultRow);
  }
  function grow(el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`; }
  /* path の場所: { list（入っている並び）, index, item } */
  function locate(path) {
    const p = path.split(".").map(Number);
    let list = draft[p[0]].conditions, item = null;
    for (let k = 1; k < p.length; k++) { item = list[p[k]]; if (k < p.length - 1) list = item.items; }
    return { list, index: p[p.length - 1], item };
  }
  /* 条件を足す先の並び（行そのもの か、かっこの中） */
  const listAt = (path) => (path.includes(".") ? locate(path).item.items : draft[+path].conditions);
  /* 中が空になったかっこを消す（消した結果また空になった外側も） */
  function prune(items) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (!isGroup(items[i])) continue;
      prune(items[i].items);
      if (!items[i].items.length) items.splice(i, 1);
    }
  }
  function bind(box) {
    const n = (el) => +el.dataset.row, condOf = (el) => locate(el.dataset.path).item;
    $$(".lr-kind", box).forEach((el) => { el.onchange = () => {
      const c = condOf(el), side = el.dataset.side, kind = el.value;
      c[side] = kind === "column" ? { kind: "column", column: srcColumns()[0] || "" } : kind === "value" ? { kind: "value", value: "" } : kind === "calc" ? { kind: "calc", expr: "" } : { kind: "self" };
      if (side === "left" && kind === "calc") { c.op = "formula"; delete c.right; delete c.right2; }
      else if (side === "left" && c.op === "formula") { c.op = "eq"; c.right = { kind: "value", value: "" }; }
      const at = `[data-path="${el.dataset.path}"][data-side="left"]`;
      render();
      if (side === "left" && kind === "calc") requestAnimationFrame(() => $(`#lrRows .lr-expr${at}`)?.focus());
    }; });
    $$(".lr-col", box).forEach((el) => { el.onchange = () => { condOf(el)[el.dataset.side].column = el.value; render(); }; });
    $$(".lr-val", box).forEach((el) => { el.oninput = () => {
      const sd = condOf(el)[el.dataset.side];
      if (el.classList.contains("lr-expr")) {
        sd.expr = el.value;
        const why = el.nextElementSibling, bad = calcWhy(sd.expr);
        why.textContent = bad || exprOk(el.dataset.side); why.classList.toggle("is-ng", !!bad);
        grow(el); refreshCounts(); return;
      }
      sd.value = el.value; refreshCounts();      // 入力中は組み直さない（カーソルが飛ぶ）
    }; });
    $$(".lr-expr", box).forEach((el) => { grow(el); F().suggest(el, { columns: srcColumns }); });
    $$(".lr-text", box).forEach((el) => { F().suggest(el, { columns: srcColumns }); el.oninput = () => { draft[n(el)].text = el.value; refreshCounts(); }; });
    $$(".lr-op", box).forEach((el) => { el.onchange = () => {
      const c = condOf(el); c.op = el.value;
      if (NO_RIGHT.has(c.op)) { delete c.right; delete c.right2; } else if (!c.right) c.right = { kind: "value", value: "" };
      if (c.op === "between" && !c.right2) c.right2 = { kind: "value", value: "" };
      if (c.op !== "between") delete c.right2;
      render();
    }; });
    $$(".lr-join", box).forEach((el) => { el.onchange = () => { condOf(el).join = el.value; render(); }; });
    // 消す（条件・かっこ）。中が空になったかっこも消す
    $$(".lr-cond-del", box).forEach((el) => { el.onclick = () => {
      const { list, index } = locate(el.dataset.path); list.splice(index, 1);
      prune(draft[+el.dataset.path.split(".")[0]].conditions); render();
    }; });
    // 足す（＋ かつ／＋ または／＋ かっこ）
    $$(".lr-cond-add", box).forEach((el) => { el.onclick = () => {
      const list = listAt(el.dataset.path), join = el.dataset.join;
      list.push(el.classList.contains("is-paren") ? { join, items: [blankCond("and")] } : blankCond(join));
      render();
    }; });
    // この条件をかっこでくくる（つなぎはかっこが引き継ぐ）
    $$(".lr-wrap", box).forEach((el) => { el.onclick = () => {
      const { list, index, item } = locate(el.dataset.path);
      list[index] = { join: item.join || "and", items: [Object.assign({}, item, { join: "and" })] };
      render();
    }; });
    // かっこを外す（中の先頭がかっこのつなぎを引き継ぐ）
    $$(".lr-unwrap", box).forEach((el) => { el.onclick = () => {
      const { list, index, item } = locate(el.dataset.path);
      const inner = item.items.map((x, k) => (k === 0 ? Object.assign({}, x, { join: item.join || "and" }) : x));
      list.splice(index, 1, ...inner); render();
    }; });
    $$(".lr-row-del", box).forEach((el) => { el.onclick = () => { draft.splice(n(el), 1); render(); }; });
    $$(".lr-up", box).forEach((el) => { el.onclick = () => move(n(el), -1); });
    $$(".lr-down", box).forEach((el) => { el.onclick = () => move(n(el), 1); });
    $$(".lr-color", box).forEach((el) => { el.onchange = () => { draft[n(el)].color = el.value; refreshCounts(); }; });
  }
  function move(ri, d) { const to = ri + d; if (to < 0 || to >= draft.length) return; const [r] = draft.splice(ri, 1); draft.splice(to, 0, r); render(); }
  function refreshCounts() {
    const picked = recount();
    $$("#lrRows .lr-read[data-row]").forEach((el) => { const r = draft[+el.dataset.row]; if (r) $(".lr-read-text", el).textContent = readOf(r.conditions || []); });
    draft.forEach((_, ri) => {
      const el = $(`#lrRows .lr-row[data-row="${ri}"]`); if (!el) return;
      const st = hitStat(ri); el.classList.toggle("lr-row-dead", !!st.dead);
      let nt = $(".lr-row-stat", el);
      if (!st.note) { nt?.remove(); return; }
      if (!nt) { nt = document.createElement("div"); nt.className = "lr-row-stat"; $(".lr-row-main", el).append(nt); }
      nt.textContent = st.note; nt.classList.toggle("is-dead", !!st.dead);
    });
    renderTry(picked); renderFx();
  }
  function renderTry(picked) {
    const list = picked || [], hit = list.filter((p) => p.index >= 0).length;
    $("#lrTry").innerHTML = `<div class="lr-try-head"><b>試した結果</b><small>${esc(labelOf(selfColumn))} の先頭${list.length}件・${mode === "shown" ? "表示の値" : "元のデータ"}で比べています</small>
      <span class="lr-try-sum"><i class="is-hit">当てはまった ${hit}件</i><i class="is-miss">当てはまらない ${list.length - hit}件</i></span></div>
      <ul class="lr-try-list">${list.map((p) => { const seen = String(p.seen ?? ""); return `<li class="${p.index >= 0 ? "is-hit" : "is-miss"}"><code title="条件が見た値">${esc(seen || "（空欄）")}</code><span aria-hidden="true">→</span>`
        + `<b class="${p.out && p.out.color ? "cell-" + p.out.color : ""}">${esc((p.out && p.out.text) || "（空欄）")}</b>${p.index >= 0 ? `<span class="lr-which">${p.index + 1}行目</span>` : '<span class="lr-nohit">当てはまらず</span>'}</li>`; }).join("") || "<li>データがありません</li>"}</ul>`;
  }
  function paintMode() {
    $$(".lr-mode [data-mode]", panel).forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle("is-on", on); b.setAttribute("aria-checked", String(on)); });
    $("#lrModeNote").textContent = mode === "shown" ? "この列も他の列も、作り方の式→値の整え方の後の値で比べます" : "この列も他の列も、処理する前のデータで比べます（式の列は式の結果）";
  }
  function renderFx() {
    const box = $("#lrFx"); if (!box || box.hidden) return;
    const r = toFormula(draft, { column: selfColumn, mode }), chk = F().check(r.expr);
    box.innerHTML = `<div class="lr-fx-head"><b>このルールと同じ意味の式</b><small>行＝if の入れ子（上から順）・条件＝and／or（and が先・かっこは中が先）・どれにも当てはまらないとき＝最後の値</small></div>
      <textarea class="lr-fx-out" readonly rows="3" spellcheck="false">${esc(r.expr)}</textarea>
      <div class="lr-fx-state ${chk.ok ? "is-ok" : "is-ng"}">${chk.ok ? `使える式です（${r.expr.length}字）` : esc(chk.error)}</div>
      ${r.notes.length ? `<ul class="lr-fx-notes">${r.notes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <div class="lr-fx-acts"><button type="button" id="lrFxCopy">コピー</button>${toFormulaCb ? `<button type="button" id="lrFxPut" class="lc-primary"${chk.ok ? "" : " disabled"}>「この列の作り方」へ入れる</button>` : ""}</div>`;
    grow($(".lr-fx-out", box));
    $("#lrFxCopy").onclick = async () => { try { await navigator.clipboard.writeText(r.expr); note("式をコピーしました"); } catch (_) { $(".lr-fx-out", box).select(); } };
    $("#lrFxPut")?.addEventListener("click", () => { toFormulaCb(r.expr); note("「この列の作り方」へ入れました（列の設定で「保存」すると一覧に効きます）"); });
  }
  function renderUsage() {
    const used = src && src.usage ? src.usage(ruleName) : null, el = $("#lrUsage");
    el.textContent = !used ? "" : !used.length ? "まだどの列でも使っていません" : `使っている列: ${used.slice(0, 4).join("、")}${used.length > 4 ? ` ほか${used.length - 4}件` : ""}（直すと全部に効きます）`;
  }
  function save() {
    put(ruleName, draft, { self: mode }); write();
    note(`表示ルール「${ruleName}」を保存しました（${draft.length}行）`);
    close(); if (onDone) onDone(ruleName);
  }
  function remove() {
    const used = src && src.usage ? src.usage(ruleName) : [];
    if (!confirm(`表示ルール「${ruleName}」を削除します。` + (used && used.length ? `\nいま ${used.length}件の列で使っています。消すと、その列は元の値のまま表示されます。` : "") + "\nよろしいですか？")) return;
    put(ruleName, null); write();
    close(); if (onDone) onDone("");
  }
  function close() { if (panel && !panel.hidden) { win.remember(); panel.hidden = true; } }
  /* 開く。name が空なら新規（名前を聞く）。source は列の設定の窓が渡す（列・行・この列の見え方）。 */
  function open(o) {
    src = o.source; selfColumn = String(o.column || ""); onDone = o.onDone || null; toFormulaCb = o.toFormula || null;
    ruleName = String(o.name || "").trim();
    if (!ruleName) {
      ruleName = (prompt("新しい表示ルール\n複数の列から使い回すための名前を付けます（例: 有無フラグ、合否）", "") || "").trim().slice(0, 60);
      if (!ruleName) return;
    }
    const saved = get(ruleName);
    draft = saved.length ? TPA.clone(saved) : [blankRow()];
    mode = selfMode(ruleName);
    ensurePanel(); win.place(); paintMode();
    $("#lrFx").hidden = true;
    $("#lrTitle").textContent = `表示ルール「${ruleName}」`;
    $("#lrDelete").hidden = !saved.length;
    panel.hidden = false;
    renderUsage(); render();
  }

  window.LotListRules = { names, selfMode, match, textOf, open, compile: calcOf, SELF_KEY,
    _toFormula: toFormula };   // 評価用
})();
