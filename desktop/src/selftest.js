/* 自己診断（環境変数 TPA_SELFTEST=結果のファイル で起動したときだけ、窓が画面に流し込む）。
   本物の WebView の中から、窓（Rust）と中身（Python）の組が正しく動くかを確かめて /__desktop/selftest へ送る。窓は結果を書いて終わる。
   調べること: 起動が終わる・振り分け（部品は Rust・画面と API は Python・窓のことは Rust）・使い回しの決まり・大きな日本語の本文・
   日本語の問い合わせ文字・40 本同時・安全な文脈・保存領域・保存（ダウンロード）・窓の情報・画面のエラーが無い・速さ。 */
(async () => {
  const res = [];
  const ok = (name, cond, info = "") => res.push({ name, ok: !!cond, info: String(info).slice(0, 300) });
  const t0 = performance.now();
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const get = async (url, opt) => { const r = await fetch(url, opt); return { r, by: r.headers.get("X-TPA-By"), text: await r.text() }; };
  const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    // 1) 起動が終わる（画面の JS が設定と自分の権限を読み終えた）
    const end = performance.now() + 60000;
    const booted = () => typeof state === "object" && state.config && state.me;
    while (!booted() && performance.now() < end) await sleep(200);
    ok("起動が終わる（設定と権限を読み終える）", booted(), ((performance.now() - t0) / 1000).toFixed(1) + " 秒");
    const app = document.querySelector('meta[name="tpa-app"]');
    ok("画面の題（Python が作った HTML・アプリの名前）", app && document.title === app.content, document.title);
    ok("画面の JS が動いている（TPA の共通部品）", typeof TPA === "object" && typeof TPA.download === "function");

    // 2) 振り分けと使い回しの決まり
    const fp = (document.querySelector('meta[name="tpa-build"]') || {}).content || "x";
    const js = await get(`/static/js/shared.js?v=${fp}`);
    ok("部品は Rust が返す（指紋付きは長く使い回す）", js.by === "shell" && js.r.ok && /immutable/.test(js.r.headers.get("Cache-Control") || ""), js.by);
    const plain = await get("/static/js/shared.js");
    ok("指紋の無い部品は毎回確かめる（no-cache）", plain.by === "shell" && plain.r.headers.get("Cache-Control") === "no-cache" && plain.text === js.text);
    const three = await get(`/static/vendor/three/three-bundle.min.js?v=${fp}`);
    ok("大きな部品（three.js）も Rust が返す", three.by === "shell" && three.r.ok && three.text.length > 100000, `${three.r.status} ${three.text.length}字`);
    const page = await get("/");
    ok("画面は Python が作る（使い回さない）", page.by === "python" && page.r.ok && page.r.headers.get("Cache-Control") === "no-store", page.by);
    const escape = await get("/static/%2e%2e/templates/index.html");
    ok("static の外へは出ない", escape.r.status === 404, escape.r.status);

    // 3) API
    const b = await get("/api/build");
    ok("API が答える（/api/build）", b.r.ok && b.by === "python" && JSON.parse(b.text).version, b.text.slice(0, 80));
    const ch = await get("/api/changelog");
    ok("大きな答え（更新履歴）が欠けずに届く", ch.r.ok && JSON.parse(ch.text).entries.length > 10, ch.text.length + " 字");
    const nf = await get("/api/no-such-route");
    ok("無いところは 404", nf.r.status === 404 && nf.by === "python", nf.r.status);
    const bad = await get("/api/ui-state", json("POST", { changed: "形が違う" }));
    const why = (JSON.parse(bad.text).error || "");
    ok("誤りの答え（400 と日本語の理由）", bad.r.status === 400 && /形が違います/.test(why), why);

    // 4) 大きな日本語の本文（約 460KB）が往復する——画面の設定の控えへ重ねて読み戻し、消す
    const big = "汚れ位置・発見設備と転写".repeat(13000), key = "tpa.selftestBig";
    const put = await get("/api/ui-state", json("POST", { changed: { [key]: big } }));
    const back = JSON.parse((await get("/api/ui-state")).text);
    ok("約 460KB の日本語の本文が往復する", put.r.ok && (back.keys || {})[key] === big, `${put.r.status} / ${((back.keys || {})[key] || "").length}`);
    await get("/api/ui-state", json("POST", { changed: {}, removed: [key] }));

    // 5) 日本語の問い合わせ文字（Python のアプリが JSON で答える。元ファイルが無い PC では理由つきの誤り）
    const q = await get("/api/lotlist?search=" + encodeURIComponent("日本語・ロット") + "&page=1");
    let qj = null; try { qj = JSON.parse(q.text); } catch (_) { /* 下で失敗にする */ }
    ok("日本語の問い合わせ文字（Python が JSON で答える）", q.by === "python" && qj && (q.r.ok || qj.error), `${q.r.status} ${q.text.slice(0, 80)}`);

    // 6) 同時の問い合わせが混ざらない
    const paths = Array.from({ length: 40 }, (_, i) => (i % 2 ? "/api/build" : `/static/js/shared.js?v=p${i}`));
    const all = await Promise.all(paths.map((p) => get(p)));
    ok("40 本同時でも、それぞれの答えが届く", all.every((x, i) => x.r.ok && (i % 2 ? JSON.parse(x.text).version : x.by === "shell")));

    // 7) 安全な文脈・保存領域
    ok("安全な文脈（クリップボードへ写せる）", window.isSecureContext && !!(navigator.clipboard && navigator.clipboard.writeText),
       `isSecureContext=${window.isSecureContext}`);
    localStorage.setItem("tpaSelftestV1", "1");
    ok("localStorage が使える", localStorage.getItem("tpaSelftestV1") === "1");
    localStorage.removeItem("tpaSelftestV1");
    const idb = await new Promise((done) => { const r = indexedDB.open("tpaSelftest", 1); r.onsuccess = () => { r.result.close(); done(true); }; r.onerror = () => done(false); });
    ok("IndexedDB が使える", idb);

    // 8) 保存（ダウンロード）: 画面の保存の道（TPA.download）で CSV が名前どおり・中身どおりに届く。窓は自己診断のときだけ記録する
    TPA.download(new Blob(["﻿ロット,値\r\nA,1\r\n"], { type: "text/csv;charset=utf-8" }), "自己診断_保存.csv");
    let saved = null;
    for (let i = 0; i < 100 && !saved; i++) {
      await sleep(200);
      saved = (await (await fetch("/__desktop/downloads")).json()).find((x) => x.state === "finished");
    }
    ok("保存: CSV が日本語の名前どおり・中身どおりに届く", saved && saved.success && saved.head === "efbbbfe3" && /自己診断_保存.*\.csv$/.test(saved.path || ""),
       JSON.stringify(saved));

    // 9) 窓の情報（枠の約束の版・目印・受け持ち）
    const info = await (await fetch("/__desktop/info")).json();
    const ready = info.backend || {};
    ok("窓の情報: 枠の約束の版が中身と同じ・目印・作業場所", info.protocol === 1 && ready.protocol === info.protocol && /transferpitchanalyzer/.test(info.app_id) && !!info.local_root,
       `protocol ${info.protocol}/${ready.protocol} serves=${JSON.stringify(info.serves)} root=${info.local_root}`);
    ok("窓の版と中身の版が同じ", info.shell_version === ready.version, `${info.shell_version} / ${ready.version}`);

    // 10) 画面のエラーが無い（窓の外の受け口 /__desktop/update などが無くても、画面は黙って続ける）
    await sleep(500);
    const errs = window.__tpaErrors || [];
    ok("画面のエラーが無い", errs.length === 0, errs.join(" / "));

    // 11) 速さ（参考）: Python へ 30 回・Rust の部品 30 回の平均（ミリ秒）
    const avg = async (url) => { const s = performance.now(); for (let i = 0; i < 30; i++) await (await fetch(url)).arrayBuffer(); return (performance.now() - s) / 30; };
    const py = await avg("/api/build"), sh = await avg(`/static/js/shared.js?v=${fp}`);
    ok("問い合わせの速さ（参考）", py < 300, `Python ${py.toFixed(1)}ms / Rust の部品 ${sh.toFixed(1)}ms`);
  } catch (e) {
    ok("例外", false, e && (e.stack || e.message || e));
  }
  const body = JSON.stringify({ ok: res.every((r) => r.ok), elapsed_ms: Math.round(performance.now() - t0), ua: navigator.userAgent, results: res });
  await fetch("/__desktop/selftest", { method: "POST", headers: { "Content-Type": "application/json" }, body });
})();
