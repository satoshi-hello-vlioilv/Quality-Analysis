//! 異常ロット一覧の速さを測る（Rust）。program/tests/lotlist_bench.py（Python）と同じ問い合わせ・同じ回数。
//!     cargo run --release --example lotbench -- <品質データ.sqlite3>
use da_core::lotlist::{query, Args};
use std::time::Instant;

fn main() {
    let db = std::env::args().nth(1).expect("品質データの場所");
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
    let f = |c: &str, o: &str, v: &str| format!(r#"[{{"column":"{c}","op":"{o}","value":"{v}"}}]"#);
    let cases: Vec<(&str, Args)> = vec![
        ("1ページ目（500行）", Args::default()),
        ("検索「汚れ」（全列）", Args { search: "汚れ".into(), ..Default::default() }),
        (
            "条件2つ（等しい・90日以内）",
            Args {
                filters: r#"[{"column":"不良名","op":"eq","value":"汚れ"},{"column":"発生日","op":"within_days","value":"90"}]"#.into(),
                ..Default::default()
            },
        ),
        ("並べ替え", Args { sorts: r#"[{"column":"重量","dir":"desc"}]"#.into(), ..Default::default() }),
        ("ロット番号でまとめる＋並べ替え", Args { group: true, sorts: r#"[{"column":"重量","dir":"desc"}]"#.into(), ..Default::default() }),
        ("数で絞る", Args { filters: f("重量", "gte", "3000"), ..Default::default() }),
        (
            "0件（日付の手がかり）",
            Args {
                filters: r#"[{"column":"発生日","op":"within_days","value":"0"},{"column":"設備","op":"eq","value":"無い"}]"#.into(),
                ..Default::default()
            },
        ),
    ];
    for (name, a) in &cases {
        let _ = query(db.as_ref(), a, "", 500, today); // 1回目（日付の列の見分け・OS のキャッシュ）は数えない
        let mut ms: Vec<f64> = (0..5)
            .map(|_| {
                let t = Instant::now();
                let v = query(db.as_ref(), a, "", 500, today).unwrap();
                let _ = serde_json::to_vec(&v).unwrap();
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("{name}\t{:.0}", ms[2]);
    }
}
