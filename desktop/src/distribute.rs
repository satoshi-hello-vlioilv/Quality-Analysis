//! 配布（設計書 §14）: 画面から版を置く・配る版を選ぶ・配る入口を置く、と、配る入口から新しい PC へ。
//! 置いてよいのはだれか（開発者・メンテナンス者）を決めるのは Python（services/access.py）。ここは置き場の形だけを扱う。
//!
//! 置き場（release.rs と同じ形）:
//! ```text
//! <更新の置き場>\<アプリのフォルダ>\
//!   distribute.json          { schema:1, app_id, version, entry, setAt, setBy, setPc, previous }
//!   <exe>                    配る入口（配る版の ZIP の exe。新しい PC へはこのアドレスだけを渡す）
//!   <版>\release.json        { schema:1, app_id, name, version, zip, sha256, exe, placedAt, placedBy, placedPc, source }
//!   <版>\<name>-<版>-windows.zip
//! ```
//! 置くときは `.<版>.placing-<pid>` へ写して指紋を確かめ直し、release.json を書いてから名前を変える（各 PC が置きかけを読まない）。

use crate::release::{self, Release, Scan, DISTRIBUTE, MARKER};
use crate::update::{self, dist_root, extract_zip, read_json, sha256_file, validate_dist, write_json, Paths};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// だれが（Python の /api/update/settings の who）。
#[derive(Debug, Clone, Default)]
pub struct Who {
    pub login: String,
    pub pc: String,
}

/// 進み具合を伝える（段・済んだバイト・全部のバイト）。
pub type Progress<'a> = &'a dyn Fn(&str, u64, u64);

fn now_text() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// アプリのフォルダ（配る版の覚えがあればそこ、無ければいちばん新しい版の隣、どちらも無ければ 置き場\<アプリ名>）。
pub fn app_folder(found: &Path, scan: &Scan, name: &str) -> PathBuf {
    if let Some(d) = &scan.distribute {
        return d.dir.clone();
    }
    if let Some(r) = scan.newest() {
        if let Some(parent) = r.dir.parent() {
            return parent.to_path_buf();
        }
    }
    found.join(name)
}

/// 配る形の名乗り（ZIP の中の program/app/brand.json）。
fn dist_brand(root: &Path) -> Result<Value, String> {
    read_json(&root.join("program").join("app").join("brand.json")).ok_or_else(|| "ZIP に program\\app\\brand.json がありません".into())
}

/// 写しながら進み具合を伝える。
fn copy_with_progress(from: &Path, to: &Path, progress: Progress) -> Result<u64, String> {
    let total = std::fs::metadata(from).map(|m| m.len()).unwrap_or(0);
    let mut r = std::fs::File::open(from).map_err(|e| format!("{} を開けません: {e}", from.display()))?;
    let mut w = std::fs::File::create(to).map_err(|e| format!("{} を書けません: {e}", to.display()))?;
    let (mut buf, mut done) = (vec![0u8; 1 << 20], 0u64);
    loop {
        let n = r.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n]).map_err(|e| format!("置き場へ書けません: {e}"))?;
        done += n as u64;
        progress("copy", done, total);
    }
    w.sync_all().map_err(|e| e.to_string())?;
    Ok(done)
}

/// 画面から選んだ ZIP を置き場に置く。→ 置いた版の release.json
pub fn place(p: &Paths, found: &Path, zip: &Path, source_name: &str, app_id: &str, who: &Who, progress: Progress) -> Result<Value, String> {
    progress("check", 0, 0);
    let work = p.work();
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let tmp = work.join(format!("place-check-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let checked = (|| {
        extract_zip(zip, &tmp)?;
        let root = dist_root(&tmp).ok_or("ZIP に program\\sidecar.py がありません（配る ZIP ではありません）")?;
        let b = dist_brand(&root)?;
        if b["app_id"].as_str() != Some(app_id) {
            return Err("このアプリの ZIP ではありません（目印 app_id が違います）".to_string());
        }
        let exe = b["exe"].as_str().unwrap_or("").to_string();
        let name = b["name"].as_str().unwrap_or("").to_string();
        if !release::safe_name(&exe) || name.is_empty() {
            return Err("ZIP の名前の定義（brand.json の name・exe）が正しくありません".to_string());
        }
        let version = validate_dist(&root, &exe, app_id, None)?;
        Ok((version, exe, name))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    let (version, exe, name) = checked?;
    let scan = release::scan(found, app_id);
    if scan.find(&version).is_some() {
        return Err(format!("版 {version} はもう置いてあります（同じ版は置けません。取り込んだ PC と中身が食い違うため）"));
    }
    let folder = app_folder(found, &scan, &name);
    let (dest, placing) = (folder.join(&version), folder.join(format!(".{version}.placing-{}", std::process::id())));
    if dest.exists() {
        return Err(format!("{} がもうあります", dest.display()));
    }
    let _ = std::fs::remove_dir_all(&placing);
    let result = (|| {
        std::fs::create_dir_all(&placing).map_err(|e| format!("置き場にフォルダを作れません（{}）: {e}", placing.display()))?;
        let zip_name = format!("{name}-{version}-windows.zip");
        let sha = sha256_file(zip).map_err(|e| e.to_string())?;
        copy_with_progress(zip, &placing.join(&zip_name), progress)?;
        progress("finish", 0, 0);
        if sha256_file(&placing.join(&zip_name)).map_err(|e| e.to_string())? != sha {
            return Err("置き場へ写した ZIP の指紋が元と違います（写す途中で壊れました）".to_string());
        }
        let rel = json!({"schema": 1, "app_id": app_id, "name": name, "version": version, "zip": zip_name, "sha256": sha, "exe": exe,
                         "placedAt": now_text(), "placedBy": who.login, "placedPc": who.pc, "source": source_name,
                         "bytes": std::fs::metadata(zip).map(|m| m.len()).unwrap_or(0)});
        write_json(&placing.join(MARKER), &rel)?;
        std::fs::rename(&placing, &dest).map_err(|e| format!("版のフォルダを置けません: {e}"))?;
        Ok(rel)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&placing);
    }
    result
}

/// ZIP の中から配る形の exe を取り出す（配る入口にする）。
fn extract_exe(zip: &Path, exe: &str, to: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    let names: Vec<String> = z.file_names().map(str::to_string).collect();
    // 配る形の根（program/sidecar.py の隣）の exe
    let root = names.iter().find_map(|n| n.strip_suffix("program/sidecar.py")).ok_or("ZIP に program/sidecar.py がありません")?.to_string();
    let mut e = z.by_name(&format!("{root}{exe}")).map_err(|_| format!("ZIP に {exe} がありません"))?;
    let mut buf = Vec::new();
    e.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    std::fs::write(to, buf).map_err(|e| format!("{} を書けません: {e}", to.display()))
}

/// 配る版を決める: distribute.json を書き、配る入口（その版の ZIP の exe）をアプリのフォルダの直下に置く。→ {version, notes}
pub fn set_distributed(found: &Path, version: &str, app_id: &str, who: &Who) -> Result<Value, String> {
    let scan = release::scan(found, app_id);
    let rel: &Release = scan.find(version).ok_or_else(|| format!("版 {version} は置き場にありません"))?;
    if sha256_file(&rel.zip_path()).map_err(|e| format!("版 {version} の ZIP を読めません: {e}"))? != rel.sha256 {
        return Err(format!("版 {version} の ZIP の指紋が release.json と違います（置いている途中か、壊れています）"));
    }
    let folder = app_folder(found, &scan, &rel.name);
    let mut notes = vec![];
    // 配る入口: 指紋を確かめた ZIP からだけ取り出す
    let entry = folder.join(&rel.exe);
    let tmp = folder.join(format!(".{}.new-{}", rel.exe, std::process::id()));
    extract_exe(&rel.zip_path(), &rel.exe, &tmp)?;
    if let Err(e) = update::rename_patiently(&tmp, &entry) {
        let _ = std::fs::remove_file(&tmp);
        notes.push(format!(
            "配る入口（{}）を置き換えられませんでした（だれかが入口を開いている最中かもしれません）。少し待ってから、もう一度「この版を配る」を押してください: {e}",
            entry.display()
        ));
    }
    let prev = scan.distribute.as_ref();
    let previous = prev.map(|d| d.version.clone()).filter(|v| v != version);
    // 入口の名前が変わった版を配ったら、前の名前の入口を消す
    if let Some(old_entry) = prev.and_then(|d| d.raw["entry"].as_str()).filter(|e| *e != rel.exe && release::safe_name(e)) {
        let _ = std::fs::remove_file(folder.join(old_entry));
    }
    let d = json!({"schema": 1, "app_id": app_id, "version": version, "entry": rel.exe, "setAt": now_text(),
                   "setBy": who.login, "setPc": who.pc, "previous": previous});
    write_json(&folder.join(DISTRIBUTE), &d)?;
    Ok(json!({"version": version, "notes": notes, "entry": entry}))
}

/// 配布の画面の答え（GET /__desktop/release）。
pub fn view(found: &Path, adjusted: bool, source: &str, app_id: &str, name: &str, me: Value) -> Value {
    let scan = release::scan(found, app_id);
    let folder = app_folder(found, &scan, name);
    let versions: Vec<Value> = scan
        .by_version()
        .iter()
        .map(|r| {
            let bytes = r.raw["bytes"].as_u64().or_else(|| std::fs::metadata(r.zip_path()).ok().map(|m| m.len())).unwrap_or(0);
            json!({"version": r.version, "placedAt": r.raw["placedAt"], "placedPc": r.raw["placedPc"], "placedBy": r.raw["placedBy"],
                   "source": r.raw["source"], "zip": r.zip, "bytes": bytes, "dir": r.dir})
        })
        .collect();
    let entry = scan.distribute.as_ref().and_then(|d| d.raw["entry"].as_str().map(|e| d.dir.join(e)));
    json!({
        "reachable": true, "found": found, "adjusted": adjusted, "folder": source, "appFolder": folder,
        "distributed": scan.distribute.as_ref().map(|d| d.raw.clone()), "versions": versions,
        "entry": {"exists": entry.as_ref().is_some_and(|e| e.is_file()), "path": entry},
        "problems": scan.problems, "me": me,
    })
}

/// いま動いている exe が「配る入口」か（隣の distribute.json がこのアプリの物で、入口の名前が自分）。→ アプリのフォルダ
pub fn entry_folder(me: &Path, app_id: &str) -> Option<PathBuf> {
    let dir = me.parent()?;
    let d = read_json(&dir.join(DISTRIBUTE))?;
    let name = me.file_name()?.to_string_lossy().to_string();
    (d["app_id"].as_str() == Some(app_id) && d["entry"].as_str().is_some_and(|e| e.eq_ignore_ascii_case(&name))).then(|| dir.to_path_buf())
}

/// 配る入口から: 配る版を取り込み、この PC の app に据える（app が配る版と同じなら写さない）。入口の置き場を控える。→ 据えた版
pub fn install_from_entry(p: &Paths, folder: &Path, app_id: &str, progress: &dyn Fn(&str)) -> Result<String, String> {
    let d = read_json(&folder.join(DISTRIBUTE)).ok_or("配る版の覚え（distribute.json）を読めません")?;
    let version = d["version"].as_str().unwrap_or("").to_string();
    let _ = write_json(&p.root.join("entry.json"), &json!({"dir": folder, "at": now_text()}));
    let _ = write_json(&p.want(), &d);
    if update::program_version(&p.app().join("program")).as_deref() == Some(version.as_str()) {
        return Ok(version);
    }
    let scan = release::scan(folder, app_id);
    let rel = scan.find(&version).ok_or_else(|| format!("配る版 {version} が置き場にありません（BOX の同期待ちかもしれません）"))?;
    update::stage_release(p, rel, app_id, progress)?;
    progress("この PC へ据えています");
    update::apply_staged(p, &rel.exe)?;
    update::confirm(p);
    Ok(version)
}

/// 控えた入口の置き場（参照先の更新の置き場の後ろの候補にする）。
pub fn remembered_entry(p: &Paths) -> Option<PathBuf> {
    read_json(&p.root.join("entry.json"))?["dir"].as_str().map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "local.test.app";

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("da-dist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 配る ZIP を作る（App/App.exe・program/…）。
    fn make_zip(out: &Path, version: &str, exe_body: &str, app_id: &str) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(out).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        for (n, body) in [
            ("App/App.exe".to_string(), exe_body.to_string()),
            ("App/program/sidecar.py".into(), "#".into()),
            ("App/program/app/brand.json".into(), format!(r#"{{"app_id":"{app_id}","name":"App","exe":"App.exe"}}"#)),
            ("App/program/app/version.py".into(), format!("APP_VERSION = \"{version}\"\n")),
        ] {
            z.start_file(n, o).unwrap();
            z.write_all(body.as_bytes()).unwrap();
        }
        z.finish().unwrap();
    }

    #[test]
    fn place_then_distribute_then_a_new_pc_takes_it() {
        let d = tmp("flow");
        let (rels, p) = (d.join("Releases"), Paths::new(&d.join("local")));
        std::fs::create_dir_all(&rels).unwrap();
        let who = Who { login: "maint".into(), pc: "PC1".into() };
        let none = |_: &str, _: u64, _: u64| {};
        make_zip(&d.join("a.zip"), "3.10.0", "exe-1", ID);
        let r = place(&p, &rels, &d.join("a.zip"), "a.zip", ID, &who, &none).unwrap();
        assert_eq!((r["version"].as_str(), r["placedBy"].as_str()), (Some("3.10.0"), Some("maint")));
        assert!(rels.join("App").join("3.10.0").join(MARKER).is_file(), "置き場\\アプリ名\\版");
        assert!(place(&p, &rels, &d.join("a.zip"), "a.zip", ID, &who, &none).unwrap_err().contains("もう置いて"), "同じ版は置かない");
        make_zip(&d.join("other.zip"), "1.0.0", "x", "other.app");
        assert!(place(&p, &rels, &d.join("other.zip"), "o.zip", ID, &who, &none).unwrap_err().contains("このアプリ"), "ほかのアプリは断る");
        std::fs::write(d.join("junk.zip"), "not a zip").unwrap();
        assert!(place(&p, &rels, &d.join("junk.zip"), "j.zip", ID, &who, &none).is_err(), "ZIP でない物は断る");
        let left: Vec<_> = std::fs::read_dir(rels.join("App")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "途中の物を残さない: {left:?}");
        // 各 PC の取り込みにそのまま通る（release.rs の読み方）
        assert_eq!(release::scan(&rels, ID).newest().unwrap().version, "3.10.0");
        // 配る
        make_zip(&d.join("b.zip"), "3.10.1", "exe-2", ID);
        place(&p, &rels, &d.join("b.zip"), "b.zip", ID, &who, &none).unwrap();
        let s = set_distributed(&rels, "3.10.1", ID, &who).unwrap();
        assert!(s["notes"].as_array().unwrap().is_empty(), "{s}");
        let entry = rels.join("App").join("App.exe");
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), "exe-2", "配る入口はその版の exe");
        let back = set_distributed(&rels, "3.10.0", ID, &who).unwrap();
        assert_eq!(back["version"], "3.10.0");
        let dj = read_json(&rels.join("App").join(DISTRIBUTE)).unwrap();
        assert_eq!((dj["version"].as_str(), dj["previous"].as_str()), (Some("3.10.0"), Some("3.10.1")), "戻すのも選び直し・前の版を覚える");
        assert_eq!(std::fs::read_to_string(&entry).unwrap(), "exe-1");
        assert!(set_distributed(&rels, "9.9.9", ID, &who).is_err());
        // 画面の答え
        let v = view(&rels, false, "src", ID, "App", json!({}));
        assert_eq!((v["versions"].as_array().unwrap().len(), v["entry"]["exists"].as_bool()), (2, Some(true)));
        // 新しい PC: 入口を開くだけで配る版を取り込み、app に据える
        assert_eq!(entry_folder(&entry, ID), Some(rels.join("App")), "隣に distribute.json がある入口");
        assert_eq!(entry_folder(&d.join("a.zip"), ID), None);
        let got = install_from_entry(&p, &rels.join("App"), ID, &|_| {}).unwrap();
        assert_eq!(got, "3.10.0");
        assert_eq!(update::program_version(&p.app().join("program")).as_deref(), Some("3.10.0"));
        assert_eq!(remembered_entry(&p), Some(rels.join("App")), "入口の置き場を控える");
        assert_eq!(read_json(&p.want()).unwrap()["version"], "3.10.0", "配る版を覚える");
        assert_eq!(install_from_entry(&p, &rels.join("App"), ID, &|_| {}).unwrap(), "3.10.0", "2 回目は写さない");
        let _ = std::fs::remove_dir_all(&d);
    }
}
