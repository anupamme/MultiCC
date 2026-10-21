//! 只读 Token 统计。目录顺序、窗口边界由 Node 传入；逐行解析不展开无关正文。
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    claude_files: Vec<String>,
    codex_files: Vec<String>,
    windows: Bounds,
    timezone: String,
}
#[derive(Deserialize)]
struct Bounds {
    today: String,
    week: String,
    month: String,
}
#[derive(Deserialize, Default)]
struct Row<'a> {
    #[serde(default = "missing_timestamp")]
    timestamp: Value,
    #[serde(default, rename = "requestId")]
    request_id: Value,
    #[serde(default)]
    uuid: Value,
    #[serde(default, rename = "type")]
    kind: Value,
    #[serde(default)]
    message: Option<Message>,
    #[serde(default, borrow)]
    payload: Option<&'a RawValue>,
}
#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    id: Value,
    #[serde(default)]
    model: Value,
    #[serde(default)]
    usage: Value,
}
#[derive(Deserialize)]
struct Payload {
    #[serde(default)]
    model: Value,
    #[serde(default, rename = "type")]
    kind: Value,
    #[serde(default)]
    info: Value,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    input_tokens: f64,
    output_tokens: f64,
    cache_write: f64,
    cache_read: f64,
    msgs: usize,
}
type Models = BTreeMap<String, Bucket>;
type Days = BTreeMap<String, BTreeMap<String, f64>>;
#[derive(Default, Serialize)]
struct Windows {
    today: Models,
    week: Models,
    month: Models,
    all: Models,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    scanned_files: usize,
    responses: usize,
    windows: Windows,
    by_day: Days,
    by_day_fresh: Days,
}
#[derive(Clone, Copy)]
struct Usage {
    fresh: f64,
    cached: f64,
    output: f64,
}
struct Event {
    ms: i64,
    day: String,
    model: String,
    current: Usage,
    last: Option<Usage>,
}
struct Fragment {
    derived: bool,
    meta_ms: Option<i64>,
    events: Vec<Event>,
}

fn missing_timestamp() -> Value {
    Value::String("__missing_timestamp__".into())
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn string(v: &Value, fallback: &str) -> Result<String, String> {
    if !truthy(v) {
        return Ok(fallback.into());
    }
    v.as_str()
        .map(str::to_owned)
        .ok_or_else(|| "unsupported_usage_string".into())
}
fn amount(v: &Value) -> Result<f64, String> {
    if !truthy(v) {
        return Ok(0.0);
    }
    v.as_f64()
        .filter(|x| x.is_finite())
        .ok_or_else(|| "unsupported_usage_number".into())
}
fn exclusive(v: &Value) -> Option<Usage> {
    let input = v.get("input_tokens")?.as_f64()?;
    let cached = v.get("cached_input_tokens")?.as_f64()?;
    let output = v.get("output_tokens")?.as_f64()?;
    if ![input, cached, output]
        .iter()
        .all(|x| x.is_finite() && *x >= 0.0)
        || cached > input
    {
        return None;
    }
    Some(Usage {
        fresh: input - cached,
        cached,
        output,
    })
}
fn derived(meta: &Value) -> bool {
    let source = &meta["source"];
    truthy(&meta["forked_from_id"])
        || truthy(&meta["parent_thread_id"])
        || meta["thread_source"] == "subagent"
        || source == "subagent"
        || source
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "subagent"))
        || truthy(&source["subagent"])
}
fn timestamp(value: &Value, timezone: Tz) -> Result<Option<(i64, String)>, String> {
    // 仅接管明确的 ISO / 毫秒格式；JS Date 的其他合法语法交回旧实现。
    let instant = if value.is_null() {
        Utc.timestamp_millis_opt(0)
            .single()
            .map(|d| d.with_timezone(&timezone))
    } else if let Some(n) = value.as_f64() {
        Utc.timestamp_millis_opt(n as i64)
            .single()
            .map(|d| d.with_timezone(&timezone))
    } else if let Some(text) = value.as_str() {
        if let Ok(d) = DateTime::parse_from_rfc3339(text) {
            Some(d.with_timezone(&timezone))
        } else if let Ok(d) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
            Some(
                d.and_hms_opt(0, 0, 0)
                    .unwrap()
                    .and_utc()
                    .with_timezone(&timezone),
            )
        } else if let Ok(d) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f") {
            timezone
                .from_local_datetime(&d)
                .earliest()
                .ok_or("unsupported_usage_timestamp")?
                .into()
        } else {
            return Err("unsupported_usage_timestamp".into());
        }
    } else {
        return Err("unsupported_usage_timestamp".into());
    };
    let d = instant.ok_or("unsupported_usage_timestamp")?;
    // JS Date 不接受闰秒；极端年份的格式和可表示范围也与 chrono 不同。
    if !(1000..=9999).contains(&d.year()) || d.nanosecond() >= 1_000_000_000 {
        return Err("unsupported_usage_timestamp".into());
    }
    Ok(Some((
        d.timestamp_millis(),
        d.format("%Y-%m-%d").to_string(),
    )))
}
fn add(target: &mut Models, model: &str, i: f64, o: f64, cw: f64, cr: f64) {
    let b = target.entry(model.into()).or_default();
    b.input_tokens += i;
    b.output_tokens += o;
    b.cache_write += cw;
    b.cache_read += cr;
    b.msgs += 1;
}
fn record(out: &mut Output, w: &Bounds, day: &str, model: &str, values: [f64; 4]) {
    let [i, o, cw, cr] = values;
    add(&mut out.windows.all, model, i, o, cw, cr);
    if day >= w.month.as_str() && day <= w.today.as_str() {
        add(&mut out.windows.month, model, i, o, cw, cr);
    }
    if day >= w.week.as_str() && day <= w.today.as_str() {
        add(&mut out.windows.week, model, i, o, cw, cr);
    }
    if day == w.today {
        add(&mut out.windows.today, model, i, o, cw, cr);
    }
    *out.by_day
        .entry(day.into())
        .or_default()
        .entry(model.into())
        .or_default() += i + o + cw + cr;
    *out.by_day_fresh
        .entry(day.into())
        .or_default()
        .entry(model.into())
        .or_default() += i + o;
}
fn lines(file: &str, mut visit: impl FnMut(&str) -> Result<(), String>) -> Result<(), String> {
    let Ok(file) = File::open(file) else {
        return Ok(());
    };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| "usage_read_failed")?;
        if n == 0 {
            break;
        }
        visit(&String::from_utf8_lossy(&line))?;
    }
    Ok(())
}
fn parse_fragment(file: &str, timezone: Tz) -> Result<(Value, Fragment), String> {
    let mut meta = Value::Null;
    let mut has_meta = false;
    let mut meta_ms = None;
    let mut model = "codex".to_owned();
    let mut events = Vec::new();
    lines(file, |line| {
        if !line.contains("\"session_meta\"")
            && !line.contains("\"token_count\"")
            && !line.contains("\"model\"")
        {
            return Ok(());
        }
        let row = match serde_json::from_str::<Row>(line) {
            Ok(row) => row,
            Err(_) if serde_json::from_str::<Value>(line).is_err() => {
                // JS JSON.parse 接受孤立 surrogate 和溢出数字；不能当坏行漏算。
                let error = serde_json::from_str::<Value>(line).unwrap_err().to_string();
                if line.contains("\\u") || error.contains("out of range") {
                    return Err("unsupported_usage_json".into());
                }
                return Ok(());
            }
            Err(_) => return Err("unsupported_usage_row".into()),
        };
        let Some(raw) = row.payload else {
            return Ok(());
        };
        if row.kind == "session_meta" {
            if !has_meta {
                meta = serde_json::from_str(raw.get()).map_err(|_| "invalid_usage_metadata")?;
                meta_ms = timestamp(&row.timestamp, timezone)?.map(|x| x.0);
                has_meta = true;
            }
            return Ok(());
        }
        if raw.get() == "null" {
            return Ok(());
        }
        let p: Payload =
            serde_json::from_str(raw.get()).map_err(|_| "unsupported_usage_payload")?;
        if truthy(&p.model) {
            model = string(&p.model, "codex")?;
        }
        if row.kind != "event_msg" || p.kind != "token_count" {
            return Ok(());
        }
        let Some(current) = exclusive(&p.info["total_token_usage"]) else {
            return Ok(());
        };
        let Some((ms, day)) = timestamp(&row.timestamp, timezone)? else {
            return Ok(());
        };
        let last = exclusive(&p.info["last_token_usage"]).filter(|last| {
            last.fresh <= current.fresh
                && last.cached <= current.cached
                && last.output <= current.output
        });
        events.push(Event {
            ms,
            day,
            model: model.clone(),
            current,
            last,
        });
        Ok(())
    })?;
    let fragment = Fragment {
        derived: derived(&meta),
        meta_ms,
        events,
    };
    Ok((meta, fragment))
}
fn replay_prefix(f: &Fragment) -> usize {
    if !f.derived || f.events.len() < 2 {
        return 0;
    }
    let Some(meta) = f.meta_ms else {
        return 0;
    };
    if f.events[0].ms < meta || f.events[0].ms - meta > 100 {
        return 0;
    }
    let mut n = 1;
    while n < f.events.len() {
        let delta = f.events[n].ms - f.events[n - 1].ms;
        if !(0..=100).contains(&delta) {
            break;
        }
        n += 1;
    }
    if n >= 2 {
        n
    } else {
        0
    }
}
pub fn compute(json: &str) -> Result<String, String> {
    let input: Input = serde_json::from_str(json).map_err(|_| "invalid_usage_input")?;
    let timezone: Tz = input
        .timezone
        .parse()
        .map_err(|_| "unsupported_usage_timezone")?;
    let mut out = Output {
        scanned_files: input.claude_files.len() + input.codex_files.len(),
        ..Default::default()
    };
    let mut seen = HashSet::new();
    for file in &input.claude_files {
        lines(file, |line| {
            if !line.contains("\"usage\"") {
                return Ok(());
            }
            let row = match serde_json::from_str::<Row>(line) {
                Ok(row) => row,
                Err(_) if serde_json::from_str::<Value>(line).is_err() => {
                    // JS JSON.parse 接受孤立 surrogate 和溢出数字；不能当坏行漏算。
                    let error = serde_json::from_str::<Value>(line).unwrap_err().to_string();
                    if line.contains("\\u") || error.contains("out of range") {
                        return Err("unsupported_usage_json".into());
                    }
                    return Ok(());
                }
                Err(_) => return Err("unsupported_usage_row".into()),
            };
            let Some(message) = row.message else {
                return Ok(());
            };
            if !truthy(&row.timestamp) || !truthy(&message.usage) {
                return Ok(());
            }
            let u = &message.usage;
            let values = [
                amount(&u["input_tokens"])?,
                amount(&u["output_tokens"])?,
                amount(&u["cache_creation_input_tokens"])?,
                amount(&u["cache_read_input_tokens"])?,
            ];
            if values.iter().sum::<f64>() == 0.0 {
                return Ok(());
            }
            let rid = string(&row.request_id, "")?;
            let mid = string(
                if truthy(&message.id) {
                    &message.id
                } else {
                    &row.uuid
                },
                "",
            )?;
            if !seen.insert(format!("{rid}:{mid}")) {
                return Ok(());
            }
            let Some((_, day)) = timestamp(&row.timestamp, timezone)? else {
                return Err("unsupported_usage_timestamp".into());
            };
            record(
                &mut out,
                &input.windows,
                &day,
                &string(&message.model, "unknown")?,
                values,
            );
            out.responses += 1;
            Ok(())
        })?;
    }
    // 保留 Node 给定的排序和首次出现顺序，线程续接共享同一累计基线。
    let mut groups: Vec<Vec<Fragment>> = Vec::new();
    let mut group_ids = HashMap::new();
    for file in &input.codex_files {
        let (meta, fragment) = parse_fragment(file, timezone)?;
        let identity = [&meta["id"], &meta["session_id"], &meta["thread_id"]]
            .into_iter()
            .find(|v| truthy(v));
        let key = if let Some(id) = identity {
            format!("thread:{}", string(id, "")?)
        } else {
            format!("file:{file}")
        };
        let index = *group_ids.entry(key).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[index].push(fragment);
    }
    for fragments in groups {
        let is_derived = fragments.iter().any(|f| f.derived);
        let mut high: Option<Usage> = None;
        for fragment in fragments {
            let prefix = replay_prefix(&fragment);
            for (index, event) in fragment.events.into_iter().enumerate() {
                let cur = event.current;
                let usage = if let Some(previous) = high {
                    if cur.fresh < previous.fresh
                        || cur.cached < previous.cached
                        || cur.output < previous.output
                    {
                        continue;
                    }
                    Some(Usage {
                        fresh: cur.fresh - previous.fresh,
                        cached: cur.cached - previous.cached,
                        output: cur.output - previous.output,
                    })
                } else if is_derived {
                    event.last
                } else {
                    Some(cur)
                };
                high = Some(cur);
                if index < prefix {
                    continue;
                }
                if let Some(u) = usage {
                    if u.fresh + u.output + u.cached <= 0.0 {
                        continue;
                    }
                    record(
                        &mut out,
                        &input.windows,
                        &event.day,
                        &event.model,
                        [u.fresh, u.output, 0.0, u.cached],
                    );
                    if u.output > 0.0 {
                        out.responses += 1;
                    }
                }
            }
        }
    }
    serde_json::to_string(&out).map_err(|_| "usage_result_encode".into())
}
