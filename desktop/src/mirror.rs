//! 共有上の品質データ（SQLite）を手元へ写してから読む係。Python 版（program/app/services/db_mirror.py）と**同じ手順・同じ台帳・同じ文言**。
//!
//! - 写し方: SQLite のバックアップ API → 失敗したらバイト単位のコピー。どちらも採用前に quick_check で検査する
//! - 世代名: 毎回 `<キー>.g<世代>.sqlite3` で作り、台帳 `_mirror.json` が今の世代を指す（開いているファイルを上書きしない）
//! - いつ: 背景の糸が一定間隔で元の (パス, 大きさ, 更新時刻 ns) を見て、変わっていれば写す。一覧の問い合わせの中では共有を見ない
//! - 台帳は Python と同じ形なので、どちらが写した写しも互いに読める（desktop/tests/mirror_parity.rs が突き合わせる）

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LEDGER: &str = "_mirror.json";
const DEFAULT_INTERVAL_SEC: i64 = 60;
const MIN_INTERVAL_SEC: i64 = 10;
const FIRST_WAIT: Duration = Duration::from_secs(30);
const STAT_RETRY_SEC: [f64; 3] = [0.3, 0.7, 1.5];
const RETRY_AFTER_UNREACHABLE_SEC: i64 = 10;
const REPLACE_BUDGET: f64 = 2.0;

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// OS の誤りの文（Python の _os_error_text と同じ形: "Errno 2 No such file or directory"・Windows は "WinError 2 …"）。
pub fn os_error_text(e: &std::io::Error) -> String {
    let text = e.to_string();
    match e.raw_os_error() {
        Some(n) => {
            let msg = text.strip_suffix(&format!(" (os error {n})")).unwrap_or(&text).trim();
            format!("{} {n} {msg}", if cfg!(windows) { "WinError" } else { "Errno" })
        }
        None => text,
    }
}

/// fn を、失敗のあいだ budget 秒まで間を広げながらやり直す（無い＝NotFound はやり直さない。Python の fsio.retrying と同じ）。
fn retrying<T>(budget: f64, mut f: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let (mut delay, mut waited) = (0.05, 0.0);
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e),
            Err(e) => {
                if waited >= budget {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_secs_f64(delay));
                waited += delay;
                delay = (delay * 2.0).min(0.5);
            }
        }
    }
}

/// JSON を置き換えで書く（途中で止まっても前の台帳か新しい台帳のどちらか）。Python の write_json_atomic（indent=1）と同じ形。
fn write_json_atomic(path: &Path, data: &Value) -> std::io::Result<()> {
    use serde::Serialize;
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp =
        path.with_file_name(format!(".{}.{}-{nanos}.tmp", path.file_name().unwrap_or_default().to_string_lossy(), std::process::id()));
    let mut buf = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, serde_json::ser::PrettyFormatter::with_indent(b" "));
    data.serialize(&mut ser).map_err(std::io::Error::other)?;
    buf.push(b'\n');
    let r = std::fs::write(&tmp, &buf).and_then(|_| retrying(REPLACE_BUDGET, || std::fs::rename(&tmp, path)));
    let _ = std::fs::remove_file(&tmp);
    r
}

fn sqlite_text(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(m)) => m.clone(),
        e => e.to_string(),
    }
}

/// 設定（元ファイル・間隔・古さのしきい）。
struct Conf {
    remote: String,
    interval: i64,
    stale_hours: f64,
}

#[derive(Default)]
struct Wake {
    woken: bool,
    first_done: bool,
}

pub struct DbMirror {
    pub key: String,
    cache_dir: PathBuf,
    conf: Mutex<Conf>,
    state: Mutex<Map<String, Value>>,
    refresh_lock: Mutex<()>,
    wake: Arc<(Mutex<Wake>, Condvar)>,
    started: Mutex<bool>,
}

impl DbMirror {
    pub fn new(key: &str, remote: &str, cache_dir: &Path, interval_sec: i64, stale_hours: f64) -> Arc<DbMirror> {
        let key = if key.is_empty() { "db" } else { key };
        let key: String = key.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        Arc::new(DbMirror {
            key,
            cache_dir: cache_dir.to_path_buf(),
            conf: Mutex::new(Conf { remote: remote.into(), interval: interval_of(interval_sec), stale_hours }),
            state: Mutex::default(),
            refresh_lock: Mutex::new(()),
            wake: Arc::default(),
            started: Mutex::new(false),
        })
    }

    pub fn remote(&self) -> String {
        self.conf.lock().unwrap().remote.clone()
    }

    fn enabled(&self) -> bool {
        !self.remote().is_empty()
    }

    /// 元ファイル・間隔・古さのしきいが変わったとき、起動し直さずに切り替える（背景の糸を起こして次の周回を今すぐ）。変わった物があれば true。
    pub fn reconfigure(self: &Arc<Self>, remote: &str, interval_sec: i64, stale_hours: f64) -> bool {
        let changed = self.reconfigure_quiet(remote, interval_sec, stale_hours);
        if changed {
            self.start();
            self.wake();
        }
        changed
    }

    /// 切り替えるだけ（背景の糸は起こさない。突き合わせの試験と、受け身の Python 版と同じ振る舞い）。
    pub fn reconfigure_quiet(&self, remote: &str, interval_sec: i64, stale_hours: f64) -> bool {
        let mut changed = false;
        {
            let mut c = self.conf.lock().unwrap();
            if remote != c.remote {
                c.remote = remote.into();
                *self.state.lock().unwrap() = Map::new();
                changed = true;
            }
            let iv = interval_sec.max(MIN_INTERVAL_SEC); // Python も切り替えでは 0 を既定にしない（max(10, int(n))）
            if iv != c.interval {
                c.interval = iv;
                changed = true;
            }
            if stale_hours != c.stale_hours {
                c.stale_hours = stale_hours;
                changed = true;
            }
        }
        changed
    }

    fn ledger_path(&self) -> PathBuf {
        self.cache_dir.join(LEDGER)
    }

    fn ledger(&self) -> Map<String, Value> {
        std::fs::read(self.ledger_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    fn entry(&self) -> Map<String, Value> {
        self.ledger().get(&self.key).and_then(Value::as_object).cloned().unwrap_or_default()
    }

    fn save_entry(&self, signature: &Value, filename: &str) -> std::io::Result<()> {
        let mut data = self.ledger();
        data.insert(self.key.clone(), json!({"signature": signature, "file": filename}));
        write_json_atomic(&self.ledger_path(), &Value::Object(data))
    }

    fn generation_path(&self, gen: i64) -> PathBuf {
        self.cache_dir.join(format!("{}.g{gen}.sqlite3", self.key))
    }

    /// `<キー>.g<n>.sqlite3` の名前を並べる。
    fn generations(&self) -> Vec<PathBuf> {
        let prefix = format!("{}.g", self.key);
        std::fs::read_dir(&self.cache_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".sqlite3")))
            .collect()
    }

    fn next_generation(&self) -> i64 {
        let prefix = format!("{}.g", self.key);
        let top = self
            .generations()
            .iter()
            .filter_map(|p| {
                let n = p.file_name()?.to_str()?;
                crate::pyfmt::py_int(&n[prefix.len()..n.len() - ".sqlite3".len()]).ok()
            })
            .fold(0, i64::max);
        top + 1
    }

    pub fn mirror_path(&self) -> Option<PathBuf> {
        match self.entry().get("file") {
            Some(Value::String(s)) if !s.is_empty() => Some(self.cache_dir.join(s)),
            Some(v) if !matches!(v, Value::Null | Value::Bool(false)) && v.as_str() != Some("") => Some(self.cache_dir.join(v.to_string())),
            _ => None,
        }
    }

    fn sweep(&self, keep: &Path) {
        let keep = keep.file_name().map(|n| n.to_os_string());
        for p in self.generations() {
            if p.file_name().map(|n| n.to_os_string()) != keep {
                let _ = retrying(0.2, || std::fs::remove_file(&p)); // 読んでいる間は消せない。次の周回でまた試す
            }
        }
    }

    fn remote_stat(&self, remote: &str, retry: bool) -> Result<Value, String> {
        let waits: &[f64] = if retry { &[0.0, STAT_RETRY_SEC[0], STAT_RETRY_SEC[1], STAT_RETRY_SEC[2]] } else { &[0.0] };
        let mut err = None;
        for w in waits {
            if *w > 0.0 {
                std::thread::sleep(Duration::from_secs_f64(*w));
            }
            match std::fs::metadata(remote) {
                Ok(m) => {
                    let ns = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
                    return Ok(json!({"source": remote, "size": m.len(), "mtime_ns": ns}));
                }
                Err(e) => err = Some(e),
            }
        }
        Err(err.map(|e| os_error_text(&e)).unwrap_or_default())
    }

    fn snapshot_backup(remote: &str, tmp: &Path) -> Result<(), String> {
        let src = Connection::open_with_flags(remote, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| sqlite_text(&e))?;
        let _ = src.busy_timeout(Duration::from_secs(15));
        let mut dst = Connection::open(tmp).map_err(|e| sqlite_text(&e))?;
        let b = rusqlite::backup::Backup::new(&src, &mut dst).map_err(|e| sqlite_text(&e))?;
        b.run_to_completion(256, Duration::from_millis(50), None).map_err(|e| sqlite_text(&e))
    }

    fn verify(tmp: &Path) -> Option<String> {
        let c = match Connection::open_with_flags(tmp, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) {
            Ok(c) => c,
            Err(e) => return Some(format!("開けません: {}", sqlite_text(&e))),
        };
        let _ = c.busy_timeout(Duration::from_secs(10));
        let row: Result<Option<String>, _> = c.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, Option<String>>(0));
        match row {
            Err(rusqlite::Error::QueryReturnedNoRows) => return Some("整合性検査に通りません: (応答なし)".into()),
            Err(e) => return Some(format!("読めません: {}", sqlite_text(&e))),
            Ok(v) => {
                let v = v.unwrap_or_else(|| "None".into());
                if v.to_lowercase() != "ok" {
                    return Some(format!("整合性検査に通りません: {v}"));
                }
            }
        }
        match c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| r.get::<_, i64>(0)) {
            Ok(0) => Some("テーブルが1つもありません（まだ書き込み中の可能性）".into()),
            Ok(_) => None,
            Err(e) => Some(format!("読めません: {}", sqlite_text(&e))),
        }
    }

    /// 1回ぶん写し直す。結果（画面の診断用）を返す。
    pub fn refresh(&self, force: bool) -> Value {
        let _one = self.refresh_lock.lock().unwrap_or_else(|e| e.into_inner());
        Value::Object(self.refresh_inner(force))
    }

    fn refresh_inner(&self, force: bool) -> Map<String, Value> {
        let remote = self.remote();
        let mut res = Map::new();
        res.insert("updated".into(), json!(false));
        res.insert("reason".into(), json!(""));
        res.insert("at".into(), json!(now()));
        res.insert("remote".into(), json!(remote));
        let reason = |res: &mut Map<String, Value>, r: String| {
            res.insert("reason".into(), json!(r));
        };
        if remote.is_empty() {
            reason(&mut res, "元ファイルが設定されていません".into());
            return self.record(res);
        }
        let entry = self.entry();
        let local = self.mirror_path();
        let has_local = local.as_ref().is_some_and(|p| p.exists());
        let prev = self.state.lock().unwrap().clone();
        let prev_unreachable = prev.get("unreachable").is_some_and(truthy);
        let prev_same_remote = prev.get("remote").and_then(Value::as_str) == Some(remote.as_str());
        let known_good = !prev.is_empty() && prev_same_remote && !prev_unreachable;
        let sig = match self.remote_stat(&remote, known_good) {
            Ok(s) => s,
            Err(err) => {
                let same = prev_unreachable && prev_same_remote;
                let fails = if same { prev.get("fails").and_then(Value::as_i64).filter(|n| *n != 0).unwrap_or(1) + 1 } else { 1 };
                res.insert("unreachable".into(), json!(true));
                res.insert("error".into(), json!(err));
                res.insert("fails".into(), json!(fails));
                let name = Path::new(&remote).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let head = if has_local {
                    "共有の元ファイルへ届かないため、前の写しを使い続けます"
                } else {
                    "共有の元ファイルへ届かず、写しもまだありません"
                };
                reason(&mut res, format!("{head}（{name}: {err}）"));
                return self.record(res);
            }
        };
        if !force && has_local && entry.get("signature") == Some(&sig) {
            res.insert("skipped".into(), json!(true));
            reason(&mut res, "元ファイルは変わっていません".into());
            self.sweep(local.as_deref().unwrap());
            return self.record(res);
        }
        let _ = std::fs::create_dir_all(&self.cache_dir);
        let target = self.generation_path(self.next_generation());
        let tmp = target.with_extension("sqlite3.tmp");
        let _ = std::fs::remove_file(&tmp);
        let how = match Self::snapshot_backup(&remote, &tmp) {
            Ok(()) => "backup",
            Err(_) => {
                let _ = std::fs::remove_file(&tmp);
                match std::fs::copy(&remote, &tmp) {
                    Ok(_) => "copy",
                    Err(e) => {
                        reason(&mut res, format!("写せませんでした: {}", copy_error_text(&e, &remote)));
                        cleanup(&tmp);
                        return self.record(res);
                    }
                }
            }
        };
        if let Some(bad) = Self::verify(&tmp) {
            reason(&mut res, format!("写しが正しくないため見送りました（{bad}）"));
            cleanup(&tmp);
            return self.record(res);
        }
        let name = target.file_name().unwrap().to_string_lossy().into_owned();
        if let Err(e) = retrying(REPLACE_BUDGET, || std::fs::rename(&tmp, &target)).and_then(|_| self.save_entry(&sig, &name)) {
            reason(&mut res, format!("写しを置き換えられませんでした: {}", copy_error_text(&e, &target.display().to_string())));
            cleanup(&tmp);
            return self.record(res);
        }
        res.insert("updated".into(), json!(true));
        res.insert("how".into(), json!(how));
        reason(&mut res, format!("写しを更新しました（{}）", if how == "backup" { "バックアップAPI" } else { "コピー" }));
        self.sweep(&target);
        self.record(res)
    }

    fn record(&self, res: Map<String, Value>) -> Map<String, Value> {
        *self.state.lock().unwrap() = res.clone();
        res
    }

    /// 実際に読む場所。その元から作った写しがあればそれ、無ければ元（fail-open）。最初の周回が済むまでは待つ。
    pub fn read_path(&self) -> Option<PathBuf> {
        if !self.enabled() {
            return None;
        }
        if *self.started.lock().unwrap() {
            let (m, cv) = &*self.wake;
            let g = m.lock().unwrap();
            let _ = cv.wait_timeout_while(g, FIRST_WAIT, |w| !w.first_done);
        }
        let remote = self.remote();
        let entry = self.entry();
        if let Some(src) = entry.get("signature").and_then(|s| s.get("source")).filter(|s| truthy(s)) {
            if src.as_str().map(str::to_string).unwrap_or_else(|| src.to_string()) != remote {
                return Some(PathBuf::from(remote));
            }
        }
        match self.mirror_path() {
            Some(p) if p.exists() => Some(p),
            _ => Some(PathBuf::from(remote)),
        }
    }

    /// いま読んでいるデータは「いつのものか」。共有は見に行かない（台帳の印から読む）。
    pub fn source_info(&self) -> Value {
        let (remote, interval, stale_hours) = {
            let c = self.conf.lock().unwrap();
            (c.remote.clone(), c.interval, c.stale_hours)
        };
        let entry = self.entry();
        let sig = entry.get("signature").and_then(Value::as_object).cloned().unwrap_or_default();
        let local = self.mirror_path();
        let mirrored = local.is_some()
            && sig.get("source").and_then(Value::as_str) == Some(remote.as_str())
            && local.as_ref().is_some_and(|p| p.exists());
        let mut at = Value::Null;
        let mut copied = Value::Null;
        if mirrored {
            if let Some(ns) = sig.get("mtime_ns").and_then(Value::as_f64) {
                at = json!(ns / 1e9);
            }
            if let Some(t) = local.as_ref().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok()) {
                copied = json!(t.duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0));
            }
        }
        let st = self.state.lock().unwrap().clone();
        let checked = st.get("at").and_then(Value::as_f64).map(Value::from).unwrap_or(Value::Null);
        let mut out = json!({
            "remote": remote, "at": at, "mirrored": mirrored, "copiedAt": copied, "checkedAt": checked,
            "unreachable": st.get("unreachable").is_some_and(truthy), "reason": st.get("reason").cloned().unwrap_or(json!("")),
            "interval_sec": interval, "staleHours": stale_hours,
        });
        let o = out.as_object_mut().unwrap();
        match at.as_f64() {
            Some(a) => {
                let age = (now() - a) / 3600.0;
                o.insert("ageHours".into(), json!(round1(age)));
                o.insert("stale".into(), json!(stale_hours > 0.0 && age > stale_hours));
            }
            None => {
                o.insert("ageHours".into(), Value::Null);
                o.insert("stale".into(), Value::Null);
            }
        }
        out
    }

    fn next_wait(&self) -> Duration {
        let st = self.state.lock().unwrap().clone();
        let interval = self.conf.lock().unwrap().interval;
        let secs =
            if st.get("unreachable").is_some_and(truthy) && st.get("fails").and_then(Value::as_i64).filter(|n| *n != 0).unwrap_or(1) == 1 {
                interval.min(RETRY_AFTER_UNREACHABLE_SEC)
            } else {
                interval
            };
        Duration::from_secs(secs.max(1) as u64)
    }

    /// 背景の糸を始める（元が決まっていない・もう動いているなら何もしない）。
    pub fn start(self: &Arc<Self>) -> bool {
        let mut started = self.started.lock().unwrap();
        if *started || !self.enabled() {
            return false;
        }
        *started = true;
        let me = self.clone();
        std::thread::Builder::new()
            .name(format!("db-mirror-{}", self.key))
            .spawn(move || {
                me.refresh(false);
                {
                    let (m, cv) = &*me.wake;
                    m.lock().unwrap().first_done = true;
                    cv.notify_all();
                }
                loop {
                    let (m, cv) = &*me.wake;
                    let end = Instant::now() + me.next_wait();
                    let mut g = m.lock().unwrap();
                    while !g.woken {
                        let left = end.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        g = cv.wait_timeout(g, left).unwrap().0;
                    }
                    g.woken = false;
                    drop(g);
                    me.refresh(false);
                }
            })
            .is_ok()
    }

    /// 次の周回を今すぐにする。
    pub fn wake(&self) {
        let (m, cv) = &*self.wake;
        m.lock().unwrap().woken = true;
        cv.notify_all();
    }
}

fn interval_of(sec: i64) -> i64 {
    (if sec == 0 { DEFAULT_INTERVAL_SEC } else { sec }).max(MIN_INTERVAL_SEC)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python の round(x, 1)（偶数への丸めの違いは 0.05 刻みの境目だけ。比べる側は 0.15 の幅を持つ）。
fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// 写せなかったときの文（Python の shutil.copyfile の誤り "[Errno 2] No such file or directory: 'パス'" と同じ形）。
fn copy_error_text(e: &std::io::Error, path: &str) -> String {
    let t = os_error_text(e);
    match t.split_once(' ').and_then(|(kind, rest)| rest.split_once(' ').map(|(n, msg)| (kind, n, msg))) {
        Some((kind, n, msg)) if e.raw_os_error().is_some() => format!("[{kind} {n}] {msg}: {}", crate::pyfmt::str_repr(path)),
        _ => t,
    }
}

fn cleanup(tmp: &Path) {
    let _ = retrying(1.0, || std::fs::remove_file(tmp));
}
