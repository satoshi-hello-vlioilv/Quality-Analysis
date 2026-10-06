//! 窓の更新の係（裏の糸と画面への答え）。取り込み・入れ替えの中身は da_core::update、置き場の探し方は da_core::release。
//!
//! - 確かめる: 中身が起動した直後・30 分ごと・画面の「確かめる」（参照先で更新の置き場を保存したとき）
//! - 置き場（参照先 update.source）は中身（Python）に尋ねる（GET /api/update/settings。共有のマスタにあるため）
//! - 配る版が決まっていればその版（前の版へ戻すときも）、決まっていなければいちばん新しい版を、使っている間に取り込む
//! - 画面: GET /__desktop/update（状態）・POST /__desktop/update/check・POST /__desktop/update/apply（開き直す）・
//!   POST /__desktop/update/probe（参照先の「確かめる」: この PC での見え方で置き場を探す）

use crate::brand::brand;
use da_core::release::{self, newer};
use da_core::update::{self, Paths};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// 確かめる間隔。
const EVERY: Duration = Duration::from_secs(30 * 60);

pub struct Updater {
    pub paths: Paths,
    /// この PC のアプリ（app）で動いているか。開発の作業ツリー・共有から動くときは取り込まない
    pub installed: bool,
    /// いま動いている中身の版
    pub current: String,
    state: Mutex<Map<String, Value>>,
    wake: (Mutex<bool>, Condvar),
}

impl Updater {
    pub fn new(paths: Paths, installed: bool, current: String, notes: Vec<String>) -> Arc<Updater> {
        let mut st = Map::new();
        st.insert("state".into(), json!(if installed { "idle" } else { "off" }));
        st.insert("current".into(), json!(current));
        st.insert("notes".into(), json!(notes));
        if !installed {
            st.insert("detail".into(), json!("この PC のアプリ（作業場所の app）で動いていないので、更新は取り込みません"));
        }
        Arc::new(Updater { paths, installed, current, state: Mutex::new(st), wake: (Mutex::new(false), Condvar::new()) })
    }

    /// 画面へ（GET /__desktop/update）。
    pub fn status(&self) -> Value {
        let mut s = self.state.lock().unwrap().clone();
        s.insert("failed".into(), json!(update::failed_versions(&self.paths)));
        Value::Object(s)
    }

    fn set(&self, pairs: Value) {
        let mut s = self.state.lock().unwrap();
        for k in ["ready", "direction", "detail", "problem"] {
            s.remove(k);
        }
        if let Value::Object(m) = pairs {
            s.extend(m);
        }
    }

    /// すぐ確かめる（画面の「確かめる」・置き場の保存）。
    pub fn wake(&self) {
        *self.wake.0.lock().unwrap() = true;
        self.wake.1.notify_all();
    }

    /// 裏の糸: 確かめて、間隔を空けて繰り返す。ask は置き場の設定を中身に尋ねる。
    pub fn run(self: &Arc<Self>, ask: impl Fn() -> Result<Value, String> + Send + 'static, log: fn(&str)) {
        if !self.installed {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || loop {
            me.check(&ask, log);
            let (m, cv) = (&me.wake.0, &me.wake.1);
            let g = m.lock().unwrap();
            let (mut g, _) = cv.wait_timeout_while(g, EVERY, |w| !*w).unwrap();
            *g = false;
        });
    }

    /// 1 回確かめる（取り込みまで）。
    pub fn check(&self, ask: &dyn Fn() -> Result<Value, String>, log: fn(&str)) {
        let b = brand();
        self.set(json!({"state": "checking"}));
        let settings = match ask() {
            Ok(v) => v,
            Err(e) => return self.set(json!({"state": "error", "problem": format!("更新の置き場の設定を読めません: {e}")})),
        };
        let source = settings["source"].as_str().unwrap_or("").to_string();
        let checked = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
        {
            let mut s = self.state.lock().unwrap();
            s.insert("source".into(), json!(source));
            s.insert("checkedAt".into(), json!(checked));
        }
        if source.trim().is_empty() {
            let _ = std::fs::remove_file(self.paths.want());
            return self.set(json!({"state": "off"}));
        }
        let (found, adjusted) = match release::locate_source(&source) {
            Ok(f) => f,
            Err(e) => return self.set(json!({"state": "error", "problem": e})),
        };
        let scan = release::scan(&found, &b.app_id);
        {
            let mut s = self.state.lock().unwrap();
            s.insert("found".into(), json!(found.display().to_string()));
            s.insert("adjusted".into(), json!(adjusted));
            s.insert("distributed".into(), scan.distribute.as_ref().map(|d| d.raw.clone()).unwrap_or(Value::Null));
        }
        // 配る版（Python の利用状況が「最新版」に使う）。決まっていなければ消す
        match &scan.distribute {
            Some(d) => {
                let _ = update::write_json(&self.paths.want(), &d.raw);
            }
            None => {
                let _ = std::fs::remove_file(self.paths.want());
            }
        }
        let failed = update::failed_versions(&self.paths);
        let target = match &scan.distribute {
            Some(d) => scan.find(&d.version).filter(|r| !failed.contains(&r.version)),
            None => scan.by_version().into_iter().find(|r| !failed.contains(&r.version)),
        };
        let Some(target) = target else {
            let why = match &scan.distribute {
                Some(d) if failed.contains(&d.version) => format!("配る版 {} はこの PC で起動できなかったので使いません", d.version),
                Some(d) => format!("配る版 {} がまだ置き場にありません（BOX の同期待ちかもしれません）", d.version),
                None => "置き場にこのアプリの版がありません".into(),
            };
            return self.set(json!({"state": "latest", "detail": why}));
        };
        let distributed = scan.distribute.is_some();
        if target.version == self.current || (!distributed && !newer(&target.version, &self.current)) {
            // 取り込みかけの別の版は捨てる（配る版が戻された等）
            if update::staged(&self.paths).is_some_and(|s| s["version"] != json!(target.version)) {
                let _ = std::fs::remove_dir_all(self.paths.stage());
                let _ = std::fs::remove_file(self.paths.stage_record());
            }
            return self.set(json!({"state": "latest"}));
        }
        let direction = if newer(&target.version, &self.current) { "up" } else { "down" };
        if update::staged(&self.paths).is_some_and(|s| s["version"] == json!(target.version)) {
            return self.set(json!({"state": "ready", "ready": target.version, "direction": direction}));
        }
        self.set(json!({"state": "staging", "detail": target.version}));
        let progress = |_t: &str| {};
        match update::stage_release(&self.paths, target, &b.app_id, &progress) {
            Ok(_) => {
                log(&format!("UPDATE 版 {} を取り込みました（{}）", target.version, target.zip_path().display()));
                self.set(json!({"state": "ready", "ready": target.version, "direction": direction}));
            }
            Err(e) => {
                log(&format!("UPDATE 版 {} を取り込めません: {e}", target.version));
                self.set(json!({"state": "error", "problem": format!("版 {} を取り込めません: {e}", target.version)}));
            }
        }
    }

    /// 参照先の「確かめる」（この PC での見え方で探し、見つけた版を言う）。
    pub fn probe(value: &str) -> Value {
        let b = brand();
        let (found, adjusted) = match release::locate_source(value) {
            Ok(f) => f,
            Err(e) => return json!({"ok": false, "message": e}),
        };
        let scan = release::scan(&found, &b.app_id);
        let vers: Vec<String> = scan.by_version().iter().map(|r| r.version.clone()).collect();
        let adj = if adjusted { "（この PC での BOX の見え方に合わせて探しました）" } else { "" };
        let dist = scan.distribute.as_ref().map(|d| format!("・配る版 {}", d.version)).unwrap_or_default();
        let problems = if scan.problems.is_empty() { String::new() } else { format!("。読めない物: {}", scan.problems.join("・")) };
        if vers.is_empty() {
            return json!({"ok": true, "message": format!("置き場 {}{adj} に届きました。このアプリの版はまだ置いてありません{problems}", found.display())});
        }
        json!({"ok": true, "message": format!("置き場 {}{adj} に届きました。版 {} 個（いちばん新しい版 {}）{dist}{problems}",
            found.display(), vers.len(), vers[0])})
    }
}
