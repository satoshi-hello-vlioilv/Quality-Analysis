//! 異常ロット一覧: Rust（src/lotlist.rs）の答えが Python（app/services/lot_list.py）と同じか。
//! 試験用の品質データと問い合わせの組は program/tests/lotlist_fixture.py（Python の試験と同じ物）。

mod common;

use chrono::NaiveDate;
use da_core::lotlist::{query, slicer, Args};
use serde_json::Value;

fn args(case: &Value) -> Args {
    let s = |k: &str| case.get(k).and_then(Value::as_str).map(str::to_string);
    Args {
        table: s("table").unwrap_or_default(),
        page: s("page"),
        page_size: s("page_size"),
        search: s("search").unwrap_or_default(),
        filters: s("filters").unwrap_or_default(),
        sorts: s("sorts").unwrap_or_default(),
        group: s("group").as_deref() == Some("1"),
    }
}

#[test]
fn rust_answers_like_python() {
    let work = common::work("lotlist");
    let o = common::python_json("lotlist_oracle.py", &[work.to_str().unwrap()]);
    let db = std::path::PathBuf::from(o["db"].as_str().unwrap());
    let today = NaiveDate::parse_from_str(o["today"].as_str().unwrap(), "%Y-%m-%d").unwrap();
    let (cases, expected) = (o["cases"].as_array().unwrap(), o["expected"].as_array().unwrap());
    assert!(cases.len() >= 40, "問い合わせの組が足りません: {}", cases.len());
    let mut bad = vec![];
    for (i, (case, want)) in cases.iter().zip(expected).enumerate() {
        // Python の oracle と同じ渡し方（設定の件数は 500・設定の表は無し）
        let s = |k: &str| case.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let answer = match case.get("slicer") {
            // スライサーに並べる値（/api/lotlist/slicer）
            Some(_) => slicer(&db, &args(case), &s("slicer"), &s("key"), "", today).map_err(|(_, e)| e),
            None => query(&db, &args(case), "", 500, today),
        };
        let got = match answer {
            Ok(mut v) => {
                v.as_object_mut().unwrap().remove("timing");
                serde_json::json!({"ok": v})
            }
            Err(e) => serde_json::json!({"error": e}),
        };
        if let Some(d) = common::diff(want, &got, "") {
            bad.push(format!("#{i} {case}: {d}"));
        }
    }
    let _ = std::fs::remove_dir_all(&work);
    assert!(bad.is_empty(), "{} / {} 通りが食い違いました:\n{}", bad.len(), cases.len(), bad.join("\n"));
}
