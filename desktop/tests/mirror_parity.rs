//! 品質データの写し: Rust（src/mirror.rs）が Python（app/services/db_mirror.py）と同じ手順・同じ文言・同じ台帳か。
//! 筋書きは program/tests/mirror_oracle.py の STEPS（Python が別の置き場で同じ筋書きを行い、一歩ずつの結果を出す）。

mod common;

use da_core::mirror::DbMirror;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

/// 作業フォルダの場所を <D> に、時刻を「あるか」に（Python の normalize と同じ）。
fn normalize(v: &Value, base: &str) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| {
                    let y = match k.as_str() {
                        "at" | "copiedAt" | "checkedAt" => json!(!x.is_null()),
                        _ => normalize(x, base),
                    };
                    (k.clone(), y)
                })
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| normalize(x, base)).collect()),
        Value::String(s) => json!(s.replace(base, "<D>").replace('\\', "/")),
        _ => v.clone(),
    }
}

/// 経った時間（ageHours）は、Python と Rust で走らせた時刻がずれるので 0.15 時間の幅で比べ、Rust の値を Python の値にそろえる。
fn align_age(want: &Value, got: &mut Value) {
    if let (Some(w), Some(g)) = (want.get("ageHours").and_then(Value::as_f64), got.get("ageHours").and_then(Value::as_f64)) {
        if (w - g).abs() <= 0.15 {
            got["ageHours"] = json!(w);
        }
    }
}

fn set_age(p: &Path, hours: f64) {
    let t = SystemTime::now() - Duration::from_secs_f64(hours * 3600.0);
    std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
}

#[test]
fn rust_mirrors_like_python() {
    let work = common::work("mirror");
    let o = common::python_json("mirror_oracle.py", &["scenario", work.to_str().unwrap()]);
    let base = work.join("rs");
    std::fs::create_dir_all(base.join("share")).unwrap();
    let assets = work.join("assets");
    let place = |k: &str| -> String {
        match k {
            "share" => base.join("share").join("SIKADEF.sqlite3").display().to_string(),
            "other" => base.join("other.sqlite3").display().to_string(),
            "missing" => base.join("nowhere").join("x.sqlite3").display().to_string(),
            _ => String::new(),
        }
    };
    let cache: PathBuf = base.join("cache");
    let mut m: Option<Arc<DbMirror>> = None;
    let mut bad = vec![];
    let steps = o["steps"].as_array().unwrap();
    for (i, (st, want)) in steps.iter().zip(o["results"].as_array().unwrap()).enumerate() {
        let s = |k: &str| st[k].as_str().unwrap_or("").to_string();
        let r: Value = match s("do").as_str() {
            "new" => {
                // 背景の糸は起こさない（写すのは筋書きの refresh だけ。Python 側も受け身で同じ）
                m = Some(DbMirror::new(
                    "lot_list",
                    &place(&s("remote")),
                    &cache,
                    st["interval"].as_i64().unwrap(),
                    st["stale"].as_f64().unwrap(),
                ));
                Value::Null
            }
            "put" => {
                std::fs::copy(assets.join(format!("{}.sqlite3", s("asset"))), place(&s("file"))).unwrap();
                set_age(Path::new(&place(&s("file"))), st["age"].as_f64().unwrap());
                Value::Null
            }
            "corrupt" => {
                std::fs::write(place(&s("file")), b"not a sqlite file".repeat(100)).unwrap();
                set_age(Path::new(&place(&s("file"))), st["age"].as_f64().unwrap());
                Value::Null
            }
            "unlink" => {
                std::fs::remove_file(place(&s("file"))).unwrap();
                Value::Null
            }
            "refresh" => m.as_ref().unwrap().refresh(st["force"].as_bool().unwrap_or(false)),
            "read_path" => m.as_ref().unwrap().read_path().map(|p| json!(p.display().to_string())).unwrap_or(Value::Null),
            "source_info" => m.as_ref().unwrap().source_info(),
            "reconfigure" => {
                // 試験では背景の糸を起こさない形で切り替える（Python 側も受け身）
                m.as_ref().unwrap().reconfigure_quiet(
                    &place(&s("remote")),
                    st["interval"].as_i64().unwrap(),
                    st["stale"].as_f64().unwrap(),
                );
                Value::Null
            }
            "files" => {
                let mut v: Vec<String> =
                    std::fs::read_dir(&cache).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                v.sort();
                json!(v)
            }
            "ledger" => {
                let l: Value = serde_json::from_slice(&std::fs::read(cache.join("_mirror.json")).unwrap()).unwrap();
                let e = &l["lot_list"];
                let mtime = std::fs::metadata(place("share"))
                    .unwrap()
                    .modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos() as u64;
                json!({"file": e["file"], "source": e["signature"]["source"], "size": e["signature"]["size"],
                       "mtime_ns_is_stat": e["signature"]["mtime_ns"].as_u64() == Some(mtime)})
            }
            other => panic!("知らない歩: {other}"),
        };
        let mut got = normalize(&r, &base.display().to_string());
        let want = &want["result"];
        align_age(want, &mut got);
        if let Some(d) = common::diff(want, &got, "") {
            bad.push(format!("#{i} {st}: {d}"));
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    assert!(bad.is_empty(), "{} / {} 歩が食い違いました:\n{}", bad.len(), steps.len(), bad.join("\n"));
}

#[test]
fn python_and_rust_share_the_ledger() {
    let work = common::work("mirror-share");
    let o = common::python_json("mirror_oracle.py", &["scenario", work.join("x").to_str().unwrap()]); // 元ファイルの見本を作らせる
    assert!(o["results"].is_array());
    let cache = work.join("cache");
    let remote = work.join("SIKADEF.sqlite3");
    std::fs::copy(work.join("x").join("assets").join("v1.sqlite3"), &remote).unwrap();
    let (c, r) = (cache.to_str().unwrap(), remote.to_str().unwrap());
    // Python が写す → Rust は写し直さずに読む
    let py = common::python_json("mirror_oracle.py", &["op", c, r, "refresh"]);
    assert_eq!(py["updated"], true, "{py}");
    let m = DbMirror::new("lot_list", r, &cache, 60, 36.0);
    let rs = m.refresh(false);
    assert_eq!((rs["skipped"].as_bool(), rs["reason"].as_str()), (Some(true), Some("元ファイルは変わっていません")), "{rs}");
    assert_eq!(m.read_path().unwrap(), cache.join("lot_list.g1.sqlite3"));
    // Rust が写し直す（force）→ Python は写し直さずに読む
    let rs = m.refresh(true);
    assert_eq!(rs["updated"], true, "{rs}");
    let py = common::python_json("mirror_oracle.py", &["op", c, r, "refresh"]);
    assert_eq!(py["skipped"], true, "{py}");
    assert_eq!(
        common::python_json("mirror_oracle.py", &["op", c, r, "read_path"]),
        json!(cache.join("lot_list.g2.sqlite3").display().to_string())
    );
    let info = common::python_json("mirror_oracle.py", &["op", c, r, "source_info"]);
    assert_eq!(info["mirrored"], true);
    let _ = std::fs::remove_dir_all(&work);
}
