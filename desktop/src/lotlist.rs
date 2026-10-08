//! 異常ロット一覧を品質データ（SQLite）から引く。Python 版（program/app/services/lot_list.py）と**同じ答え**を作る。
//!
//! 絞り込み・並べ替え・ページ・まとめ（ロット番号）・日付の列・0 件の手がかりの決まりは Python 版の写し。SQL の文も同じ物を作り、
//! SQL の中の CStr・Val・ToDate・Nz は Rust の関数（pyfmt）として SQLite に入れる（Python 版は行×列の回数だけ Python の関数を
//! 呼ぶので、検索・0 件の手がかりが遅かった。DESKTOP_MIGRATION_DESIGN.md §7.1）。
//! 答えが同じことは desktop/tests/lotlist_parity.rs が Python の答え（program/tests/lotlist_oracle.py）と比べて確かめる。

use crate::pyfmt::{self, Py};
use chrono::{Datelike, Duration as Days, NaiveDate};
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const MAX_FILTERS: usize = 20;
const MAX_SORTS: usize = 4;
const PAGE_SIZE_MAX: i64 = 5000;
pub const PAGE_SIZE_DEFAULT: i64 = 500;
const DATE_SAMPLE: usize = 60;
const DATE_RATIO: f64 = 0.8;
const TABLE_CANDIDATES: &[&str] = &["仕掛", "品質情報", "品質", "保留"];
const LOT_COLUMN_CANDIDATES: &[&str] = &["ロット番号", "ﾛｯﾄ番号", "ロット№", "LTNO"];
const ALLOWED_OPS: &[&str] = &[
    "contains",
    "not_contains",
    "eq",
    "neq",
    "starts",
    "starts_any",
    "ends",
    "gt",
    "gte",
    "lt",
    "lte",
    "empty",
    "not_empty",
    "within_days",
    "within_weeks",
    "within_months",
    "within_years",
];
const ROWID_NAMES: &[&str] = &["rowid", "_rowid_", "oid"];

/// 画面が送る問い合わせ文字（/api/lotlist の引数）。無い物は None。
#[derive(Debug, Default, Clone)]
pub struct Args {
    pub table: String,
    pub page: Option<String>,
    pub page_size: Option<String>,
    pub search: String,
    pub filters: String,
    pub sorts: String,
    pub group: bool,
}

impl Args {
    /// 問い合わせ文字（a=1&b=2）から。
    pub fn from_query(query: &str) -> Args {
        let mut a = Args::default();
        for (k, v) in parse_query(query) {
            match k.as_str() {
                "table" => a.table = v,
                "page" => a.page = Some(v),
                "page_size" => a.page_size = Some(v),
                "search" => a.search = v,
                "filters" => a.filters = v,
                "sorts" => a.sorts = v,
                "group" => a.group = v == "1",
                _ => {}
            }
        }
        a
    }
}

/// 問い合わせ文字を読む（+ は空白・%xx は戻す。同じ名前は最初の物＝Python の request.args.get と同じ）。
pub fn parse_query(q: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for part in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        let (k, v) = (unquote(k), unquote(v));
        if !out.iter().any(|(n, _)| *n == k) {
            out.push((k, v));
        }
    }
    out
}

fn unquote(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                    out.push(h << 4 | l);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 識別子を [ ] で括る。
pub fn qi(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

fn py_of(v: ValueRef<'_>) -> Py<'_> {
    match v {
        ValueRef::Null => Py::None,
        ValueRef::Integer(i) => Py::Int(i),
        ValueRef::Real(f) => Py::Float(f),
        ValueRef::Text(t) => Py::Text(std::str::from_utf8(t).unwrap_or("")),
        ValueRef::Blob(b) => Py::Blob(b),
    }
}

/// 一覧の答えに入れる値（Python の _json_value と同じ。バイナリは大きさだけ）。
fn json_of(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::from(format!("（バイナリ {} バイト）", b.len())),
    }
}

/// 読み取り専用で開き、Access 風の関数を入れる（Python の sqlite_ro.connect_ro と同じ）。
pub fn connect_ro(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let c = Connection::open_with_flags(path, flags).map_err(|e| match path.try_exists() {
        Ok(false) => format!("データベースが見つかりません: {}", path.display()),
        _ => format!("データベースを開けませんでした: {}（SQLite: {e}）", path.display()),
    })?;
    let _ = c.busy_timeout(std::time::Duration::from_secs(10));
    let utf8 = FunctionFlags::SQLITE_UTF8;
    let add = |name: &str, n: i32, flags: FunctionFlags, f: fn(&Context<'_>) -> rusqlite::Result<SqlValue>| {
        c.create_scalar_function(name, n, flags, f).map_err(|e| e.to_string())
    };
    add("CStr", 1, utf8, |ctx| Ok(SqlValue::Text(py_of(ctx.get_raw(0)).cstr())))?;
    add("Val", 1, utf8, |ctx| Ok(SqlValue::Real(pyfmt::val(&py_of(ctx.get_raw(0))))))?;
    add("Nz", 2, utf8, |ctx| {
        let v = ctx.get_raw(0);
        Ok(SqlValue::from(if v == ValueRef::Null { ctx.get_raw(1) } else { v }))
    })?;
    add("ToDate", 1, utf8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(pyfmt::to_date(&py_of(ctx.get_raw(0))).map(SqlValue::Text).unwrap_or(SqlValue::Null))
    })?;
    add("SortKey", 1, utf8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| Ok(sort_key(&py_of(ctx.get_raw(0)))))?;
    Ok(c)
}

/// 並べ替えの鍵（Python の sqlite_ro.sort_key と同じ）: 空欄（NULL・空白だけ）は NULL、数と数に読める字は数、
/// ほかは前後の空白を除いた字。一覧の「並び・まとめ」で同じ値と見る物を、並べ替えでも隣へ寄せる。
pub fn sort_key(v: &Py) -> SqlValue {
    match v {
        Py::None => SqlValue::Null,
        Py::Int(i) => SqlValue::Integer(*i),
        Py::Float(f) => SqlValue::Real(*f),
        _ => {
            let text = v.cstr();
            let s = pyfmt::strip(&text);
            if s.is_empty() {
                return SqlValue::Null;
            }
            if s.bytes().any(|b| b.is_ascii_digit()) && s.bytes().all(|b| b"0123456789.eE+-".contains(&b)) {
                if let Ok(f) = s.parse::<f64>() {
                    return SqlValue::Real(f);
                }
            }
            SqlValue::Text(s.to_string())
        }
    }
}

fn sql_err(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(m)) => m,
        e => e.to_string(),
    }
}

pub fn tables(c: &Connection) -> Result<Vec<String>, String> {
    let mut st = c
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(sql_err)?;
    let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?;
    rows.collect::<Result<_, _>>().map_err(sql_err)
}

/// 設定の表 → 候補の完全一致 → 候補を含む名前 → 最初の表。
pub fn pick_table(names: &[String], preferred: &str) -> String {
    if !preferred.is_empty() && names.iter().any(|n| n == preferred) {
        return preferred.into();
    }
    for c in TABLE_CANDIDATES {
        if names.iter().any(|n| n == c) {
            return c.to_string();
        }
    }
    for c in TABLE_CANDIDATES {
        if let Some(n) = names.iter().find(|n| n.contains(c)) {
            return n.clone();
        }
    }
    names.first().cloned().unwrap_or_default()
}

fn raw_columns(c: &Connection, t: &str) -> Result<Vec<String>, String> {
    let mut st = c.prepare(&format!("PRAGMA table_info({})", qi(t))).map_err(sql_err)?;
    let rows = st.query_map([], |r| r.get::<_, String>(1)).map_err(sql_err)?;
    rows.collect::<Result<_, _>>().map_err(sql_err)
}

fn dedup(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for x in raw {
        if !out.contains(x) {
            out.push(x.clone());
        }
    }
    out
}

pub fn lot_column(cs: &[String]) -> String {
    for c in LOT_COLUMN_CANDIDATES {
        if cs.iter().any(|x| x == c) {
            return c.to_string();
        }
    }
    cs.iter().find(|c| c.contains("ロット") || c.contains("ﾛｯﾄ")).cloned().unwrap_or_default()
}

/// Python の真偽（JSON の値）。
fn json_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python の str(JSON から読んだ値)。
fn json_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => json_repr(other),
    }
}

fn json_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True" } else { "False" }.into(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => pyfmt::float_repr(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => pyfmt::str_repr(s),
        Value::Array(a) => format!("[{}]", a.iter().map(json_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => {
            format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", pyfmt::str_repr(k), json_repr(v))).collect::<Vec<_>>().join(", "))
        }
    }
}

/// it.get(key) or 既定 を str にして strip（Python の str(it.get(k) or d).strip()）。
fn field(it: &Map<String, Value>, key: &str, default: &str) -> String {
    match it.get(key) {
        Some(v) if json_truthy(v) => pyfmt::strip(&json_str(v)).to_string(),
        _ => default.to_string(),
    }
}

#[derive(Debug, Clone)]
pub struct Filter {
    pub column: String,
    pub op: String,
    pub value: String,
}

fn safe_filters(text: &str, cs: &[String]) -> Vec<Filter> {
    if text.is_empty() {
        return vec![];
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else { return vec![] };
    let mut out = vec![];
    for it in items.iter().take(MAX_FILTERS) {
        let Value::Object(it) = it else { continue };
        let (column, op, value) = (field(it, "column", ""), field(it, "op", "contains"), field(it, "value", ""));
        if cs.contains(&column) && ALLOWED_OPS.contains(&op.as_str()) {
            out.push(Filter { column, op, value });
        }
    }
    out
}

fn relative_unit(op: &str) -> Option<&'static str> {
    match op {
        "within_days" => Some("days"),
        "within_weeks" => Some("weeks"),
        "within_months" => Some("months"),
        "within_years" => Some("years"),
        _ => None,
    }
}

/// 「今日から N 単位前」の日付（Python の cutoff_date と同じ。N は 0 以上の整数、読めなければ 0）。
pub fn cutoff_date(op: &str, value: &str, today: NaiveDate) -> Result<String, String> {
    let n: i64 = match pyfmt::py_float(value) {
        Err(_) => 0,
        Ok(f) if f.is_nan() => 0,
        Ok(f) if f.is_infinite() => return Err("cannot convert float infinity to integer".into()),
        Ok(f) => (f.trunc().clamp(-1e15, 1e15) as i64).max(0),
    };
    let range = || "date value out of range".to_string();
    let d = match relative_unit(op).unwrap_or("days") {
        "days" => today.checked_sub_signed(Days::try_days(n).ok_or_else(range)?).ok_or_else(range)?,
        "weeks" => today.checked_sub_signed(Days::try_weeks(n).ok_or_else(range)?).ok_or_else(range)?,
        unit => {
            let months = n.checked_mul(if unit == "years" { 12 } else { 1 }).ok_or_else(range)?;
            let total = today.year() as i64 * 12 + today.month0() as i64 - months;
            let (y, m) = (total.div_euclid(12), total.rem_euclid(12) + 1);
            if !(1..=9999).contains(&y) {
                return Err(format!("year {y} is out of range"));
            }
            let first_next =
                if m == 12 { NaiveDate::from_ymd_opt(y as i32 + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y as i32, m as u32 + 1, 1) };
            let last = first_next.and_then(|d| d.pred_opt()).map(|d| d.day()).unwrap_or(28);
            NaiveDate::from_ymd_opt(y as i32, m as u32, today.day().min(last)).ok_or_else(range)?
        }
    };
    if d.year() < 1 {
        return Err(range());
    }
    Ok(d.format("%Y-%m-%d").to_string())
}

fn build_filter_where(filters: &[Filter], today: NaiveDate) -> Result<(Vec<String>, Vec<SqlValue>), String> {
    let (mut parts, mut params): (Vec<String>, Vec<SqlValue>) = (vec![], vec![]);
    let text = |s: String| SqlValue::Text(s);
    for f in filters {
        let (col, op, value) = (qi(&f.column), f.op.as_str(), f.value.as_str());
        match op {
            "contains" => {
                parts.push(format!("CStr({col}) LIKE ?"));
                params.push(text(format!("%{value}%")));
            }
            "not_contains" => {
                parts.push(format!("(CStr({col}) NOT LIKE ? OR {col} IS NULL)"));
                params.push(text(format!("%{value}%")));
            }
            "eq" => {
                parts.push(format!("CStr({col})=?"));
                params.push(text(value.into()));
            }
            "neq" => {
                parts.push(format!("(CStr({col})<>? OR {col} IS NULL)"));
                params.push(text(value.into()));
            }
            "starts" => {
                parts.push(format!("CStr({col}) LIKE ?"));
                params.push(text(format!("{value}%")));
            }
            "starts_any" => {
                let vals: Vec<&str> = if value.is_empty() { vec![] } else { value.split(',').filter(|x| !x.is_empty()).take(60).collect() };
                if vals.is_empty() {
                    parts.push("0=1".into());
                } else {
                    parts.push(format!("({})", vals.iter().map(|_| format!("CStr({col}) LIKE ?")).collect::<Vec<_>>().join(" OR ")));
                    params.extend(vals.iter().map(|v| text(format!("{v}%"))));
                }
            }
            "ends" => {
                parts.push(format!("CStr({col}) LIKE ?"));
                params.push(text(format!("%{value}")));
            }
            "empty" => parts.push(format!("({col} IS NULL OR CStr({col})='')")),
            "not_empty" => parts.push(format!("({col} IS NOT NULL AND CStr({col})<>'')")),
            "gt" | "gte" | "lt" | "lte" => {
                let sign = match op {
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    _ => "<=",
                };
                parts.push(format!("Val(CStr({col})) {sign} ?"));
                params.push(SqlValue::Real(pyfmt::val(&Py::Text(value))));
            }
            _ if relative_unit(op).is_some() => {
                parts.push(format!("ToDate({col}) >= ?"));
                params.push(text(cutoff_date(op, value, today)?));
            }
            _ => {}
        }
    }
    Ok((parts, params))
}

/// 並べ替え1つ（列・向き・鍵の形）。鍵の形は画面が列の書式から決める（Python の lot_list.sort_key_kind と同じ）。
pub type Sort = (String, &'static str, String);

/// 鍵の形: date・month・year・round:N（N は 0〜10）。分からなければ ""（そのままの値）。
fn sort_key_kind(v: &str) -> String {
    let k = v.to_lowercase();
    if ["date", "month", "year"].contains(&k.as_str()) {
        return k;
    }
    match k.strip_prefix("round:") {
        Some(n) if (1..=2).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()) => {
            format!("round:{}", n.parse::<u32>().unwrap_or(0).min(10))
        }
        _ => String::new(),
    }
}

fn safe_sorts(text: &str, cs: &[String]) -> Vec<Sort> {
    let items = if text.is_empty() { Value::Array(vec![]) } else { serde_json::from_str(text).unwrap_or(Value::Array(vec![])) };
    let mut out: Vec<Sort> = vec![];
    for it in items.as_array().into_iter().flatten() {
        let (col, dir, key) = match it {
            Value::String(s) => (pyfmt::strip(s).to_string(), String::new(), String::new()),
            Value::Object(o) => (field(o, "column", ""), field(o, "dir", ""), field(o, "key", "")),
            _ => continue,
        };
        if !cs.contains(&col) || out.iter().any(|(c, _, _)| *c == col) {
            continue;
        }
        out.push((col, if dir.to_lowercase() == "desc" { "DESC" } else { "ASC" }, sort_key_kind(&key)));
        if out.len() >= MAX_SORTS {
            break;
        }
    }
    out
}

/// 並べ替えに使う式（Python の lot_list.order_key と同じ）。ふだんは SortKey（ロット番号の列は大小を同じに）。
/// 日付だけ・年月・年で見せる列は ToDate の頭（読めない値はその後ろで SortKey）、小数 N 桁で見せる列は丸めた数。
fn order_key(col: &str, lot: &str, key: &str) -> Vec<String> {
    let q = qi(col);
    let head = match key {
        "date" => Some(format!("ToDate({q})")),
        "month" => Some(format!("SUBSTR(ToDate({q}), 1, 7)")),
        "year" => Some(format!("SUBSTR(ToDate({q}), 1, 4)")),
        _ => None,
    };
    if let Some(h) = head {
        return vec![h, format!("CASE WHEN ToDate({q}) IS NULL THEN SortKey({q}) END")];
    }
    if let Some(n) = key.strip_prefix("round:") {
        return vec![format!("CASE WHEN typeof(SortKey({q})) IN ('integer', 'real') THEN ROUND(SortKey({q}), {n}) ELSE SortKey({q}) END")];
    }
    vec![if col == lot { format!("SortKey(UPPER(CStr({q})))") } else { format!("SortKey({q})") }]
}

/// [(列, 向き, 鍵の形)] → ORDER BY の後ろ（Python の lot_list.order_sql と同じ）。
fn order_sql(order: &[Sort], lot: &str) -> String {
    order.iter().flat_map(|(c, d, k)| order_key(c, lot, k).into_iter().map(move |x| format!("{x} {d}"))).collect::<Vec<_>>().join(",")
}

fn lot_key(col: &str) -> String {
    format!("UPPER(TRIM(CStr({})))", qi(col))
}

fn rowid_name(c: &Connection, t: &str, raw_cs: &[String]) -> Option<&'static str> {
    let kind: Option<String> = c.query_row("SELECT type FROM sqlite_master WHERE name = ?", [t], |r| r.get(0)).ok();
    if kind.as_deref() != Some("table") {
        return None;
    }
    for name in ROWID_NAMES {
        if raw_cs.iter().any(|x| x.to_lowercase() == name.to_lowercase()) {
            continue;
        }
        return c.prepare(&format!("SELECT {name} FROM {} LIMIT 0", qi(t))).ok().map(|_| *name);
    }
    None
}

/// まとめた並びの SQL（Python の grouped_sql と同じ文）。最後の ? はページ。
pub fn grouped_sql(t: &str, raw_cs: &[String], lot: &str, wh: &str, order: &[Sort], size: i64, rid: Option<&str>) -> String {
    let over = if order.is_empty() { String::new() } else { format!("ORDER BY {}", order_sql(order, lot)) };
    let cols = raw_cs.iter().map(|x| qi(x)).collect::<Vec<_>>().join(", ");
    let steps = "
        k AS (SELECT *, CASE WHEN _tpa_k0 = '' THEN '#' || _tpa_rn ELSE _tpa_k0 END AS _tpa_k FROM b),
        g AS (SELECT *, MIN(_tpa_rn) OVER (PARTITION BY _tpa_k) AS _tpa_first, COUNT(*) OVER (PARTITION BY _tpa_k) AS _tpa_n FROM k),
        p AS (SELECT *, ROW_NUMBER() OVER (ORDER BY _tpa_first, _tpa_rn) AS _tpa_pos FROM g),
        q AS (SELECT *, MIN(_tpa_pos) OVER (PARTITION BY _tpa_k) AS _tpa_head FROM p),";
    let page = format!("r AS (SELECT *, DENSE_RANK() OVER (ORDER BY (_tpa_head - 1) / {size}) AS _tpa_page FROM q)");
    let (qt, key) = (qi(t), lot_key(lot));
    match rid {
        Some(rid) => {
            let tail = raw_cs.iter().map(|x| format!("{qt}.{}", qi(x))).collect::<Vec<_>>().join(", ");
            format!(
                "WITH b AS (SELECT {rid} AS _tpa_id, ROW_NUMBER() OVER ({over}) AS _tpa_rn, {key} AS _tpa_k0 FROM {qt}{wh}),\
{steps} {page} SELECT {tail}, r._tpa_n, r._tpa_pos - r._tpa_head + 1, r._tpa_pos FROM r \
JOIN {qt} ON {qt}.{rid} = r._tpa_id WHERE r._tpa_page = ? ORDER BY r._tpa_pos"
            )
        }
        None => format!(
            "WITH b AS (SELECT *, ROW_NUMBER() OVER ({over}) AS _tpa_rn, {key} AS _tpa_k0 FROM {qt}{wh}),\
{steps} {page} SELECT {cols}, _tpa_n, _tpa_pos - _tpa_head + 1, _tpa_pos FROM r WHERE _tpa_page = ? ORDER BY _tpa_pos"
        ),
    }
}

/// 読んだ行（各行の値と、続きの数の列）。
type Rows = (Vec<Vec<Value>>, Vec<Vec<i64>>);

/// 行を読む（各行の値と、続きの数の列）。
fn read_rows(c: &Connection, sql: &str, params: &[SqlValue], ncols: usize) -> Result<Rows, String> {
    let mut st = c.prepare(sql).map_err(sql_err)?;
    let total = st.column_count();
    let mut rows = st.query(params_from_iter(params.iter())).map_err(sql_err)?;
    let (mut vals, mut extra) = (vec![], vec![]);
    while let Some(r) = rows.next().map_err(sql_err)? {
        let mut v = Vec::with_capacity(ncols);
        for i in 0..ncols {
            v.push(json_of(r.get_ref(i).map_err(sql_err)?));
        }
        let mut x = vec![];
        for i in ncols..total {
            x.push(r.get::<_, i64>(i).map_err(sql_err)?);
        }
        vals.push(v);
        extra.push(x);
    }
    Ok((vals, extra))
}

fn count(c: &Connection, sql: &str, params: &[SqlValue]) -> Result<i64, String> {
    c.query_row(sql, params_from_iter(params.iter()), |r| r.get::<_, Option<i64>>(0)).map(|v| v.unwrap_or(0)).map_err(sql_err)
}

fn date_columns(c: &Connection, t: &str, cs: &[String]) -> Result<Vec<String>, String> {
    let mut out = vec![];
    for col in cs {
        let q = qi(col);
        let mut st = c
            .prepare(&format!("SELECT {q} FROM {} WHERE {q} IS NOT NULL AND CStr({q})<>'' LIMIT {DATE_SAMPLE}", qi(t)))
            .map_err(sql_err)?;
        let mut rows = st.query([]).map_err(sql_err)?;
        let (mut n, mut dated) = (0usize, 0usize);
        while let Some(r) = rows.next().map_err(sql_err)? {
            n += 1;
            if pyfmt::to_date(&py_of(r.get_ref(0).map_err(sql_err)?)).is_some() {
                dated += 1;
            }
        }
        if n > 0 && dated as f64 / n as f64 >= DATE_RATIO {
            out.push(col.clone());
        }
    }
    Ok(out)
}

type DateKey = (String, u128, String, Vec<String>);

/// 写しは世代ごとに別のファイルなので、(ファイル, 更新時刻, 表, 列) が同じなら前の答えを使う（Python と同じ）。
fn date_columns_cached(path: &Path, c: &Connection, t: &str, cs: &[String]) -> Result<Vec<String>, String> {
    static CACHE: OnceLock<Mutex<HashMap<DateKey, Vec<String>>>> = OnceLock::new();
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok());
    let Some(mtime) = mtime else { return date_columns(c, t, cs) };
    let key = (path.display().to_string(), mtime.as_nanos(), t.to_string(), cs.to_vec());
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(v) = cache.lock().unwrap().get(&key) {
        return Ok(v.clone());
    }
    let v = date_columns(c, t, cs)?;
    let mut m = cache.lock().unwrap();
    if m.len() > 32 {
        m.clear();
    }
    m.insert(key, v.clone());
    Ok(v)
}

fn date_hints(c: &Connection, t: &str, filters: &[Filter], today: NaiveDate) -> Result<Vec<Value>, String> {
    let mut out = vec![];
    let qt = qi(t);
    for f in filters.iter().filter(|f| relative_unit(&f.op).is_some()) {
        let col = qi(&f.column);
        let cut = cutoff_date(&f.op, &f.value, today)?;
        let (dated, newest, oldest): (i64, Option<String>, Option<String>) = c
            .query_row(
                &format!("SELECT COUNT(*), MAX(ToDate({col})), MIN(ToDate({col})) FROM {qt} WHERE ToDate({col}) IS NOT NULL"),
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql_err)?;
        let mut raw = Value::Null;
        if let Some(n) = &newest {
            let mut st = c.prepare(&format!("SELECT {col} FROM {qt} WHERE ToDate({col}) = ? LIMIT 1")).map_err(sql_err)?;
            let mut rows = st.query([n]).map_err(sql_err)?;
            if let Some(r) = rows.next().map_err(sql_err)? {
                raw = json_of(r.get_ref(0).map_err(sql_err)?);
            }
        }
        let alone = count(c, &format!("SELECT COUNT(*) FROM {qt} WHERE ToDate({col}) >= ?"), &[SqlValue::Text(cut.clone())])?;
        let filled = count(c, &format!("SELECT COUNT(*) FROM {qt} WHERE {col} IS NOT NULL AND CStr({col})<>''"), &[])?;
        out.push(json!({"column": f.column, "op": f.op, "value": f.value, "cutoff": cut, "dated": dated, "filled": filled,
                        "newest": newest, "newestRaw": raw, "oldest": oldest, "alone": alone}));
    }
    Ok(out)
}

/// 一覧の1ページ（Python の lot_list.query と同じ答え）。default_page_size は設定の件数（引数に page_size が無いとき）。
pub fn query(path: &Path, a: &Args, preferred_table: &str, default_page_size: i64, today: NaiveDate) -> Result<Value, String> {
    let t0 = Instant::now();
    let page = match a.page.as_deref() {
        None | Some("") => 1,
        Some(p) => pyfmt::py_int(p)?,
    }
    .max(1);
    let size = match a.page_size.as_deref() {
        None => {
            if default_page_size == 0 {
                PAGE_SIZE_DEFAULT
            } else {
                default_page_size
            }
        }
        Some("") => PAGE_SIZE_DEFAULT,
        Some(s) => pyfmt::py_int(s)?,
    }
    .clamp(1, PAGE_SIZE_MAX);
    let q = pyfmt::strip(&a.search).to_string();
    let c = connect_ro(path)?;
    let names = tables(&c)?;
    let t = if names.contains(&a.table) { a.table.clone() } else { pick_table(&names, preferred_table) };
    if t.is_empty() {
        return Err("品質データにテーブルが1つもありません。".into());
    }
    let raw_cs = raw_columns(&c, &t)?;
    let cs = dedup(&raw_cs);
    let (mut where_parts, mut params): (Vec<String>, Vec<SqlValue>) = (vec![], vec![]);
    if !q.is_empty() {
        where_parts.push(format!("({})", cs.iter().map(|x| format!("CStr({}) LIKE ?", qi(x))).collect::<Vec<_>>().join(" OR ")));
        params.extend(cs.iter().map(|_| SqlValue::Text(format!("%{q}%"))));
    }
    let fl = safe_filters(&a.filters, &cs);
    let (fp, fpp) = build_filter_where(&fl, today)?;
    where_parts.extend(fp);
    params.extend(fpp);
    let wh = if where_parts.is_empty() { String::new() } else { format!(" WHERE {}", where_parts.join(" AND ")) };
    let lot = lot_column(&cs);
    let order_parts = safe_sorts(&a.sorts, &cs);
    let order = if order_parts.is_empty() { String::new() } else { format!(" ORDER BY {}", order_sql(&order_parts, &lot)) };
    let qt = qi(&t);
    let total = count(&c, &format!("SELECT COUNT(*) FROM {qt}{wh}"), &params)?;
    let start = (page - 1).saturating_mul(size);
    let mut out = Map::new();
    let (rows, first, last) = if a.group && !lot.is_empty() {
        let sql = grouped_sql(&t, &raw_cs, &lot, &wh, &order_parts, size, rowid_name(&c, &t, &raw_cs));
        let mut p = params.clone();
        p.push(SqlValue::Integer(page));
        let (rows, extra) = read_rows(&c, &sql, &p, raw_cs.len())?;
        let groups: Vec<Value> = extra.iter().map(|x| json!([x[0], x[1]])).collect();
        let (first, last) = (extra.first().map(|x| x[2]).unwrap_or(0), extra.last().map(|x| x[2]).unwrap_or(0));
        let gc = count(
            &c,
            &format!("SELECT COUNT(DISTINCT NULLIF(k, '')) + COALESCE(SUM(k = ''), 0) FROM (SELECT {} AS k FROM {qt}{wh})", lot_key(&lot)),
            &params,
        )?;
        out.insert("groups".into(), Value::Array(groups));
        out.insert("groupCount".into(), json!(gc));
        (rows, first, last)
    } else {
        let (rows, _) = read_rows(&c, &format!("SELECT * FROM {qt}{wh}{order} LIMIT {size} OFFSET {start}"), &params, raw_cs.len())?;
        let fl = if rows.is_empty() { (0, 0) } else { (start + 1, start + rows.len() as i64) };
        (rows, fl.0, fl.1)
    };
    let dcols = date_columns_cached(path, &c, &t, &cs)?;
    let hints = if total == 0 { date_hints(&c, &t, &fl, today)? } else { vec![] };
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            let mut m = Map::new();
            for (col, v) in raw_cs.iter().zip(r) {
                m.insert(col.clone(), v); // 同じ名前の列は後ろの値（Python の dict と同じ）
            }
            Value::Object(m)
        })
        .collect();
    let base = json!({
        "table": t, "tables": names, "columns": cs, "lotColumn": lot, "dateColumns": dcols,
        "today": today.format("%Y-%m-%d").to_string(), "dateHints": hints, "rows": rows,
        "count": total, "page": page, "page_size": size, "range": [first, last],
        "filters_applied": fl.len(),
        "sorts": order_parts.iter().map(|(c, d, k)| {
            let mut o = json!({"column": c, "dir": d.to_lowercase()});
            if !k.is_empty() {
                o["key"] = json!(k);
            }
            o
        }).collect::<Vec<_>>(),
        "timing": {"server": t0.elapsed().as_millis() as u64},
    });
    if let Value::Object(b) = base {
        out.extend(b);
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_text_like_python() {
        let a = Args::from_query("search=%E6%97%A5+%E6%9C%AC&page=2&group=1&page=9&filters=%5B%5D&x=%zz");
        assert_eq!((a.search.as_str(), a.page.as_deref(), a.group, a.filters.as_str()), ("日 本", Some("2"), true, "[]"));
        assert_eq!(unquote("100%"), "100%");
        assert_eq!(unquote("%zz%4"), "%zz%4");
    }

    #[test]
    fn cutoff_like_python() {
        let d = NaiveDate::from_ymd_opt(2026, 3, 31).unwrap();
        assert_eq!(cutoff_date("within_months", "1", d).unwrap(), "2026-02-28", "月末に合わせる");
        assert_eq!(cutoff_date("within_years", "2", NaiveDate::from_ymd_opt(2024, 2, 29).unwrap()).unwrap(), "2022-02-28");
        assert_eq!(cutoff_date("within_days", "x", d).unwrap(), "2026-03-31", "読めなければ 0");
        assert_eq!(cutoff_date("within_weeks", "1.9", d).unwrap(), "2026-03-24", "小数は切り捨て");
        assert_eq!(cutoff_date("within_days", "-5", d).unwrap(), "2026-03-31", "負は 0");
        assert!(cutoff_date("within_days", "inf", d).is_err());
    }

    #[test]
    fn sort_key_like_python() {
        let k = |v: Py| sort_key(&v);
        for blank in ["", "  ", "\u{3000}"] {
            assert_eq!(k(Py::Text(blank)), SqlValue::Null, "空欄はまとめる");
        }
        assert_eq!(k(Py::None), SqlValue::Null);
        assert_eq!(k(Py::Int(54)), SqlValue::Integer(54));
        assert_eq!(k(Py::Text(" 54 ")), SqlValue::Real(54.0), "数に読める字は数");
        assert_eq!(k(Py::Text("1e-05")), SqlValue::Real(1e-05));
        assert_eq!(k(Py::Text("+.5")), SqlValue::Real(0.5));
        assert_eq!(k(Py::Text("2.")), SqlValue::Real(2.0));
        for (v, want) in [(" 100%", "100%"), ("1-2", "1-2"), ("e5", "e5"), ("a]b ", "a]b"), ("Ｌ－１", "Ｌ－１")] {
            assert_eq!(k(Py::Text(v)), SqlValue::Text(want.into()));
        }
        assert_eq!(k(Py::Blob(b"\x00\x01")), SqlValue::Text("b'\\x00\\x01'".into()));
    }
}
