//! ショートカット（設計書 §15.2 の決まり）。決めるのはここ、.lnk を作る・読むのは窓の lnk.rs（Windows の IShellLinkW）。
//!
//! - ショートカットはいつもこの PC の app の exe（入口）を指し、作業フォルダも app（共有を作業フォルダにしない）
//! - 置き場はデスクトップとスタート（プログラム）。どこへ作るかは窓が Windows に尋ねる（OneDrive へ移したデスクトップでもよい）
//! - 尋ねる: app があり、置き場に正しいショートカットが 1 つも無く、断っていなければ（画面が「作りますか」と尋ねる）
//! - 「今後たずねない」はこの PC の記録（作業場所の install.json の declined）。作れば断りは消える
//! - 起動のたび（maintain）: 置き場にあるこのアプリのショートカットで、指す先か作業フォルダが違う物（共有の exe・前の名前）を作り直す。
//!   前の名前（アプリ名を変える前）の物は消して、いまの名前で作る。消された物は作り直さない

use crate::update::{read_json, write_json, Paths};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// ショートカットを作る・読む手段（窓では Windows の部品、試験では作り物）。
pub trait LinkIo {
    /// 作る（上書き）。
    fn make(&self, link: &Path, target: &Path, workdir: &Path, description: &str) -> Result<(), String>;
    /// 読む → (指す先, 作業フォルダ)。無い・読めなければ None。
    fn read(&self, link: &Path) -> Option<(PathBuf, PathBuf)>;
}

/// 名前（いまのアプリ名と、前の名前の歴史）。
pub struct Names<'a> {
    pub name: &'a str,
    pub exe: &'a str,
    pub description: &'a str,
    /// 前の名前（名前の歴史: 版 3.5.0 までのアプリ名）。見つけたら消していまの名前で作る
    pub legacy: &'a [&'a str],
}

fn record_path(p: &Paths) -> PathBuf {
    p.root.join("install.json")
}

fn record(p: &Paths) -> Value {
    read_json(&record_path(p)).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn save(p: &Paths, v: &Value) -> Result<(), String> {
    write_json(&record_path(p), v)
}

fn same(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (x, y) = (norm(a), norm(b));
    if cfg!(windows) {
        x.to_string_lossy().to_lowercase() == y.to_string_lossy().to_lowercase()
    } else {
        x == y
    }
}

fn link_name(name: &str) -> String {
    format!("{name}.lnk")
}

/// 置き場にある正しいショートカット（app の exe を指し、作業フォルダも app）。
pub fn good_links(p: &Paths, places: &[PathBuf], io: &dyn LinkIo, n: &Names) -> Vec<PathBuf> {
    let (exe, app) = (p.app().join(n.exe), p.app());
    places.iter().map(|d| d.join(link_name(n.name))).filter(|l| io.read(l).is_some_and(|(t, w)| same(&t, &exe) && same(&w, &app))).collect()
}

/// 画面への答え（GET /__desktop/install）。
pub fn status(p: &Paths, places: &[PathBuf], io: &dyn LinkIo, n: &Names, running_from_app: bool) -> Value {
    let installed = p.app().join(n.exe).is_file() && p.app().join("program").join("sidecar.py").is_file();
    let links = good_links(p, places, io, n);
    let declined = record(p)["declined"] == true;
    json!({
        "installed": installed, "runningFromApp": running_from_app, "local": p.root, "appDir": p.app(), "name": n.name,
        "shortcut": {"links": links, "places": places, "ask": installed && links.is_empty() && !declined && !places.is_empty(),
                     "declined": declined},
    })
}

/// 作る（POST /__desktop/shortcut）。→ {made, problems}。作れば断りは消える。
pub fn make(p: &Paths, places: &[PathBuf], io: &dyn LinkIo, n: &Names) -> Result<Value, String> {
    let exe = p.app().join(n.exe);
    if !exe.is_file() {
        return Err("この PC のアプリ（app）がまだありません。共有・BOX の exe から一度開いてください".into());
    }
    let (mut made, mut problems) = (vec![], vec![]);
    for d in places {
        let link = d.join(link_name(n.name));
        let r = std::fs::create_dir_all(d).map_err(|e| e.to_string()).and_then(|_| io.make(&link, &exe, &p.app(), n.description));
        match r {
            Ok(()) => made.push(link),
            Err(e) => problems.push(format!("{}: {e}", link.display())),
        }
    }
    let mut rec = record(p);
    rec["declined"] = json!(false);
    rec["links"] = json!(made);
    save(p, &rec)?;
    Ok(json!({"made": made, "problems": problems}))
}

/// 「今後たずねない」（POST /__desktop/shortcut/decline）。
pub fn decline(p: &Paths) -> Result<Value, String> {
    let mut rec = record(p);
    rec["declined"] = json!(true);
    save(p, &rec)?;
    Ok(json!({"declined": true}))
}

/// 起動のたび: 置き場にあるこのアプリのショートカットの指す先・作業フォルダを直し、前の名前の物を作り直す。→ 直した物
pub fn maintain(p: &Paths, places: &[PathBuf], io: &dyn LinkIo, n: &Names) -> Vec<String> {
    let (exe, app) = (p.app().join(n.exe), p.app());
    if !exe.is_file() {
        return vec![];
    }
    let mut fixed = vec![];
    for d in places {
        let link = d.join(link_name(n.name));
        if let Some((t, w)) = io.read(&link) {
            if !(same(&t, &exe) && same(&w, &app)) && io.make(&link, &exe, &app, n.description).is_ok() {
                fixed.push(format!("{} を作り直しました（指す先 {} → {}）", link.display(), t.display(), exe.display()));
            }
        }
        for old in n.legacy.iter().filter(|o| **o != n.name) {
            let ol = d.join(link_name(old));
            if io.read(&ol).is_some() && std::fs::remove_file(&ol).is_ok() && io.make(&link, &exe, &app, n.description).is_ok() {
                fixed.push(format!("{} を {} で作り直しました", ol.display(), link.display()));
            }
        }
    }
    fixed
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// 作り物（ショートカットをファイルとして置き、中身を覚える）。
    #[derive(Default)]
    pub struct Fake(pub RefCell<HashMap<PathBuf, (PathBuf, PathBuf)>>);
    impl LinkIo for Fake {
        fn make(&self, link: &Path, target: &Path, workdir: &Path, _d: &str) -> Result<(), String> {
            if link.parent().is_some_and(|d| d.ends_with("locked")) {
                return Err("書けません".into());
            }
            std::fs::write(link, "lnk").map_err(|e| e.to_string())?;
            self.0.borrow_mut().insert(link.to_path_buf(), (target.to_path_buf(), workdir.to_path_buf()));
            Ok(())
        }
        fn read(&self, link: &Path) -> Option<(PathBuf, PathBuf)> {
            link.is_file().then(|| self.0.borrow().get(link).cloned()).flatten()
        }
    }

    const N: Names = Names { name: "App", exe: "App.exe", description: "説明", legacy: &["OldName"] };

    fn setup(name: &str) -> (PathBuf, Paths, Vec<PathBuf>) {
        let d = std::env::temp_dir().join(format!("da-inst-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = Paths::new(&d.join("local"));
        std::fs::create_dir_all(p.app().join("program")).unwrap();
        std::fs::write(p.app().join("App.exe"), "x").unwrap();
        std::fs::write(p.app().join("program").join("sidecar.py"), "#").unwrap();
        let places = vec![d.join("Desktop"), d.join("Programs")];
        for pl in &places {
            std::fs::create_dir_all(pl).unwrap();
        }
        (d, p, places)
    }

    #[test]
    fn ask_make_decline() {
        let (d, p, places) = setup("ask");
        let io = Fake::default();
        let s = status(&p, &places, &io, &N, true);
        assert_eq!(
            (s["installed"].as_bool(), s["shortcut"]["ask"].as_bool()),
            (Some(true), Some(true)),
            "app があり、ショートカットが無ければ尋ねる"
        );
        decline(&p).unwrap();
        assert_eq!(status(&p, &places, &io, &N, true)["shortcut"]["ask"], false, "断ったら尋ねない");
        let r = make(&p, &places, &io, &N).unwrap();
        assert_eq!(r["made"].as_array().unwrap().len(), 2, "断ったあとでも作れる");
        let s = status(&p, &places, &io, &N, true);
        assert_eq!((s["shortcut"]["ask"].as_bool(), s["shortcut"]["declined"].as_bool()), (Some(false), Some(false)), "作れば断りは消える");
        for l in good_links(&p, &places, &io, &N) {
            let (t, w) = io.read(&l).unwrap();
            assert!(same(&t, &p.app().join("App.exe")) && same(&w, &p.app()), "指す先も作業フォルダもこの PC の app");
        }
        std::fs::remove_file(places[0].join("App.lnk")).unwrap();
        assert_eq!(status(&p, &places, &io, &N, true)["shortcut"]["ask"], false, "1 つでもあれば尋ねない");
        std::fs::remove_file(places[1].join("App.lnk")).unwrap();
        assert_eq!(status(&p, &places, &io, &N, true)["shortcut"]["ask"], true, "全部消されたらまた尋ねる");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn maintain_fixes_shared_targets_and_old_names_but_not_deleted_ones() {
        let (d, p, places) = setup("maint");
        let io = Fake::default();
        // 人が作った、共有の exe を指し作業フォルダも共有のショートカット
        io.make(&places[0].join("App.lnk"), &d.join("share").join("App.exe"), &d.join("share"), "").unwrap();
        // 前の名前のショートカット
        io.make(&places[1].join("OldName.lnk"), &d.join("old").join("Old.exe"), &d.join("old"), "").unwrap();
        let fixed = maintain(&p, &places, &io, &N);
        assert_eq!(fixed.len(), 2, "{fixed:?}");
        assert_eq!(good_links(&p, &places, &io, &N).len(), 2, "どちらもこの PC の app を指す");
        assert!(!places[1].join("OldName.lnk").exists(), "前の名前の物は消す");
        std::fs::remove_file(places[0].join("App.lnk")).unwrap();
        assert!(maintain(&p, &places, &io, &N).is_empty(), "正しい物は触らない・消された物は作り直さない");
        assert!(!places[0].join("App.lnk").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn problems_are_told_with_reason() {
        let (d, p, mut places) = setup("prob");
        places.push(d.join("locked"));
        let io = Fake::default();
        let r = make(&p, &places, &io, &N).unwrap();
        assert_eq!(r["made"].as_array().unwrap().len(), 2);
        assert!(r["problems"][0].as_str().unwrap().contains("書けません"), "作れなかった物は理由つき");
        let _ = std::fs::remove_dir_all(&d);
    }
}
