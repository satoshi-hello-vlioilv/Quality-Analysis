/* =========================================================================
   一覧の表示の設定（個人の分）: 書き出す・読み込む・初期設定に戻す・今の表示を初期設定にする（開発者だけ）
   - 範囲（どの名前を表示の設定とするか）はサーバーの 1 か所（services/ui_defaults.PROFILE_KEYS）で決め、画面に埋めてある
     （window.TPA_UI_PROFILE = {keys, defaults, updatedAt, updatedBy}）。表示列・スライサー・並び・見せ方・登録した条件
   - 書き出しの形は WaveLog と同じ {kind, version, savedAt, items}（items は [{key, value}]。value は覚えている字のまま）
   - 読み込み・初期設定に戻すは、この PC の表示の設定を置き換え（範囲の中で、ファイルに無い名前は消す）、控えへ送ってから開き直す
     （各部品は開いたときに設定を読むので、開き直すのがいちばん確か）
   - 初期設定は開発者だけが置ける（サーバーも確かめる: PUT /api/ui-defaults）。新しく入れた PC が最初に開いたときに当たる
   ========================================================================= */
(function () {
  "use strict";
  const KIND = "tpa-lotlist-display";
  const profile = () => window.TPA_UI_PROFILE || { keys: [], defaults: {} };
  const keys = () => profile().keys || [];

  /** この PC の表示の設定 → {名前: 字}（覚えていない名前は入れない） */
  function current() {
    const out = {};
    keys().forEach((k) => { const v = TPA.local.getRaw(k); if (v != null) out[k] = v; });
    return out;
  }
  /** 表示の設定を keys で置き換え、控えへ送り終えてから開き直す */
  async function replaceWith(values) {
    keys().forEach((k) => { if (k in values) TPA.local.setRaw(k, values[k]); else TPA.local.remove(k); });
    try { await TPA.saveUiState(); } catch (_) { /* 送れなくても手元には入った */ }
    location.reload();
  }
  function exportFile(name = "異常ロット一覧_表示の設定.json") {
    const items = Object.entries(current()).map(([key, value]) => ({ key, value }));
    TPA.saveJson(KIND, items, name);
    return items.length;
  }
  /** ファイルを選んで読む → 読み込んだ名前の数（選ばなければ null）。範囲の外の名前は飛ばす */
  async function importFile() {
    const items = await TPA.pickJson(KIND, "一覧の表示");
    if (!items) return null;
    const allowed = new Set(keys()), values = {};
    items.forEach((x) => { if (allowed.has(x.key) && typeof x.value === "string") values[x.key] = x.value; });
    if (!Object.keys(values).length) throw new Error("このファイルには、一覧の表示の設定が入っていません");
    await replaceWith(values);
    return Object.keys(values).length;
  }
  const hasDefaults = () => Object.keys(profile().defaults || {}).length > 0;
  function resetToDefaults() { return replaceWith(profile().defaults || {}); }
  /** 今の表示を初期設定にする（開発者だけ）→ 置いた名前の数。サーバーの答えで埋めた初期設定も新しくする */
  async function publish() {
    const r = await fetch("/api/ui-defaults", TPA.json("PUT", { keys: current() }));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "初期設定を置けませんでした");
    window.TPA_UI_PROFILE = { keys: d.keys, defaults: d.defaults, updatedAt: d.updatedAt, updatedBy: d.updatedBy };
    return d.count;
  }
  /** 初期設定の出どころの言葉（「10/08 PC-01／user」）。無ければ "" */
  function defaultsWho() {
    const p = profile(); if (!hasDefaults()) return "";
    const by = [p.updatedBy && p.updatedBy.pc, p.updatedBy && p.updatedBy.login].filter(Boolean).join("／");
    const at = String(p.updatedAt || "").slice(5, 16).replace("T", " ").replace("-", "/");
    return [at, by].filter(Boolean).join(" ");
  }
  window.LotListProfile = { exportFile, importFile, resetToDefaults, publish, hasDefaults, defaultsWho, current };
})();
