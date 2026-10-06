//! 更新とこの PC の写し（B+・利用者の決めたこと 2026-10-06）。WaveLog の形（この PC へ写し、ショートカットから写しで開く・
//! 起動の最初に入れ替える）に、2 つ足した: ① 使っている間に新しい版を裏で取り込み、確かめまで済ませておく（起動を待たせない）
//! ② 入れ替えた版が起動できなければ、控えの前の版へ戻して開く。
//!
//! この PC の作業場所（`locate::local_root()`）:
//! ```text
//! app\                    この PC のアプリ（<exe>・program・README.md）。ショートカットはここの exe（入口）を指す
//! desktop\<印>\<exe>      版ごとに写した exe。窓として動くのはこちら（動いている窓が app を掴まない）
//! update\stage\           裏で取り込み、確かめ終えた次の版（stage.json がその記録）
//! update\old\             直前の版の控え
//! update\applied.json     入れ替えた直後の印（中身が起動できたら消す。起動できなければ控えへ戻す）
//! update\FAILED.json      起動できなかった版（もう取り込まない）
//! want.json               配る版（Python の利用状況が「最新版」に使う・presence.WANT_FILE）
//! ```
//! ここは窓に依らない処理だけ（試験から直に呼ぶ）。窓の係（裏の糸・画面への答え）は src/updater.rs。

use crate::release::{newer, parse_version, Release};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

/// 展開してよい大きさ（これを超える ZIP は断る）。
pub const MAX_BYTES: u64 = 1 << 30;
/// 使用中（ウイルス対策の検査・終わる途中のプロセス）で断られた名前の付け替えを待つ長さ。
const BUSY_WAIT: Duration = Duration::from_millis(3000);
const BUSY_STEP: Duration = Duration::from_millis(150);

/// 作業場所の中の置き場。
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    pub fn new(root: &Path) -> Paths {
        Paths { root: root.to_path_buf() }
    }
    pub fn app(&self) -> PathBuf {
        self.root.join("app")
    }
    pub fn desktop(&self) -> PathBuf {
        self.root.join("desktop")
    }
    pub fn work(&self) -> PathBuf {
        self.root.join("update")
    }
    pub fn stage(&self) -> PathBuf {
        self.work().join("stage")
    }
    pub fn stage_record(&self) -> PathBuf {
        self.work().join("stage.json")
    }
    pub fn old(&self) -> PathBuf {
        self.work().join("old")
    }
    pub fn applied(&self) -> PathBuf {
        self.work().join("applied.json")
    }
    pub fn failed(&self) -> PathBuf {
        self.work().join("FAILED.json")
    }
    pub fn want(&self) -> PathBuf {
        self.root.join("want.json")
    }
}

pub fn read_json(p: &Path) -> Option<Value> {
    let b = std::fs::read(p).ok()?;
    serde_json::from_slice(b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&b)).ok()
}

/// JSON を書く（一時ファイル → 名前の付け替え。途中で止まっても前か後のどちらか）。
pub fn write_json(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("{} を作れません: {e}", d.display()))?;
    }
    let tmp = p.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).unwrap_or_default()).map_err(|e| format!("{} を書けません: {e}", tmp.display()))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{} を書けません: {e}", p.display())
    })
}

/// アプリの版（program/app/version.py の `APP_VERSION = "X.Y.Z"`）。読めなければ None。
pub fn program_version(program: &Path) -> Option<String> {
    let text = std::fs::read_to_string(program.join("app").join("version.py")).ok()?;
    text.lines().find_map(|l| {
        let rest = l.strip_prefix("APP_VERSION")?.trim_start().strip_prefix('=')?.trim();
        let q = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
        let v = &rest[1..];
        let v = &v[..v.find(q)?];
        parse_version(v).map(|_| v.to_string())
    })
}

/// 配る形の目印（program/app/brand.json の app_id）。
fn dist_app_id(program: &Path) -> Option<String> {
    read_json(&program.join("app").join("brand.json"))?["app_id"].as_str().map(str::to_string)
}

/// 配る形（exe と program が並ぶフォルダ）を確かめる → 版。版を指定すれば一致も見る。
pub fn validate_dist(dir: &Path, exe: &str, app_id: &str, expect: Option<&str>) -> Result<String, String> {
    let program = dir.join("program");
    if !dir.join(exe).is_file() {
        return Err(format!("{exe} がありません"));
    }
    if !program.join("sidecar.py").is_file() {
        return Err("program\\sidecar.py がありません".into());
    }
    if dist_app_id(&program).as_deref() != Some(app_id) {
        return Err("このアプリの物ではありません（program\\app\\brand.json の app_id が違います）".into());
    }
    let v = program_version(&program).ok_or("program\\app\\version.py の版を読めません")?;
    if let Some(want) = expect {
        if v != want {
            return Err(format!("中身の版（{v}）が置き場の版（{want}）と違います"));
        }
    }
    Ok(v)
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// ZIP を dest へ展開する。絶対パス・ドライブ名・`..`・リンクの名前があれば断る。合計が MAX_BYTES を超えれば断る。
pub fn extract_zip(zip: &Path, dest: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip).map_err(|e| format!("ZIP を開けません: {e}"))?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| format!("ZIP として読めません: {e}"))?;
    let mut total = 0u64;
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| format!("ZIP の中を読めません: {e}"))?;
        let name = e.name().to_string();
        let rel = Path::new(&name);
        let bad = name.contains(':')
            || name.starts_with(['/', '\\'])
            || rel.components().any(|c| !matches!(c, Component::Normal(_)))
            || e.is_symlink()
            || name.split(['/', '\\']).any(|p| p == "..");
        if bad {
            return Err(format!("ZIP に危ない名前があります: {name}"));
        }
        total = total.saturating_add(e.size());
        if total > MAX_BYTES {
            return Err("ZIP の中身が 1 GB を超えます".into());
        }
        let out = dest.join(rel);
        if e.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(d) = out.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let mut w = std::fs::File::create(&out).map_err(|e| format!("{} を書けません: {e}", out.display()))?;
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).map_err(|e| format!("ZIP の中を読めません（{name}）: {e}"))?;
        std::io::Write::write_all(&mut w, &buf).map_err(|e| e.to_string())?;
        // 実行の許可を戻す（Linux などの試験の窓。Windows には無い考え）
        #[cfg(unix)]
        if let Some(mode) = e.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777));
        }
    }
    Ok(())
}

/// 展開したフォルダの中の配る形の根（program/sidecar.py がある所。先頭のフォルダ名には頼らない）。
pub fn dist_root(dir: &Path) -> Option<PathBuf> {
    if dir.join("program").join("sidecar.py").is_file() {
        return Some(dir.to_path_buf());
    }
    let subs: Vec<PathBuf> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    match subs.as_slice() {
        [one] if one.join("program").join("sidecar.py").is_file() => Some(one.clone()),
        _ => None,
    }
}

/// 起動できなかった版。
pub fn failed_versions(p: &Paths) -> Vec<String> {
    read_json(&p.failed())
        .and_then(|v| v["versions"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

pub fn mark_failed(p: &Paths, version: &str) {
    let mut vs = failed_versions(p);
    if !vs.iter().any(|v| v == version) {
        vs.push(version.to_string());
    }
    let _ = write_json(&p.failed(), &json!({ "versions": vs }));
}

/// 取り込み済みの次の版（stage.json の中身）。版のフォルダが無ければ None。
pub fn staged(p: &Paths) -> Option<Value> {
    let v = read_json(&p.stage_record())?;
    p.stage().join("program").join("sidecar.py").is_file().then_some(v)
}

/// 置き場の版を裏で取り込む: 手元へ写す → 指紋を照らす → 展開 → 中身を確かめる → update\stage へ（前の取り込みは捨てる）。
/// 動いているアプリには触らない（入れ替えは次の起動の最初・apply_staged）。
pub fn stage_release(p: &Paths, rel: &Release, app_id: &str, progress: &dyn Fn(&str)) -> Result<Value, String> {
    let work = p.work();
    std::fs::create_dir_all(&work).map_err(|e| format!("{} を作れません: {e}", work.display()))?;
    let pid = std::process::id();
    let (dl, tmp) = (work.join(format!("dl-{pid}.zip")), work.join(format!("stage-tmp-{pid}")));
    let clean = || {
        let _ = std::fs::remove_file(&dl);
        let _ = std::fs::remove_dir_all(&tmp);
    };
    clean();
    let result = (|| {
        progress(&format!("版 {} を写しています", rel.version));
        std::fs::copy(rel.zip_path(), &dl).map_err(|e| format!("置き場の ZIP を写せません（{}）: {e}", rel.zip_path().display()))?;
        progress(&format!("版 {} の指紋を確かめています", rel.version));
        let sum = sha256_file(&dl).map_err(|e| e.to_string())?;
        if sum != rel.sha256 {
            return Err(format!("ZIP の指紋が release.json と違います（置いている途中か、壊れています）: {}", rel.zip));
        }
        extract_zip(&dl, &tmp)?;
        let root = dist_root(&tmp).ok_or("ZIP に program\\sidecar.py がありません")?;
        validate_dist(&root, &rel.exe, app_id, Some(&rel.version))?;
        let _ = std::fs::remove_dir_all(p.stage());
        let _ = std::fs::remove_file(p.stage_record());
        std::fs::rename(&root, p.stage()).map_err(|e| format!("取り込んだ版を置けません: {e}"))?;
        let rec = json!({"version": rel.version, "exe": rel.exe, "sha256": rel.sha256, "from": rel.zip_path(),
                         "at": now_text()});
        write_json(&p.stage_record(), &rec)?;
        Ok(rec)
    })();
    clean();
    result
}

/// 名前の付け替え。「使用中」（Windows の 5・32・33）だけは BUSY_WAIT まで待ってやり直す。
pub fn rename_patiently(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut waited = Duration::ZERO;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if matches!(e.raw_os_error(), Some(5 | 32 | 33)) && waited < BUSY_WAIT => {
                std::thread::sleep(BUSY_STEP);
                waited += BUSY_STEP;
            }
            Err(e) => return Err(e),
        }
    }
}

/// フォルダ new を app に据える（今の app は old へ。途中で失敗したら戻す）。
fn swap_in(p: &Paths, new: &Path) -> Result<(), String> {
    let (app, old) = (p.app(), p.old());
    let _ = std::fs::remove_dir_all(&old);
    let had = app.exists();
    if had {
        rename_patiently(&app, &old).map_err(|e| format!("この PC のアプリを入れ替えられません（使用中）: {e}"))?;
    }
    if let Err(e) = rename_patiently(new, &app) {
        if had {
            let _ = std::fs::rename(&old, &app);
        }
        return Err(format!("新しい版を置けません: {e}"));
    }
    Ok(())
}

/// 入れ替えた結果。
#[derive(Debug, PartialEq)]
pub struct Applied {
    pub from: String,
    pub to: String,
    /// exe も変わったか（変わったら新しい exe で開き直す）
    pub exe_changed: bool,
}

fn exe_sum(dir: &Path, exe: &str) -> Option<String> {
    sha256_file(&dir.join(exe)).ok()
}

/// 起動の最初（Python を起こす前）: 取り込み済みの版があれば app と入れ替える。起動できなかった版・同じ版は入れ替えない。
pub fn apply_staged(p: &Paths, exe: &str) -> Result<Option<Applied>, String> {
    let Some(rec) = staged(p) else { return Ok(None) };
    let to = rec["version"].as_str().unwrap_or("").to_string();
    let from = program_version(&p.app().join("program")).unwrap_or_default();
    if to.is_empty() || to == from || failed_versions(p).contains(&to) {
        let _ = std::fs::remove_dir_all(p.stage());
        let _ = std::fs::remove_file(p.stage_record());
        return Ok(None);
    }
    let before = exe_sum(&p.app(), exe);
    swap_in(p, &p.stage())?;
    let _ = std::fs::remove_file(p.stage_record());
    write_json(&p.applied(), &json!({"from": from, "to": to, "at": now_text()}))?;
    Ok(Some(Applied { exe_changed: exe_sum(&p.app(), exe) != before, from, to }))
}

/// 入れ替えた版が起動できなかった: その版に印を付け、控え（直前の版）へ戻す。→ 戻した版（戻せなければ None）。
pub fn revert(p: &Paths) -> Option<Applied> {
    let rec = read_json(&p.applied())?;
    let (from, to) = (rec["from"].as_str().unwrap_or("").to_string(), rec["to"].as_str().unwrap_or("").to_string());
    mark_failed(p, &to);
    let _ = std::fs::remove_file(p.applied());
    if !p.old().join("program").join("sidecar.py").is_file() {
        return None;
    }
    let broken = p.work().join(format!("broken-{}", std::process::id()));
    rename_patiently(&p.app(), &broken).ok()?;
    if rename_patiently(&p.old(), &p.app()).is_err() {
        let _ = std::fs::rename(&broken, p.app());
        return None;
    }
    let _ = std::fs::remove_dir_all(&broken);
    Some(Applied { from: to, to: from, exe_changed: true })
}

/// 中身が起動できた: 入れ替えた直後の印を消す（控えは次の入れ替えまで残す）。
pub fn confirm(p: &Paths) {
    let _ = std::fs::remove_file(p.applied());
}

/// 写した exe から「インターネットから来た」印（Zone.Identifier）を外す（開くたびの実行前の警告を出さない・設計書 §14.3）。
/// Windows の写し方は印も写すので、出どころの分かっている自分で写した物だけ外す。ほかの OS には印が無い。
pub fn drop_web_mark(path: &Path) {
    if cfg!(windows) {
        let mut s = path.as_os_str().to_os_string();
        s.push(":Zone.Identifier");
        let _ = std::fs::remove_file(PathBuf::from(s));
    }
}

/// 配る形（共有・BOX・展開したフォルダ）をこの PC の app へ写す。.pyc・__pycache__ は写さない。
pub fn localize(p: &Paths, dist: &Path, exe: &str, app_id: &str) -> Result<String, String> {
    let version = validate_dist(dist, exe, app_id, None)?;
    std::fs::create_dir_all(p.work()).map_err(|e| e.to_string())?;
    let tmp = p.work().join(format!("local-tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let copy = (|| {
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        std::fs::copy(dist.join(exe), tmp.join(exe)).map_err(|e| format!("{exe} を写せません: {e}"))?;
        drop_web_mark(&tmp.join(exe));
        copy_tree(&dist.join("program"), &tmp.join("program"))?;
        if dist.join("README.md").is_file() {
            let _ = std::fs::copy(dist.join("README.md"), tmp.join("README.md"));
        }
        validate_dist(&tmp, exe, app_id, Some(&version))?;
        swap_in(p, &tmp)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    copy.map(|_| version)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(from).map_err(|e| format!("{} を読めません: {e}", from.display()))?.flatten() {
        let (name, path) = (e.file_name(), e.path());
        let n = name.to_string_lossy();
        if n == "__pycache__" || n.ends_with(".pyc") {
            continue;
        }
        if path.is_dir() {
            copy_tree(&path, &to.join(&name))?;
        } else {
            std::fs::copy(&path, to.join(&name)).map_err(|e| format!("{} を写せません: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// app を写すべきか: まだ無い・この配る形の方が新しい（古い共有の exe を開いても戻さない）。
pub fn should_localize(p: &Paths, dist_version: &str) -> bool {
    match program_version(&p.app().join("program")) {
        None => true,
        Some(have) => newer(dist_version, &have) && !failed_versions(p).iter().any(|v| v == dist_version),
    }
}

/// 起動のはじめに何をするか。
#[derive(Debug, PartialEq)]
pub enum Step {
    /// このまま窓として動く（版ごとの写し・開発の作業ツリー）
    Stay,
    /// app の exe（入口）: 版ごとの写しへ渡して終わる
    Handoff,
    /// app の外（共有・BOX・展開したフォルダ）の配る形: この PC の app へ写して（新しければ）から入口を開く
    Localize(PathBuf),
}

fn same(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 決める（純粋な判断・試験が直に確かめる）。me＝いま動いている exe、dev＝開発の作業ツリー・引き継がない指定。
pub fn plan(p: &Paths, me: &Path, exe: &str, dev: bool) -> Step {
    if dev {
        return Step::Stay;
    }
    if me.starts_with(p.desktop())
        || std::fs::canonicalize(me).is_ok_and(|m| std::fs::canonicalize(p.desktop()).is_ok_and(|d| m.starts_with(d)))
    {
        return Step::Stay;
    }
    if same(me, &p.app().join(exe)) {
        return Step::Handoff;
    }
    match me.parent() {
        Some(dir) if dir.join("program").join("sidecar.py").is_file() => Step::Localize(dir.to_path_buf()),
        _ => Step::Stay,
    }
}

/// 版ごとの写しの置き場（exe の大きさ＋更新時刻。中身が変われば別の場所）。
pub fn copy_for_run(p: &Paths, app_exe: &Path) -> Result<PathBuf, String> {
    let m = std::fs::metadata(app_exe).map_err(|e| format!("{} を読めません: {e}", app_exe.display()))?;
    let t = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    let dir = p.desktop().join(format!("{}-{t}", m.len()));
    let dest = dir.join(app_exe.file_name().unwrap_or_default());
    if dest.is_file() && std::fs::metadata(&dest).map(|d| d.len()).ok() == Some(m.len()) {
        return Ok(dest);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{} を作れません: {e}", dir.display()))?;
    let tmp = dir.join(format!(".copy-{}", std::process::id()));
    std::fs::copy(app_exe, &tmp).map_err(|e| format!("exe を写せません: {e}"))?;
    drop_web_mark(&tmp);
    std::fs::rename(&tmp, &dest).map_err(|e| format!("exe を置けません: {e}"))?;
    Ok(dest)
}

/// 古い版ごとの写しを片付ける（動いている版は消せないので、消せた物だけ）。
pub fn cleanup_copies(p: &Paths, keep: &Path) {
    for e in std::fs::read_dir(p.desktop()).into_iter().flatten().flatten() {
        let path = e.path();
        if path.is_dir() && !keep.starts_with(&path) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn now_text() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const EXE: &str = "App.exe";
    const ID: &str = "local.test.app";

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("da-upd-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 配る形を作る（exe・program/sidecar.py・brand.json・version.py）。
    pub fn dist(dir: &Path, version: &str, exe_body: &str) {
        let app = dir.join("program").join("app");
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(dir.join(EXE), exe_body).unwrap();
        std::fs::write(dir.join("program").join("sidecar.py"), "#").unwrap();
        std::fs::write(app.join("brand.json"), format!(r#"{{"app_id":"{ID}"}}"#)).unwrap();
        std::fs::write(app.join("version.py"), format!("APP_VERSION = \"{version}\"\n")).unwrap();
    }

    fn zip_of(dir: &Path, top: &str, out: &Path) -> String {
        let f = std::fs::File::create(out).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default();
        for e in walk(dir) {
            let rel = e.strip_prefix(dir).unwrap().to_string_lossy().replace('\\', "/");
            z.start_file(format!("{top}/{rel}"), opt).unwrap();
            z.write_all(&std::fs::read(&e).unwrap()).unwrap();
        }
        z.finish().unwrap();
        sha256_file(out).unwrap()
    }

    fn walk(d: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        for e in std::fs::read_dir(d).unwrap().flatten() {
            if e.path().is_dir() {
                out.extend(walk(&e.path()));
            } else {
                out.push(e.path());
            }
        }
        out
    }

    fn release(dir: &Path, version: &str, sha: &str) -> Release {
        Release {
            dir: dir.to_path_buf(),
            name: "App".into(),
            version: version.into(),
            zip: "App.zip".into(),
            sha256: sha.into(),
            exe: EXE.into(),
            raw: Value::Null,
        }
    }

    #[test]
    fn version_py_is_read() {
        let d = tmp("ver");
        dist(&d, "3.9.0", "x");
        assert_eq!(program_version(&d.join("program")).as_deref(), Some("3.9.0"));
        assert_eq!(validate_dist(&d, EXE, ID, Some("3.9.0")), Ok("3.9.0".into()));
        assert!(validate_dist(&d, EXE, "other", None).is_err(), "ほかのアプリは断る");
        assert!(validate_dist(&d, EXE, ID, Some("3.9.1")).unwrap_err().contains("違います"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn stage_then_apply_then_revert() {
        let d = tmp("flow");
        let p = Paths::new(&d.join("local"));
        // この PC の app は 3.9.0
        dist(&d.join("share"), "3.9.0", "exe-1");
        assert!(should_localize(&p, "3.9.0"));
        assert_eq!(localize(&p, &d.join("share"), EXE, ID), Ok("3.9.0".into()));
        assert!(!should_localize(&p, "3.9.0") && !should_localize(&p, "3.8.0"), "同じ版・古い共有の exe では写さない");
        // 置き場に 3.10.0（exe も変わる）
        dist(&d.join("new"), "3.10.0", "exe-2");
        let rel_dir = d.join("rel");
        std::fs::create_dir_all(&rel_dir).unwrap();
        let sha = zip_of(&d.join("new"), "App", &rel_dir.join("App.zip"));
        let rec = stage_release(&p, &release(&rel_dir, "3.10.0", &sha), ID, &|_| {}).unwrap();
        assert_eq!(rec["version"], "3.10.0");
        assert_eq!(program_version(&p.app().join("program")).as_deref(), Some("3.9.0"), "取り込んでも動いている app には触らない");
        // 次の起動: 入れ替える
        let a = apply_staged(&p, EXE).unwrap().unwrap();
        assert_eq!((a.from.as_str(), a.to.as_str(), a.exe_changed), ("3.9.0", "3.10.0", true));
        assert_eq!(program_version(&p.app().join("program")).as_deref(), Some("3.10.0"));
        assert_eq!(program_version(&p.old().join("program")).as_deref(), Some("3.9.0"), "直前の版は控えに");
        // 新しい版が起動できなかった → 控えへ戻し、もう取り込まない
        let back = revert(&p).unwrap();
        assert_eq!((back.from.as_str(), back.to.as_str()), ("3.10.0", "3.9.0"));
        assert_eq!(program_version(&p.app().join("program")).as_deref(), Some("3.9.0"));
        assert_eq!(failed_versions(&p), ["3.10.0"]);
        stage_release(&p, &release(&rel_dir, "3.10.0", &sha), ID, &|_| {}).unwrap();
        assert_eq!(apply_staged(&p, EXE).unwrap(), None, "起動できなかった版へは入れ替えない");
        assert!(!should_localize(&p, "3.10.0"), "起動できなかった版を共有から写し直さない");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn staging_refuses_bad_zips_and_leaves_nothing() {
        let d = tmp("bad");
        let p = Paths::new(&d.join("local"));
        dist(&d.join("new"), "3.10.0", "x");
        let rel_dir = d.join("rel");
        std::fs::create_dir_all(&rel_dir).unwrap();
        let sha = zip_of(&d.join("new"), "App", &rel_dir.join("App.zip"));
        let bad_sha = "0".repeat(64);
        assert!(stage_release(&p, &release(&rel_dir, "3.10.0", &bad_sha), ID, &|_| {}).unwrap_err().contains("指紋"));
        assert!(stage_release(&p, &release(&rel_dir, "3.11.0", &sha), ID, &|_| {}).unwrap_err().contains("版"));
        // 危ない名前
        let evil = rel_dir.join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
            z.start_file("../outside.txt", zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
        }
        let mut r = release(&rel_dir, "3.10.0", &sha256_file(&evil).unwrap());
        r.zip = "evil.zip".into();
        assert!(stage_release(&p, &r, ID, &|_| {}).unwrap_err().contains("危ない"));
        assert!(!d.join("outside.txt").exists() && !d.join("local").join("outside.txt").exists(), "外に書かない");
        let left: Vec<_> = std::fs::read_dir(p.work()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "途中の物を残さない: {left:?}");
        assert!(staged(&p).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn plan_of_the_start() {
        let d = tmp("plan");
        let p = Paths::new(&d.join("local"));
        dist(&d.join("share"), "3.9.0", "x");
        localize(&p, &d.join("share"), EXE, ID).unwrap();
        assert_eq!(plan(&p, &d.join("share").join(EXE), EXE, false), Step::Localize(d.join("share")), "共有の exe はこの PC へ写す");
        assert_eq!(plan(&p, &p.app().join(EXE), EXE, false), Step::Handoff, "入口は版ごとの写しへ渡す");
        let copy = copy_for_run(&p, &p.app().join(EXE)).unwrap();
        assert!(copy.starts_with(p.desktop()));
        assert_eq!(copy_for_run(&p, &p.app().join(EXE)).unwrap(), copy, "同じ exe なら写し直さない");
        assert_eq!(plan(&p, &copy, EXE, false), Step::Stay, "版ごとの写しは窓として動く");
        assert_eq!(plan(&p, &d.join("share").join(EXE), EXE, true), Step::Stay, "開発の作業ツリーは引き継がない");
        assert_eq!(plan(&p, &d.join("nowhere").join(EXE), EXE, false), Step::Stay);
        std::fs::create_dir_all(p.desktop().join("old-1")).unwrap();
        cleanup_copies(&p, &copy);
        assert!(copy.is_file() && !p.desktop().join("old-1").exists(), "古い写しは片付け、動いている写しは残す");
        let _ = std::fs::remove_dir_all(&d);
    }
}
