//! Defect-Analyzer（転写距離・ピッチ解析）デスクトップ版の窓（Tauri）。設計は program/docs/DESKTOP_MIGRATION_DESIGN.md。
//!
//! 役割の分け方（得意な分野ごと）:
//!   - Rust（この exe）: 窓・起動と終了・1つだけ起動・静的ファイル・中身（Python）の監督と起こし直し・外のリンク
//!   - Python（program/sidecar.py）: 画面と API（計算・LotDsp・マスタ・権限）。標準の部品だけで動く
//!   - 画面（WebView2）: program/app の HTML/JS/CSS。問い合わせは自前の仕組み（tpa）で Rust が受ける
//!
//! ポートを開かないので、プロキシ・ポートの取り合い・古いサーバーの残り・ハートビートによる推し量りが無い。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod brand;
mod frame;
mod locate;
mod proc;
mod router;
mod sidecar;

use brand::brand;
use da_core::lot::Lot;
use router::{error_reply, After, Backend, Native, Router};
use serde_json::json;
use sidecar::{Ask, Progress, Reply, Supervisor};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 自前の仕組みの名前。program/sidecar.py の BASE_URL（http://tpa.localhost/）と同じ（食い違うと URL の組み立てがずれる）。
const SCHEME: &str = "tpa";
const SELFTEST_JS: &str = include_str!("selftest.js");
const SELFTEST_LIMIT: Duration = Duration::from_secs(180);
/// 終了（/api/shutdown）を受けてから窓を閉じるまで。答えが画面へ届いてから閉じる。
const QUIT_DELAY: Duration = Duration::from_millis(150);
/// 自己診断のときだけ、画面の読み込みより前に入れる見張り（画面のエラーを残す。selftest.js が読む）。
const ERROR_WATCH_JS: &str = "window.__tpaErrors=[];addEventListener('error',e=>__tpaErrors.push(String(e.message||e.type)));\
addEventListener('unhandledrejection',e=>__tpaErrors.push('promise: '+String(e.reason&&(e.reason.message||e.reason))));";

/// 画面の置き場。Windows（WebView2）は http://tpa.localhost/、ほかは tpa://localhost/ になる（Tauri の決まり）。
fn app_url(path: &str) -> Url {
    let base = if cfg!(windows) { "http://tpa.localhost" } else { "tpa://localhost" };
    Url::parse(&format!("{base}{path}")).expect("app url")
}

fn is_app_url(u: &Url) -> bool {
    u.scheme() == SCHEME || u.host_str() == Some("tpa.localhost")
}

/// 起動画面（desktop/splash。Tauri が tauri://localhost で出す）
fn is_splash(u: &Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

fn selftest_on() -> bool {
    std::env::var_os("TPA_SELFTEST").is_some()
}

/// 窓の記録（この PC の作業場所の logs/desktop.log）。Python の記録（app.log・sidecar_stderr.log）とは別に、
/// 窓が確かめた事実（探した Python・起動の秒・終わり方）だけを残す。
fn log(line: &str) {
    let dir = locate::local_root().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {line}");
    }
}

type AppRouter = Router<Supervisor>;

/// 起動画面へ伝えること。画面が読み終わる前の分はためておき、読み終わったら流す。
#[derive(Default)]
struct Splash {
    loaded: AtomicBool,
    queue: Mutex<Vec<String>>,
}

impl Splash {
    fn say(&self, app: &AppHandle, js: String) {
        let mut q = self.queue.lock().unwrap();
        if self.loaded.load(Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval(&js);
            }
        } else {
            q.push(js);
        }
    }
    fn flush(&self, w: &WebviewWindow) {
        let mut q = self.queue.lock().unwrap();
        self.loaded.store(true, Ordering::SeqCst);
        for js in q.drain(..) {
            let _ = w.eval(&js);
        }
    }
    fn step(&self, app: &AppHandle, id: &str, state: &str, detail: &str) {
        self.say(app, format!("splash.step(...{})", json!([id, state, detail])));
    }
    fn fail(&self, app: &AppHandle, title: &str, detail: &str) {
        log(&format!("FAIL {title}: {}", detail.replace('\n', " / ")));
        self.say(app, format!("splash.fail(...{})", json!([title, detail])));
        selftest_finish(app, &json!({"ok": false, "error": format!("{title}: {detail}")}));
    }
}

/// 自己診断の結果を書いて終わる（TPA_SELFTEST が無ければ何もしない）。
fn selftest_finish(app: &AppHandle, result: &serde_json::Value) {
    if let Some(path) = std::env::var_os("TPA_SELFTEST") {
        let _ = std::fs::write(&path, serde_json::to_vec_pretty(result).unwrap_or_default());
        let code = if result["ok"] == true { 0 } else { 1 };
        app.exit(code);
    }
}

/// 窓そのものが答える問い合わせ（終了・窓の情報・自己診断の受け口・異常ロット一覧）。
fn native(app: AppHandle, info: serde_json::Value, lot: Arc<Lot>) -> Native {
    Box::new(move |req, backend| match (req.method, req.path) {
        // 画面の「終了」・版が混ざったときの「再起動する」。答えてから閉じる（中身の Python は入力が閉じて自分で終わる）
        ("POST", "/api/shutdown") => {
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(QUIT_DELAY);
                log("EXIT 画面の終了");
                app.exit(0);
            });
            Some(json_reply(&json!({"ok": true})))
        }
        ("GET", "/__desktop/info") => Some(json_reply(&info)),
        ("GET", "/__desktop/downloads") => Some(json_reply(&json!(downloads().lock().map(|v| v.clone()).unwrap_or_default()))),
        ("POST", "/__desktop/selftest") => {
            let result: serde_json::Value =
                serde_json::from_slice(req.body).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
            selftest_finish(&app, &result);
            Some(json_reply(&json!({"received": true})))
        }
        (method, path) => {
            lot.handle(method, path, req.query, &|| lot_settings(backend)).map(|(status, v)| Reply { status, ..json_reply(&v) })
        }
    })
}

/// 異常ロット一覧の設定を中身（Python）に尋ねる（lot.rs が 10 秒覚える）。
fn lot_settings(backend: &dyn Backend) -> Result<serde_json::Value, String> {
    let r = backend.ask(&Ask { method: "GET", path: "/api/lotlist/settings", query: "", headers: vec![], body: &[] });
    if r.status != 200 {
        return Err(format!("一覧の設定を読めません（{}）", r.status));
    }
    serde_json::from_slice(&r.body).map_err(|e| e.to_string())
}

/// 中身が答えたあとに窓が見ること: 参照先（設定）を保存したら、一覧の設定を尋ね直す（元ファイル・間隔をすぐ当て直す）。
fn after(lot: Arc<Lot>) -> After {
    Box::new(move |method, path, status| {
        if method == "PUT" && status == 200 && path.starts_with("/api/settings/") {
            lot.invalidate();
        }
    })
}

fn json_reply(v: &serde_json::Value) -> Reply {
    Reply {
        status: 200,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: serde_json::to_vec(v).unwrap_or_default(),
    }
}

/// 窓を作る（主の窓・別の窓で同じ決まり: 外のリンクはいつものブラウザで開く）。
fn window(app: &AppHandle, label: &str, url: WebviewUrl, splash: Arc<Splash>) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();
    let nav = app.clone();
    let b = brand();
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(format!("{} — {}", b.name, b.subtitle))
        .inner_size(1600.0, 1000.0)
        .min_inner_size(1100.0, 700.0)
        .maximized(label == "main")
        // 起動画面・画面の見出しと同じ藍（開いた瞬間の白い光りを出さない）
        .background_color(tauri::window::Color(0x1c, 0x35, 0x50, 0xff))
        // 画面がファイルのドロップを読めるように（Tauri は既定で窓へのドロップを横取りする）
        .disable_drag_drop_handler()
        .on_navigation(move |u| {
            let inside = is_app_url(u) || is_splash(u) || matches!(u.scheme(), "about" | "blob" | "data");
            if !inside {
                open_outside(&nav, u);
            }
            inside
        })
        .on_new_window(move |u, _features| {
            if is_app_url(&u) {
                let app = handle.clone();
                let s = Arc::new(Splash::default());
                let label =
                    format!("w{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
                // 窓は作り終えてから（呼ばれている最中に作ると止まることがある）
                std::thread::spawn(move || {
                    let _ = window(&app, &label, WebviewUrl::External(u), s);
                });
            } else {
                open_outside(&handle, &u);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |w, p| {
            if p.event() != PageLoadEvent::Finished {
                return;
            }
            if is_splash(p.url()) {
                splash.flush(&w);
            } else if is_app_url(p.url()) && p.url().path() == "/" && selftest_on() {
                let _ = w.eval(SELFTEST_JS);
            }
        });
    // 自己診断のときだけ: 画面のエラーを残し、保存を記録する（利用者の起動では WebView2 の既定の保存の案内のまま）
    let builder =
        if selftest_on() { builder.initialization_script(ERROR_WATCH_JS).on_download(|_, ev| record_download(ev)) } else { builder };
    builder.build()
}

/// LotDsp など外のページは、いつものブラウザ（Edge）で開く（ログインはそちらにある）。
fn open_outside(app: &AppHandle, u: &Url) {
    if matches!(u.scheme(), "http" | "https" | "mailto" | "file") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(u.as_str(), None::<&str>);
    }
}

/// 保存（ダウンロード）の記録。**自己診断のときだけ**付ける受け手が書き、`/__desktop/downloads` が自己診断へ渡す。
/// 利用者の起動では付けない（付けると WebView2 の既定の保存の案内が出なくなる）。
fn downloads() -> &'static Mutex<Vec<serde_json::Value>> {
    static D: OnceLock<Mutex<Vec<serde_json::Value>>> = OnceLock::new();
    D.get_or_init(Mutex::default)
}

/// 保存の始まりと終わりを残す（終わりは置いた先・大きさ・先頭4バイト）。保存先は変えない（既定の「ダウンロード」）。
fn record_download(ev: DownloadEvent<'_>) -> bool {
    let row = match ev {
        DownloadEvent::Requested { url, destination } => {
            json!({"state": "requested", "url": url.as_str(), "path": destination.display().to_string()})
        }
        DownloadEvent::Finished { url, path, success } => {
            let body = path.as_ref().and_then(|p| std::fs::read(p).ok()).unwrap_or_default();
            let head: String = body.iter().take(4).map(|b| format!("{b:02x}")).collect();
            json!({"state": "finished", "url": url.as_str(), "path": path.map(|p| p.display().to_string()),
                   "success": success, "bytes": body.len(), "head": head})
        }
        _ => return true,
    };
    log(&format!("DOWNLOAD {row}"));
    if let Ok(mut v) = downloads().lock() {
        v.push(row);
    }
    true
}

/// 中身（Python）を探して起こし、準備できたら主の窓を画面へ切り替える（裏の糸で。窓は先に出しておく）。
fn start(app: AppHandle, slot: Arc<OnceLock<AppRouter>>, splash: Arc<Splash>) {
    let program = match locate::program_dir() {
        Ok(p) => p,
        Err(e) => return splash.fail(&app, "アプリの中身が見つかりません", &e),
    };
    splash.step(&app, "program", "ok", &program.display().to_string());
    let py = match locate::python(&program) {
        Ok(p) => p,
        Err(e) => {
            splash.step(&app, "python", "bad", "見つかりません");
            return splash.fail(&app, "Python が見つかりません", &e);
        }
    };
    let py_text = format!("{} {}", py.exe.display(), py.args.join(" ")).trim().to_string();
    log(&format!("START program={} python={py_text}", program.display()));
    splash.step(&app, "python", "ok", &py_text);
    splash.step(&app, "backend", "now", "Python でアプリの中身を読み込んでいます…");
    let (app_p, splash_p) = (app.clone(), splash.clone());
    let progress: Progress = Arc::new(move |h| {
        let text = h["text"].as_str().unwrap_or("起動前の確認をしています");
        splash_p.step(&app_p, "backend", if h["bad"] == true { "warn" } else { "now" }, text);
    });
    let sup = Supervisor::new(py, program.clone(), locate::local_root().join("logs"), progress);
    let t0 = Instant::now();
    let ready = match sup.get() {
        Ok(s) => {
            // 起こした物と本物が違えば、入口（別名の python.exe）を通っている（止めるときは本物を待つ）
            if let (spawned, Some(real)) = s.pids() {
                log(&format!("PID 起こした {spawned}・本物の Python {real}"));
            }
            s.ready.clone()
        }
        Err(e) => {
            splash.step(&app, "backend", "bad", "起動できません");
            return splash.fail(&app, "アプリの中身（Python）が起動できません", &e);
        }
    };
    let version = ready["version"].as_str().unwrap_or("?").to_string();
    log(&format!("READY version={version} elapsed={:.2} spawn_ms={}", ready["elapsed"].as_f64().unwrap_or(0.0), t0.elapsed().as_millis()));
    splash.step(&app, "backend", "ok", &format!("版 {version} ・ {:.1} 秒", t0.elapsed().as_secs_f64()));
    let info = json!({
        "shell": "tauri", "app_id": brand().app_id, "shell_version": env!("CARGO_PKG_VERSION"), "commit": env!("TPA_BUILD_COMMIT"), "protocol": sidecar::PROTOCOL,
        "serves": sidecar::SERVES, "program": program, "python": py_text, "local_root": locate::local_root(),
        "exe": std::env::current_exe().unwrap_or_default(), "backend": ready, "url": app_url("/").as_str(),
    });
    let static_dir = program.join("app").join("static");
    // 異常ロット一覧（写しは作業場所の db_cache・Python と同じ台帳）
    let lot = Arc::new(Lot::new(locate::local_root().join("db_cache")));
    let _ = slot.set(Router { static_dir, backend: sup, native: native(app.clone(), info, lot.clone()), after: after(lot.clone()) });
    // 起動の直後から写し始める（一覧を開いたときに待たせない）
    let warm = slot.clone();
    std::thread::spawn(move || {
        if let Some(r) = warm.get() {
            lot.warm(&|| lot_settings(&r.backend));
        }
    });
    splash.step(&app, "open", "now", "画面を開いています…");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(app_url("/"));
    }
}

fn main() {
    let slot: Arc<OnceLock<AppRouter>> = Arc::default();
    let splash: Arc<Splash> = Arc::default();
    let proto_slot = slot.clone();

    let app = tauri::Builder::default()
        // 2つめを起こしたら、前の窓を前に出すだけ（ポートを見て止め直す仕組みが要らない）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // 画面からの問い合わせ（tpa）。1つずつ別の糸で答える（長い問い合わせが画面を止めない）
        .register_asynchronous_uri_scheme_protocol(SCHEME, move |_ctx, req, responder| {
            let slot = proto_slot.clone();
            std::thread::spawn(move || {
                let resp = match slot.get() {
                    Some(r) => r.handle(&req),
                    None => router::to_response(error_reply(503, "starting", "起動中です。"), "shell"),
                };
                responder.respond(resp);
            });
        })
        .setup({
            let slot = slot.clone();
            let splash = splash.clone();
            move |app| {
                let handle = app.handle().clone();
                window(&handle, "main", WebviewUrl::App("index.html".into()), splash.clone())?;
                splash.say(&handle, format!("splash.brand(...{})", json!([brand().name, brand().subtitle])));
                if selftest_on() {
                    let h = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(SELFTEST_LIMIT);
                        selftest_finish(&h, &json!({"ok": false, "error": format!("{} 秒で終わりませんでした", SELFTEST_LIMIT.as_secs())}));
                    });
                }
                std::thread::spawn(move || start(handle, slot, splash));
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("起動できません");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            // 中身の Python を止める（入力を閉じる → 片付けて自分で終わる。終わらなければ止める）
            if let Some(r) = slot.get() {
                r.backend.stop();
            }
            log("EXIT 窓を閉じた");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_of_the_app_and_the_splash() {
        assert!(is_app_url(&app_url("/api/build")), "自分の画面");
        assert!(is_app_url(&Url::parse("http://tpa.localhost/x").unwrap()), "Windows（WebView2）の形");
        assert!(is_app_url(&Url::parse("tpa://localhost/x").unwrap()), "ほかの OS の形");
        assert!(!is_app_url(&Url::parse("http://lotdsp.example/").unwrap()), "外のページ");
        assert!(is_splash(&Url::parse("tauri://localhost/index.html").unwrap()));
        assert!(is_splash(&Url::parse("http://tauri.localhost/index.html").unwrap()));
    }
}
