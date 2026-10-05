//! 置き場所を探す: アプリの中身（program フォルダ）・Python・この PC の作業場所。
//! 作業場所の決まりは Python 側（`program/app_env.py` の `local_root`）と同じ（食い違うと記録・写し・設定が別々になる）。

use crate::brand::brand;
use std::env;
use std::path::{Path, PathBuf};

/// program フォルダを渡す引数（`--program <フォルダ>`）。
pub const PROGRAM_ARG: &str = "--program";
/// 最後に使った program フォルダの控え（`local_root()/desktop/program.txt`）。
const REMEMBERED: &str = "program.txt";

/// program フォルダ（sidecar.py がある所）。答えはここの1箇所。
/// 探す順: 引数 `--program` → 環境変数 TPA_PROGRAM_DIR（開発・試験）→ この exe の置き場所から上へたどって
/// `program/sidecar.py` がある所（配る形は exe と program が並ぶ・作る途中は3つ上）→ 最後に使った場所の控え。
pub fn program_dir() -> Result<PathBuf, String> {
    let given = arg_value(PROGRAM_ARG).or_else(|| env::var_os("TPA_PROGRAM_DIR").map(PathBuf::from));
    let found = match given {
        Some(p) if p.join("sidecar.py").is_file() => p,
        Some(p) => return Err(format!("指定された program フォルダに sidecar.py がありません: {}", p.display())),
        None => {
            let exe = env::current_exe().map_err(|e| e.to_string())?;
            match find_program_from(&exe).or_else(remembered) {
                Some(p) => p,
                None => {
                    return Err(format!(
                        "アプリの中身（program フォルダ）が見つかりません。配られた ZIP を展開したフォルダの {} から開いてください（exe と program フォルダが並んでいる形）。\n探し始めた場所: {}",
                        brand().exe,
                        exe.parent().unwrap_or(&exe).display()
                    ))
                }
            }
        }
    };
    remember(&found);
    Ok(found)
}

/// 引数 `name <値>` の値（`--name=値` も受ける）。
fn arg_value(name: &str) -> Option<PathBuf> {
    let args: Vec<String> = env::args().collect();
    let eq = format!("{name}=");
    args.iter()
        .enumerate()
        .find_map(|(i, a)| if a == name { args.get(i + 1).map(PathBuf::from) } else { a.strip_prefix(&eq).map(PathBuf::from) })
}

fn remembered() -> Option<PathBuf> {
    let text = std::fs::read_to_string(local_root().join("desktop").join(REMEMBERED)).ok()?;
    let p = PathBuf::from(text.trim());
    p.join("sidecar.py").is_file().then_some(p)
}

/// program フォルダを控える（同じなら書かない）。
pub fn remember(p: &Path) {
    let dir = local_root().join("desktop");
    let file = dir.join(REMEMBERED);
    let text = p.display().to_string();
    if std::fs::read_to_string(&file).ok().as_deref() != Some(text.as_str()) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(file, text);
    }
}

pub fn find_program_from(start: &Path) -> Option<PathBuf> {
    start.ancestors().skip(1).take(6).map(|d| d.join("program")).find(|p| p.join("sidecar.py").is_file())
}

/// この PC の作業場所（`app_env.local_root` と同じ決まり: TRANSFER_LOCAL_ROOT → (LOCALAPPDATA → TEMP → ホーム)\<data_dir>）。
pub fn local_root() -> PathBuf {
    local_root_from(|k| env::var_os(k).filter(|v| !v.is_empty()), home())
}

fn local_root_from(var: impl Fn(&str) -> Option<std::ffi::OsString>, home: PathBuf) -> PathBuf {
    if let Some(p) = var("TRANSFER_LOCAL_ROOT") {
        return PathBuf::from(p);
    }
    var("LOCALAPPDATA").or_else(|| var("TEMP")).map(PathBuf::from).unwrap_or(home).join(&brand().data_dir)
}

/// Python の `Path.home()` と同じ（Windows は USERPROFILE、ほかは HOME）。
fn home() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env::var_os(key).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Python の起こし方（exe と、前に付ける引数。py ランチャーは -3）。
#[derive(Clone, Debug, PartialEq)]
pub struct Python {
    pub exe: PathBuf,
    pub args: Vec<String>,
}

/// Python を探す。見つからなければ、探した場所を添えて誤り。
pub fn python(program: &Path) -> Result<Python, String> {
    let path: Vec<PathBuf> = env::var_os("PATH").map(|p| env::split_paths(&p).collect()).unwrap_or_default();
    let cands = python_candidates(env::var_os("TPA_PYTHON").map(PathBuf::from), program, &path);
    cands.iter().find(|c| exists(&c.exe)).cloned().ok_or_else(|| {
        let tried: Vec<String> = cands.iter().map(|c| format!("  {}", c.exe.display())).collect();
        format!("Python が見つかりません。\n探した場所:\n{}", tried.join("\n"))
    })
}

/// 在るか。**リンクをたどらずに**見る（Microsoft Store 版の入口 WindowsApps の python.exe は、たどると「無い」と答えることがある）。
fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// 同梱の Python の exe（配る形は program と並ぶ python フォルダ）。
pub fn bundled_python(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("python").join("python.exe")
    } else {
        dir.join("python").join("bin").join("python3")
    }
}

/// 探す順（先にあるほど優先）: TPA_PYTHON（開発と CI）→ **同梱の Python**（program の隣。配る形）→
/// PATH を前から見て最初に pythonw.exe がある場所の python.exe（いつも同じ Python を使う）→ PATH の python.exe → py ランチャー。
pub fn python_candidates(given: Option<PathBuf>, program: &Path, path: &[PathBuf]) -> Vec<Python> {
    let plain = |exe: PathBuf| Python { exe, args: vec![] };
    let mut out = Vec::new();
    if let Some(p) = given {
        out.push(plain(p));
    }
    if let Some(root) = program.parent() {
        out.push(plain(bundled_python(root)));
    }
    if cfg!(windows) {
        out.extend(path.iter().filter(|d| exists(&d.join("pythonw.exe"))).map(|d| plain(d.join("python.exe"))));
        out.extend(path.iter().map(|d| plain(d.join("python.exe"))));
        let windir = env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        out.push(Python { exe: windir.join("py.exe"), args: vec!["-3".into()] });
    } else {
        out.extend(path.iter().map(|d| plain(d.join("python3"))));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn finds_program_next_to_the_exe_or_above() {
        let tmp = env::temp_dir().join(format!("da-locate-{}", std::process::id()));
        let prog = tmp.join("program");
        std::fs::create_dir_all(&prog).unwrap();
        std::fs::write(prog.join("sidecar.py"), "").unwrap();
        let deep = tmp.join("desktop").join("target").join("release");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(find_program_from(&tmp.join("Defect-Analyzer.exe")), Some(prog.clone()), "exe と program が並ぶ（配る形）");
        assert_eq!(find_program_from(&deep.join("Defect-Analyzer.exe")), Some(prog.clone()), "作る途中（3つ上）");
        assert_eq!(find_program_from(&env::temp_dir().join("nowhere").join("x.exe")), None);
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn local_root_follows_app_env() {
        let home = PathBuf::from("/home/u");
        let vars = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
        };
        let d = &brand().data_dir;
        assert_eq!(
            local_root_from(vars(&[("TRANSFER_LOCAL_ROOT", "/x"), ("LOCALAPPDATA", "/l")]), home.clone()),
            PathBuf::from("/x"),
            "指定が先"
        );
        assert_eq!(local_root_from(vars(&[("LOCALAPPDATA", "/l"), ("TEMP", "/t")]), home.clone()), PathBuf::from("/l").join(d));
        assert_eq!(local_root_from(vars(&[("TEMP", "/t")]), home.clone()), PathBuf::from("/t").join(d), "LOCALAPPDATA が無ければ TEMP");
        assert_eq!(local_root_from(vars(&[]), home.clone()), home.join(d), "どちらも無ければホーム");
    }

    #[test]
    fn given_then_bundled_then_path() {
        let a = PathBuf::from("/opt/a");
        let b = PathBuf::from("/opt/b");
        let program = PathBuf::from("/app/program");
        let c = python_candidates(Some(PathBuf::from("/given/python")), &program, &[a.clone(), b.clone()]);
        assert_eq!(c[0].exe, PathBuf::from("/given/python"), "指定された Python（TPA_PYTHON）が先");
        assert_eq!(c[1].exe, bundled_python(Path::new("/app")), "次に program の隣の同梱の Python");
        if !cfg!(windows) {
            assert_eq!(c[2].exe, a.join("python3"), "PATH の順は並べ替えない（いつも同じ Python）");
            assert_eq!(c[3].exe, b.join("python3"));
        }
    }
}
