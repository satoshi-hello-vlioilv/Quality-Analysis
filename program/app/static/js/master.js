/* =========================================================================
   マスタ管理(設備マスタ / ロールマスタ)
   - 別ページに遷移せず、解析画面の上にオーバーレイで開く(SPA として一体化)。
   - 一覧は代表列のみ表示し、詳細な追加・修正はフォームダイアログに委ねる
     (Progressive Disclosure: 一度に見せる情報量を絞り、認知負荷を抑える)。
   - 保存/削除に成功したら解析画面を再計算し、マスタ変更を即座に反映する。
   - 置き場（手元のみ／共有）はサーバーの master_store が答える。共有のときは:
       ・開いている間は数秒ごとに版を見て、ほかの PC の変更を読み込む（読んだことを帯で言う）
       ・保存中の PC がいれば（409 locked）自動で待って保存し直す（錠は20秒で切れる）
       ・開いたあとに同じ行が変わった／消えた（409 conflict）ら、相手と自分の値を並べて選んでもらう
       ・共有に届かない（503）あいだは、追加・編集・削除を押せなくして理由を言う
   - 解析画面とは合図（イベント）だけでつながる（相手の変数・関数に触らない）:
       tpa:masters-changed … マスタが変わった（保存・削除・ほかの PC の変更を読んだ）→ 解析画面が計算し直す
       tpa:masters-closed  … 閉じた（検査計・自分の権限を直したかもしれない）→ 解析画面が引き直す
       tpa:settings-changed… 参照先を保存した → 解析画面・一覧が設定を取り直す
       tpa:error           … 解析画面のエラー欄に出してほしい失敗（detail は文言）
   ========================================================================= */
(function () {
"use strict";
const { $, esc: escapeHtml } = TPA;
const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
const fail = (message) => emit("tpa:error", message);

const MASTER_DEFS = {
  equipment: {
    name: "equipment_master",
    label: "設備マスタ", group: "データ",
    api: "/api/masters/equipment",
    idField: "設備名",
    searchPlaceholder: "設備名・同一工程の名前で検索",
    // kind: 値の見せ方（cellHtml）。w: 列の幅（中身に合わせる）。grow: 余りを受ける列
    listColumns: [
      { key: "設備名", label: "設備名", kind: "name", w: "9em" },
      { key: "巻取方向", label: "巻取方向", kind: "rewind", w: "8em" },
      { key: "ライン方向", label: "ライン方向", kind: "line", w: "8.5em" },
      { key: "検査計", label: "検査計", kind: "meter", w: "6em" },
      { key: "同一工程", label: "同一工程とみなす名前", kind: "aliases", grow: true },
    ],
    searchKeys: ["設備名", "巻取方向", "ライン方向", "同一工程", "検査計"],
    emptyLabel: "設備",
    formFields: [
      { key: "設備名", label: "設備名", type: "text", required: true, placeholder: "例: L-3", full: true },
      { key: "巻取方向", label: "巻取方向", type: "select", options: ["", "上", "下", "-"] },
      { key: "ライン方向", label: "ライン方向", type: "select", options: ["", "←", "→", "-"] },
      { key: "検査計", label: "検査計", type: "select", options: ["", "有"],
        hint: "「有」の設備が発見設備の候補です。取り込んだロットの実績の設備のうち、検査計がある最後の設備を発見設備に自動で選びます（手ではどの設備でも選べます）。" },
      { key: "同一工程", label: "同一工程とみなす名前（LotDsp で別の名前・番号付きで出てくるとき）", type: "text", full: true,
        placeholder: "例: ANI*, ANF*　／　CAI*, CAF*, CAL*",
        hint: "カンマ区切り。* は「どんな文字でも・無くてもよい」（ANI* → ANI・ANI1・ANI12）、? は「どれか1文字」。取込ではこの設備名に読み替えます。番号に意味がある設備（L-1・L-2 など）は登録しないでください。" },
    ],
  },
  rolls: {
    name: "roll_master",
    label: "ロールマスタ", group: "データ",
    api: "/api/masters/rolls",
    idField: "ロール名",
    searchPlaceholder: "設備・ロール名・基準番号・材質で検索",
    listColumns: [
      { key: "設備", label: "設備", kind: "name", w: "9.5em" },
      { key: "ロール名", label: "ロール名", grow: true },
      { key: "入出位置", label: "入出位置", kind: "chip", w: "6.5em" },
      { key: "接触面", label: "接触面", kind: "chip", w: "6.5em" },
      { key: "ロール径MAX", label: "径 MAX", num: true, unit: "mm", w: "7.5em" },
      { key: "ロール径MIN", label: "径 MIN", num: true, unit: "mm", w: "7.5em" },
      { key: "基準番号", label: "基準番号", w: "11em" },
    ],
    searchKeys: ["設備", "ロール名", "基準番号", "備考", "ロール使用条件", "材質"],
    emptyLabel: "ロール",
    formFields: [
      { key: "設備", label: "設備", type: "text", required: true, placeholder: "例: TLV" },
      { key: "ロール名", label: "ロール名", type: "text", placeholder: "例: 入側ピンチロール" },
      { key: "入出位置", label: "入出位置", type: "select", options: ["ー", "入側", "出側"] },
      { key: "接触面", label: "接触面", type: "select", options: ["", "上", "下", "上下"] },
      { key: "ロール径MAX", label: "ロール径MAX (mm)", type: "text", placeholder: "数値、または ― " },
      { key: "ロール径MIN", label: "ロール径MIN (mm)", type: "text" },
      { key: "ロール面長", label: "ロール面長 (mm)", type: "text" },
      { key: "材質", label: "材質", type: "text" },
      { key: "硬度", label: "硬度", type: "text" },
      { key: "本数", label: "本数", type: "text" },
      { key: "駆動方式", label: "駆動方式", type: "text" },
      { key: "基準番号", label: "基準番号", type: "text" },
      { key: "ロール使用条件", label: "使用条件", type: "text", full: true },
      { key: "備考", label: "備考", type: "textarea", full: true },
    ],
  },
};

/* 参照先（読みに行く場所）。表ではなくカードで出す特別なタブ（custom）。中身は /api/settings の items */
MASTER_DEFS.paths = { name: "path_settings", label: "参照先", group: "つなぎ先", api: "/api/settings", custom: true, admin: true };
/* アクセス権限（管理のマスタ）。判定はサーバー（services/access.py）の1箇所。画面は選択欄と印を出すだけ。 */
MASTER_DEFS.access = {
  name: "access_permissions", label: "アクセス権限", group: "管理", api: "/api/masters/access", idField: "ログインID", admin: true,
  parse: (d) => { mstate.meta.access = d; return d.items || []; },
  searchPlaceholder: "ログインID・PC名・権限区分で検索",
  listColumns: [
    { key: "ログインID", label: "ログインID", kind: "ident", w: "9em", anyText: "（だれでも）" },
    { key: "PC名", label: "PC名", kind: "ident", w: "9em", anyText: "（どの PC でも）" },
    { key: "権限区分", label: "権限区分", kind: "role", w: "8em" },
    { key: "マスタ編集", label: "マスタ編集", kind: "medit", w: "8em" },
    { key: "有効", label: "有効", kind: "enabled", w: "5em" },
    { key: "備考", label: "備考", grow: true },
  ],
  searchKeys: ["ログインID", "PC名", "権限区分", "マスタ編集", "備考"],
  emptyLabel: "権限",
  rowNote: (row) => (mstate.meta.access && row.id === mstate.meta.access.matchedId ? '<span class="m-chip c-me" title="この PC・このログインの権限を決めている行">あなた</span>' : ""),
  formFields: [
    { key: "ログインID", label: "ログインID（空＝だれでも）", type: "text", placeholder: "例: satoshi-harada" },
    { key: "PC名", label: "PC名（空＝どの PC でも）", type: "text", placeholder: "例: NLM-NGY-252134" },
    { key: "権限区分", label: "権限区分", type: "select", options: () => (mstate.meta.access || {}).roles || ["一般ユーザー"],
      hint: "開発者 > メンテナンス者 > 一般ユーザー > 設備作業者。自分の区分は自分では変えられず、自分と同格以上の区分は与えられません。" },
    { key: "マスタ編集", label: "マスタ編集", type: "select", options: () => (mstate.meta.access || {}).masterEditLevels || ["編集可"],
      hint: "非表示＝マスタ管理を出さない／閲覧のみ／部分的編集可＝設備・ロールだけ書ける／編集可＝参照先・アクセス権限も書ける。区分の上限を超えては与えられません（設備作業者は非表示まで）。" },
    { key: "有効", label: "有効", type: "select", options: ["有", "無"] },
    { key: "備考", label: "備考", type: "text", full: true },
  ],
};
/* 利用状況（だれが・どの PC で・どの版を）。見られる区分だけにタブを出す。 */
MASTER_DEFS.presence = { name: "presence", label: "利用状況", group: "管理", api: "/api/presence", custom: true, render: () => renderPresence(),
  visible: (me) => !!me.canViewPresence };
/* アプリの配布（版 3.4.0・WaveLog と同じ流れ）: ① 版を置く → ② 配る版を選ぶ → ③ 各 PC がそろう。
   答えるのは窓（desktop/src/distribute.rs）。置く・配るは開発者・メンテナンス者だけ（決めるのは services/access.py）。 */
MASTER_DEFS.release = { name: "release", label: "アプリの配布", group: "管理", api: "/__desktop/release", custom: true, render: () => renderRelease() };

const mstate = {
  tab: "equipment",
  data: { equipment: null, rolls: null, paths: null, access: null, presence: null, release: null },
  meta: {},           // タブごとの付き物（アクセス権限の選択欄・自分の行 など）
  me: null,           // /api/access/me（この PC・このログインの権限）
  loadedRev: { equipment: null, rolls: null, paths: null },   // 一覧を読んだときのマスタの版
  place: null,        // /api/masters/status の答え
  search: "",
  editing: null,      // 右の詳細に出している行 { tab, id(追加なら null), baseRev, orig } | null(=何も出していない)
  selId: null,        // 右に出す行（一覧を描き直しても同じ行を出す）。追加の前に選んでいた行は prevSel
  deleteTarget: null, // { tab, id, rev }
  pollTimer: null,
};
const MASTER_POLL_MS = 5000;
const LOCK_WAIT_LIMIT_MS = 30000;   // 錠（既定20秒）が切れるまで粘る長さ
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const whoText = (w) => [w && w.pc, w && w.login].filter(Boolean).join("／") || "ほかの PC";
const hhmm = (iso) => (iso ? String(iso).slice(11, 16) : "");
const stamp = (iso) => String(iso || "").replace("T", " ").slice(0, 16);   // 2026-09-29 10:15
/* 保存中の PC を待っている間の文言（what: 保存・削除）。d は 409 locked の答え */
const lockWaitText = (d, what, name = (w) => w) =>
  `${name(whoText({ pc: d.holder_pc, login: d.holder_login }))} が保存中です。終わりしだい自動で${what}します（あと約${d.remaining}秒）…`;
const boldName = (w) => `<b>${escapeHtml(w)}</b>`;   // HTML の文言では相手の名前を太字に

/* サーバーへ。成否に関わらず {ok, status, data} で返す（画面が理由を読んで次の手を決める）。 */
async function masterRequest(url, opts) {
  try {
    const r = await fetch(url, opts);
    let data = {};
    try { data = await r.json(); } catch (_) { /* 本文なし */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: "アプリに届きません: " + e.message, kind: "network" } };
  }
}
/* 保存中の PC がいれば（409 locked）、錠が切れるまで待って送り直す。待っている間は onWait で言う。 */
async function withLockWait(send, onWait) {
  const until = Date.now() + LOCK_WAIT_LIMIT_MS;
  for (;;) {
    const res = await send();
    if (!(res.status === 409 && res.data.kind === "locked") || Date.now() > until) return res;
    onWait(res.data);
    await sleep(Math.min(2000, Math.max(500, (res.data.remaining || 1) * 1000)));
  }
}

/* ---------------- 開閉 ---------------- */
/* この PC・このログインで、そのタブのマスタへ書けるか（判定はサーバー。ここは答えを読むだけ）。 */
function canWrite(tab) {
  const me = mstate.me;
  if (!me) return true;
  if (me.revoked) return false;
  return MASTER_DEFS[tab].admin ? !!me.canEditAdminMaster : !!me.canEditFieldMaster;
}
function readOnlyWhy(tab) {
  const me = mstate.me || {};
  if (me.revoked) return "この PC は一時的に切断されています";
  return `権限「${me.role || "-"}」・マスタ編集「${me.masterEdit || "-"}」`;
}
const tabVisible = (k) => !MASTER_DEFS[k].visible || MASTER_DEFS[k].visible(mstate.me || {});
async function openMaster() {
  $("#masterOverlay").classList.remove("hidden");
  mstate.editing = null;   // 前に開いたときの詳細は、読み直した内容で出し直す
  try { mstate.me = await (await fetch("/api/access/me")).json(); } catch (_) { mstate.me = null; }
  if (!tabVisible(mstate.tab)) mstate.tab = "equipment";
  buildMasterTabs();
  await refreshPlace();
  await ensureTabLoaded(mstate.tab);
  renderMasterTable();
  // ほかの一覧のタブも裏で読んで件数を出す（開く前にどれだけあるか分かる）
  Promise.all(Object.keys(MASTER_DEFS).filter((k) => !MASTER_DEFS[k].custom && k !== mstate.tab && tabVisible(k)).map(ensureTabLoaded))
    .then(buildMasterTabs, () => {});
  clearInterval(mstate.pollTimer);
  mstate.pollTimer = setInterval(refreshPlace, MASTER_POLL_MS);
}
function closeMaster() {
  if (!leaveOk()) return;
  emit("tpa:masters-closed");   // 設備マスタ（検査計など）を直したかもしれない → 画面が引き直す
  $("#masterOverlay").classList.add("hidden");
  clearInterval(mstate.pollTimer);
  mstate.pollTimer = null;
  clearInterval(mstate.presenceTimer);
}

/* ---------------- 置き場の帯（どこの・いつのマスタか）と、ほかの PC の変更の取り込み ---------------- */
const shareDown = () => !!(mstate.place && mstate.place.mode === "shared" && !mstate.place.reachable);
async function refreshPlace() {
  const res = await masterRequest("/api/masters/status");
  if (!res.ok) return;
  mstate.place = res.data;
  const news = [];
  for (const tab of Object.keys(MASTER_DEFS)) {
    const m = res.data.masters[MASTER_DEFS[tab].name];
    const known = mstate.loadedRev[tab];
    if (!m || known == null || m.revision === known || !mstate.data[tab]) continue;
    // 読んだあとに版が進んだ＝ほかの PC（か自分の別の画面）が保存した
    if (MASTER_DEFS[tab].custom && settingsDirty()) {
      settingsNotice(`この間に <b>${escapeHtml(whoText(m.updated_by))}</b> が参照先を更新しました（${hhmm(m.updated_at)}）。保存するときに、直している項目が変わっていないかを確かめます。`);
      continue;
    }
    if (mstate.editing && mstate.editing.tab === tab && formDirty()) {
      showFormNotice("wait", `この間に <b>${escapeHtml(whoText(m.updated_by))}</b> が${MASTER_DEFS[tab].label}を更新しました（${hhmm(m.updated_at)}）。
        保存するときに、開いている行が変わっていないかを確かめます。`);
      continue;
    }
    mstate.data[tab] = null;
    if (mstate.editing && mstate.editing.tab === tab) mstate.editing = null;   // 直していない詳細は、読み込んだ新しい内容で出し直す
    await ensureTabLoaded(tab);
    if (tab === mstate.tab) renderMasterTable();
    news.push(`${MASTER_DEFS[tab].label}: ${whoText(m.updated_by)} の変更を読み込みました（${hhmm(m.updated_at)}）`);
    afterMasterChange();
  }
  paintPlace(news);
}
function paintPlace(news) {
  const p = mstate.place, el = $("#masterPlace");
  if (!p || !el) return;
  const cur = p.masters[MASTER_DEFS[mstate.tab].name] || {};
  let html;
  if (p.mode !== "shared") {
    html = `<span class="place-tag local">手元のみ</span><span class="place-meta">この PC のアプリの data/ に保存します（ほかの PC とは共有しません）</span>`;
  } else if (!p.reachable) {
    html = `<span class="place-tag off">共有に届きません</span><span class="place-dir">${escapeHtml(p.dir)}</span>
      <span class="place-meta">前に取り込んだ写しを表示中・届くまで保存できません</span>
      <button type="button" class="place-btn" id="masterPlaceRetry">もう一度つなぐ</button>`;
  } else {
    const by = cur.updated_by && (cur.updated_by.pc || cur.updated_by.login)
      ? `・最終更新 ${escapeHtml(whoText(cur.updated_by))} ${hhmm(cur.updated_at)}` : "";
    html = `<span class="place-tag shared">共有</span><span class="place-dir">${escapeHtml(p.dir)}</span>
      <span class="place-meta">版 ${cur.revision ?? "-"}${by}</span>`;
  }
  if (news && news.length) html += `<span class="place-news">${news.map(escapeHtml).join(" ／ ")}</span>`;
  el.innerHTML = html;
  const retry = $("#masterPlaceRetry");
  if (retry) retry.onclick = refreshPlace;
  const down = shareDown(), ro = !canWrite(mstate.tab);
  $("#masterAddBtn").disabled = down;
  $("#masterAddBtn").classList.toggle("hidden", ro);
  $("#masterAddBtn").title = down ? "共有フォルダに届かないため、いまは保存できません" : "";
  // 書けないときは「閲覧のみ」の札（理由つき）。行は押せば中身を見られる（保存はできない）
  const roTag = $("#masterRO");
  roTag.classList.toggle("hidden", !ro);
  roTag.textContent = "閲覧のみ";
  roTag.title = `${readOnlyWhy(mstate.tab)}のため、このマスタは書き換えられません`;
  paintDetailButtons();
}

/* ---------------- タブ ---------------- */
function buildMasterTabs() {
  const tabs = $("#masterTabs");
  let group = "";
  tabs.innerHTML = Object.keys(MASTER_DEFS).filter(tabVisible).map((k) => {
    const def = MASTER_DEFS[k];
    const rows = mstate.data[k];
    const count = rows && !def.custom ? `<span class="tab-count">${rows.length}</span>` : "";
    const head = def.group !== group ? `<span class="mg-lab">${(group = def.group)}</span>` : "";
    return `${head}<button class="tab${k === mstate.tab ? " active" : ""}" data-tab="${k}" role="tab" aria-selected="${k === mstate.tab}">${def.label}${count}</button>`;
  }).join("");
  tabs.querySelectorAll(".tab").forEach((b) => b.onclick = () => {
    if (b.dataset.tab === mstate.tab || !leaveOk()) return;
    mstate.tab = b.dataset.tab;
    mstate.editing = null; mstate.selId = null;   // 行の番号はマスタごとなので、移ったら先頭から
    mstate.search = "";
    $("#masterSearch").value = "";
    buildMasterTabs();
    ensureTabLoaded(mstate.tab).then(renderMasterTable);
  });
}

async function ensureTabLoaded(tab) {
  if (mstate.data[tab]) return;
  const def = MASTER_DEFS[tab];
  const r = await fetch(def.api);
  const d = await r.json();
  mstate.data[tab] = def.parse ? def.parse(d) : d;
  const m = mstate.place && mstate.place.masters[def.name];
  mstate.loadedRev[tab] = m ? m.revision : null;
  buildMasterTabs();
}
async function reloadTab(tab) {
  await refreshPlace();
  mstate.data[tab] = null;
  await ensureTabLoaded(tab);
  if (tab === mstate.tab) renderMasterTable();
}

/* ---------------- 一覧表示 ---------------- */
function filteredRows(tab) {
  const def = MASTER_DEFS[tab];
  const rows = mstate.data[tab] || [];
  const q = mstate.search.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => def.searchKeys.some((k) => String(r[k] || "").toLowerCase().includes(q)));
}

/* ---------------- 参照先（カード） ---------------- */
function settingsDirty() {
  return [...document.querySelectorAll("#masterSettings .ps-card input")].some((i) => i.value !== (i.dataset.saved || ""));
}
function settingsNotice(html) {
  const n = $("#psNotice"); if (!n) return;
  n.innerHTML = html; n.classList.remove("hidden");
}
function fmtDefault(v) { return v === null || v === undefined || v === "" ? "（空）" : String(v); }
function renderSettings() {
  const d = mstate.data.paths, box = $("#masterSettings");
  if (!d) { box.innerHTML = '<p class="ps-loading">読み込み中…</p>'; return; }
  const down = shareDown();
  const where = d.shared
    ? `ここで直すと <b>共有フォルダのマスタ</b>に保存され、<b>全員の PC にすぐ効きます</b>（アプリを起動し直さなくてよい）。`
    : `マスタの共有フォルダが決まっていないため、<b>この PC だけ</b>に保存します。`;
  box.innerHTML = `<p class="ps-lead">${where} 空にして保存すると、配った設定（既定）に戻ります。</p>
    <div class="ps-notice hidden" id="psNotice"></div>`
    + d.items.map((it) => {
      const changed = it.source === "master";
      const by = changed && it.updated_by ? `${escapeHtml(whoText(it.updated_by))} ${stamp(it.updated_at)}` : "";
      return `<section class="ps-card${changed ? " is-changed" : ""}" data-key="${escapeHtml(it.key)}" data-rev="${it.rev ?? 0}"${it.check_url ? ` data-check="${escapeHtml(it.check_url)}"` : ""}>
        <div class="ps-head"><b>${escapeHtml(it.label)}</b>
          <span class="ps-badge ${changed ? "changed" : "default"}">${changed ? `マスタで変更（${by}）` : "既定（配った設定）"}</span></div>
        <p class="ps-hint">${escapeHtml(it.hint)}</p>
        <div class="ps-row">
          <input type="text" class="ps-input" value="${escapeHtml(it.value ?? "")}" data-saved="${escapeHtml(it.value ?? "")}"
                 placeholder="既定: ${escapeHtml(fmtDefault(it.default))}" spellcheck="false" aria-label="${escapeHtml(it.label)}">
          <button type="button" class="ps-check" title="保存する前に、その値で本当に読めるかを確かめます">確かめる</button>
          <button type="button" class="btn-primary ps-save"${down ? ' disabled title="共有フォルダに届かないため、いまは保存できません"' : !canWrite("paths") ? ` disabled title="${escapeHtml(readOnlyWhy("paths"))}のため保存できません"` : ""}>保存</button>
          <button type="button" class="ps-reset"${changed && !down && canWrite("paths") ? "" : " disabled"} title="マスタの値を消して、配った設定（既定）に戻します">既定に戻す</button>
        </div>
        <div class="ps-now">いま効いている値: <code>${escapeHtml(fmtDefault(it.effective))}</code></div>
        <div class="ps-result hidden" aria-live="polite"></div>
      </section>`;
    }).join("")
    + `<section class="ps-card is-readonly"><div class="ps-head"><b>マスタの共有フォルダ</b><span class="ps-badge default">この画面では変えません</span></div>
        <p class="ps-hint">マスタ（設備・ロール・この参照先）そのものの置き場です。ここで変えるとこの画面自体が別の場所を見てしまうため、設定ファイルで変えます:
          <code>${escapeHtml(d.config_file)}</code> の <code>master_share.dir</code> を直して、アプリを起動し直してください。</p>
        <div class="ps-now">いまの置き場: <code>${escapeHtml(d.share_dir || "（なし＝この PC の中だけ）")}</code></div></section>`
    + `<section class="ps-card is-readonly"><div class="ps-head"><b>調査の道具（LotDsp の項目）</b><span class="ps-badge default">読むだけ・何も書き換えない</span></div>
        <p class="ps-hint">LotDsp の API の応答に入っている項目の一覧と、それが LotDsp の画面のどの見出しかの紐づけを調べます（値は出しません）。
          開いた画面の「← アプリへ戻る」でここへ戻ります。</p>
        <div class="ps-row"><a class="btn-ghost ps-tool" href="/lotdsp-link">LotDsp の項目を調べる</a></div></section>`;
  box.querySelectorAll(".ps-card[data-key]").forEach(bindSettingCard);
}
function bindSettingCard(card) {
  const key = card.dataset.key, input = card.querySelector(".ps-input"), out = card.querySelector(".ps-result");
  const say = (kind, html) => { out.className = "ps-result " + kind; out.innerHTML = html; };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") card.querySelector(".ps-save").click(); });
  // 保存は、直したカードだけ主の色（黄）にする。並んだカードのどれを保存すればよいかが色で分かる
  input.addEventListener("input", () => card.querySelector(".ps-save").classList.toggle("is-dirty", input.value !== (input.dataset.saved || "")));
  card.querySelector(".ps-check").onclick = async () => {
    say("wait", "確かめています…");
    // 確かめる先は項目が決める（更新の置き場は、探す本人のデスクトップ版: /__desktop/update/probe）
    const r = await masterRequest(card.dataset.check || "/api/settings/check", TPA.json("POST", { key, value: input.value }));
    const d = r.status === 404 ? { ok: false, message: "デスクトップ版で開いたときだけ確かめられます。" } : (r.data || {});
    say(d.ok ? "ok" : "ng", `${d.ok ? "✓" : "✕"} ${escapeHtml(d.message || d.error || "確かめられませんでした")}`);
  };
  const send = async (value, baseRev) => {
    say("wait", "保存しています…");
    const res = await withLockWait(
      () => masterRequest(`/api/settings/${encodeURIComponent(key)}`, TPA.json("PUT", { value, base_rev: baseRev })),
      (d) => say("wait", lockWaitText(d, "保存", boldName)));
    if (res.status === 409 && res.data.kind === "conflict") {
      const cur = res.data.current;
      const theirs = cur ? `「${escapeHtml(cur["値"])}」（${escapeHtml(whoText(cur.updated_by))} ${stamp(cur.updated_at)}）` : "既定に戻されています";
      say("ng", `開いたあとに、ほかの PC がこの項目を変更しました。相手の値: ${theirs}
        <div class="ps-acts"><button type="button" class="ps-theirs">相手の値を読み込む</button><button type="button" class="ps-mine">自分の値で上書きする</button></div>`);
      out.querySelector(".ps-theirs").onclick = () => reloadTab("paths");
      out.querySelector(".ps-mine").onclick = () => send(value, cur ? cur.rev : 0);
      return;
    }
    if (!res.ok) { say("ng", "✕ " + escapeHtml(res.data.error || "保存できませんでした")); return; }
    await reloadTab("paths");
    const again = document.querySelector(`#masterSettings .ps-card[data-key="${CSS.escape(key)}"] .ps-result`);
    if (again) { again.className = "ps-result ok"; again.innerHTML = value === "" ? "✓ 既定に戻しました。すぐ効きます。" : "✓ 保存しました。すぐ効きます（ほかの PC にも数秒で届きます）。"; }
    emit("tpa:settings-changed", { key });
  };
  card.querySelector(".ps-save").onclick = () => send(input.value, +card.dataset.rev || 0);
  card.querySelector(".ps-reset").onclick = () => {
    if (confirm("この項目を配った設定（既定）に戻します。全員の PC に効きます。よろしいですか？")) send("", +card.dataset.rev || 0);
  };
}
/* ほかの画面から「参照先」を開く（異常ロット一覧で元ファイルが読めない・古いとき） */
async function openMasterAt(tab) {
  mstate.tab = tab;
  await openMaster();
}
window.openMasterAt = openMasterAt;

function renderMasterTable() {
  const def = MASTER_DEFS[mstate.tab], custom = !!def.custom;
  document.querySelector("#masterOverlay .master-toolbar").classList.toggle("hidden", custom);
  document.querySelector("#masterOverlay .master-table-wrap").classList.toggle("hidden", custom);
  $("#masterDetail").classList.toggle("hidden", custom);
  $("#masterSettings").classList.toggle("hidden", !custom);
  clearInterval(mstate.presenceTimer);
  if (custom) { (def.render || renderSettings)(); return; }
  const rows = filteredRows(mstate.tab);
  $("#masterSearch").placeholder = def.searchPlaceholder || "検索";
  const widths = columnWidths(def, mstate.data[mstate.tab] || []);
  $("#masterHead").innerHTML = "<tr>" + def.listColumns.map((c, i) =>
    `<th class="${c.num ? "num" : ""}${c.grow ? " grow" : ""}"${widths[i] ? ` style="width:${widths[i]}px"` : ""}>${c.label}${c.unit ? `<small>${c.unit}</small>` : ""}</th>`).join("") + "</tr>";
  // 行のどこを押しても（Enter でも）右の詳細がその行になる。削除は右の詳細の「削除」か Delete キー（押し間違いを減らす）
  $("#masterBody").innerHTML = rows.map((row) => {
    const tds = def.listColumns.map((c, i) => `<td class="${c.num ? "num" : ""}${c.grow ? " grow" : ""}">${cellHtml(c, row[c.key])}${i === 0 && def.rowNote ? def.rowNote(row) : ""}</td>`).join("");
    return `<tr data-id="${row.id}" tabindex="0" aria-selected="false">${tds}</tr>`;
  }).join("");
  $("#masterEmpty").classList.toggle("hidden", rows.length > 0);
  const all = mstate.data[mstate.tab];
  $("#masterCount").textContent = all ? (rows.length === all.length ? `${all.length} 件` : `${rows.length} / ${all.length} 件`) : "";

  paintPlace();
  const rowOf = (id) => (mstate.data[mstate.tab] || []).find((r) => r.id === Number(id));
  $("#masterBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = () => { if (Number(tr.dataset.id) !== mstate.selId && leaveOk()) openForm(mstate.tab, rowOf(tr.dataset.id), { focus: false }); };
    tr.onkeydown = (e) => {
      if (e.target !== tr) return;
      if (e.key === "Enter") { e.preventDefault(); if (Number(tr.dataset.id) === mstate.selId || leaveOk()) openForm(mstate.tab, rowOf(tr.dataset.id)); }
      else if (e.key === "Delete" && !shareDown() && canWrite(mstate.tab)) { e.preventDefault(); openDeleteConfirm(mstate.tab, rowOf(tr.dataset.id)); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
        if (next) { next.focus(); next.click(); }   // 矢印で行を移ると、右もその行になる（直している途中なら確かめる）
      }
    };
  });
  // 右の詳細: 直している途中（追加の途中も）はそのまま。そうでなければ選んでいた行（無ければ先頭）を出す
  const ed = mstate.editing;
  const keep = ed && ed.tab === mstate.tab && (ed.id == null || rowOf(ed.id));
  if (!keep) {
    const pick = rows.find((r) => r.id === mstate.selId) || rows[0];
    if (pick) openForm(mstate.tab, pick, { focus: false }); else showDetailEmpty();
  }
  markSelected();
}
/** 一覧で、右に出している行に印（藍の帯）を付ける */
function markSelected() {
  $("#masterBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    const on = mstate.editing && mstate.editing.id != null && Number(tr.dataset.id) === mstate.editing.id;
    tr.classList.toggle("is-sel", !!on); tr.setAttribute("aria-selected", !!on);
  });
}
/* 列の幅: 見出しと（絞り込む前の）全部の値のうちいちばん長いものを、実際の文字の幅で測って決める
   （幅を決め打ちすると、長い設備名が入ったときに切れる）。grow の列は余りを受けるので測らない。c.w は最小の幅。 */
function columnWidths(def, rows) {
  const family = getComputedStyle(document.body).fontFamily;
  const px = parseFloat(getComputedStyle(document.body).fontSize) || 14;
  const text = (t, weight, size) => TPA.textWidth(t, `${weight} ${size}px ${family}`);
  const em = (w) => (w ? parseFloat(w) * 14 : 0);
  return def.listColumns.map((c) => {
    if (c.grow) return 0;
    const head = text(c.label + (c.unit ? ` ${c.unit}` : ""), 700, 12.5);
    const chipPad = ["rewind", "line", "meter", "chip", "role", "medit", "enabled"].includes(c.kind) ? 20 : 0;
    const shown = (v) => (c.kind === "rewind" ? (REWIND[v] || [v])[0] : c.kind === "line" ? (LINE[v] || [v])[0]
      : c.kind === "enabled" ? "有効" : v);
    // 空の欄に出す文言（「（どの PC でも）」など）も測る。「あなた」の印が付く最初の列はその分も見込む
    const vals = rows.map((r) => String(r[c.key] ?? "").trim() || c.anyText || "").filter(Boolean);
    const extra = def.rowNote && def.listColumns[0] === c ? 52 : 0;
    const body = vals.reduce((m, v) => Math.max(m, text(shown(v), c.kind === "name" || chipPad ? 700 : 400, chipPad ? 12.5 : px) + chipPad), 0);
    return Math.ceil(Math.max(head, body + extra, em(c.w) - 28) + 28 + 2);   // 28 = 左右の余白
  });
}
/* ---------------- 利用状況（WaveLog の接続状況を移したもの） ----------------
   だれが・どの PC で・どの版を使っているか。最新版は「使っている人たち（開発者を除く）の版のうちいちばん新しいもの」。
   切断（一時的にマスタへ書けなくする）・切断を解く・使わなくなった PC の記録を消す。できるかはサーバーの答え（can）。
   開いているあいだは 10 秒ごとに読み直す。 */
mstate.presenceFilter = "all";
mstate.presenceView = "status";          // status: PC ごとの状況 / history: 使用の履歴
mstate.historyKey = "";                  // 使用の履歴を 1 台に絞るとき（PC ごとの状況の行の「履歴」から）
mstate.historyLimit = 300;
function ago(iso) {
  if (!iso) return "-";
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 90) return "いま";
  if (sec < 3600) return `${Math.round(sec / 60)} 分前`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 時間前`;
  return String(iso).slice(0, 10).replaceAll("-", "/");
}
const hours = (sec) => (sec >= 3600 ? `${(sec / 3600).toFixed(1)} 時間` : `${Math.round((sec || 0) / 60)} 分`);
/* 利用状況のタブの中の切り替え（PC ごとの状況・使用の履歴）。いま見ている方を濃くする */
function presenceViews(active) {
  return `<div class="pz-views" role="tablist" aria-label="利用状況の見方">${[["status", "PC ごとの状況"], ["history", "使用の履歴"]].map(([k, t]) =>
    `<button class="pz-view${k === active ? " on" : ""}" role="tab" aria-selected="${k === active}" data-view="${k}">${t}</button>`).join("")}</div>`;
}
function bindPresenceViews(box) {
  box.querySelectorAll(".pz-view").forEach((b) => { b.onclick = () => { mstate.presenceView = b.dataset.view; mstate.historyKey = ""; renderPresence(); }; });
}
function renderPresence() {
  clearInterval(mstate.presenceTimer);
  return mstate.presenceView === "history" ? renderHistory() : renderPresenceStatus();
}
async function renderPresenceStatus() {
  const box = $("#masterSettings");
  const res = await masterRequest("/api/presence");
  if (!res.ok) { box.innerHTML = `<p class="ps-loading">${escapeHtml(res.data.error || "利用状況を読めませんでした。")}</p>`; return; }
  const d = res.data, fl = d.fleet, can = d.can || {};
  mstate.data.presence = d;
  const f = mstate.presenceFilter;
  const items = fl.items.filter((x) => f === "all" || (f === "online" && x.online) || (f === "outdated" && x.outdated));
  const verState = (x) => !x.counted ? chip("対象外", "c-plain", "開発者の PC は試しの版を使うので最新版に数えません")
    : x.outdated ? chip("要更新", "c-warn", `最新版は ${fl.latest}`) : chip("最新", "c-meter");
  const acts = (x) => {
    const b = [];
    if (x.revoked) b.push(`<button class="pz-btn" data-pz="allow" data-key="${escapeHtml(x.key)}">切断を解く</button>`);
    else if (x.online && x.key !== d.me && (x.role === "開発者" ? can.canDisconnectDeveloper : can.canDisconnect))
      b.push(`<button class="pz-btn danger" data-pz="cut" data-key="${escapeHtml(x.key)}">切断</button>`);
    if (!x.online && can.canForget) b.push(`<button class="pz-btn" data-pz="forget" data-key="${escapeHtml(x.key)}">記録を消す</button>`);
    b.unshift(`<button class="pz-btn" data-hist="${escapeHtml(x.key)}" title="この PC・ログインID の使用の履歴（いつ・どの版で・何分）">履歴</button>`);
    return b.join("");
  };
  box.innerHTML = presenceViews("status") + `
    <div class="pz-summary">
      <div class="pz-kpi"><span>最新版</span><b>${escapeHtml(fl.latest || "-")}</b></div>
      <div class="pz-kpi"><span>いま使っている</span><b>${fl.online}</b><i>台</i></div>
      <div class="pz-kpi${fl.outdated ? " warn" : ""}"><span>要更新</span><b>${fl.outdated}</b><i>台</i></div>
      <div class="pz-kpi"><span>記録</span><b>${fl.total}</b><i>台</i></div>
      <p class="pz-where">${d.shared ? "共有フォルダ" : "この PC の中だけ（共有フォルダが決まっていません）"}: <code>${escapeHtml(d.dir)}</code>・
        最新版は、使っている人たち（開発者を除く）の版のうちいちばん新しいもの。${d.readable ? "" : "<b>記録を読めませんでした。</b>"}</p>
    </div>
    <div class="pz-filter" role="tablist">${[["all", "すべて"], ["online", "いま使っている"], ["outdated", "要更新だけ"]].map(([k, t]) =>
      `<button class="pz-f${k === f ? " on" : ""}" data-f="${k}">${t}</button>`).join("")}</div>
    <div class="master-table-wrap pz-wrap"><table class="master-table pz-table">
      <thead><tr><th>状態</th><th>PC名</th><th>ログインID</th><th>権限区分</th><th>版</th><th>最後</th><th>回数・時間</th><th class="grow"></th></tr></thead>
      <tbody>${items.map((x) => `<tr class="${x.key === d.me ? "is-me" : ""}">
        <td>${x.revoked ? chip("切断中", "c-off", `${x.revoked.by} が切断・あと約 ${Math.ceil(x.revoked.remainingSec / 60)} 分`) : x.online ? chip("● 使用中", "c-on") : '<span class="m-none">使っていない</span>'}</td>
        <td><b class="m-name">${escapeHtml(x.pc || "-")}</b>${x.key === d.me ? '<span class="m-chip c-me">あなた</span>' : ""}</td>
        <td><span class="m-ident">${escapeHtml(x.login || "-")}</span></td>
        <td>${cellHtml({ kind: "role" }, x.role)}</td>
        <td><span class="pz-ver">${escapeHtml(x.version || "-")}</span> ${verState(x)}</td>
        <td title="${escapeHtml(x.lastAt || "")}">${ago(x.lastAt)}</td>
        <td>${x.sessions || 0} 回・${hours(x.totalSec)}</td>
        <td class="pz-acts">${acts(x)}</td></tr>`).join("")}</tbody></table>
      ${items.length ? "" : '<div class="master-empty">該当する PC はありません。</div>'}</div>`;
  box.querySelectorAll(".pz-f").forEach((b) => { b.onclick = () => { mstate.presenceFilter = b.dataset.f; renderPresence(); }; });
  box.querySelectorAll(".pz-btn[data-pz]").forEach((b) => { b.onclick = () => presenceAct(b.dataset.pz, b.dataset.key, b); });
  box.querySelectorAll(".pz-btn[data-hist]").forEach((b) => { b.onclick = () => { mstate.presenceView = "history"; mstate.historyKey = b.dataset.hist; mstate.historyLimit = 300; renderPresence(); }; });
  bindPresenceViews(box);
  clearInterval(mstate.presenceTimer);
  mstate.presenceTimer = setInterval(() => { if (mstate.tab === "presence" && mstate.presenceView === "status" && !$("#masterOverlay").classList.contains("hidden")) renderPresence(); }, 10000);
}

/* ---------------- 使用の履歴（起動ごと: いつ・だれ・どの PC・どの版・何分） ----------------
   新しい順。同じ日は日付を薄くして、日の区切りを目で追えるようにする。版が前の使い始めから変わった行には「更新」の札。
   下に保存期間（残す日数）と「古い記録を今すぐ整理」（記録を消せる区分だけ）。 */
const PZ_WEEK = "日月火水木金土";
const pzDay = (iso) => { const d = new Date(iso); return isNaN(d) ? "-" : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}（${PZ_WEEK[d.getDay()]}）`; };
const pzTime = (iso) => { const d = new Date(iso); return isNaN(d) ? "-" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
async function renderHistory() {
  const box = $("#masterSettings");
  const q = new URLSearchParams({ limit: mstate.historyLimit });
  if (mstate.historyKey) q.set("key", mstate.historyKey);
  const res = await masterRequest("/api/presence/sessions?" + q);
  if (!res.ok) { box.innerHTML = presenceViews("history") + `<p class="ps-loading">${escapeHtml(res.data.error || "使用の履歴を読めませんでした。")}</p>`; bindPresenceViews(box); return; }
  const d = res.data, can = d.can || {}, items = d.items || [];
  const who = items[0] && mstate.historyKey ? `${items[0].pc} ／ ${items[0].login}` : mstate.historyKey;
  let lastDay = "";
  const rows = items.map((x) => {
    const day = pzDay(x.start), same = day === lastDay;
    lastDay = day;
    const ver = `<span class="pz-ver">${escapeHtml(x.version || "-")}</span>`
      + (x.changedFrom ? chip(`更新 ${x.changedFrom} →`, "c-meter", `前の使い始めは ${x.changedFrom}。この使い始めから ${x.version}`) : "");
    return `<tr><td class="${same ? "pz-same" : ""}">${day}</td>
      <td class="pz-time">${pzTime(x.start)}〜${x.live ? chip("● 使用中", "c-on") : pzTime(x.end)}</td>
      <td class="num">${hours(x.sec || 0)}</td>
      <td><b class="m-name">${escapeHtml(x.pc || "-")}</b></td><td><span class="m-ident">${escapeHtml(x.login || "-")}</span></td>
      <td>${x.role ? cellHtml({ kind: "role" }, x.role) : '<span class="m-none">-</span>'}</td><td>${ver}</td></tr>`;
  }).join("");
  const [lo, hi] = d.range || [30, 3650];
  box.innerHTML = presenceViews("history") + `
    <div class="pz-hhead">${mstate.historyKey
      ? `<span class="pz-only">${escapeHtml(who)} の履歴だけ</span><button class="pz-btn" id="pzAll">すべての PC に戻す</button>`
      : "<span>すべての PC の使い始め（新しい順）</span>"}</div>
    <div class="master-table-wrap pz-wrap"><table class="master-table pz-table pz-history">
      <thead><tr><th>日付</th><th>時刻</th><th class="num">使った時間</th><th>PC名</th><th>ログインID</th><th>権限区分</th><th class="grow">版</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${items.length ? "" : '<div class="master-empty">まだ使用の履歴がありません（版 3.3.0 から記録します）。</div>'}</div>
    ${d.more ? '<div class="pz-more"><button class="pz-btn" id="pzMore">さらに表示</button></div>' : ""}
    <section class="ps-card pz-keep"><div class="ps-head"><b>保存期間</b></div>
      <p class="ps-hint">使用の履歴は <b>${d.historyDays} 日</b>残します。それより古い記録は、各 PC が使い始めるときに自分の分を自動で消します。
        使わなくなった PC の古い記録は「古い記録を今すぐ整理」で消せます。</p>
      ${can.canForget ? `<div class="ps-row"><label class="pz-days">残す日数 <input type="number" id="pzDays" min="${lo}" max="${hi}" value="${d.historyDays}"> 日</label>
        <button class="btn-primary ps-save" id="pzDaysSave">保存</button>
        <button class="pz-btn danger" id="pzPrune">古い記録を今すぐ整理</button></div>
        <div class="ps-result hidden" id="pzKeepMsg" aria-live="polite"></div>`
        : '<p class="ps-hint">残す日数を変える・整理するのは、メンテナンス者以上です。</p>'}
    </section>`;
  bindPresenceViews(box);
  const all = $("#pzAll"); if (all) all.onclick = () => { mstate.historyKey = ""; renderPresence(); };
  const more = $("#pzMore"); if (more) more.onclick = () => { mstate.historyLimit += 300; renderPresence(); };
  const say = (cls, t) => { const m = $("#pzKeepMsg"); m.className = `ps-result ${cls}`; m.textContent = t; };
  const save = $("#pzDaysSave");
  if (save) save.onclick = async () => {
    const r = await masterRequest("/api/presence/retention", TPA.json("POST", { days: $("#pzDays").value }));
    if (!r.ok) { say("ng", "✕ " + (r.data.error || "保存できませんでした。")); return; }
    await renderPresence();
    say("ok", `✓ 使用の履歴を ${r.data.historyDays} 日残すようにしました（全員の PC に効きます）。`);
  };
  const prune = $("#pzPrune");
  if (prune) prune.onclick = async () => {
    if (!confirm(`${d.historyDays} 日より古い使用の履歴を、すべての PC の分まとめて消します。よろしいですか？`)) return;
    const r = await masterRequest("/api/presence/prune", TPA.json("POST", {}));
    if (!r.ok) { say("ng", "✕ " + (r.data.error || "整理できませんでした。")); return; }
    await renderPresence();
    say("ok", `✓ ${r.data.files} ファイル（${r.data.sessions} 回分）を消しました。`);
  };
}
/* ---------------- アプリの配布（① 版を置く → ② 配る版を選ぶ → ③ 各 PC がそろう） ----------------
   並びは作業の順（左→右・上→下）。判定は窓（distribute.rs）と Python（権限）で、ここは答えを並べるだけ。
   置いている間は進み具合を出す（共有へ十数 MB を写す。反応が無いと止まったように見える）。 */
const MB = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} MB`;
const RELEASE_STAGE = { send: "ZIP を送っています", check: "ZIP の中身を確かめています（このアプリの物か・版・exe・同梱の Python）",
  copy: "置き場へ写しています", finish: "写した物を確かめて仕上げています" };
mstate.releaseBusy = null;      // 置いている最中 { name, size, p }
async function renderRelease() {
  const box = $("#masterSettings");
  let d;
  try {
    const r = await fetch("/__desktop/release", { cache: "no-store" });
    if (!r.ok) throw new Error();
    d = await r.json();
  } catch (_) {
    box.innerHTML = '<p class="ps-loading">アプリの配布は、デスクトップ版の窓の中でだけ使えます。</p>';
    return;
  }
  mstate.data.release = d;
  const me = d.me || {};
  const placeBtn = me.canRelease && !mstate.releaseBusy
    ? '<button type="button" class="pz-btn dz-place-btn" id="dzPlaceBtn" aria-expanded="false" aria-controls="dzPlaceBox" title="配布の置き場の場所・フォルダの名前を変えます（置いてある版を写して、全員の PC の参照先を切り替えます）">置き場を変える…</button>' : "";
  if (!d.reachable) {
    box.innerHTML = `<div class="dz-bad"><b>更新の置き場に届きません。</b>${escapeHtml(d.why || "")}<br>
      「参照先」タブの「更新の置き場」を確かめてください（BOX の同期・権限も）。各 PC は届かないあいだ、いまの版のまま開きます。
      ${placeBtn ? `<div class="dz-bad-acts">${placeBtn}<small>置き場の場所・名前を変えたときは、ここから新しい置き場へ切り替えられます。</small></div>` : ""}</div>
      <div class="dz-place" id="dzPlaceBox" hidden></div>`;
    bindReleasePlace(d);
    return;
  }
  const dist = d.distributed, cur = dist && dist.version, prev = dist && dist.previous;
  const step3 = !cur ? "配る版が決まるまでは、置き場のいちばん新しい版を取り込みます（版 3.3.0 までと同じ）"
    : me.current === cur ? `この PC は配る版（<b>${escapeHtml(cur)}</b>）で動いています`
      : `この PC は開き直すと <b>${escapeHtml(me.current)} → ${escapeHtml(cur)}</b> になります`;
  const flow = `<ol class="dz-flow" aria-label="配布の流れ">
    <li class="dz-step"><b>① 版を置く</b><span>${d.versions.length} 版を置いてあります</span><small>GitHub Releases の ZIP を選ぶ</small></li>
    <li class="dz-arrow" aria-hidden="true"></li>
    <li class="dz-step${cur ? " is-set" : ""}"><b>② 配る版を選ぶ</b><span>${cur ? `配る版 <b>${escapeHtml(cur)}</b>` : "まだ決めていません"}</span>
      <small>${cur ? escapeHtml(`${dist.setAt || ""} ${dist.setBy || ""}`.trim()) + (prev ? `・前は ${escapeHtml(prev)}` : "") : "一覧の「この版を配る」で決める"}</small></li>
    <li class="dz-arrow" aria-hidden="true"></li>
    <li class="dz-step${cur && me.current !== cur ? " is-pending" : ""}"><b>③ 各 PC がそろう</b><span>${step3}</span>
      <small>起動したとき・30 分ごとに確かめ、取り込んでから開き直したときにそろいます（データ・設定は触りません）</small></li></ol>`;
  const entry = d.entry && d.entry.exists
    ? `<div class="dz-new"><b>新しい PC へ</b><span>このアドレスを渡し、ダブルクリックしてもらいます（ZIP の展開は要りません）:
        <code>${escapeHtml(d.entry.path)}</code><button type="button" class="pz-btn" id="dzCopy">アドレスをコピー</button>
        <small>配る版がその PC の作業場所へ写って開き、「この PC に入れる」でショートカットを作れます。BOX の見え方が人で違っても、その人に見えるアドレスで構いません。</small></span></div>`
    : `<div class="dz-new"><b>新しい PC へ</b><span>配る版を決めると、置き場に配る入口（exe）を置き、ここに渡すアドレスが出ます。</span></div>`;
  const busy = mstate.releaseBusy;
  const put = busy ? `<div class="dz-progress" id="dzProgress"><div class="dz-ptitle"></div><div class="dz-bar"><i></i></div><div class="dz-pmeta"></div>
      <small>置き終わるまでお待ちください。途中で閉じても、置きかけの版は配られません。</small></div>`
    : me.canRelease ? `<label class="btn-primary dz-pick"><input type="file" accept=".zip,application/zip" id="dzZip" hidden>ZIP から版を置く…</label>
      <small>置くだけでは配りません（試してから「この版を配る」）。同じ版はもう一度置けません。置き場: <code>${escapeHtml(d.folder)}</code></small>`
      : `<small>版を置く・配る版を決めるのは、開発者・メンテナンス者だけです（この PC は「${escapeHtml(me.role || "-")}」）。</small>`;
  const rows = d.versions.map((v) => {
    const tags = [v.version === cur ? chip("配っている", "c-on") : "", v.version === prev ? chip("前に配った", "c-plain") : "",
      v.version === me.current ? chip("この PC", "c-me") : ""].join("");
    const act = me.canRelease && !busy && v.version !== cur
      ? `<button type="button" class="pz-btn${cur && cmpVer(v.version, cur) < 0 ? "" : " dz-go"}" data-dist="${escapeHtml(v.version)}">${cur && cmpVer(v.version, cur) < 0 ? "この版に戻す" : "この版を配る"}</button>` : "";
    return `<tr class="${v.version === cur ? "is-live" : ""}"><td><b class="pz-ver">${escapeHtml(v.version)}</b></td><td>${tags}</td>
      <td>${escapeHtml(stamp(v.placedAt) || "-")} ${escapeHtml([v.placedPc, v.placedBy].filter(Boolean).join("／"))}</td>
      <td><span class="m-ident">${escapeHtml(v.source || v.zip || "-")}</span></td><td class="num">${MB(v.bytes)}</td><td class="pz-acts">${act}</td></tr>`;
  }).join("");
  box.innerHTML = `<p class="dz-where">置き場 <code>${escapeHtml(d.found)}</code>${d.adjusted ? "（この PC での BOX の見え方に合わせて探しました）" : ""} ${chip("届いています", "c-on")} ${placeBtn}</p>
    <div class="dz-place" id="dzPlaceBox" hidden></div>
    ${flow}${entry}<div class="dz-put">${put}</div>
    <div class="master-table-wrap pz-wrap"><table class="master-table pz-table">
      <thead><tr><th>版</th><th>状態</th><th>置いた日時・PC／人</th><th>元の ZIP</th><th class="num">大きさ</th><th class="grow"></th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${d.versions.length ? "" : '<div class="master-empty">まだ版を置いていません。上の「ZIP から版を置く…」で置いてください。</div>'}</div>
    ${(d.problems || []).length ? `<p class="ps-hint">読めない物: ${d.problems.map(escapeHtml).join("<br>")}</p>` : ""}`;
  const zip = $("#dzZip"); if (zip) zip.onchange = () => { placeRelease(zip.files && zip.files[0]); zip.value = ""; };
  const copy = $("#dzCopy"); if (copy) copy.onclick = () => navigator.clipboard.writeText(d.entry.path).then(() => { copy.textContent = "コピーしました"; });
  box.querySelectorAll("[data-dist]").forEach((b) => { b.onclick = () => distributeRelease(b.dataset.dist, d); });
  bindReleasePlace(d);
  paintReleaseProgress();
}
/* ---------------- 配布の置き場を変える（場所・フォルダの名前） ----------------
   ① 上のフォルダと名前を入れる（いまの置き場から始める）。打つたびにサーバーが確かめ、写す量・切り替えるだけか・使えない理由を出す。
   ② 変える: いまの置き場を新しい場所の隣の一時フォルダへ写し、写し終えてから名前を付ける（services/release_place.py）
      → 参照先「更新の置き場」（update.source）を新しい場所に書き換える（全員の PC に効く・行の版と書き込みの門番が効く）。
   前の置き場は消さない（ほかの PC が持っている前の入口のアドレス・戻すときのため）。 */
const splitPath = (p) => {
  const s = String(p || "").trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i < 0 ? ["", s] : [s.slice(0, i) || s.slice(0, i + 1), s.slice(i + 1)];
};
function bindReleasePlace(d) {
  const btn = $("#dzPlaceBtn"), box = $("#dzPlaceBox");
  if (!btn || !box) return;
  btn.onclick = () => {
    if (box.hidden) openReleasePlace(d); else box.hidden = true;
    btn.setAttribute("aria-expanded", String(!box.hidden));
  };
}
function openReleasePlace(d) {
  const box = $("#dzPlaceBox"), cur = d.found || String(d.folder || "").split(";")[0] || "";
  const [parent, name] = splitPath(cur), sep = cur.includes("/") && !cur.includes("\\") ? "/" : "\\";
  const canCopy = !!(d.reachable && d.found);
  box.hidden = false;
  box.innerHTML = `<div class="dz-pl-head"><b>配布の置き場を変える</b><small>置く場所（上のフォルダ）とフォルダの名前を決めます。いまの置き場から始めているので、変えたい所だけ直してください。</small></div>
    <div class="dz-pl-grid">
      <label class="dz-pl-f">置く場所（上のフォルダ）<input id="dzPlParent" class="ps-input" value="${escapeHtml(parent)}" spellcheck="false" autocomplete="off"></label>
      <span class="dz-pl-sep" aria-hidden="true">${escapeHtml(sep)}</span>
      <label class="dz-pl-f">フォルダの名前<input id="dzPlName" class="ps-input" value="${escapeHtml(name)}" spellcheck="false" autocomplete="off" maxlength="120"></label>
    </div>
    <p class="dz-pl-new">新しい置き場 <code id="dzPlDest"></code></p>
    <div class="dz-tree" id="dzPlTree" aria-label="変えたあとのフォルダの形"></div>
    <label class="dz-pl-copy"><input type="checkbox" id="dzPlCopy"${canCopy ? " checked" : " disabled"}>
      置いてある版・配る版・配る入口を、そのまま新しい置き場へ写す<small>${canCopy ? "前の置き場は消さずに残します（あとで要らなければ手で消せます）" : "いまの置き場に届かないので写せません（切り替えるだけになります）"}</small></label>
    <div class="dz-pl-state" id="dzPlState" aria-live="polite"></div>
    <div class="dz-pl-acts"><button type="button" class="btn-primary" id="dzPlGo" disabled>この置き場に変える</button><button type="button" class="pz-btn" id="dzPlCancel">やめる</button></div>`;
  const say = (cls, html) => { const s = $("#dzPlState"); s.className = `dz-pl-state ${cls}`; s.innerHTML = html; };
  const args = () => ({ from: canCopy ? d.found : "", parent: $("#dzPlParent").value, name: $("#dzPlName").value, copy: $("#dzPlCopy").checked });
  let seq = 0, timer = null, last = null;
  const check = async () => {
    const a = args(), my = ++seq;
    $("#dzPlDest").textContent = `${a.parent.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "")}${sep}${a.name.trim()}`;
    say("wait", "確かめています…");
    const r = await masterRequest("/api/release/place/check", TPA.json("POST", a));
    if (my !== seq) return;               // 打ち続けているあいだの古い答えは捨てる
    last = r.data || {};
    $("#dzPlTree").innerHTML = placeTree(d, a, last, sep);
    const go = $("#dzPlGo");
    go.disabled = !last.ok;
    go.textContent = last.mode === "copy" ? "写して、この置き場に変える" : "この置き場に切り替える";
    if (!last.ok) say("ng", "✕ " + escapeHtml(last.problem || last.error || "変えられません。"));
    else say("ok", "✓ " + escapeHtml(last.note || "") + (last.mode === "copy" ? `<small>写す量 ${last.files} ファイル・${MB(last.bytes)}</small>` : ""));
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(check, 350); };
  $("#dzPlParent").addEventListener("input", later);
  $("#dzPlName").addEventListener("input", later);
  $("#dzPlCopy").addEventListener("change", check);
  $("#dzPlCancel").onclick = () => { box.hidden = true; $("#dzPlaceBtn")?.setAttribute("aria-expanded", "false"); };
  $("#dzPlGo").onclick = () => { if (last && last.ok) moveReleasePlace(d, args(), last, say); };
  check();
  requestAnimationFrame(() => $("#dzPlName").focus());
}
/* 変えたあとのフォルダの形（木）。いまの置き場は灰（残す）、新しい置き場は藍（写す／切り替えるだけ／空のまま）、中身は置いてある版。
   上のフォルダが同じなら1本の木、違えば2本並べる。使えないときは新しい置き場を赤で示す。 */
function placeTree(d, a, pl, sep) {
  const clean = (x) => String(x || "").trim().replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
  const [curParent, curName] = splitPath(d.found || ""), newParent = clean(a.parent), newName = String(a.name || "").trim() || "（名前）";
  const same = curParent && curParent.toLowerCase() === newParent.toLowerCase();
  const dist = d.distributed && d.distributed.version;
  const vers = (d.versions || []).map((v) => `<li>📁 ${escapeHtml(v.version)}${v.version === dist ? '<em class="dz-t-dist">配る版</em>' : ""}</li>`).join("");
  const inside = `<ul>${vers}<li>📄 配る版の覚え・配る入口（exe）</li></ul>`;
  const mode = !pl.ok ? ["is-ng", "使えません"] : pl.mode === "copy" ? ["is-copy", "← いまの置き場を写す"] : pl.mode === "switch" ? ["is-switch", "← 既に置き場（写さずに切り替える）"] : ["is-empty", "← 空のまま切り替える"];
  const oldLi = d.found ? `<li class="dz-t-old">📁 ${escapeHtml(curName)}<em>いまの置き場・消さずに残す</em></li>` : "";
  const newLi = `<li class="dz-t-new ${mode[0]}">📁 <b>${escapeHtml(newName)}</b><em>${mode[1]}</em>${pl.ok && pl.mode !== "empty" ? inside : ""}</li>`;
  const root = (path, items) => `<ul class="dz-t-root"><li>📁 ${escapeHtml(path || "（場所）")}<ul>${items}</ul></li></ul>`;
  return same ? root(newParent, oldLi + newLi) : (d.found ? root(curParent, oldLi) : "") + root(newParent, newLi);
}
async function moveReleasePlace(d, a, pl, say) {
  const what = pl.mode === "copy" ? `いまの置き場（${d.found}）を写して、新しい置き場（${pl.dest}）に変えます。\n写すもの: ${pl.files} ファイル・${MB(pl.bytes)}（前の置き場は消さずに残します）`
    : `新しい置き場（${pl.dest}）に切り替えます。` + (pl.mode === "empty" ? "\n新しい置き場に版を置いて配るまで、各 PC はいまの版のまま開きます。" : "");
  if (!confirm(`${what}\n\n参照先の「更新の置き場」を書き換えるので、全員の PC が次に確かめたとき（起動・30 分ごと）から新しい置き場を見ます。`
    + "新しい PC へ渡す入口のアドレスも変わります。よろしいですか？")) return;
  const go = $("#dzPlGo"); go.disabled = true;
  const r = await masterRequest("/api/release/place/move", TPA.json("POST", a));
  if (!r.ok) { say("ng", "✕ " + escapeHtml(r.data.error || "変えられませんでした。")); go.disabled = false; return; }
  if (r.data.started) {
    for (;;) {                           // 写し終えるまで進み具合を出す（共有・BOX へ数十〜数百 MB）
      await new Promise((res) => setTimeout(res, 400));
      const p = (await masterRequest("/api/release/place/progress")).data || {};
      if (p.state === "failed") { say("ng", "✕ " + escapeHtml(p.error || "写せませんでした。") + "<small>写しかけの物は片付けました。前の置き場はそのままです。</small>"); go.disabled = false; return; }
      if (p.state !== "running") break;
      const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
      say("wait", `写しています… ${p.files || 0} / ${p.totalFiles || 0} ファイル・${MB(p.done)} / ${MB(p.total)}（経過 ${Math.round(p.elapsed || 0)} 秒）`
        + `<div class="dz-bar"><i style="width:${pct.toFixed(0)}%"></i></div>`);
    }
  }
  say("wait", "参照先「更新の置き場」を書き換えています…");
  const st = await masterRequest("/api/settings", { cache: "no-store" });
  const item = ((st.data || {}).items || []).find((x) => x.key === "update.source") || {};
  const res = await withLockWait(
    () => masterRequest("/api/settings/update.source", TPA.json("PUT", { value: r.data.dest, base_rev: item.rev || 0 })),
    (dd) => say("wait", lockWaitText(dd, "保存", boldName)));
  if (!res.ok) {
    say("ng", `✕ ${r.data.started ? "写し終えましたが、" : ""}参照先を書き換えられませんでした: ${escapeHtml(res.data.error || "")}<br>`
      + `「参照先」タブの「更新の置き場」に <code>${escapeHtml(r.data.dest)}</code> を入れて保存してください。`);
    return;
  }
  emit("tpa:settings-changed", { key: "update.source" });
  await renderRelease();
  releaseNotice("ok", `✓ 配布の置き場を ${r.data.dest} に変えました。全員の PC が次に確かめたときから、新しい置き場を見ます。`
    + "\n新しい PC へ渡すアドレスも変わりました（下の「アドレスをコピー」で写し直してください）。"
    + (r.data.started ? `\n前の置き場（${d.found}）は残しています。要らなければ、全員がそろったあとで手で消してください。` : ""));
}
const cmpVer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function paintReleaseProgress() {
  const root = $("#dzProgress"), b = mstate.releaseBusy;
  if (!root || !b) return;
  const p = b.p || {}, stage = p.state === "running" ? p.stage || "check" : "send";
  const pct = stage === "copy" && p.total ? (p.done / p.total) * 100 : stage === "finish" ? 100 : null;
  root.querySelector(".dz-ptitle").textContent = RELEASE_STAGE[stage];
  root.querySelector(".dz-bar").classList.toggle("is-indet", pct === null);
  root.querySelector(".dz-bar i").style.width = pct === null ? "" : `${pct.toFixed(0)}%`;
  root.querySelector(".dz-pmeta").textContent = `${b.name}（${MB(b.size)}）`
    + (stage === "copy" && p.total ? `・${MB(p.done)} / ${MB(p.total)}` : "") + (p.elapsed != null ? `・経過 ${Math.round(p.elapsed)} 秒` : "");
}
async function placeRelease(file) {
  if (!file || mstate.releaseBusy) return;
  mstate.releaseBusy = { name: file.name, size: file.size, p: {} };
  await renderRelease();
  const poll = setInterval(async () => {
    try { mstate.releaseBusy.p = await (await fetch("/__desktop/release/progress", { cache: "no-store" })).json(); paintReleaseProgress(); } catch (_) { /* 次の問い合わせで */ }
  }, 400);
  let msg;
  try {
    // 本文は読み終えたバイト列で送る（ファイルのまま渡すと、WebView によっては本文を読む所で落ちる: Linux の WebKitGTK で確かめた）
    const body = await file.arrayBuffer();
    const r = await fetch("/__desktop/release/place?name=" + encodeURIComponent(file.name), { method: "POST", headers: { "Content-Type": "application/zip" }, body });
    const j = await r.json().catch(() => ({ error: `置けませんでした（${r.status}）` }));
    if (!r.ok) throw new Error(j.error || `置けませんでした（${r.status}）`);
    msg = ["ok", `✓ 版 ${j.version} を置きました（${MB(j.bytes)}）。試してから、一覧の「この版を配る」を押してください。`];
  } catch (e) {
    msg = ["ng", "✕ " + e.message];
  } finally {
    clearInterval(poll);
    mstate.releaseBusy = null;
  }
  await renderRelease();
  releaseNotice(...msg);
}
async function distributeRelease(version, d) {
  const cur = d.distributed && d.distributed.version, back = cur && cmpVer(version, cur) < 0;
  const ok = confirm(`版 ${version} を${back ? "配る版に戻します" : "配ります"}。${cur ? `（いま配っている版は ${cur}）` : ""}\n`
    + "全員の PC が、次に確かめたとき（起動・30 分ごと）に取り込み、開き直したときにそろいます。前の版へ戻すのも、ここで選び直すだけです。");
  if (!ok) return;
  const r = await masterRequest("/__desktop/release/distribute", TPA.json("POST", { version }));
  await renderRelease();
  if (!r.ok) { releaseNotice("ng", "✕ " + (r.data.error || "配る版を決められませんでした。")); return; }
  releaseNotice((r.data.notes || []).length ? "ng" : "ok", `✓ 配る版を ${r.data.version} にしました。` + (r.data.notes || []).map((n) => `\n${n}`).join(""));
}
function releaseNotice(cls, text) {
  const put = document.querySelector("#masterSettings .dz-put");
  if (put) put.insertAdjacentHTML("beforeend", `<div class="ps-result ${cls}" style="white-space:pre-line">${escapeHtml(text)}</div>`);
}

/* 意味のある札（色は cls）。title は乗せたときの説明（任意） */
function chip(t, cls, title = "") { return `<span class="m-chip ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(t)}</span>`; }
async function presenceAct(kind, key, btn) {
  const url = { cut: "/api/presence/disconnect", allow: "/api/presence/allow", forget: "/api/presence/forget" }[kind];
  let body = { key };
  if (kind === "cut") {
    // 切断は理由を添えて確かめる（その場の欄。相手の画面の帯に出る）
    const cell = btn.closest("td");
    clearInterval(mstate.presenceTimer);
    cell.innerHTML = `<input class="pz-reason" placeholder="理由（相手の画面に出ます）" maxlength="200">
      <button class="pz-btn danger" data-go="1">切断する</button><button class="pz-btn" data-no="1">やめる</button>`;
    cell.querySelector(".pz-reason").focus();
    cell.querySelector("[data-no]").onclick = () => renderPresence();
    cell.querySelector("[data-go]").onclick = async () => {
      body.reason = cell.querySelector(".pz-reason").value;
      const r = await masterRequest(url, TPA.json("POST", body));
      if (!r.ok) fail(r.data.error || "切断できませんでした。");
      renderPresence();
    };
    return;
  }
  const r = await masterRequest(url, TPA.json("POST", body));
  if (!r.ok) fail(r.data.error || "できませんでした。");
  renderPresence();
}

/* 値の見せ方: 意味のある札にして、読まずに見分けられるようにする（未設定は目立たせ、「なし」は淡く）。 */
const REWIND = { "上": ["上巻き", "c-up"], "下": ["下巻き", "c-down"] };
const LINE = { "←": ["← 左へ", "c-line"], "→": ["右へ →", "c-line"] };
function cellHtml(c, raw) {
  const v = String(raw ?? "").trim();
  const none = (t = "—") => `<span class="m-none">${t}</span>`;
  const unset = '<span class="m-unset" title="まだ決めていません">未設定</span>';
  switch (c.kind) {
    case "name": return `<b class="m-name">${escapeHtml(v)}</b>`;
    case "rewind": return REWIND[v] ? chip(...REWIND[v]) : v === "-" ? none("なし") : unset;
    case "line": return LINE[v] ? chip(...LINE[v]) : v === "-" ? none("なし") : unset;
    case "meter": return v === "有" ? chip("◉ 有", "c-meter") : none();
    case "aliases": return v ? v.split(/[,、，]/).map((x) => x.trim()).filter(Boolean).map((x) => `<code class="m-code">${escapeHtml(x)}</code>`).join(" ") : none();
    case "chip": return v && v !== "ー" && v !== "-" ? chip(v, "c-plain") : none();
    case "ident": return v ? `<span class="m-ident">${escapeHtml(v)}</span>` : none(c.anyText || "—");
    case "role": return chip(v || "一般ユーザー", `c-${TPA.roleKey(v)}`);
    case "medit": return chip(v || "編集可", { "非表示": "c-off", "閲覧のみ": "c-view", "部分的編集可": "c-part" }[v || ""] || "c-full");
    case "enabled": return v === "無" ? chip("無効", "c-off") : chip("有効", "c-meter");
    default: return v ? escapeHtml(v) : none();
  }
}
TPA.onText($("#masterSearch"), (el) => { mstate.search = el.value; renderMasterTable(); });
$("#masterBtn").onclick = openMaster;
$("#masterCloseBtn").onclick = closeMaster;
TPA.layer($("#masterOverlay"), closeMaster);
$("#masterAddBtn").onclick = () => { if (!leaveOk()) return; mstate.prevSel = mstate.selId; openForm(mstate.tab, null); };

/* ---------------- 追加・編集フォーム ---------------- */
/* 右の詳細に行（row）を出す。row が無ければ追加の空の欄。focus: 最初の欄へ移るか（行を押しただけなら移らない） */
function openForm(tab, row, { focus = true } = {}) {
  const def = MASTER_DEFS[tab];
  mstate.editing = { tab, id: row ? row.id : null, baseRev: row ? (row.rev ?? null) : null };
  mstate.selId = row ? row.id : null;
  hideFormNotice();
  const name = row ? row[def.idField] || row[def.listColumns[0].key] || "" : "";
  $("#masterFormTitle").textContent = row ? `「${name}」を直す` : `${def.label}に追加`;
  $("#masterFormError").classList.add("hidden");
  $("#masterFormBody").innerHTML = def.formFields.map((f) => {
    const val = row ? escapeHtml(row[f.key]) : "";
    const req = f.required ? '<span class="req">*必須</span>' : "";
    let input;
    if (f.type === "select") {
      const opts = typeof f.options === "function" ? f.options(row) : f.options;
      input = `<select data-field="${f.key}">` + opts.map((o) =>
        `<option value="${escapeHtml(o)}"${(row ? (row[f.key] || "") : "") === o ? " selected" : ""}>${o ? escapeHtml(o) : "(空欄)"}</option>`).join("") + "</select>";
    } else if (f.type === "textarea") {
      input = `<textarea data-field="${f.key}" placeholder="${escapeHtml(f.placeholder || "")}">${val}</textarea>`;
    } else {
      input = `<input type="text" data-field="${f.key}" value="${val}" placeholder="${escapeHtml(f.placeholder || "")}">`;
    }
    const hint = f.hint ? `<small class="f-hint">${escapeHtml(f.hint)}</small>` : "";
    return `<div class="f-field${f.full ? " full" : ""}"><label>${f.label}${req}</label>${input}${hint}</div>`;
  }).join("");
  // 書けないときは見るだけ（欄は止め、保存・削除は出さない）
  const ro = !canWrite(tab);
  $("#masterFormBody").querySelectorAll("input,select,textarea").forEach((el) => { el.disabled = ro; });
  if (ro && row) $("#masterFormTitle").textContent = `「${name}」（閲覧のみ）`;
  showDetail(true);
  mstate.editing.orig = JSON.stringify(formValues());   // 直したかどうか（formDirty）の物差し
  paintDetailButtons();
  markSelected();
  if (focus) $("#masterFormBody").querySelector("input,select,textarea")?.focus();
}
/** 右の詳細の欄と、空のときの案内を切り替える */
function showDetail(on) {
  ["#masterFormBody", "#masterFormFoot"].forEach((sel) => $(sel).classList.toggle("hidden", !on));
  $("#masterFormTitle").parentElement.classList.toggle("hidden", !on);
  $("#masterDetailEmpty").classList.toggle("hidden", on);
}
function showDetailEmpty() { mstate.editing = null; hideFormNotice(); showDetail(false); markSelected(); }
/** 保存・削除・元に戻すを、いまの状態（書けるか・届くか・直したか）に合わせる */
function paintDetailButtons() {
  const ed = mstate.editing; if (!ed) return;
  const ro = !canWrite(ed.tab), down = shareDown(), dirty = formDirty();
  const why = down ? "共有フォルダに届かないため、いまは保存できません" : "";
  $("#masterFormSaveBtn").classList.toggle("hidden", ro);
  $("#masterFormSaveBtn").disabled = down;
  $("#masterFormSaveBtn").title = why;
  $("#masterFormDelBtn").classList.toggle("hidden", ro || ed.id == null);
  $("#masterFormDelBtn").disabled = down;
  $("#masterFormCancelBtn").classList.toggle("hidden", ro || (!dirty && ed.id != null));   // 直していない行では出さない（押しても何も起きない）
  $("#masterFormCancelBtn").textContent = ed.id == null ? "やめる" : "元に戻す";
}
/** 右の詳細を直したか（保存していない変更があるか） */
function formDirty() {
  const ed = mstate.editing;
  return !!ed && !!ed.orig && JSON.stringify(formValues()) !== ed.orig;
}
/** 直している途中なら、捨ててよいかを聞く（行・タブを移る・閉じる前） */
function leaveOk() {
  if (!formDirty()) return true;
  if (!confirm("右の詳細に保存していない変更があります。捨てて移りますか？")) return false;
  mstate.editing = null;
  return true;
}
function showFormNotice(kind, html) { const n = $("#masterFormNotice"); n.className = "master-notice " + kind; n.innerHTML = html; }
function hideFormNotice() { const n = $("#masterFormNotice"); n.className = "master-notice hidden"; n.innerHTML = ""; }
function formValues() {
  const data = {};
  $("#masterFormBody").querySelectorAll("[data-field]").forEach((el) => { data[el.dataset.field] = el.value; });
  return data;
}
function setFormValues(row) {
  $("#masterFormBody").querySelectorAll("[data-field]").forEach((el) => { el.value = row[el.dataset.field] ?? ""; });
}
/* 開いたあとに、同じ行がほかの PC で変わった／消えた。相手と自分の値を並べ、次の手を選んでもらう。 */
function showConflict(def, mine, current, message) {
  if (!current) {
    showFormNotice("conflict", `<b>${escapeHtml(message)}</b><br>入力した内容は、新しい行として追加し直せます。
      <div class="acts"><button type="button" class="primary" id="cfAddNew">新しい行として追加し直す</button>
      <button type="button" id="cfClose">閉じて一覧を読み直す</button></div>`);
    $("#cfAddNew").onclick = () => { mstate.editing.id = null; mstate.editing.baseRev = null; hideFormNotice();
      $("#masterFormTitle").textContent = `${def.label}に追加`; paintDetailButtons(); };
    $("#cfClose").onclick = () => { const t = mstate.editing.tab; mstate.editing = null; mstate.selId = null; reloadTab(t); };
    return;
  }
  const diff = def.formFields.filter((f) => String(current[f.key] ?? "") !== String(mine[f.key] ?? ""));
  const rows = diff.map((f) => `<tr><th>${escapeHtml(f.label)}</th><td class="theirs">${escapeHtml(current[f.key] || "（空欄）")}</td>
    <td>${escapeHtml(mine[f.key] || "（空欄）")}</td></tr>`).join("");
  showFormNotice("conflict", `<b>${escapeHtml(message)}</b>
    ${diff.length ? `<table><thead><tr><th>項目</th><th>相手の内容（いま保存されている）</th><th>あなたの入力</th></tr></thead><tbody>${rows}</tbody></table>`
      : "<br>内容は同じです。そのまま保存できます。"}
    <div class="acts"><button type="button" id="cfTheirs">相手の内容を読み込む（入力は捨てる）</button>
    <button type="button" class="primary" id="cfMine">自分の内容で上書きする</button></div>`);
  $("#cfTheirs").onclick = () => { setFormValues(current); mstate.editing.baseRev = current.rev; hideFormNotice(); };
  $("#cfMine").onclick = () => { mstate.editing.baseRev = current.rev; hideFormNotice(); $("#masterFormSaveBtn").click(); };
}
// 元に戻す: 保存してある内容を出し直す（追加の途中なら、やめて前に選んでいた行へ）
$("#masterFormCancelBtn").onclick = () => { const ed = mstate.editing; mstate.editing = null; if (ed && ed.id == null) mstate.selId = mstate.prevSel ?? null; renderMasterTable(); };
$("#masterFormDelBtn").onclick = () => { const ed = mstate.editing; const row = ed && (mstate.data[ed.tab] || []).find((r) => r.id === ed.id); if (row) openDeleteConfirm(ed.tab, row); };
$("#masterFormBody").addEventListener("input", paintDetailButtons);
$("#masterFormBody").addEventListener("change", paintDetailButtons);
$("#masterFormBody").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); $("#masterFormSaveBtn").click(); } });   // Ctrl+Enter で保存

$("#masterFormSaveBtn").onclick = async () => {
  const editing = mstate.editing;
  const { tab } = editing;
  const def = MASTER_DEFS[tab];
  const data = formValues();
  const err = $("#masterFormError");
  err.classList.add("hidden");

  const missing = def.formFields.find((f) => f.required && !String(data[f.key] || "").trim());
  if (missing) {
    err.textContent = `${missing.label} は必須です。`;
    err.classList.remove("hidden");
    return;
  }

  $("#masterFormSaveBtn").disabled = true;
  try {
    const id = editing.id;
    const url = id ? `${def.api}/${id}` : def.api;
    const body = id ? { ...data, base_rev: editing.baseRev } : data;
    const res = await withLockWait(
      () => masterRequest(url, TPA.json(id ? "PUT" : "POST", body)),
      (d) => showFormNotice("wait", lockWaitText(d, "保存", boldName)));
    if (res.status === 409 && res.data.kind === "conflict") { showConflict(def, data, res.data.current, res.data.error); return; }
    if (!res.ok) throw new Error(res.data.error || "保存に失敗しました。");
    hideFormNotice();
    mstate.editing = null;
    if (!id && res.data && res.data.id != null) mstate.selId = res.data.id;
    await reloadTab(tab);
    afterMasterChange();
  } catch (e) {
    hideFormNotice();
    err.textContent = e.message;
    err.classList.remove("hidden");
  } finally {
    $("#masterFormSaveBtn").disabled = false;
  }
};

/* ---------------- 削除確認 ---------------- */
function openDeleteConfirm(tab, row) {
  const def = MASTER_DEFS[tab];
  mstate.deleteTarget = { tab, id: row.id, rev: row.rev ?? null };
  $("#masterDeleteMsg").textContent = `${def.label}「${row[def.idField] || row.id}」を削除します。この操作は取り消せません。よろしいですか？`;
  $("#masterDeleteOverlay").classList.remove("hidden");
}
function closeDeleteConfirm() { $("#masterDeleteOverlay").classList.add("hidden"); mstate.deleteTarget = null; }
$("#masterDeleteCancelBtn").onclick = closeDeleteConfirm;
TPA.layer($("#masterDeleteOverlay"), closeDeleteConfirm);
$("#masterDeleteConfirmBtn").onclick = async () => {
  const { tab, id, rev } = mstate.deleteTarget;
  const def = MASTER_DEFS[tab];
  const msg = $("#masterDeleteMsg");
  $("#masterDeleteConfirmBtn").disabled = true;
  try {
    const res = await withLockWait(
      () => masterRequest(`${def.api}/${id}${rev != null ? `?rev=${rev}` : ""}`, { method: "DELETE" }),
      (d) => { msg.textContent = lockWaitText(d, "削除"); });
    if (res.status === 409 && res.data.kind === "conflict") {
      // 開いたあとに変わった行は消さない。最新を見てから、もう一度選んでもらう
      closeDeleteConfirm();
      await reloadTab(tab);
      fail(`${res.data.error} 削除はしていません。一覧の最新の内容を確かめてから、もう一度削除してください。`);
      return;
    }
    if (!res.ok) throw new Error(res.data.error || "削除に失敗しました。");
    closeDeleteConfirm();
    if (mstate.selId === id) { mstate.selId = null; mstate.editing = null; }
    await reloadTab(tab);
    afterMasterChange();
  } catch (e) {
    fail(e.message);
    closeDeleteConfirm();
  } finally {
    $("#masterDeleteConfirmBtn").disabled = false;
  }
};

/* ---------------- 解析画面への反映（解析画面が計算し直す） ---------------- */
function afterMasterChange() { emit("tpa:masters-changed"); }
})();
