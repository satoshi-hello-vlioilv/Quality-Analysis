//! 異常ロット一覧の 3 つの問い合わせに窓（Rust）が答える係: 一覧（GET /api/lotlist）・データの時刻（GET /api/lotlist/source）・
//! 再読込（POST /api/lotlist/refresh）。答えの形は Python 版（program/app/routes/lotlist.py）と同じ。
//!
//! - 設定（元ファイル・写す間隔・古さのしきい・既定の表と件数・係）は Python に尋ねる（GET /api/lotlist/settings。参照先マスタは
//!   共有のマスタにあるため）。10 秒覚え、参照先を保存したら（invalidate）すぐ尋ね直す
//! - 設定の係（desktop.lotlist_engine）が "python" なら答えない（Python が写しも一覧も受け持つ）。問い合わせに engine=python を
//!   付けたときも、その1回だけ Python に任せる（自己診断の突き合わせ・食い違いの切り分け）
//! - 写しの係（mirror.rs）は 1 つだけ。Python は窓が lotlist を受け持つと名乗ると写さず、同じ台帳を読む

use crate::lotlist::{self, Args};
use crate::mirror::DbMirror;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 設定を覚える長さ（ほかの PC が参照先を直したときも、遅くともこれで切り替わる）。
pub const SETTINGS_TTL: Duration = Duration::from_secs(10);

const NO_SOURCE: &str = "ロット一覧の元ファイルが決まっていません。「マスタ管理」の「参照先」で元ファイルを入れてください。";

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub source: String,
    pub refresh_seconds: i64,
    pub stale_hours: f64,
    pub table: String,
    pub page_size: i64,
    pub engine: String,
}

impl Settings {
    pub fn from_json(v: &Value) -> Settings {
        let num = |k: &str, d: f64| v.get(k).and_then(Value::as_f64).unwrap_or(d);
        Settings {
            source: v["source"].as_str().unwrap_or("").into(),
            refresh_seconds: num("refresh_seconds", 60.0) as i64,
            stale_hours: num("stale_hours", 36.0),
            table: v["table"].as_str().unwrap_or("").into(),
            page_size: num("page_size", 500.0) as i64,
            engine: v["engine"].as_str().unwrap_or("rust").into(),
        }
    }
}

/// 設定を尋ねる手段（窓では Python への問い合わせ。試験では作り物）。
pub type AskSettings<'a> = &'a dyn Fn() -> Result<Value, String>;

pub struct Lot {
    cache_dir: PathBuf,
    mirror: Mutex<Option<Arc<DbMirror>>>,
    settings: Mutex<Option<(Instant, Settings)>>,
}

impl Lot {
    pub fn new(cache_dir: PathBuf) -> Lot {
        Lot { cache_dir, mirror: Mutex::default(), settings: Mutex::default() }
    }

    /// 参照先を保存したとき: 次の問い合わせで設定を尋ね直す。
    pub fn invalidate(&self) {
        *self.settings.lock().unwrap() = None;
    }

    fn settings(&self, ask: AskSettings) -> Result<Settings, String> {
        if let Some((at, s)) = self.settings.lock().unwrap().as_ref() {
            if at.elapsed() < SETTINGS_TTL {
                return Ok(s.clone());
            }
        }
        let s = Settings::from_json(&ask()?);
        *self.settings.lock().unwrap() = Some((Instant::now(), s.clone()));
        Ok(s)
    }

    /// 設定に合わせた写しの係（無ければ作り、変わっていれば切り替えて、背景の周回を始める）。
    fn mirror(&self, s: &Settings) -> Arc<DbMirror> {
        let mut cur = self.mirror.lock().unwrap();
        let m = match cur.as_ref() {
            Some(m) => {
                m.reconfigure(&s.source, s.refresh_seconds, s.stale_hours);
                m.clone()
            }
            None => {
                let m = DbMirror::new("lot_list", &s.source, &self.cache_dir, s.refresh_seconds, s.stale_hours);
                *cur = Some(m.clone());
                m
            }
        };
        m.start();
        m
    }

    /// 起動の直後: 設定を尋ねて写し始める（一覧を開いたときに待たせない）。
    pub fn warm(&self, ask: AskSettings) {
        if let Ok(s) = self.settings(ask) {
            if s.engine == "rust" {
                self.mirror(&s);
            }
        }
    }

    /// 窓が答える問い合わせなら (状態, 答え)。Python に任せるなら None。
    pub fn handle(&self, method: &str, path: &str, query: &str, ask: AskSettings) -> Option<(u16, Value)> {
        let mine = matches!((method, path), ("GET", "/api/lotlist") | ("GET", "/api/lotlist/source") | ("POST", "/api/lotlist/refresh"));
        if !mine || lotlist::parse_query(query).iter().any(|(k, v)| k == "engine" && v == "python") {
            return None;
        }
        let s = match self.settings(ask) {
            Ok(s) => s,
            // 設定を尋ねられない（Python が止まっている等）→ Python に任せる（同じ理由の答えが返る）
            Err(_) => return None,
        };
        if s.engine != "rust" {
            return None;
        }
        let m = self.mirror(&s);
        Some(match path {
            "/api/lotlist/source" => (200, m.source_info()),
            "/api/lotlist/refresh" => {
                let r = m.refresh(true);
                (200, json!({"result": r, "source": m.source_info()}))
            }
            _ => match m.read_path() {
                None => (400, json!({"error": NO_SOURCE, "source": m.source_info()})),
                Some(p) => {
                    let today = chrono::Local::now().date_naive();
                    match lotlist::query(&p, &Args::from_query(query), &s.table, s.page_size, today) {
                        Ok(mut v) => {
                            v["source"] = m.source_info();
                            (200, v)
                        }
                        Err(e) => (503, json!({"error": e, "source": m.source_info()})),
                    }
                }
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn fixture(dir: &std::path::Path) -> PathBuf {
        let p = dir.join("src.sqlite3");
        let c = rusqlite::Connection::open(&p).unwrap();
        c.execute_batch("CREATE TABLE [仕掛] ([ロット番号] TEXT, [重量] REAL); INSERT INTO [仕掛] VALUES ('L1', 1.5), ('L2', 2.0);")
            .unwrap();
        p
    }

    #[test]
    fn answers_with_the_mirror_and_follows_the_engine() {
        let dir = std::env::temp_dir().join(format!("da-lot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = fixture(&dir);
        let lot = Lot::new(dir.join("cache"));
        let asked = Cell::new(0);
        let engine = Mutex::new("rust");
        let ask = || {
            asked.set(asked.get() + 1);
            Ok(json!({"source": src.display().to_string(), "refresh_seconds": 60, "stale_hours": 36, "table": "", "page_size": 500,
                      "engine": *engine.lock().unwrap()}))
        };
        let (st, v) = lot.handle("GET", "/api/lotlist", "page=1", &ask).expect("Rust が答える");
        assert_eq!((st, v["count"].as_i64(), v["source"]["mirrored"].as_bool()), (200, Some(2), Some(true)), "写してから引く: {v}");
        let (_, s) = lot.handle("GET", "/api/lotlist/source", "", &ask).unwrap();
        assert_eq!(s["mirrored"], true);
        assert_eq!(asked.get(), 1, "設定は覚えている間は1回だけ尋ねる");
        let (_, r) = lot.handle("POST", "/api/lotlist/refresh", "", &ask).unwrap();
        assert_eq!(r["result"]["updated"], true, "再読込は写し直す: {r}");
        assert!(lot.handle("GET", "/api/lotlist", "engine=python", &ask).is_none(), "engine=python はその1回だけ Python");
        assert!(lot.handle("GET", "/api/lotlist/settings", "", &ask).is_none(), "設定そのものは Python");
        *engine.lock().unwrap() = "python";
        lot.invalidate();
        assert!(lot.handle("GET", "/api/lotlist", "", &ask).is_none(), "設定の係が python なら Python に任せる");
        assert_eq!(asked.get(), 2, "保存のあとは尋ね直す");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_source_is_a_reasoned_400_and_a_dead_python_is_left_to_python() {
        let lot = Lot::new(std::env::temp_dir().join(format!("da-lot2-{}", std::process::id())));
        let ask = || Ok(json!({"source": "", "engine": "rust"}));
        let (st, v) = lot.handle("GET", "/api/lotlist", "", &ask).unwrap();
        assert_eq!((st, v["error"].as_str()), (400, Some(NO_SOURCE)));
        let lot = Lot::new(std::env::temp_dir().join("da-lot3"));
        let dead = || Err("止まっています".to_string());
        assert!(lot.handle("GET", "/api/lotlist", "", &dead).is_none());
    }
}
