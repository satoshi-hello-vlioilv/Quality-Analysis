//! ショートカット（.lnk）を作る・読む（Windows の部品 IShellLinkW を直に呼ぶ）と、置き場（デスクトップ・スタート）を Windows に尋ねる。
//! 何を作るか決めるのは da_core::install。
//!
//! 試験と開発のため、置き場は環境変数 TPA_LINK_DIRS（「;」区切り）で差し替えられる。Windows 以外では .lnk の代わりに
//! 指す先と作業フォルダを書いた小さな JSON を置く（Linux の本物の窓で決まりを通しで確かめるため。配る物は Windows だけ）。

use da_core::install::LinkIo;
use std::path::{Path, PathBuf};

pub struct OsLinks;

/// ショートカットを置く場所（デスクトップ・スタートのプログラム）。
pub fn places() -> Vec<PathBuf> {
    if let Some(v) = std::env::var_os("TPA_LINK_DIRS") {
        return std::env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()).collect();
    }
    imp::places()
}

impl LinkIo for OsLinks {
    fn make(&self, link: &Path, target: &Path, workdir: &Path, description: &str) -> Result<(), String> {
        imp::make(link, target, workdir, description)
    }
    fn read(&self, link: &Path) -> Option<(PathBuf, PathBuf)> {
        if !link.is_file() {
            return None;
        }
        imp::read(link)
    }
}

#[cfg(windows)]
mod imp {
    use std::path::{Path, PathBuf};
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
        STGM_READ,
    };
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT};

    /// COM を使えるようにして 1 件こなし、片付ける。
    fn with_link<T>(f: impl FnOnce(&IShellLinkW) -> windows::core::Result<T>) -> Result<T, String> {
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let r = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER).and_then(|l| f(&l));
            if init.is_ok() {
                CoUninitialize();
            }
            r.map_err(|e| e.message().to_string())
        }
    }

    pub fn make(link: &Path, target: &Path, workdir: &Path, description: &str) -> Result<(), String> {
        with_link(|l| unsafe {
            l.SetPath(&HSTRING::from(target.as_os_str()))?;
            l.SetWorkingDirectory(&HSTRING::from(workdir.as_os_str()))?;
            l.SetDescription(&HSTRING::from(description))?;
            l.SetIconLocation(&HSTRING::from(target.as_os_str()), 0)?;
            l.cast::<IPersistFile>()?.Save(&HSTRING::from(link.as_os_str()), true)
        })
        .map_err(|e| format!("ショートカットを保存できません: {e}"))
    }

    pub fn read(link: &Path) -> Option<(PathBuf, PathBuf)> {
        with_link(|l| unsafe {
            l.cast::<IPersistFile>()?.Load(&HSTRING::from(link.as_os_str()), STGM_READ)?;
            let mut buf = vec![0u16; 32768];
            l.GetPath(&mut buf, std::ptr::null_mut(), 0)?;
            let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let target = String::from_utf16_lossy(&buf[..n]);
            let mut wd = vec![0u16; 32768];
            l.GetWorkingDirectory(&mut wd)?;
            let m = wd.iter().position(|&c| c == 0).unwrap_or(wd.len());
            Ok((PathBuf::from(target), PathBuf::from(String::from_utf16_lossy(&wd[..m]))))
        })
        .ok()
    }

    fn known(id: &windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let p: PWSTR = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            s.map(PathBuf::from)
        }
    }

    pub fn places() -> Vec<PathBuf> {
        [known(&FOLDERID_Desktop), known(&FOLDERID_Programs)].into_iter().flatten().collect()
    }
}

#[cfg(not(windows))]
mod imp {
    use serde_json::json;
    use std::path::{Path, PathBuf};

    pub fn make(link: &Path, target: &Path, workdir: &Path, description: &str) -> Result<(), String> {
        let v = json!({"target": target, "workdir": workdir, "description": description});
        std::fs::write(link, serde_json::to_vec(&v).unwrap_or_default()).map_err(|e| format!("ショートカットを保存できません: {e}"))
    }

    pub fn read(link: &Path) -> Option<(PathBuf, PathBuf)> {
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(link).ok()?).ok()?;
        Some((PathBuf::from(v["target"].as_str()?), PathBuf::from(v["workdir"].as_str()?)))
    }

    pub fn places() -> Vec<PathBuf> {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        vec![home.join("Desktop"), home.join(".local").join("share").join("applications")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn make_then_read_gives_target_and_workdir() {
        let dir = std::env::temp_dir().join(format!("da-lnk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("起動 テスト.exe");
        std::fs::write(&target, "x").unwrap();
        let link = dir.join("転写距離.lnk");
        OsLinks.make(&link, &target, &dir, "説明").unwrap();
        let (t, w) = OsLinks.read(&link).unwrap();
        // 一時フォルダは 8.3 の短い名前で来ることがあり、読み戻すと長い名前になる——実際の場所で比べる
        let real = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!((real(&t), real(&w)), (real(&target), real(&dir)));
        assert!(OsLinks.read(&dir.join("無い.lnk")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
