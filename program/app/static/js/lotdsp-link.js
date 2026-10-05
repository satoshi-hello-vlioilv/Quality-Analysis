"use strict";
/* =========================================================================
   LotDsp 項目の紐づけ（調査の道具・/lotdsp-link）
   保存した LotDsp の画面（タブごとの HTML）を選ぶ → POST /api/lots/lotdsp-api/link → 「項目 ↔ 画面の見出し」の一覧。
   選んだ時点で、読んだタブ名とロット番号をすぐ見せる（取り違え・LotDsp の画面でないファイルに、押す前に気づける）。
   ========================================================================= */
(function () {
  const { $, esc } = TPA;
  const el = { files: $("#files"), drop: $("#drop"), list: $("#fileList"), run: $("#run"), clear: $("#clear"), state: $("#state"),
    result: $("#result"), sum: $("#sum"), next: $("#next"), seg: $("#tabSeg"), onlyNew: $("#onlyNew"), q: $("#q"), copy: $("#copy"),
    rows: $("#rows"), only: $("#onlyScreen") };
  let picked = [];             // [{name, html, tab, lot, error}]
  let data = null;             // サーバーの答え
  let tab = "";                // 絞り込み中のタブ（空＝すべて）
  const nfkc = (s) => String(s || "").normalize("NFKC").trim();

  /* 選んだ画面を、押す前に軽く読む（タブ名とロット番号）。サーバーの読み方（lotdsp_link.read_screen）と同じ手がかり */
  function peek(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tabName = nfkc((doc.querySelector(".MniTabSelTxt span") || {}).textContent);
    let lot = "";
    for (const td of doc.querySelectorAll("td")) {
      if (nfkc(td.textContent).replace(/\s/g, "") !== "ﾛｯﾄ番号".normalize("NFKC")) continue;
      const tr = td.closest("tr"), next = tr && tr.nextElementSibling;
      const i = [...tr.children].indexOf(td);
      const v = next && next.children[i];
      if (v && nfkc(v.textContent)) { lot = nfkc(v.textContent); break; }
    }
    return { tab: tabName, lot };
  }

  async function addFiles(list) {
    for (const f of list) {
      if (picked.some((p) => p.name === f.name && p.size === f.size)) continue;
      const html = await f.text();
      const info = peek(html);
      picked.push({ name: f.name, size: f.size, html, ...info,
        error: info.lot ? "" : "LotDsp の画面からロット番号を読めません（保存した画面か確かめてください）" });
    }
    renderFiles();
  }

  function renderFiles() {
    el.list.innerHTML = picked.map((p, i) => `<li><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span>`
      + (p.error ? `<span class="tag ng">${esc(p.error)}</span>`
        : `<span class="tag">${esc(p.tab || "タブ名なし")}</span><span class="meta">ロット ${esc(p.lot)}</span>`)
      + `<button type="button" class="lk-ghost" data-rm="${i}" aria-label="外す">外す</button></li>`).join("");
    const ok = picked.filter((p) => !p.error);
    el.run.disabled = !ok.length;
    el.clear.hidden = !picked.length;
    // 押す前の案内: 同じタブでロットが1つだけなら、確定しにくいことを先に言う
    const byTab = {};
    ok.forEach((p) => { (byTab[p.tab || "タブ名なし"] = byTab[p.tab || "タブ名なし"] || new Set()).add(p.lot); });
    const single = Object.entries(byTab).filter(([, s]) => s.size < 2).map(([t]) => t);
    el.state.className = "lk-state";
    el.state.textContent = !ok.length ? (picked.length ? "" : "")
      : single.length ? `「${single.join("」「")}」はロットが1つだけです。照合はできますが、別のロットも選ぶと確定しやすくなります。`
        : `${ok.length} ファイルを照合できます。`;
  }

  async function run() {
    const ok = picked.filter((p) => !p.error);
    el.run.disabled = true;
    el.state.className = "lk-state is-busy";
    el.state.textContent = `照合中…（${ok.length} ファイル。LotDsp の API を引いています）`;
    try {
      const r = await fetch("/api/lots/lotdsp-api/link", TPA.json("POST", { files: ok.map((p) => ({ name: p.name, html: p.html })) }));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "照合できませんでした");
      data = d; tab = "";
      el.state.className = "lk-state";
      el.state.textContent = "";
      // ファイルごとの失敗（API に届かない・該当なし など）を、一覧の札に反映
      (d.files || []).forEach((f) => { const p = picked.find((x) => x.name === f.name); if (p && f.error) p.error = f.error; });
      renderFiles();
      render();
    } catch (e) {
      el.state.className = "lk-state is-err";
      el.state.textContent = e.message;
    }
    el.run.disabled = !picked.some((p) => !p.error);
  }

  const STATUS = { "確定": "ok", "候補": "cand", "食い違い": "ng" };
  function visible() {
    const q = nfkc(el.q.value).toLowerCase();
    return (data.links || []).filter((r) => (!tab || r.tab === tab) && (!el.onlyNew.checked || !r.used_for)
      && (!q || (r.path + " " + r.labels.join(" ")).toLowerCase().includes(q)));
  }
  function render() {
    if (!data) return;
    el.result.hidden = false;
    const s = data.summary;
    el.sum.innerHTML = [["ok", s.confirmed, "確定"], ["cand", s.candidates, "候補（もう1ロットで確かめる）"], ["ng", s.conflicts, "食い違い"]]
      .map(([c, n, t]) => `<div class="lk-chip ${c}"><b>${n}</b><span>${t}</span></div>`).join("");
    const lots = (s.lots || []).length;
    el.next.innerHTML = !s.linked ? "<b>紐づけできた項目がありませんでした。</b>ロット番号が合っているか、画面が LotDsp の保存画面かを確かめてください。"
      : s.conflicts ? "<b>食い違い</b>は、同じ項目が別のロットで別の見出しに当たったものです。値が偶然同じ欄に当たった可能性があります。別のロットも足して照合し直してください。"
        : s.candidates ? `<b>候補</b>が残っています。同じタブを<b>別のロットでもう1つ</b>選んで照合し直すと、確定が増えます（いま ${lots} ロット）。`
          : "<b>すべて確定しました。</b>「使っていない項目だけ」で絞り、取り込みたい項目を選んで教えてください。";
    const tabs = s.tabs || [];
    el.seg.innerHTML = [["", "すべて"]].concat(tabs.map((t) => [t, t])).map(([v, t]) =>
      `<button type="button" role="radio" data-tab="${esc(v)}" aria-checked="${v === tab}">${esc(t)}</button>`).join("");
    const rows = visible();
    let last = null, html = "";
    for (const r of rows) {
      if (!tab && r.tab !== last) { html += `<tr class="tab-row"><td colspan="4">${esc(r.tab)}</td></tr>`; last = r.tab; }
      const alt = r.labels.slice(1);
      html += `<tr><td><span class="lk-st ${STATUS[r.status]}">${esc(r.status)}</span></td>`
        + `<td class="lbl">${esc(r.labels[0] || "")}${alt.length ? ` <span class="lk-alt">／ ${esc(alt.join(" ／ "))}</span>` : ""}</td>`
        + `<td class="path">${esc(r.path)}</td><td class="used">${esc((r.used_for || []).join("、") || "（未使用）")}</td></tr>`;
    }
    el.rows.innerHTML = html || '<tr><td colspan="4" class="used">当てはまる項目がありません</td></tr>';
    const so = Object.entries(data.screen_only || {}).filter(([t]) => !tab || t === tab);
    el.only.hidden = !so.length;
    el.only.innerHTML = `<summary>画面にあって、応答のどの項目にも当たらなかった見出し（${so.reduce((n, [, v]) => n + v.length, 0)}）</summary>`
      + so.map(([t, v]) => `<p><b>${esc(t)}</b>: ${esc(v.join("、"))}</p>`).join("")
      + '<p class="lk-alt">画面の中で計算した値・別の問い合わせから来る値・値が目立たない欄（0 や 1 など）です。</p>';
  }

  // ---- 操作
  el.files.addEventListener("change", () => { addFiles([...el.files.files]); el.files.value = ""; });
  ["dragenter", "dragover"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => el.drop.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.remove("is-over"); }));
  el.drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
  el.list.addEventListener("click", (e) => { const b = e.target.closest("[data-rm]"); if (b) { picked.splice(+b.dataset.rm, 1); renderFiles(); } });
  el.clear.onclick = () => { picked = []; data = null; el.result.hidden = true; renderFiles(); };
  el.run.onclick = run;
  el.seg.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); } });
  el.onlyNew.onchange = render;
  el.q.oninput = render;
  /* 応答に入っている項目の一覧（GET /api/lots/lotdsp-api/survey）。以前はブラウザのアドレス欄で開いていた（版 3.0.0 で窓の中に） */
  const sv = { lot: $("#svLot"), values: $("#svValues"), run: $("#svRun"), copy: $("#svCopy"), state: $("#svState"), out: $("#svOut") };
  const svSay = (text, kind = "") => { sv.state.textContent = text; sv.state.className = "lk-state" + (kind ? " is-" + kind : ""); };
  async function survey() {
    const lot = nfkc(sv.lot.value).toUpperCase();
    if (!lot) { svSay("ロット番号を入れてください", "err"); sv.lot.focus(); return; }
    sv.run.disabled = true; svSay("LotDsp の API に問い合わせています…", "busy");
    try {
      const r = await fetch(`/api/lots/lotdsp-api/survey?lot=${encodeURIComponent(lot)}${sv.values.checked ? "&values=1" : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `読めませんでした（${r.status}）`);
      sv.out.textContent = JSON.stringify(d, null, 2);
      sv.out.hidden = false; sv.copy.hidden = false;
      svSay(`${lot}: ${(d.fields || d.items || []).length || "—"} 項目${sv.values.checked ? "（値あり・外へ渡さない）" : "（値なし）"}`);
    } catch (e) { svSay(e.message, "err"); }
    finally { sv.run.disabled = false; }
  }
  sv.run.onclick = survey;
  sv.lot.addEventListener("keydown", (e) => { if (e.key === "Enter") survey(); });
  sv.copy.onclick = async () => {
    try { await navigator.clipboard.writeText(sv.out.textContent); sv.copy.textContent = "コピーしました"; }
    catch (_) { sv.copy.textContent = "コピーできませんでした"; }
    setTimeout(() => { sv.copy.textContent = "コピー"; }, 2200);
  };

  el.copy.onclick = async () => {
    const tsv = ["タブ\t状態\t画面の見出し\t応答の項目\tいまの用途"].concat(visible().map((r) =>
      [r.tab, r.status, r.labels.join(" / "), r.path, (r.used_for || []).join("、")].join("\t"))).join("\n");
    try { await navigator.clipboard.writeText(tsv); el.copy.textContent = "コピーしました（値は含みません）"; }
    catch (_) { el.copy.textContent = "コピーできませんでした"; }
    setTimeout(() => { el.copy.textContent = "貼り付け用にコピー"; }, 2200);
  };
})();
