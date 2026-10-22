//! chrome-proxy-launcher —— MultiCC 第一个插件。
//!
//! 给每个「身份」绑定一份完全隔离的 Chrome profile（独立 user-data-dir）
//! 和一个强制出口，一键启动互不串号的浏览器。出口有两种：
//!   - 直连代理：本地 VPN 端口 / 任意 http(s)/socks5（支持账号密码，走本地中继）
//!   - 订阅节点：Clash 订阅里的某个节点，由身份专属 mihomo 内核承接；可再经
//!     该节点跳板到上游住宅代理（家宽代理的常见链路）
//!
//! 调用约定（Node 通道 src/routes/plugins.js 只做协议桥接，业务全在这里）：
//!   chrome-proxy-launcher <command>    （JSON 从 stdin 读，结果一行 JSON 到 stdout）
//!   成功：{"ok":true,"data":{...}}    失败：{"ok":false,"error":"中文原因"}，退出码 1

mod chrome;
mod core;
mod proxy;
mod relay;
mod store;
mod subs;

use serde_json::{json, Value};
use std::io::Read;
use std::thread;
use std::time::{Duration, Instant};

use store::{Profile, ProxyConfig, Subscription, SubscriptionEgress};

fn read_stdin_json() -> Value {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    if text.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(text.trim()).unwrap_or_else(|_| json!({}))
}

/// 本机常见 VPN/代理客户端的出口端口表（detect 用；都是无认证的本地端口）。
const COMMON_PROXY_PORTS: [(u16, &str); 10] = [
    (7897, "Clash 混合端口（http+socks 都收）"),
    (7890, "Clash HTTP"),
    (7891, "Clash SOCKS5"),
    (1080, "SOCKS5 常用"),
    (1086, "SOCKS5"),
    (1087, "HTTP"),
    (10808, "v2ray SOCKS5"),
    (10809, "v2ray HTTP"),
    (8888, "HTTP（Charles）"),
    (8080, "HTTP"),
];

fn get_str(value: &Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
}

fn get_bool(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn parse_proxy_input(input: &Value) -> Result<ProxyConfig, String> {
    let raw = input.get("proxy").cloned().unwrap_or_else(|| input.clone());
    let scheme = get_str(&raw, "scheme").to_lowercase();
    let host = get_str(&raw, "host");
    let port = raw.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    store::validate_proxy(&scheme, &host, port)?;
    let optional = |raw: &Value, key: &str| -> Option<String> {
        let value = get_str(raw, key);
        if value.is_empty() { None } else { Some(value) }
    };
    Ok(ProxyConfig {
        scheme,
        host,
        port,
        username: optional(&raw, "username"),
        password: optional(&raw, "password"),
    })
}

/// 解析订阅出口参数（save 与未保存时的 probe 共用）。
fn parse_subscription_egress(input: &Value) -> Result<SubscriptionEgress, String> {
    let raw = input.get("subscription").cloned().unwrap_or_else(|| json!({}));
    let id = get_str(&raw, "id");
    if id.is_empty() {
        return Err("请先选择订阅".into());
    }
    let subscriptions = store::load_subscriptions()?;
    let subscription = subscriptions
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("订阅「{id}」不存在，先刷新订阅列表"))?;
    let node = get_str(&raw, "node");
    if !node.is_empty() && !subscription.nodes.iter().any(|name| name == &node) {
        return Err(format!("订阅里没有节点「{node}」，刷新订阅后再选"));
    }
    let via = match raw.get("via") {
        Some(value) if value.is_object() && !get_str(value, "host").is_empty() => {
            Some(parse_proxy_input(&json!({ "proxy": value }))?)
        }
        _ => None,
    };
    Ok(SubscriptionEgress { id, node, via })
}

/// 解析 save 的出口参数：direct（代理）或 subscription（订阅节点 ± 上游）。
fn parse_egress(input: &Value) -> Result<(Option<ProxyConfig>, Option<SubscriptionEgress>), String> {
    let kind = {
        let raw = get_str(input, "egressType");
        if raw.is_empty() { "direct".to_string() } else { raw }
    };
    match kind.as_str() {
        "direct" => Ok((Some(parse_proxy_input(input)?), None)),
        "subscription" => Ok((None, Some(parse_subscription_egress(input)?))),
        other => Err(format!("未知出口类型「{other}」（可用 direct / subscription）")),
    }
}

fn egress_text(profile: &Profile, subscriptions: &[Subscription]) -> String {
    if let Some(egress) = &profile.subscription {
        let sub_name = subscriptions
            .iter()
            .find(|item| item.id == egress.id)
            .map(|item| item.name.clone())
            .unwrap_or_else(|| egress.id.clone());
        let node = if egress.node.is_empty() { "（第一个节点）" } else { &egress.node };
        let mut text = format!("订阅「{sub_name}」/ {node}");
        if let Some(via) = &egress.via {
            text.push_str(&format!(" → 上游 {}://{}:{}", via.scheme, via.host, via.port));
        }
        text
    } else if let Some(proxy) = &profile.proxy {
        let user = if proxy.has_credentials() {
            format!("{}@", proxy.username.as_deref().unwrap_or(""))
        } else {
            String::new()
        };
        let lock = if proxy.has_credentials() { " 🔑" } else { "" };
        format!("{}://{}{}:{}{}", proxy.scheme, user, proxy.host, proxy.port, lock)
    } else {
        "未配置出口".into()
    }
}

fn profile_with_runtime(profile: Profile, subscriptions: &[Subscription]) -> Value {
    let pid = store::read_pid(&profile.id);
    let running = pid.map(chrome::pid_alive).unwrap_or(false);
    let egress = egress_text(&profile, subscriptions);
    let mut value = serde_json::to_value(&profile).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("egressText".into(), json!(egress));
        map.insert("egressType".into(), json!(if profile.subscription.is_some() { "subscription" } else { "direct" }));
        map.insert("running".into(), json!(running));
        let core_port = core::running_port(&profile.id);
        if core_port.is_some() {
            map.insert("corePort".into(), json!(core_port));
        }
        if running {
            map.insert("pid".into(), json!(pid));
        }
    }
    value
}

fn command_detect(_input: &Value) -> Result<Value, String> {
    let browser = chrome::find_browser(None).ok().map(|path| path.display().to_string());
    // 内核来源：bundled（插件自带）/ system / clash-verge；找不到时带原因。
    let (core_path, core_source, core_error) = match core::find_core() {
        Ok(core) => (Some(core.path.display().to_string()), Some(core.source), None),
        Err(err) => (None, None, Some(err)),
    };
    let mut handles = Vec::new();
    for (port, label) in COMMON_PROXY_PORTS {
        handles.push(thread::spawn(move || {
            let reachable = proxy::tcp_reachable("127.0.0.1", port, Duration::from_millis(300));
            (port, label, reachable)
        }));
    }
    let mut reachable = Vec::new();
    for handle in handles {
        if let Ok((port, label, ok)) = handle.join() {
            if ok {
                reachable.push(json!({ "port": port, "label": label }));
            }
        }
    }
    Ok(json!({
        "browser": browser,
        "core": core_path,
        "coreSource": core_source,
        "coreError": core_error,
        "proxies": reachable,
    }))
}

fn command_list(_input: &Value) -> Result<Value, String> {
    let subscriptions = store::load_subscriptions()?;
    let profiles = store::load_profiles()?;
    Ok(json!({
        "profiles": profiles.into_iter().map(|p| profile_with_runtime(p, &subscriptions)).collect::<Vec<_>>(),
        "subscriptions": subscriptions,
    }))
}

fn command_save(input: &Value) -> Result<Value, String> {
    let name = get_str(input, "name");
    if name.is_empty() {
        return Err("身份名称不能为空".into());
    }
    let (proxy_config, subscription) = parse_egress(input)?;
    let note = get_str(input, "note");
    let chrome_path = {
        let raw = get_str(input, "chromePath");
        if raw.is_empty() { None } else { Some(raw) }
    };
    let subscriptions = store::load_subscriptions()?;
    let mut profiles = store::load_profiles()?;
    let id = get_str(input, "id");
    let now = store::now_secs();
    if !id.is_empty() {
        // 更新已有身份：id 不动，只刷新内容。
        let existing = profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("身份 {id} 不存在"))?;
        existing.name = name;
        existing.proxy = proxy_config;
        existing.subscription = subscription;
        existing.note = note;
        existing.chrome_path = chrome_path;
        existing.updated_at = now;
        let snapshot = existing.clone();
        store::save_profiles(&profiles)?;
        return Ok(json!({ "profile": profile_with_runtime(snapshot, &subscriptions) }));
    }
    let new_id = store::allocate_id(&name, &profiles);
    let profile = Profile {
        id: new_id,
        name,
        proxy: proxy_config,
        subscription,
        note,
        chrome_path,
        created_at: now,
        updated_at: now,
    };
    profiles.push(profile.clone());
    store::save_profiles(&profiles)?;
    Ok(json!({ "profile": profile_with_runtime(profile, &subscriptions) }))
}

fn find_profile(profiles: &[Profile], id: &str) -> Result<Profile, String> {
    profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| format!("身份 {id} 不存在"))
}

fn command_remove(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let mut profiles = store::load_profiles()?;
    find_profile(&profiles, &id)?;
    if let Some(pid) = store::read_pid(&id) {
        if chrome::pid_alive(pid) {
            let _ = chrome::terminate_pid(pid);
        }
    }
    store::clear_pid(&id);
    chrome::stop_relay_if_any(&id);
    core::stop_if_any(&id);
    // 隔离 profile 目录（cookie/历史）保留给用户手动清理：自动删几十上百 MB
    // 的目录不可逆，这里宁可少做一步。
    profiles.retain(|p| p.id != id);
    store::save_profiles(&profiles)?;
    Ok(json!({ "removed": id }))
}

fn command_launch(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let profiles = store::load_profiles()?;
    let profile = find_profile(&profiles, &id)?;
    let url = get_str(input, "url");
    let check = get_bool(input, "checkProxy", true);
    chrome::launch(&profile, if url.is_empty() { None } else { Some(&url) }, check)
}

fn command_stop(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少身份 id".into());
    }
    let pid = store::read_pid(&id).ok_or_else(|| format!("身份 {id} 没有运行记录"))?;
    chrome::stop_relay_if_any(&id);
    core::stop_if_any(&id);
    if !chrome::pid_alive(pid) {
        store::clear_pid(&id);
        return Ok(json!({ "stopped": false, "reason": "进程已退出" }));
    }
    chrome::terminate_pid(pid)?;
    store::clear_pid(&id);
    Ok(json!({ "stopped": true, "pid": pid }))
}

/// 经订阅节点取一次出口 IP。身份已在跑就复用它内核的端口，否则临时起一个
/// 测完收掉（allow_running=false 时总是临时起，用于保存前的试连）。
fn probe_via_core(profile_id: &str, egress: &SubscriptionEgress, allow_running: bool) -> Result<String, String> {
    let subscriptions = store::load_subscriptions()?;
    let subscription = subscriptions
        .iter()
        .find(|item| item.id == egress.id)
        .ok_or_else(|| format!("订阅「{}」不存在", egress.id))?;
    let raw = store::read_subscription_config(&egress.id)?;
    let node = if egress.node.is_empty() {
        subscription.nodes.first().cloned().unwrap_or_default()
    } else {
        egress.node.clone()
    };
    let (port, temporary) = match if allow_running { core::running_port(profile_id) } else { None } {
        Some(port) => (port, false),
        None => (
            core::start(profile_id, &raw, &node, egress.via.as_ref())?.mixed_port,
            true,
        ),
    };
    let outcome = core::verify_exit(port, Duration::from_secs(10));
    if temporary {
        core::stop_if_any(profile_id);
    }
    outcome
}

fn command_probe(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    let profiles = store::load_profiles()?;
    let profile = if id.is_empty() { None } else { Some(find_profile(&profiles, &id)?) };
    let started = Instant::now();
    if let Some(profile) = profile {
        if let Some(egress) = profile.subscription.clone() {
            let ip = probe_via_core(&profile.id, &egress, true)?;
            let subscriptions = store::load_subscriptions()?;
            return Ok(json!({
                "exitIp": ip,
                "via": egress_text(&profile, &subscriptions),
                "latencyMs": started.elapsed().as_millis() as u64,
            }));
        }
        let config = profile.proxy.ok_or_else(|| "这个身份还没有配置出口".to_string())?;
        let ip = proxy::exit_ip(&config, Duration::from_secs(6))?;
        return Ok(json!({
            "exitIp": ip,
            "via": format!("{}://{}:{}", config.scheme, config.host, config.port),
            "latencyMs": started.elapsed().as_millis() as u64,
        }));
    }
    // 新建前的试连：订阅出口，或显式传 proxy。
    if input.get("subscription").is_some() {
        let egress = parse_subscription_egress(input)?;
        let ip = probe_via_core("__probe__", &egress, false)?;
        return Ok(json!({
            "exitIp": ip,
            "via": "订阅节点（临时内核）",
            "latencyMs": started.elapsed().as_millis() as u64,
        }));
    }
    let config = parse_proxy_input(input)?;
    let ip = proxy::exit_ip(&config, Duration::from_secs(6))?;
    Ok(json!({
        "exitIp": ip,
        "via": format!("{}://{}:{}", config.scheme, config.host, config.port),
        "latencyMs": started.elapsed().as_millis() as u64,
    }))
}

fn allocate_subscription_id(name: &str, existing: &[Subscription]) -> String {
    let base = {
        let slug = store::slugify(name);
        if slug.is_empty() { "sub".to_string() } else { slug.chars().take(30).collect() }
    };
    let taken = |id: &str| existing.iter().any(|item| item.id == id);
    if !taken(&base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("sub-{}", store::now_secs())
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("订阅")
        .to_string()
}

fn command_subscription_save(input: &Value) -> Result<Value, String> {
    let url = get_str(input, "url");
    if url.is_empty() {
        return Err("订阅地址不能为空".into());
    }
    let fetched = subs::fetch(&url, Duration::from_secs(20))?;
    let mut subscriptions = store::load_subscriptions()?;
    let id = get_str(input, "id");
    let name = {
        let raw = get_str(input, "name");
        if raw.is_empty() { host_of(&url) } else { raw }
    };
    let now = store::now_secs();
    let bytes = fetched.raw.len() as u64;

    let updated = if !id.is_empty() {
        let existing = subscriptions
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("订阅 {id} 不存在"))?;
        existing.name = name;
        existing.url = url;
        existing.updated_at = now;
        existing.nodes = fetched.nodes.clone();
        existing.traffic = fetched.traffic.clone();
        existing.source_bytes = bytes;
        existing.clone()
    } else {
        let new_id = allocate_subscription_id(&name, &subscriptions);
        let item = Subscription {
            id: new_id,
            name,
            url,
            updated_at: now,
            nodes: fetched.nodes.clone(),
            traffic: fetched.traffic.clone(),
            source_bytes: bytes,
        };
        subscriptions.push(item.clone());
        item
    };
    // 先写配置原文再写清单：清单里登记了它，缓存就必须已经存在。
    store::write_subscription_config(&updated.id, &fetched.raw)?;
    store::save_subscriptions(&subscriptions)?;
    Ok(json!({ "subscription": updated }))
}

fn command_subscription_refresh(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少订阅 id".into());
    }
    let mut subscriptions = store::load_subscriptions()?;
    let url = subscriptions
        .iter()
        .find(|item| item.id == id)
        .map(|item| item.url.clone())
        .ok_or_else(|| format!("订阅 {id} 不存在"))?;
    let fetched = subs::fetch(&url, Duration::from_secs(20))?;
    let now = store::now_secs();
    let bytes = fetched.raw.len() as u64;
    store::write_subscription_config(&id, &fetched.raw)?;
    let updated = {
        let item = subscriptions.iter_mut().find(|item| item.id == id).expect("前面已确认存在");
        item.updated_at = now;
        item.nodes = fetched.nodes.clone();
        item.traffic = fetched.traffic.clone();
        item.source_bytes = bytes;
        item.clone()
    };
    store::save_subscriptions(&subscriptions)?;
    Ok(json!({ "subscription": updated }))
}

fn command_subscription_remove(input: &Value) -> Result<Value, String> {
    let id = get_str(input, "id");
    if id.is_empty() {
        return Err("缺少订阅 id".into());
    }
    let profiles = store::load_profiles()?;
    let used: Vec<String> = profiles
        .iter()
        .filter(|p| p.subscription.as_ref().is_some_and(|e| e.id == id))
        .map(|p| p.name.clone())
        .collect();
    if !used.is_empty() {
        return Err(format!("还有身份在用这个订阅（{}），先把它们改成别的出口", used.join("、")));
    }
    let mut subscriptions = store::load_subscriptions()?;
    subscriptions.retain(|item| item.id != id);
    store::save_subscriptions(&subscriptions)?;
    let _ = std::fs::remove_file(store::subscription_config_file(&id));
    Ok(json!({ "removed": id }))
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    let input = read_stdin_json();
    let result = match command.as_str() {
        "detect" => command_detect(&input),
        "list" => command_list(&input),
        "save" => command_save(&input),
        "remove" => command_remove(&input),
        "launch" => command_launch(&input),
        "stop" => command_stop(&input),
        "probe" => command_probe(&input),
        "subscription-save" => command_subscription_save(&input),
        "subscription-refresh" => command_subscription_refresh(&input),
        "subscription-remove" => command_subscription_remove(&input),
        // relay 是 launch 拉起的常驻中继：读 stdin 配置后进入服务循环，
        // 正常情况下不会走到输出；走到输出即启动失败。
        "relay" => {
            let id = get_str(&input, "id");
            parse_proxy_input(&input).and_then(|config| {
                relay::run(&id, &config).map(|_| json!({ "started": true }))
            })
        }
        _ => Err(format!(
            "未知命令 `{command}`（可用：detect / list / save / remove / launch / stop / probe / subscription-save / subscription-refresh / subscription-remove / relay）"
        )),
    };
    match result {
        Ok(data) => println!("{}", json!({ "ok": true, "data": data })),
        Err(message) => {
            eprintln!("{message}");
            println!("{}", json!({ "ok": false, "error": message }));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_input_accepts_nested_and_flat() {
        let nested = json!({ "proxy": { "scheme": "socks5", "host": "127.0.0.1", "port": 1080 } });
        assert_eq!(parse_proxy_input(&nested).unwrap().port, 1080);
        let flat = json!({ "scheme": "http", "host": "127.0.0.1", "port": 8080 });
        assert_eq!(parse_proxy_input(&flat).unwrap().port, 8080);
        let bad = json!({ "scheme": "socks5", "host": "", "port": 1080 });
        assert!(parse_proxy_input(&bad).is_err());
    }

    #[test]
    fn parse_egress_defaults_to_direct_and_rejects_unknown_kind() {
        let direct = json!({ "egressType": "", "proxy": { "scheme": "http", "host": "127.0.0.1", "port": 7897 } });
        let (proxy, subscription) = parse_egress(&direct).unwrap();
        assert_eq!(proxy.unwrap().port, 7897);
        assert!(subscription.is_none());
        let bad = json!({ "egressType": "wireguard", "proxy": { "scheme": "http", "host": "h", "port": 1 } });
        assert!(parse_egress(&bad).unwrap_err().contains("未知出口类型"));
    }
}
