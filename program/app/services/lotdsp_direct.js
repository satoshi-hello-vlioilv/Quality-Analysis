/* lotdsp_direct.js: このアプリだけで LotDsp を読むときに、裏で開いた LotDsp のページの中で動かす手順
   （lotdsp_direct.py が Chrome DevTools Protocol の Runtime.evaluate で入れる。__LOT__ はロット番号に置き換わる）。

   手順は LotData-Link の lotdsp-relay.js（docs/DESIGN.md §3）と同じ道——人と同じにロット番号の欄へ入れて
   「検索」を1回押し、「進度情報」タブの実績の表が描き終わったら画面の HTML をそのまま返す。
   違うのは1つだけ: **ログインはしない。** ログインの欄が見えたら何も押さずに { kind: "login" } を返す
   （VPN ではログインが要る。ログインするのは利用者だけ（LotDsp の窓）。このアプリはパスワードを扱わない）。

   入れるとすぐ戻り、手順は裏で進む。途中経過と結果は window.__tpaDirect = { stage, result } に置き、
   lotdsp_direct.py が 0.25 秒ごとに尋ねる（画面のモーダルの段階表示・中止のため）。
     stage … search（検索している）／ read（進度情報を読んでいる）
     result … { ok: true, html } ／ { ok: false, kind, error }
       kind … login（ログインが要る）／ not_found（該当なし）／ screen（画面が想定と違う・出ない）
   見えない Edge は使い回すので、2回目からは検索のあとの画面（上の検索欄）から始まる。欄は見えている方を使う。 */
window.__tpaDirect = { stage: 'search', result: null };
(async () => {
  const LOT = __LOT__;
  const TOTAL_MS = __TOTAL_MS__;
  const STEP_MS = 250;
  const NOT_FOUND_MS = 8000;
  const STABLE_TICKS = 3;
  const SEL = {
    login: '#input_userId',
    lot: ['#input_searchLtno', '#common_searchLtno'],
    search: 'button[ng-click="action.search()"]',
    message: '#messageArea',
  };
  const $ = (s) => document.querySelector(s);
  const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');
  const shown = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const left = () => Math.max(0, TOTAL_MS - (Date.now() - t0));
  class Stop extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }
  async function until(fn, ms, kind, what) {
    const s = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - s >= ms) throw new Stop(kind, what);
      await sleep(STEP_MS);
    }
  }
  function pageLot() {
    for (const t of document.querySelectorAll('table')) {
      const r = t.rows;
      if (r.length === 2 && r[0].cells.length === 1 && norm(r[0].textContent) === 'ロット番号') return norm(r[1].textContent).toUpperCase();
    }
    return '';
  }
  function hitCount() {
    for (const el of [...document.querySelectorAll('.header-label')].filter(shown)) {
      const m = norm(el.textContent).match(/検索結果:(\d+)件/);
      if (m) return Number(m[1]);
    }
    return null;
  }
  const lotInput = () => SEL.lot.map((s) => $(s)).find(shown) || null;
  const pairedInspection = (input) => document.getElementById(input.id.replace(/Ltno$/, 'Knno'));
  function searchButtonFor(input) {
    for (let el = input.parentElement; el; el = el.parentElement) {
      const b = [...el.querySelectorAll(SEL.search)].find(shown);
      if (b) return b;
    }
    return null;
  }
  const loginShown = () => shown($(SEL.login)) || [...document.querySelectorAll('button')]
    .some((b) => shown(b) && /ログイン/.test(b.textContent || ''));
  const currentTab = () => norm(($('.MniTabTblSelTd') || {}).textContent);
  const tabLink = (name) => [...document.querySelectorAll('a.MniTabLnk')].find((a) => norm(a.textContent) === name);
  function actualTable() {
    const t = [...document.querySelectorAll('table')].find((x) => {
      const h = x.rows[0] ? [...x.rows[0].cells].map((c) => norm(c.textContent)) : [];
      return h.includes('設備') && h.includes('前オフ');
    });
    if (!t || !shown(t)) return null;
    return [...t.rows].slice(1).filter((r) => /^\d+$/.test(norm(r.cells[0] && r.cells[0].textContent))).length;
  }
  function put(el, v) {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  try {
    /* 1) 画面が出るのを待つ。ログインの欄が見えたら押さずに引き返す（VPN）。 */
    const input = await until(() => {
      if (loginShown()) throw new Stop('login', 'ロット問い合わせにログインが要ります（VPN）');
      return lotInput();
    }, Math.min(left(), 30000), 'screen', 'ロット問い合わせの検索画面が出ませんでした');
    /* 最初の画面の「検索」は ng-if で欄より遅れて現れる。その間にログインの欄が出ることもある。 */
    const btn = await until(() => {
      if (loginShown()) throw new Stop('login', 'ロット問い合わせにログインが要ります（VPN）');
      return searchButtonFor(input);
    }, Math.min(left(), 15000), 'screen', '「検索」ボタンが見つかりません');
    /* 2) ロット番号で検索（検査番号の欄は空に）。押すのは1回だけ。
          LotDsp の窓で利用者がログインと一緒にこのロットを検索し終えていれば、検索し直さない（答えが重ならない）。 */
    const already = pageLot() === LOT && (hitCount() || 0) > 0;
    if (!already) {
      put(input, LOT);
      const kn = pairedInspection(input);
      if (kn && kn.value) put(kn, '');
      btn.click();
    }
    const clickedAt = Date.now();
    await until(() => {
      if (pageLot() === LOT && hitCount() !== 0) return true;
      if (hitCount() === 0 && Date.now() - clickedAt > NOT_FOUND_MS) {
        const why = norm(($(SEL.message) || {}).textContent);
        throw new Stop('not_found', `ロット問い合わせに ${LOT} が見つかりません（検索結果 0件${why ? '・' + why : ''}）`);
      }
      return false;
    }, left(), 'screen', `検索の結果が出ませんでした（${LOT}）`);
    /* 3) 進度情報タブ → 実績の行数が落ち着くまで待つ。 */
    window.__tpaDirect.stage = 'read';
    if (currentTab() !== '進度情報') {
      const a = tabLink('進度情報');
      if (!a) throw new Stop('screen', '「進度情報」タブが見つかりません');
      a.click();
    }
    let last = -1, same = 0;
    await until(() => {
      const n = currentTab() === '進度情報' && pageLot() === LOT ? actualTable() : null;
      if (n === null) { same = 0; last = -1; return false; }
      same = n === last ? same + 1 : 0;
      last = n;
      return same >= STABLE_TICKS;
    }, left(), 'screen', '進度情報の実績の表が出ませんでした');
    return { ok: true, html: document.documentElement.outerHTML };
  } catch (e) {
    return { ok: false, kind: e.kind || 'screen', error: String(e.message || e) };
  }
})().then((r) => { window.__tpaDirect.result = r; });
true
