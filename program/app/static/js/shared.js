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
      if (!pending.size) return;
      try {
        const changed = {}, removed = [], keys = [...pending];
        keys.forEach((k) => { const v = ls().getItem(k); if (v == null) removed.push(k); else changed[k] = v; });
        pending.clear();
        const body = JSON.stringify({ changed, removed }), base = +ls().getItem(REV) || 0;
        if (beacon && sendBeacon(URL, body)) return;
        fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 })
          .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
          // 自分の続きなら控えと揃っている。そうでなくても「一度は送れた」（前の版の設定は控えに入った）印に 0 を置き、
          // 次に開くとき控え全体から戻す（印が無いままだと、開くたびに前の版の設定として重ね続ける）
          .then((d) => { if (d.rev === base + 1) ls().setItem(REV, String(d.rev)); else if (ls().getItem(REV) == null) ls().setItem(REV, "0"); })
          .catch(() => { keys.forEach((k) => pending.add(k)); });   // 送れなかった名前は次に送る
      } catch (_) { /* 送れなくても画面は動く */ }
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
    /** 作ったファイルを保存させる。 */
    download(blob, name) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
    },
    /** 値だけの深い写し（設定・下書きを元と切り離す）。 */
    clone: (v) => JSON.parse(JSON.stringify(v)),

    /** 重なって開く窓を登録する。Esc（いちばん上の1枚）と、backdrop なら窓の外側（背景）を押したときに close()。 */
    layer(el, close, { backdrop = true } = {}) {
      layers.push({ el, close });
      if (backdrop) el.addEventListener("click", (e) => { if (e.target === el) close(); });
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
      const r = anchor.getBoundingClientRect(), w = el.offsetWidth;
      el.style.top = `${Math.round(r.bottom + 6)}px`;
      el.style.left = `${Math.round(Math.max(8, Math.min(align === "right" ? r.right - w : r.left, innerWidth - w - 8)))}px`;
    },
    /** メニューを押した位置に置く（画面からはみ出さない）。 */
    placeAt(el, x, y) {
      el.style.left = `${Math.round(Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)))}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)))}px`;
    },

    /** 動かせる・大きさを変えられる窓（表示列・読み替えルール）。位置と大きさを key でこの PC に覚え、
        [data-drag] の見出しを掴んで動かせる（見出しが画面に残る範囲）。w・h・top は覚えが無いときの大きさと上端、
        align は覚えが無いときの左右の置き場（center＝真ん中／right＝右寄せ。後ろの一覧を隠しすぎない窓）。
        戻り値: place() 覚えた位置に置く（画面が変わっていれば収める）／ remember() いまの位置と大きさを覚える（隠す前に）。 */
    floatPanel(panel, { key, w = 1200, h = 780, top = 40, align = "center" }) {
      const MIN_W = 400, MIN_H = 300;
      const remember = () => {
        if (panel.hidden) return;
        const b = panel.getBoundingClientRect();
        if (b.width < MIN_W || b.height < MIN_H) return;   // 出ていない・畳まれた大きさは覚えない
        TPA.local.set(key, { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) });
      };
      panel.querySelector("[data-drag]").addEventListener("mousedown", (e) => {
        if (e.target.closest("button,input")) return;
        const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
        const move = (ev) => {
          panel.style.left = Math.max(0, Math.min(ev.clientX - dx, innerWidth - 80)) + "px";
          panel.style.top = Math.max(0, Math.min(ev.clientY - dy, innerHeight - 40)) + "px";
        };
        const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); remember(); };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      });
      new ResizeObserver(remember).observe(panel);   // 大きさは右下の取っ手（CSS resize）
      return {
        remember,
        place() {
          let r = TPA.local.get(key, null);
          if (!r || r.w < MIN_W || r.h < MIN_H) r = null;
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
