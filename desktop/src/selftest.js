/* 自己診断（環境変数 TPA_SELFTEST=結果のファイル で起動したときだけ、窓が画面に流し込む）。
   本物の WebView の中から、窓（Rust）と中身（Python）の組が正しく動くかを確かめて /__desktop/selftest へ送る。窓は結果を書いて終わる。
   調べること: 起動が終わる・振り分け（部品は Rust・画面と API は Python・窓のことは Rust）・使い回しの決まり・大きな日本語の本文・
   日本語の問い合わせ文字・40 本同時・安全な文脈・保存領域・保存（ダウンロード）・窓の情報・異常ロット一覧（Rust と Python の突き合わせ）・
   画面のエラーが無い・速さ。 */
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
    const q = await get("/api/lotlist?search=" + encodeURIComponent("日本語・ロット") + "&page=1&engine=python");
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

    // 10) 異常ロット一覧（Rust が写しから引く・lot.rs）。同じ問い合わせを Python（engine=python）でも引き、答えが同じか
    const ll = await get("/api/lotlist?page=1");
    ok("一覧は Rust が答える", ll.by === "shell", `${ll.by} ${ll.r.status}`);
    const llSrc = await get("/api/lotlist/source");
    ok("データの時刻は Rust が答える（共有を見に行かない）", llSrc.by === "shell" && llSrc.r.ok, llSrc.text.slice(0, 120));
    let llCount = 0; try { llCount = JSON.parse(ll.text).count || 0; } catch (_) { /* 下で言う */ }
    if (llCount > 0) {
      const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().filter((k) => k !== "timing" && k !== "source").map((k) => [k, canon(v[k])])) : v;
      const enc = (v) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));
      const qs = ["page=1", "search=" + enc("汚れ"), "page=3&page_size=50",
        "filters=" + enc([{ column: "発生日", op: "within_days", value: "90" }, { column: "設備", op: "starts_any", value: "L-,ＣＲ" }]),
        "group=1&sorts=" + enc([{ column: "重量", dir: "desc" }]),
        "filters=" + enc([{ column: "発生日", op: "within_days", value: "0" }, { column: "設備", op: "eq", value: "無い" }])];
      const differ = [], speed = { rust: 0, python: 0 };
      for (const q of qs) {
        let s = performance.now(); const rs = await get("/api/lotlist?" + q); speed.rust += performance.now() - s;
        s = performance.now(); const py = await get("/api/lotlist?" + q + "&engine=python"); speed.python += performance.now() - s;
        if (py.by !== "python" || JSON.stringify(canon(JSON.parse(rs.text))) !== JSON.stringify(canon(JSON.parse(py.text)))) differ.push(q);
      }
      ok(`一覧: Rust と Python の答えが同じ（${qs.length} 通り・日本語の検索・絞り込み・ページ・まとめ・0 件の手がかり）`, differ.length === 0,
         differ.length ? differ.join(" | ") : `${llCount} 行・Rust ${speed.rust.toFixed(0)}ms / Python ${speed.python.toFixed(0)}ms`);
      const pySrc = JSON.parse((await get("/api/lotlist/source?engine=python")).text), rsSrc = JSON.parse(llSrc.text);
      ok("写しは 1 つ: Python も Rust が写した写しを読む（同じ台帳・同じ元の時刻）", rsSrc.mirrored && pySrc.mirrored && pySrc.at === rsSrc.at,
         `Rust ${rsSrc.at} / Python ${pySrc.at}`);
    } else {
      ok("一覧の突き合わせ: 元ファイルが無いので比べない（CI は試験用の品質データで比べる）", true, ll.text.slice(0, 120));
    }

    // 11) 配布の画面の係（窓）: 答えが返る・版を置けない人は理由つきで断られる（だれが置けるかは Python の権限）
    const rel = await get("/__desktop/release");
    let relj = {}; try { relj = JSON.parse(rel.text); } catch (_) { /* 下で言う */ }
    ok("配布の画面の係が答える（置き場に届くか・権限）", rel.by === "shell" && rel.r.ok && "reachable" in relj && relj.me,
       `${rel.r.status} reachable=${relj.reachable} canRelease=${(relj.me || {}).canRelease} ${relj.why || ""}`);
    if (relj.me && !relj.me.canRelease) {
      const put = await get("/__desktop/release/place?name=x.zip", { method: "POST", headers: { "Content-Type": "application/zip" }, body: new Uint8Array([80, 75]) });
      ok("版を置けない人は理由つきで断られる", put.r.status === 403 && /開発者・メンテナンス者/.test(put.text), `${put.r.status} ${put.text.slice(0, 80)}`);
    }

    // 12) 画面のエラーが無い（窓の外の受け口 /__desktop/update などが無くても、画面は黙って続ける）
    await sleep(500);
    const errs = window.__tpaErrors || [];
    ok("画面のエラーが無い", errs.length === 0, errs.join(" / "));

    // 13) 速さ（参考）: Python へ 30 回・Rust の部品 30 回の平均（ミリ秒）
    const avg = async (url) => { const s = performance.now(); for (let i = 0; i < 30; i++) await (await fetch(url)).arrayBuffer(); return (performance.now() - s) / 30; };
    const py = await avg("/api/build"), sh = await avg(`/static/js/shared.js?v=${fp}`);
    ok("問い合わせの速さ（参考）", py < 300, `Python ${py.toFixed(1)}ms / Rust の部品 ${sh.toFixed(1)}ms`);
  } catch (e) {
    ok("例外", false, e && (e.stack || e.message || e));
  }
  // 更新の係（この PC のアプリで動くときだけ取り込む）。取り込み中なら落ち着くまで待ち、状態を結果に添える（verify.py が読む）
  let update = null, info = null;
  try {
    const end = performance.now() + 60000;
    for (;;) {
      update = await (await fetch("/__desktop/update", { cache: "no-store" })).json();
      if (!["idle", "checking", "staging"].includes(update.state) || performance.now() > end) break;
      await sleep(500);
    }
    info = await (await fetch("/__desktop/info")).json();
    info.install = await (await fetch("/__desktop/install")).json();
    ok("更新の係が答える（取り込めない理由が無い）", update.state !== "error", `${update.state} ${update.ready || ""} ${update.problem || update.detail || ""}`);
  } catch (e) {
    ok("更新の係が答える", false, e && e.message);
  }
  const body = JSON.stringify({ ok: res.every((r) => r.ok), elapsed_ms: Math.round(performance.now() - t0), ua: navigator.userAgent, results: res,
    update, info: info && { exe: info.exe, program: info.program, installed: info.installed, version: (info.backend || {}).version,
      install: info.install } });
  await fetch("/__desktop/selftest", { method: "POST", headers: { "Content-Type": "application/json" }, body });
})();
