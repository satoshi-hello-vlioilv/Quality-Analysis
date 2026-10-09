/* =========================================================================
   画面の共通部品（どのファイルも同じ書き方を写さない）
   - window.TPA の1つだけを出す。上の階層に名前を置かない（app.js・master.js は上の階層で $ などを
     宣言しているので、ここで宣言するとぶつかって読み込めなくなる）。
   - 最初に読み込む（index.html）。list-formula.js は WaveLog と同じものを保つため使わない。
   ========================================================================= */
(function () {
  "use strict";
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /* 覚える場所（localStorage / sessionStorage）。プライベート・容量切れ・止められた PC でも投げずに既定で動く。
     get/set は JSON で、getRaw/setRaw は文字のまま（以前から文字で覚えている項目のため）。
     changed(k): 中身が変わったときだけ呼ぶ（localStorage は画面の設定の控えへ送る。下の uiState）。 */
  const store = (area, changed = () => {}) => {
    const setRaw = (k, v) => { try { if (area().getItem(k) === String(v)) return; area().setItem(k, String(v)); changed(k); } catch (_) { /* 覚えられなくても動く */ } };
    return {
      get(k, d) { try { const v = JSON.parse(area().getItem(k)); return v == null ? d : v; } catch (_) { return d; } },
      set: (k, v) => setRaw(k, JSON.stringify(v)),
      getRaw(k, d = null) { try { const v = area().getItem(k); return v == null ? d : v; } catch (_) { return d; } },
      setRaw,
      remove(k) { try { if (area().getItem(k) == null) return; area().removeItem(k); changed(k); } catch (_) { /* 覚えられなくても動く */ } },
    };
  };

  /* 画面の設定の控え（app/services/ui_state.py）。localStorage は画面の置き場（オリジン）ごとに別なので、
     WebView の作業場所が消えても戻せるように・以前のブラウザ版（ポートの置き場）で使い込んだ設定を引き継ぐために、
     覚え直すたびに「変わった名前だけ」を控えに重ね、開くときに控えの版（rev）が進んでいれば戻す（サーバーが TPA_UI_STATE として画面に埋める）。
     - 控えに入れるのは tpa. で始まる名前だけ。どの版の控えと揃っているかは tpa. で始まらない名前（REV）に覚える
     - 送ったあと、控えの版が自分の続き（＋1）でなければ、ほかの窓も重ねている。REV を進めず、次に開くとき控え全体から戻す
     - 一度も揃えたことのない画面に設定があれば、それは前の版から使ってきた設定。控えは足りない名前だけ補い、手元をすべて重ねる
       （先に開いたデスクトップ版の「まだ何も決めていない設定」で、使い込んだ設定を消さない） */
  const uiState = (() => {
    const PREFIX = "tpa.", REV = "tpaUiRev", DELAY_MS = 1500, URL = "/api/ui-state";
    const ls = () => window.localStorage;
    const appKeys = () => { const out = []; for (let i = 0; i < ls().length; i++) { const k = ls().key(i); if (k && k.startsWith(PREFIX)) out.push(k); } return out; };
    const pending = new Set();                         // 送っていない名前
    // 閉じる瞬間の送り方。使えない・投げる WebView（Linux の WebKitGTK は自前の仕組み tpa:// 宛てで投げる）では false → fetch で送る
    const sendBeacon = (url, body) => { try { return !!navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "application/json" })); } catch (_) { return false; } };
    let timer = null;
    function save(beacon) {
      clearTimeout(timer); timer = null;
      if (!pending.size) return Promise.resolve();
      try {
        const changed = {}, removed = [], keys = [...pending];
        keys.forEach((k) => { const v = ls().getItem(k); if (v == null) removed.push(k); else changed[k] = v; });
        pending.clear();
        const body = JSON.stringify({ changed, removed }), base = +ls().getItem(REV) || 0;
        if (beacon && sendBeacon(URL, body)) return Promise.resolve();
        return fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 })
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          // 自分の続きなら控えと揃っている。そうでなくても「一度は送れた」（前の版の設定は控えに入った）印に 0 を置き、
          // 次に開くとき控え全体から戻す（印が無いままだと、開くたびに前の版の設定として重ね続ける）
          .then((d) => { if (d.rev === base + 1) ls().setItem(REV, String(d.rev)); else if (ls().getItem(REV) == null) ls().setItem(REV, "0"); })
          .catch(() => { keys.forEach((k) => pending.add(k)); });   // 送れなかった名前は次に送る（戻り値: 送り終えたら解決）
      } catch (_) { /* 送れなくても画面は動く */ }
      return Promise.resolve();
    }
    function touched(k) {
      if (!String(k).startsWith(PREFIX)) return;
      pending.add(k); clearTimeout(timer); timer = setTimeout(save, DELAY_MS);
    }
    (function restore() {
      try {
        const snap = window.TPA_UI_STATE;
        if (!snap) return;                                   // 控えを埋めていない画面（LotDsp 照合など）は戻さない
        const rev = ls().getItem(REV), keys = snap.keys || {}, local = appKeys();
        if (rev == null && local.length) {                   // 前の版から使ってきた設定
          Object.entries(keys).forEach(([k, v]) => { if (ls().getItem(k) == null) ls().setItem(k, v); });
          local.forEach(touched);
        } else if (rev == null && !local.length && !(snap.rev || 0)) {
          // 入れたばかりの PC（画面の設定も控えも無い）: 開発者が置いた一覧の表示の初期設定を当てる（services/ui_defaults.py）
          const defs = (window.TPA_UI_PROFILE || {}).defaults || {};
          Object.entries(defs).forEach(([k, v]) => { ls().setItem(k, v); touched(k); });
        } else if ((snap.rev || 0) > (+rev || 0)) {
          local.forEach((k) => { if (!(k in keys)) ls().removeItem(k); });
          Object.entries(keys).forEach(([k, v]) => ls().setItem(k, v));
          ls().setItem(REV, String(snap.rev));
        }
      } catch (_) { /* 戻せなくても既定で動く */ }
    })();
    addEventListener("pagehide", () => save(true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(true); });
    return { touched, flush: () => save(false) };
  })();

  let measureCtx = null;

  /* 重なって開く窓（更新履歴・マスタ管理とその上のフォーム・削除の確認・取込ダイアログ）。
     Esc はいちばん上に開いている1枚だけを閉じる（登録した順＝重なる順。後から登録した物ほど上）。
     ほかが先に Esc を使った（preventDefault）ときは何もしない（メニュー・問い合わせ中のモーダルが先）。 */
  const layers = [];
  const isShown = (el) => !el.hidden && !el.classList.contains("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const top = layers.filter((l) => isShown(l.el)).pop();
    if (top) { e.preventDefault(); top.close(); }
  });

  /* 書き出したファイルの置き場所の知らせ（右下・閉じるまで残る）。どこから書き出しても（表示列・並び・表示の設定・計算の CSV）同じ所に出る。
     デスクトップ版は窓（desktop/src/main.rs の on_download）が保存し終えたとき tpa:saved {path, ok} を送るので、置いた場所の全文と
     「フォルダを開く」「パスをコピー」を出す。届かないとき（ブラウザで開いたとき）は、ブラウザのダウンロード先に置いたと言う。 */
  const saved = (() => {
    let el = null, fallback = 0;
    const close = () => { if (el) { el.remove(); el = null; } };
    const show = (ok, title, body, path) => {
      close();
      el = document.createElement("div");
      el.className = `tpa-saved${ok ? "" : " is-ng"}`;
      el.setAttribute("role", "status");
      el.innerHTML = `<button type="button" class="tpa-saved-x" aria-label="閉じる" title="閉じる">×</button>
        <b class="tpa-saved-t">${TPA.esc(title)}</b>${body}
        ${path ? `<div class="tpa-saved-acts"><button type="button" class="is-main" data-act="reveal">フォルダを開く</button><button type="button" data-act="copy">パスをコピー</button></div>` : ""}
        <small class="tpa-saved-msg" aria-live="polite"></small>`;
      document.body.appendChild(el);
      const box = el, msg = (t) => { box.querySelector(".tpa-saved-msg").textContent = t; };
      box.querySelector(".tpa-saved-x").onclick = close;
      box.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
        if (b.dataset.act === "copy") {
          try { await navigator.clipboard.writeText(path); msg("パスをコピーしました。"); } catch (_) { msg("コピーできませんでした。パスを選んで写してください。"); }
          return;
        }
        try {
          const r = await fetch("/__desktop/reveal", TPA.json("POST", { path }));
          if (!r.ok) msg(((await r.json().catch(() => ({}))).error) || "フォルダを開けませんでした。");
        } catch (_) { msg("フォルダを開けませんでした。"); }
      });
    };
    window.addEventListener("tpa:saved", (e) => {
      clearTimeout(fallback);
      const { path, ok } = e.detail || {};
      if (!ok || !path) { show(false, "✕ 書き出せませんでした", '<span class="tpa-saved-p">保存先に書き込めなかったか、途中で止まりました。もう一度書き出してください。</span>', ""); return; }
      const name = String(path).split(/[\\/]/).pop();
      show(true, `✓ 書き出しました「${name}」`, `<span class="tpa-saved-l">置いた場所</span><code class="tpa-saved-p">${TPA.esc(path)}</code>`, path);
    });
    return {
      /** 書き出しを始めた（name: ファイルの名前）。デスクトップ版の知らせが来なければ、ブラウザのダウンロード先と言う */
      expect(name) {
        clearTimeout(fallback);
        fallback = setTimeout(() => show(true, `✓ 書き出しました「${name}」`,
          '<span class="tpa-saved-p">ブラウザのダウンロード先（ふつうは「ダウンロード」フォルダ）に置きました。ブラウザのダウンロードの一覧（Ctrl＋J）からも開けます。</span>', ""), 2500);
      },
    };
  })();

  window.TPA = {
    /** HTML に差し込む文字を無害にする（& < > " ' ）。 */
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]),
    $: (s, r = document) => r.querySelector(s),
    $$: (s, r = document) => [...r.querySelectorAll(s)],
    local: store(() => window.localStorage, uiState.touched),
    /** 画面の設定の控えを今すぐ送る（待たずに。試験・終了の前） */
    saveUiState: () => uiState.flush(),
    session: store(() => window.sessionStorage),
    /** JSON を送る fetch の2つめの引数。例: fetch(url, TPA.json("POST", {names})) */
    json: (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    pad2: (n) => String(n).padStart(2, "0"),
    /** 文字の幅（px）を測る（列の幅を中身に合わせるため）。font は CSS の font と同じ書き方。 */
    textWidth(text, font) {
      if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
      measureCtx.font = font;
      return measureCtx.measureText(String(text)).width;
    },
    /** 作ったファイルを保存させ、置いた場所を右下に知らせる。 */
    download(blob, name) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      saved.expect(name);
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    },
    /** 設定を JSON のファイルに書き出す（形は WaveLog と同じ {kind, version, savedAt, items}）。読むのは pickJson。 */
    saveJson(kind, items, name) {
      const body = JSON.stringify({ kind, version: 1, savedAt: new Date().toISOString(), items }, null, 1);
      TPA.download(new Blob([body], { type: "application/json" }), name);
    },
    /** saveJson で書いた設定のファイルを選ばせて読む → items（1件以上）。選ばずに閉じたら null。
        別の種類（kind）・壊れたファイルは、何が違うかを言う Error で投げる（what: 「表示列」など、誤りの文に使う名前）。
        kind が null なら種類を問わない（表示列: WaveLog など、前から読めていたファイルを読めなくしない）。 */
    pickJson(kind, what) {
      return new Promise((resolve, reject) => {
        const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
        input.addEventListener("cancel", () => resolve(null));
        input.addEventListener("change", async () => {
          const file = input.files[0]; if (!file) { resolve(null); return; }
          try {
            let d;
            try { d = JSON.parse(await file.text()); } catch (_) { throw new Error(`「${file.name}」は設定のファイル（JSON）として読めません`); }
            if (!d || (kind && d.kind !== kind)) throw new Error(`「${file.name}」は${what}の設定ファイルではありません`);
            const items = Array.isArray(d.items) ? d.items.filter((x) => x && typeof x === "object") : [];
            if (!items.length) throw new Error(`「${file.name}」に${what}の設定が入っていません`);
            resolve(items);
          } catch (e) { reject(e); }
        });
        input.click();
      });
    },
    /** 値だけの深い写し（設定・下書きを元と切り離す）。 */
    clone: (v) => JSON.parse(JSON.stringify(v)),
    /* 日本語入力（IME）の変換中か。変換中の input・keydown（確定の Enter も）は、まだ打ち終わっていない字なので扱わない */
    composing: (e) => !!(e && (e.isComposing || e.keyCode === 229)),
    /** 打った字に応じて fn(el) を呼ぶ。変換中は呼ばず、確定したとき（compositionend）に呼ぶ。
        変換中に欄を描き直す・探しに行くと、未確定の字が強制確定されてしまう（ローマ字で打てない） */
    onText(el, fn) {
      el.addEventListener("input", (e) => { if (!TPA.composing(e)) fn(el, e); });
      el.addEventListener("compositionend", (e) => fn(el, e));
    },

    /** 重なって開く窓を登録する。Esc（いちばん上の1枚）と、backdrop なら窓の外側（背景）を押したときに close()。 */
    layer(el, close, { backdrop = true } = {}) {
      const entry = { el, close };
      layers.push(entry);
      if (backdrop) el.addEventListener("click", (e) => { if (e.target === el) close(); });
      return () => { const i = layers.indexOf(entry); if (i >= 0) layers.splice(i, 1); };   // 窓を捨てるとき（いくつも開くカード）
    },

    /** 開いたメニューを、外側を押す・Esc で閉じる。onClose(byEsc) を1度だけ呼ぶ。戻り値は見張りを外す関数。
        開いた操作そのものの押下で閉じないよう、見張りは次の描画から。keep の中を押しても閉じない（開いたボタン）。
        event: 外側の押下を click で見るか mousedown で見るか（選択欄・つまみを触るメニューは mousedown）。 */
    dismissable(el, onClose, { keep = null, event = "click" } = {}) {
      let live = true;
      const outside = (e) => { if (!el.contains(e.target) && !(keep && keep.contains(e.target))) done(false); };
      const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(true); } };
      const off = () => {
        live = false; cancelAnimationFrame(raf);
        document.removeEventListener(event, outside, true); document.removeEventListener("keydown", key, true);
      };
      const done = (byEsc) => { if (live) { off(); onClose(byEsc); } };
      const raf = requestAnimationFrame(() => {
        if (live) { document.addEventListener(event, outside, true); document.addEventListener("keydown", key, true); }
      });
      return off;
    },
    /** メニューを基準の要素の下に置く（左端か右端をそろえ、画面の左右からはみ出さない）。 */
    placeBelow(el, anchor, align = "left") {
      const r = anchor.getBoundingClientRect(), w = el.offsetWidth, top = Math.round(r.bottom + 6);
      el.style.top = `${top}px`;
      // 中でスクロールする窓は、置いた位置から画面の下端までに収める（下が切れて届かない所を作らない）
      if (/auto|scroll/.test(getComputedStyle(el).overflowY)) el.style.maxHeight = `${Math.max(160, innerHeight - top - 8)}px`;
      el.style.left = `${Math.round(Math.max(8, Math.min(align === "right" ? r.right - w : r.left, innerWidth - w - 8)))}px`;
    },
    /** メニューを押した位置に置く（画面からはみ出さない）。 */
    placeAt(el, x, y) {
      el.style.left = `${Math.round(Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)))}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)))}px`;
    },

    /** 動かせる・大きさを変えられる窓（表示列・読み替えルール・カード）。位置と大きさを key でこの PC に覚え、
        [data-drag] の見出しを掴んで動かせる（見出しが画面に残る範囲）。w・h・top は覚えが無いときの大きさと上端、
        align は覚えが無いときの左右の置き場（center＝真ん中／right＝右寄せ。後ろの一覧を隠しすぎない窓）。
        大きさは4辺と4隅の取っ手（CSS の resize は overflow:clip の窓では効かないので使わない）。
        細かく合わせる: 動かす・変えるあいだは画面の端とほかの窓（[data-float]）の辺へ 8px で吸い付き（Alt を押すと吸い付かない）、
        位置と大きさを窓の隅に数で出す。窓の中で Alt+矢印＝動かす・Alt+Shift+矢印＝大きさ（10px。Ctrl も押すと 1px）。
        戻り値: place() 覚えた位置に置く（画面が変わっていれば収める）／ remember() いまの位置と大きさを覚える（隠す前に）／
                rect() いまの位置と大きさ／ setRect({x,y,w,h}, keep) 置く（画面に収める。keep=false なら覚えない）。 */
    floatPanel(panel, { key = "", w = 1200, h = 780, top = 40, align = "center", minW = 400, minH = 300 }) {
      const SNAP = 8, KEY_STEP = 10;
      panel.dataset.float = "";
      const remember = () => {
        if (panel.hidden || !key) return;
        const b = panel.getBoundingClientRect();
        if (b.width < minW || b.height < minH) return;   // 出ていない・畳まれた大きさは覚えない
        TPA.local.set(key, { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
      };
      const rect = () => { const b = panel.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
      const apply = (r) => {
        const pw = Math.max(minW, Math.min(innerWidth - 8, Math.round(r.w))), ph = Math.max(minH, Math.min(innerHeight - 8, Math.round(r.h)));
        Object.assign(panel.style, { width: pw + "px", height: ph + "px",
          left: Math.round(Math.max(0, Math.min(r.x, innerWidth - 80))) + "px", top: Math.round(Math.max(0, Math.min(r.y, innerHeight - 40))) + "px" });
      };
      /* 吸い付く先の線（画面の端・ほかの窓の辺）。x の線と y の線 */
      const guides = () => {
        const xs = [0, innerWidth], ys = [0, innerHeight];
        document.querySelectorAll("[data-float]").forEach((el) => {
          if (el === panel || el.hidden || !el.isConnected) return;
          const b = el.getBoundingClientRect(); if (!b.width) return;
          xs.push(b.left, b.right); ys.push(b.top, b.bottom);
        });
        return { xs, ys };
      };
      const snap = (v, lines) => { let best = v, d = SNAP + 1; lines.forEach((l) => { const k = Math.abs(l - v); if (k < d) { d = k; best = l; } }); return best; };
      let readout = null, readTimer = null;
      const showRead = () => {
        if (!readout) { readout = document.createElement("div"); readout.className = "fp-read"; panel.append(readout); }
        const r = rect();
        readout.textContent = `${Math.round(r.x)}, ${Math.round(r.y)}　${Math.round(r.w)} × ${Math.round(r.h)}`;
        readout.hidden = false; clearTimeout(readTimer); readTimer = setTimeout(() => { if (readout) readout.hidden = true; }, 1200);
      };
      /* 掴んで動かす・大きさを変える（edge: "move" か n/s/e/w の組み合わせ） */
      const grab = (e, edge) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const r0 = rect(), x0 = e.clientX, y0 = e.clientY, g = guides();
        document.body.classList.add("fp-busy");
        panel.classList.add("is-moving");
        const move = (ev) => {
          const dx = ev.clientX - x0, dy = ev.clientY - y0, free = ev.altKey;
          let { x, y, w: rw, h: rh } = r0;
          if (edge === "move") {
            x += dx; y += dy;
            if (!free) {
              const sx = snap(x, g.xs), sx2 = snap(x + rw, g.xs) - rw, sy = snap(y, g.ys), sy2 = snap(y + rh, g.ys) - rh;
              x = sx !== x ? sx : sx2; y = sy !== y ? sy : sy2;
            }
          } else {
            if (edge.includes("e")) { rw = Math.max(minW, r0.w + dx); if (!free) rw = snap(x + rw, g.xs) - x; }
            if (edge.includes("s")) { rh = Math.max(minH, r0.h + dy); if (!free) rh = snap(y + rh, g.ys) - y; }
            if (edge.includes("w")) { let nx = Math.min(r0.x + r0.w - minW, r0.x + dx); if (!free) nx = snap(nx, g.xs); rw = r0.x + r0.w - nx; x = nx; }
            if (edge.includes("n")) { let ny = Math.min(r0.y + r0.h - minH, r0.y + dy); if (!free) ny = snap(ny, g.ys); rh = r0.y + r0.h - ny; y = ny; }
          }
          apply({ x, y, w: rw, h: rh }); showRead();
        };
        const up = () => {
          document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
          document.body.classList.remove("fp-busy"); panel.classList.remove("is-moving"); remember();
        };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      };
      panel.querySelector("[data-drag]").addEventListener("mousedown", (e) => { if (!e.target.closest("button,input,select,label,a")) grab(e, "move"); });
      ["n", "s", "e", "w", "ne", "nw", "se", "sw"].forEach((edge) => {
        const hd = document.createElement("i");
        hd.className = `fp-h fp-${edge}`; hd.setAttribute("aria-hidden", "true");
        hd.addEventListener("mousedown", (e) => grab(e, edge));
        panel.append(hd);
      });
      panel.addEventListener("keydown", (e) => {
        const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!dir || !e.altKey || e.target.closest("input,select,textarea")) return;
        e.preventDefault(); e.stopPropagation();
        const step = e.ctrlKey ? 1 : KEY_STEP, r = rect();
        if (e.shiftKey) apply({ ...r, w: r.w + dir[0] * step, h: r.h + dir[1] * step });
        else apply({ ...r, x: r.x + dir[0] * step, y: r.y + dir[1] * step });
        showRead(); remember();
      });
      new ResizeObserver(remember).observe(panel);
      return {
        remember, rect,
        setRect(r, keep = true) { apply(r); if (keep) remember(); },
        place() {
          let r = key ? TPA.local.get(key, null) : null;
          if (!r || r.w < minW || r.h < minH) r = null;
          const pw = Math.min(innerWidth - 24, r ? r.w : w), ph = Math.min(innerHeight - 24, r ? r.h : h);
          Object.assign(panel.style, { width: pw + "px", height: ph + "px",
            left: Math.max(12, Math.min(r ? r.x : align === "right" ? innerWidth - pw - 24 : (innerWidth - pw) / 2, innerWidth - pw - 12)) + "px",
            top: Math.max(12, Math.min(r ? r.y : top, innerHeight - ph - 12)) + "px" });
        },
      };
    },

    /** ドラッグで並べ替える（計算の表の見出し・列表示の窓の行・一覧のカードの項目で同じ）。鍵は各要素の data-col。
        axis: 前後どちらに入るかを上下（vertical）で決めるか左右（horizontal）で決めるか。
        canDrop(鍵, 相手の鍵) が偽の相手には落とせない（同じまとまりの中だけ など）。onDrop(鍵, 相手の鍵, 後ろか)。
        落とす先には drop-before／drop-after、掴んでいる要素には dragging のクラスが付く。 */
    dragSort(root, selector, { axis = "horizontal", canDrop = () => true, onDrop }) {
      let dragKey = null;
      const clear = () => root.querySelectorAll(".drop-before,.drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
      const isAfter = (el, e) => { const r = el.getBoundingClientRect(); return axis === "vertical" ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2; };
      root.querySelectorAll(selector).forEach((el) => {
        el.addEventListener("dragstart", (e) => { dragKey = el.dataset.col; e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); });
        el.addEventListener("dragend", () => { dragKey = null; el.classList.remove("dragging"); clear(); });
        el.addEventListener("dragover", (e) => {
          if (!dragKey || dragKey === el.dataset.col || !canDrop(dragKey, el.dataset.col)) return;
          e.preventDefault(); clear(); el.classList.add(isAfter(el, e) ? "drop-after" : "drop-before");
        });
        el.addEventListener("drop", (e) => {
          if (!dragKey) return;
          e.preventDefault(); const k = dragKey, after = isAfter(el, e); clear(); onDrop(k, el.dataset.col, after);
        });
      });
    },

    /** 権限区分 → 色の鍵（見出しの札 role-*・マスタの札 c-*）。登録が無い区分は一般ユーザー（user）。 */
    roleKey: (role) => ({ "開発者": "dev", "メンテナンス者": "maint", "設備作業者": "op" })[role] || "user",
  };
})();
