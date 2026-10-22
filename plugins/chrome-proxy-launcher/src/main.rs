//! chrome-proxy-launcher —— MultiCC 第一个插件。
//!
//! 给每个「身份」绑定一份完全隔离的 Chrome profile（独立 user-data-dir）
//! 和一个强制出口（--proxy-server 指到本地 VPN 客户端的不同端口或任意
//! http/socks5 代理），一键启动互不串号的浏览器。
//!
//! 调用约定（Node 通道 src/routes/plugins.js 只做协议桥接，业务全在这里）：
//!   chrome-proxy-launcher <command>    （JSON 从 stdin 读，结果一行 JSON 到 stdout）
//!   成功：{"ok":true,"data":{...}}    失败：{"ok":false,"error":"中文原因"}，退出码 1

mod chrome;
mod proxy;
mod store;

use serde_json::{json, Value};
use std::io::Read;
use std::thread;
use std::time::Duration;

use store::Profile;

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

fn parse_proxy_input(input: &Value) -> Result<store::ProxyConfig, String> {
    let raw = input.get("proxy").cloned().unwrap_or_else(|| input.clone());
    let scheme = get_str(&raw, "scheme").to_lowercase();
    let host = get_str(&raw, "host");
    let port = raw.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    store::validate_proxy(&scheme, &host, port)?;
    Ok(store::ProxyConfig { scheme, host, port })
}

fn profile_with_runtime(profile: Profile) -> Value {
    let pid = store::read_pid(&profile.id);
    let running = pid.map(chrome::pid_alive).unwrap_or(false);
    let mut value = serde_json::to_value(&profile).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("running".into(), json!(running));
        if running {
            map.insert("pid".into(), json!(pid));
        }
    }
    value
}

fn command_detect(_input: &Value) -> Result<Value, String> {
    let browser = chrome::find_browser(None).ok().map(|path| path.display().to_string());
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
    Ok(json!({ "browser": browser, "proxies": reachable }))
}

fn command_list(_input: &Value) -> Result<Value, String> {
    let profiles = store::load_profiles()?;
    Ok(json!({ "profiles": profiles.into_iter().map(profile_with_runtime).collect::<Vec<_>>() }))
}

fn command_save(input: &Value) -> Result<Value, String> {
    let name = get_str(input, "name");
    if name.is_empty() {
        return Err("身份名称不能为空".into());
    }
    let proxy = parse_proxy_input(input)?;
    let note = get_str(input, "note");
    let chrome_path = {
        let raw = get_str(input, "chromePath");
        if raw.is_empty() { None } else { Some(raw) }
    };
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
        existing.proxy = proxy;
        existing.note = note;
        existing.chrome_path = chrome_path;
        existing.updated_at = now;
        let snapshot = existing.clone();
        store::save_profiles(&profiles)?;
        return Ok(json!({ "profile": profile_with_runtime(snapshot) }));
    }
    let new_id = store::allocate_id(&name, &profiles);
    let profile = Profile {
        id: new_id,
        name,
        proxy,
        note,
        chrome_path,
        created_at: now,
        updated_at: now,
    };
    profiles.push(profile.clone());
    store::save_profiles(&profiles)?;
    Ok(json!({ "profile": profile_with_runtime(profile) }))
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
    if !chrome::pid_alive(pid) {
        store::clear_pid(&id);
        return Ok(json!({ "stopped": false, "reason": "进程已退出" }));
    }
    chrome::terminate_pid(pid)?;
    store::clear_pid(&id);
    Ok(json!({ "stopped": true, "pid": pid }))
}

fn command_probe(input: &Value) -> Result<Value, String> {
    // 有 id 就用身份里的代理；没有就要求显式传 proxy（新建前的试连）。
    let profiles = store::load_profiles()?;
    let config = if !get_str(input, "id").is_empty() {
        find_profile(&profiles, &get_str(input, "id"))?.proxy
    } else {
        parse_proxy_input(input)?
    };
    let started = std::time::Instant::now();
    let ip = proxy::exit_ip(&config.scheme, &config.host, config.port, Duration::from_secs(6))?;
    Ok(json!({
        "exitIp": ip,
        "via": format!("{}://{}:{}", config.scheme, config.host, config.port),
        "latencyMs": started.elapsed().as_millis() as u64,
    }))
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
        _ => Err(format!(
            "未知命令 `{command}`（可用：detect / list / save / remove / launch / stop / probe）"
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
}
