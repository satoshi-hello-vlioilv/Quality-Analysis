//! 画面（WebView）からの問い合わせの振り分け。得意なほうが答える:
//!   - /static/…           … Rust がディスク（program/app/static）から直接返す（JS・CSS・three.js。Python を通さず速い）
//!   - 窓そのものの操作      … Rust（終了・窓の情報・自己診断。main.rs が native として渡す）
//!   - それ以外（画面・API） … Python（サイドカー）へそのまま渡す
//!
//! 画面の JS は fetch("/api/...") のまま（同じ置き場への問い合わせ）で、ポートも CORS も要らない。

use crate::sidecar::{Ask, Reply, RequestError, Supervisor};
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::http::{Request, Response};

/// 問い合わせを答えに変える係（試験では作り物に差し替える）。
pub trait Backend: Send + Sync {
    fn ask(&self, ask: &Ask) -> Reply;
}

/// 長い問い合わせ（見えない Edge で LotDsp を読む・共有の写し直し）を待てる長さ。
const ASK_WAIT: Duration = Duration::from_secs(600);

impl Backend for Supervisor {
    fn ask(&self, ask: &Ask) -> Reply {
        // 送る前に止まっていた（Dead）なら起こし直して1度だけ送り直す。送った後に止まったものは送り直さない（二重に書かない）
        for attempt in 0..2 {
            let side = match self.get() {
                Ok(s) => s,
                Err(e) => return error_reply(503, "backend_unavailable", &e),
            };
            match side.request(ask, ASK_WAIT) {
                Ok(r) => return r,
                Err(RequestError::Dead) if attempt == 0 => continue,
                Err(RequestError::Timeout) => {
                    return error_reply(504, "backend_timeout", &format!("アプリの中身が {} 秒たっても答えません。", ASK_WAIT.as_secs()))
                }
                Err(_) => {
                    return error_reply(
                        503,
                        "backend_stopped",
                        "アプリの中身（Python）が途中で止まりました。もう一度お試しください（自動で起こし直します）。",
                    )
                }
            }
        }
        error_reply(503, "backend_stopped", "アプリの中身（Python）を起こし直せませんでした。")
    }
}

pub fn error_reply(status: u16, kind: &str, message: &str) -> Reply {
    Reply {
        status,
        headers: vec![("Content-Type".into(), "application/json".into())],
        body: serde_json::to_vec(&json!({"error": message, "kind": kind})).unwrap_or_default(),
    }
}

/// 窓そのものが答える問い合わせ。None ならほかへ回す。中身（Python）に尋ねたいときは backend を使う
/// （例: 異常ロット一覧は設定を Python に尋ねてから Rust が答える・lot.rs）。
pub struct Req<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub body: &'a [u8],
}
pub type Native = Box<dyn Fn(&Req, &dyn Backend) -> Option<Reply> + Send + Sync>;

/// Python が答えたあとに窓が見る（終了ボタンのあと、中身が片付けて終わったら窓も閉じる等）。
pub type After = Box<dyn Fn(&str, &str, u16) + Send + Sync>;

pub struct Router<B: Backend> {
    pub static_dir: PathBuf,
    pub backend: B,
    pub native: Native,
    pub after: After,
}

impl<B: Backend> Router<B> {
    pub fn handle(&self, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let uri = req.uri();
        let path = uri.path();
        let query = uri.query().unwrap_or("");
        let method = req.method().as_str();
        let (reply, by) = if let Some(r) = (self.native)(&Req { method, path, query, body: req.body() }, &self.backend) {
            (r, "shell")
        } else if let (true, Some(rest)) = (method == "GET" || method == "HEAD", path.strip_prefix("/static/")) {
            (static_file(&self.static_dir, rest, query), "shell")
        } else {
            let headers = req.headers().iter().filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string()))).collect();
            let r = self.backend.ask(&Ask { method, path, query, headers, body: req.body() });
            (self.after)(method, path, r.status);
            (r, "python")
        };
        to_response(reply, by)
    }
}

pub fn to_response(r: Reply, by: &str) -> Response<Vec<u8>> {
    let mut b = Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    // どちらが答えたか（自己診断・不具合の切り分けに使う）
    b = b.header("X-TPA-By", by);
    b.body(r.body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).unwrap())
}

/// /static/ の下のファイル。static フォルダの外へは出ない（.. や絶対パスは断る）。
pub fn static_file(root: &Path, rest: &str, query: &str) -> Reply {
    let decoded = percent_decode(rest);
    let rel = Path::new(&decoded);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return error_reply(404, "not_found", "ありません。");
    }
    match std::fs::read(root.join(rel)) {
        Ok(body) => {
            // 指紋の付いた URL（?v=プログラムの指紋。画面の型の url_for が付ける・app_build.fingerprint）は、
            // 中身が変われば指紋も変わるので長く使い回す。指紋の無い URL は毎回確かめる（Python の答えと同じ no-cache）
            let cache = if query.split('&').any(|kv| kv.starts_with("v=")) { "public, max-age=31536000, immutable" } else { "no-cache" };
            Reply {
                status: 200,
                headers: vec![("Content-Type".into(), mime(&decoded).into()), ("Cache-Control".into(), cache.into())],
                body,
            }
        }
        Err(_) => error_reply(404, "not_found", "ありません。"),
    }
}

pub fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Echo(Mutex<Vec<String>>);
    impl Backend for Echo {
        fn ask(&self, a: &Ask) -> Reply {
            self.0.lock().unwrap().push(format!("{} {}?{} {}", a.method, a.path, a.query, String::from_utf8_lossy(a.body)));
            Reply { status: 201, headers: vec![("Content-Type".into(), "text/plain".into())], body: b"py".to_vec() }
        }
    }

    fn router(dir: &Path) -> Router<Echo> {
        Router {
            static_dir: dir.to_path_buf(),
            backend: Echo(Mutex::default()),
            native: Box::new(|r, _| (r.method == "GET" && r.path == "/__desktop/info").then(|| error_reply(200, "info", "窓"))),
            after: Box::new(|_, _, _| {}),
        }
    }

    fn req(method: &str, uri: &str, body: &[u8]) -> Request<Vec<u8>> {
        Request::builder().method(method).uri(uri).body(body.to_vec()).unwrap()
    }

    #[test]
    fn each_kind_goes_to_its_place() {
        let dir = std::env::temp_dir().join(format!("da-router-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("js")).unwrap();
        std::fs::write(dir.join("js").join("app.js"), "x=1").unwrap();
        std::fs::write(dir.join("js").join("日本.css"), "a{}").unwrap();
        let r = router(&dir);

        let s = r.handle(&req("GET", "tpa://localhost/static/js/app.js?v=123", b""));
        assert_eq!((s.status().as_u16(), s.body().as_slice()), (200, b"x=1".as_slice()));
        assert_eq!(s.headers()["content-type"], "text/javascript; charset=utf-8");
        assert_eq!(s.headers()["x-tpa-by"], "shell", "静的ファイルは Rust");
        assert!(s.headers()["cache-control"].to_str().unwrap().contains("immutable"), "版付きは使い回す");
        assert_eq!(r.handle(&req("GET", "tpa://localhost/static/js/app.js", b"")).headers()["cache-control"], "no-cache");
        assert_eq!(r.handle(&req("GET", "tpa://localhost/static/js/%E6%97%A5%E6%9C%AC.css", b"")).status(), 200, "日本語の名前");

        for bad in ["/static/../secret.txt", "/static/js/%2e%2e/%2e%2e/x", "/static//etc/passwd", "/static/js/none.js"] {
            assert_eq!(r.handle(&req("GET", &format!("tpa://localhost{bad}"), b"")).status(), 404, "{bad}");
        }

        let p = r.handle(&req("POST", "http://tpa.localhost/api/lotdsp/import?a=1", "本文".as_bytes()));
        assert_eq!((p.status().as_u16(), p.headers()["x-tpa-by"].to_str().unwrap()), (201, "python"));
        assert_eq!(r.backend.0.lock().unwrap().last().unwrap(), "POST /api/lotdsp/import?a=1 本文", "本文・問い合わせ文字はそのまま");

        let n = r.handle(&req("GET", "tpa://localhost/__desktop/info", b""));
        assert_eq!((n.status().as_u16(), n.headers()["x-tpa-by"].to_str().unwrap()), (200, "shell"), "窓のことは Rust");
        assert_eq!(r.handle(&req("GET", "tpa://localhost/", b"")).headers()["x-tpa-by"], "python", "画面は Python が作る");
        assert_eq!(
            r.handle(&req("POST", "tpa://localhost/static/js/app.js", b"")).headers()["x-tpa-by"],
            "python",
            "/static でも GET・HEAD 以外は Python へ"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decode() {
        assert_eq!(percent_decode("a%20b%E6%97%A5"), "a b日");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%日本"), "%日本", "% の後ろが文字でも落ちない");
        assert_eq!(percent_decode("a%4"), "a%4");
    }
}
