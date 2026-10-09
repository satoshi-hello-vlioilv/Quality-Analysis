// 画面の撮影の共通部分（開発用。ui-check.mjs・ui-variants.mjs が使う。元は Inventor の同じ名前の道具）。
//
// 窓の代わりの開発用サーバー（ui_server.py。試験用の品質データ 1500 行）を起こし、Playwright の Chromium（WebView2 と同じ系統）で、
// 利用者の画面と同じ大きさ（2160×1440・表示倍率 125% → 1728×1152）の頁を開く。
// 窓だけが答える /__desktop/*（ショートカットの様子など）は作り物で答える（デスクトップのショートカットだけが欠けた PC）。
// 状態（STATES）は、異常ロット一覧 → … → 更新履歴 → 表示列の設定 → マスタ管理 の順に 1 つの頁で進める。

import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const { chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright"));
export const PROGRAM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VIEW = { width: 1728, height: 1152 }; // 利用者の PC。フル HD（1920×1080）・125% なら 1536×864
/** "1536x864" → { width, height }（無ければ利用者の PC の大きさ） */
export const parseView = (text) => (text ? Object.fromEntries(text.split("x").map((v, i) => [i ? "height" : "width", Number(v)])) : VIEW);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const DESK = "C:\\Users\\user\\Desktop";
const START = "C:\\Users\\user\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs";
/** 窓の答えの作り物（この PC のアプリはある・スタートにだけショートカットがある） */
const INSTALL = {
  installed: true, runningFromApp: true, name: "Defect-Analyzer", appDir: "C:\\Users\\user\\AppData\\Local\\Defect-Analyzer\\app",
  shortcut: { links: [`${START}\\Defect-Analyzer.lnk`], places: [DESK, START], ask: false, declined: false },
};
/** 配布の置き場の作り物（版が 3 つ置いてあり、3.12.0 を配っている） */
const BOX = "C:\\Users\\user\\Box\\Defect-Analyzer";
const RELEASE = {
  reachable: true, found: BOX, adjusted: false, folder: BOX, appFolder: BOX, problems: [],
  distributed: { schema: 1, app_id: "defect-analyzer", version: "3.12.0", entry: "Defect-Analyzer.exe", setAt: "2026-10-06T16:40:00", setBy: "user", setPc: "PC-01", previous: "3.11.0" },
  versions: ["3.13.0", "3.12.0", "3.11.0"].map((v, i) => ({ version: v, placedAt: `2026-10-0${8 - i * 2}T12:30:00`, placedPc: "PC-01", placedBy: "user", source: "desktop-windows", zip: `Defect-Analyzer-${v}-windows.zip`, bytes: 6816621, dir: `${BOX}\\${v}` })),
  entry: { exists: true, path: `${BOX}\\Defect-Analyzer.exe` },
  me: { canRelease: true, role: "開発者" },
};
// まとめて見る（並び・まとめ）の状態で使う段: 設備 ▲ → 不良名 ▲、繰り返しを省く
const ARRANGE = { "仕掛": { levels: [{ column: "設備", dir: "asc", lot: false }, { column: "不良名", dir: "asc", lot: false }], heads: false, suppress: true } };

/** サーバーとブラウザーを起こす。{ browser, newPage(テーマ, 大きさ), close() } */
export async function launch() {
  const port = 8765 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("python", ["-u", path.join(PROGRAM, "tools/ui_server.py"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((done, fail) => { server.stdout.once("data", done); server.once("exit", (c) => fail(new Error(`ui_server.py が終わりました（${c}）`))); });
  const browser = await chromium.launch();
  return {
    browser,
    /** 異常ロット一覧が出た頁（まとめていない・拡大していない・覚えた設定の無い、まっさらな状態） */
    async newPage(theme, view = VIEW) {
      const context = await browser.newContext({ viewport: view, deviceScaleFactor: 1.25, colorScheme: theme, locale: "ja-JP" });
      await context.route("**/__desktop/**", (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === "/__desktop/install") return route.fulfill({ json: INSTALL });
        if (p === "/__desktop/release") return route.fulfill({ json: RELEASE });
        return route.fulfill({ status: 404, json: { error: "作り物の窓は答えません" } });
      });
      await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, body: "", headers: { "Content-Type": "text/css" } }));
      const page = await context.newPage();
      page.on("pageerror", (e) => console.warn(`[${theme}] page error: ${e.message}`));
      await page.goto(base);
      await page.waitForSelector("#llBody tr[data-i]", { timeout: 30000 });
      await sleep(500);
      return page;
    },
    async close() {
      await browser.close();
      server.kill();
    },
  };
}

/** 開いている浮かぶ窓・メニューを閉じる（次の状態の前に） */
async function closeAll(page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  // Esc で閉じない窓（表示列の設定・マスタ管理）は閉じるボタンで
  for (const sel of ["#llColumnPanel:not([hidden]) #lcClose", "#masterOverlay:not(.hidden) #masterCloseBtn"]) {
    const b = await page.$(sel);
    if (b) await b.click().catch(() => {});
  }
  await sleep(300);
}

// 状態: [名前, そこへ行く操作, 次に押すべきもの（新しい画面の data-next → 前の画面の部品 の順に探す）]
export const STATES = [
  ["list", async () => {}, "[data-next], #llBody .ll-lot"],
  ["grouped", async (p) => {
    await p.evaluate((a) => localStorage.setItem("tpa.lotlist.arrange.v1", JSON.stringify(a)), ARRANGE);
    await p.reload();
    await p.waitForSelector("#llBody tr[data-i]");
    await sleep(500);
  }, "[data-next], #llGroupBar [data-gedit]"],
  ["viewmenu", async (p) => { await p.click("#llViewBtn"); await sleep(400); }, "[data-next], #llLvAdd"],
  ["card", async (p) => { await closeAll(p); await p.dblclick("#llBody tr[data-i] td:nth-child(3)"); await sleep(600); }, "[data-next], .lk-pin"],
  ["calc", async (p) => { await closeAll(p); await p.click("#tabCalc"); await sleep(500); }, "[data-next], #query"],
  ["appmenu", async (p) => { await p.click("#appBtn"); await sleep(500); }, "[data-next], #amShortcut"],
  ["changelog", async (p) => { await closeAll(p); await p.click("#verBadge"); await sleep(600); }, "[data-next], #clClose"],
  // スライサー（設備で CR1・L-1 を選び、不良名を足したところ）と、表示の設定（道具の行の「表示の設定 ▾」）
  ["slicer", async (p) => { await closeAll(p); await p.click("#tabList"); await sleep(300); await p.click("#llSlicerBtn"); await sleep(400);
    for (const c of ["設備", "不良名"]) { await p.selectOption("#llSlicerAdd", c); await sleep(700); }
    for (const v of ["CR1", "L-1"]) { await p.click(`#llSlicer .sx-card[data-col="設備"] .sx-v[data-v="${v}"]`); await sleep(700); } }, "[data-next], #llSlicerAdd"],
  ["profile", async (p) => { await p.click("#llProfileBtn"); await sleep(600); }, "[data-next], #llProfileMenu button"],
  // 表示列の設定（一覧の「表示列」）: 開いた直後・列を 1 つ選んだところ
  ["columns", async (p) => { await closeAll(p); await p.click("#tabList"); await sleep(300); await p.click("#llColBtn"); await sleep(600); }, "[data-next], #lcSave"],
  ["columns-detail", async (p) => { await p.click('#lcList li[data-col="発生日"]').catch(() => p.click("#lcList li[data-col]")); await sleep(500); }, "[data-next], #lcSave"],
  // マスタ管理: 設備・参照先・アクセス権限・利用状況・アプリの配布（タブは DOM で押す。区分ごとにタブを隠す案でも同じ所へ行けるように）
  ["master", async (p) => { await closeAll(p); await p.click("#masterBtn"); await sleep(900); }, "[data-next], #masterAddBtn"],
  ["master-paths", async (p) => { await tab(p, "paths"); await sleep(900); }, "[data-next], #masterSettings button"],
  ["master-access", async (p) => { await tab(p, "access"); await sleep(800); }, "[data-next], #masterAddBtn"],
  ["master-presence", async (p) => { await tab(p, "presence"); await sleep(800); }, "[data-next], #masterSettings button"],
  ["master-release", async (p) => { await tab(p, "release"); await sleep(900); }, "[data-next], #masterSettings button"],
];

/** マスタ管理のタブを押す（見えていなくても押す） */
function tab(p, key) {
  return p.$eval(`#masterTabs [data-tab="${key}"]`, (b) => b.click());
}

/** 状態を順に進め、各状態で visit(名前, 次に押すべきもの) を呼ぶ（only を渡せば、その状態だけ） */
export async function walk(page, visit, only = null) {
  page.setDefaultTimeout(5000);   // 見つからない部品で 30 秒止まらない
  for (const [name, go, next] of STATES) {
    try {
      await go(page);
    } catch (e) {
      console.warn(`${name}: ${e.message.split("\n")[0]}`);
    }
    if (!only || only.includes(name)) await visit(name, next);
  }
}

/**
 * 画面の中で測る（page.evaluate に渡す。next: 主の行動の選び方）。
 *   next      … その状態で次に押すべきもの（主の行動）が、スクロールせずに見えているか・大きさ（px²）・押せるか
 *   primaries … 見えている主のボタン（塗りの .btn-primary）の数（1 つが望ましい: どれを押すか迷わない）
 *   controls  … 見えている操作の数（Hick の法則: 選択肢が多いほど迷う）と、スクロールしないと見えない操作の数
 *   text      … 見えている文字数（読む量）
 *   hidden    … 開いている浮かぶ窓・メニューの中で、スクロールしないと見えない高さ（px）
 *   cut       … 開いている浮かぶ窓・メニューが画面の下・右からはみ出した長さ（px。0 でないと届かない所がある）
 *   fonts     … 使っている文字の大きさの種類と、いちばん小さい文字（px）
 *   contrast  … 見えている文字のコントラスト比の最小（WCAG。4.5 未満は読みにくい）
 *   list      … 一覧（表）が画面に占める割合（ほかの欄が重なっている部分は除く）
 */
export function measure(nextSelector) {
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest("[hidden], .hidden");
  };
  const inView = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  // 色 → [r, g, b, a]（0〜255）。color-mix() の結果は color(srgb r g b / a)（0〜1）で返るので、255 倍する
  const rgb = (c) => {
    const n = (c.match(/[\d.]+/g) ?? []).map(Number);
    return c.startsWith("color(srgb") ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  // 文字の後ろの色（半透明は重ねる。グラデーション・画像の上は測らない）
  function backdrop(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null;
      const [r, g, b, a = 1] = rgb(s.backgroundColor);
      if (a > 0) layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    let base = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
    return base;
  }
  // 開いている浮かぶ窓（重なる窓・メニュー）。あればその中だけを数える
  const DIALOGS = ".master-form-overlay:not(.hidden), .master-overlay:not(.hidden), #llColumnPanel:not([hidden])";
  const pops = [...document.querySelectorAll(`${DIALOGS}, .ll-viewmenu:not([hidden]), .app-menu:not(.hidden), .fb-cond-menu:not([hidden])`)].filter(visible);
  // 重なる窓（いちばん上の 1 枚）。あればその中だけを数える
  const dialog = pops.filter((el) => el.matches(DIALOGS)).sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0] ?? null;
  const scope = (el) => !dialog || dialog.contains(el);
  const controls = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, summary, [role=button]")].filter(visible);
  const seen = controls.filter((el) => inView(el.getBoundingClientRect()));
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (t && visible(n.parentElement) && scope(n.parentElement) && inView(n.parentElement.getBoundingClientRect())) texts.push([n.parentElement, t]);
  }
  const sizes = new Map();
  let minContrast = 99, worst = "";
  for (const [el, t] of texts) {
    const s = getComputedStyle(el);
    sizes.set(s.fontSize, (sizes.get(s.fontSize) ?? 0) + t.length);
    const bg = backdrop(el);
    if (!bg) continue;
    const [r, g, b, a = 1] = rgb(s.color);
    if (a === 0) continue;                       // わざと透明にした字（繰り返しを省いた値）は読ませる字ではない
    const fg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const c = ratio(fg, bg);
    if (c < minContrast) [minContrast, worst] = [c, t.slice(0, 24)];
  }
  // 書いた順に探す（新しい画面の data-next を、前の画面の部品より先に）
  const next = (nextSelector ?? "").split(",").map((sel) => sel.trim()).filter(Boolean)
    .map((sel) => [...document.querySelectorAll(sel)].find((el) => visible(el) && scope(el))).find(Boolean) ?? null;
  const primaries = [...document.querySelectorAll(".btn-primary")].filter((el) => visible(el) && scope(el) && inView(el.getBoundingClientRect())).length;
  const nr = next?.getBoundingClientRect();
  const boxes = pops.map((el) => (/overlay/.test(el.className) ? el.firstElementChild : el)).filter(Boolean);
  const hidden = Math.max(0, ...boxes.map((el) => el.scrollHeight - el.clientHeight));
  const cut = Math.max(0, ...boxes.map((el) => { const r = el.getBoundingClientRect(); return Math.max(r.bottom - innerHeight, r.right - innerWidth); }));
  // 一覧の見えている面積: 一覧の枠から、上に重なる欄（浮かぶ窓など）を 8px 刻みで除く
  let list = 0;
  const wrap = document.querySelector("#lotListScreen:not([hidden]) .ll-grid-wrap");
  const box = wrap && visible(wrap) ? wrap.getBoundingClientRect() : null;
  if (box && !dialog) {
    let shown = 0, all = 0;
    for (let y = Math.max(0, box.top) + 4; y < Math.min(innerHeight, box.bottom); y += 8) {
      for (let x = Math.max(0, box.left) + 4; x < Math.min(innerWidth, box.right); x += 8) {
        all++;
        if (document.elementFromPoint(x, y)?.closest(".ll-grid-wrap")) shown++;
      }
    }
    list = all ? (shown / all) * ((box.width * box.height) / (innerWidth * innerHeight)) : 0;
  }
  return {
    next: next ? { selector: nextSelector, visible: visible(next) && inView(nr), enabled: !next.disabled, area: Math.round(nr.width * nr.height), top: Math.round(nr.top) } : null,
    primaries,
    controls: { visible: (dialog ? seen.filter(scope) : seen).length, belowFold: controls.filter((el) => scope(el) && !inView(el.getBoundingClientRect())).length },
    text: { visible: texts.reduce((n, [, t]) => n + t.length, 0) },
    hidden: Math.round(hidden),
    cut: Math.round(cut),
    fonts: { kinds: sizes.size, min: Math.min(...[...sizes.keys()].map(parseFloat)) },
    contrast: { min: Number(minContrast.toFixed(2)), worst },
    list: Number(list.toFixed(2)),
  };
}
