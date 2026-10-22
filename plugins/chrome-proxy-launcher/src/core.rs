//! meow 内核（mihomo 的 Rust 重实现）：把「一份订阅 + 一个节点」变成只属于
//! 某个身份的本地出口。
//!
//! 为什么不自己实现 vmess/vless/trojan/ss：这些协议的握手、TLS、REALITY、
//! ws/grpc 传输由内核维护得远比插件里手写可靠。插件只做三件事：
//!   1. 拉订阅原文并解析（JSON / YAML / base64 包裹都吃）
//!   2. 改写出一份「只含选中节点、只听 127.0.0.1 随机端口」的配置
//!   3. 每个身份起一个独立内核实例，Chrome 指向它的 mixed-port
//!
//! 链式出口（家宽/住宅代理的常态）：上游代理写成内核的 proxy，并用
//! `dialer-proxy` 指到跳板节点 —— 本机 → 跳板 → 上游 → 目标站。

use crate::store::{self, ProxyConfig};
use serde_json::{json, Value};
use std::fs::File;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

/// 链式出口里上游代理的固定名（与订阅节点重名时自动加后缀）。
const UPSTREAM_NAME: &str = "MCC-Upstream";
const GROUP_NAME: &str = "MCC-Egress";

pub struct CoreRun {
    pub pid: i32,
    pub mixed_port: u16,
    pub config_path: PathBuf,
    pub core_path: PathBuf,
}

/// 插件自带的 meow 内核：和插件二进制同目录的 `meow`，或压缩包 `meow.gz`。
/// 只认自带的，不依赖用户另装任何客户端。
fn bundled_core() -> Result<Option<PathBuf>, String> {
    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    // 真实部署时二进制在 bin/<平台>-<架构>/，内核就在同目录；顺手也看一层
    // 父目录（bin/），兼容被放到 bin/ 根下的安装方式。
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        dirs.push(dir.to_path_buf());
        if let Some(parent) = dir.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    let plain_names: &[&str] = if cfg!(windows) {
        &["meow.exe", "meow"]
    } else {
        &["meow", "meow.exe"]
    };
    for dir in &dirs {
        for name in plain_names {
            let plain = dir.join(name);
            if plain.is_file() {
                return Ok(Some(plain));
            }
        }
    }
    for dir in &dirs {
        for name in ["meow.gz", "meow.exe.gz"] {
            let archive = dir.join(name);
            if archive.is_file() {
                return ensure_extracted(&archive).map(Some);
            }
        }
    }
    Ok(None)
}

/// 把自带 `.gz` 解到 `plugins-data/.../runtime/meow`，存在且比压缩包新就复用。
/// 先写临时文件再 rename：两个身份同时首次启动也不会互相写坏。
fn ensure_extracted(archive: &std::path::Path) -> Result<PathBuf, String> {
    let runtime = store::data_dir().join("runtime");
    std::fs::create_dir_all(&runtime).map_err(|err| format!("创建 runtime 目录失败：{err}"))?;
    let target = runtime.join(if cfg!(windows) { "meow.exe" } else { "meow" });
    let up_to_date = match (std::fs::metadata(archive), std::fs::metadata(&target)) {
        (Ok(source), Ok(done)) => {
            done.len() > 0
                && match (source.modified(), done.modified()) {
                    (Ok(source_time), Ok(done_time)) => done_time >= source_time,
                    _ => false,
                }
        }
        _ => false,
    };
    if up_to_date {
        return Ok(target);
    }
    let tmp = runtime.join(format!(".meow.{}.tmp", std::process::id()));
    let unpack = || -> Result<(), String> {
        let file = File::open(archive).map_err(|err| format!("打开自带内核失败：{err}"))?;
        let mut decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
        let mut out = File::create(&tmp).map_err(|err| format!("创建内核文件失败：{err}"))?;
        std::io::copy(&mut decoder, &mut out)
            .map_err(|err| format!("解压自带内核失败（文件可能损坏）：{err}"))?;
        Ok(())
    };
    if let Err(err) = unpack() {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|err| format!("设置内核可执行位失败：{err}"))?;
    }
    std::fs::rename(&tmp, &target).map_err(|err| format!("安装自带内核失败：{err}"))?;
    Ok(target)
}

pub fn find_core() -> Result<PathBuf, String> {
    if let Some(path) = bundled_core()? {
        return Ok(path);
    }
    Err("插件自带的 meow 内核缺失（应为 bin/<平台>-<架构>/meow.gz）。\
从 https://github.com/meow-rs/meow-rs/releases 下载对应平台的单文件，\
压缩成 meow.gz（或直接放未压缩的 meow）到该目录后重试"
        .into())
}

/// 本机取一个空闲端口给内核监听。绑定后退掉，有极小竞争窗口，可接受。
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| format!("分配本地端口失败：{err}"))?;
    let port = listener.local_addr().map_err(|err| format!("读取本地端口失败：{err}"))?.port();
    drop(listener);
    Ok(port)
}

fn yaml_to_json(value: serde_yaml::Value) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| format!("订阅配置无法转换：{err}"))
}

/// 解析订阅原文：JSON（Clash 的 JSON 形态）/ YAML / base64 包裹的 yaml。
pub fn parse_config(raw: &str) -> Result<Value, String> {
    let text = raw.trim().trim_start_matches('\u{feff}');
    if text.is_empty() {
        return Err("订阅内容是空的".into());
    }
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return ensure_object(value);
    }
    if let Ok(decoded) = crate::proxy::base64_decode(text) {
        if let Ok(inner) = String::from_utf8(decoded) {
            let inner = inner.trim();
            if let Ok(value) = serde_json::from_str::<Value>(inner) {
                return ensure_object(value);
            }
            if let Ok(yaml) = serde_yaml::from_str::<serde_yaml::Value>(inner) {
                return ensure_object(yaml_to_json(yaml)?);
            }
        }
    }
    match serde_yaml::from_str::<serde_yaml::Value>(text) {
        Ok(yaml) => ensure_object(yaml_to_json(yaml)?),
        Err(err) => Err(format!(
            "订阅既不是合法 JSON 也不是合法 YAML（{err}）。如果这是 base64 订阅，可能已经损坏"
        )),
    }
}

fn ensure_object(value: Value) -> Result<Value, String> {
    if value.is_object() {
        Ok(value)
    } else {
        Err("订阅内容不是 Clash 配置对象（缺 proxies 等顶层字段）".into())
    }
}

pub fn node_names(config: &Value) -> Vec<String> {
    config
        .get("proxies")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 上游代理 → mihomo 的 proxy 条目。
/// mihomo 没有 `https` 这个 type：TLS 代理写成 type: http + tls: true。
fn upstream_proxy(config: &ProxyConfig, name: &str, dialer: &str) -> Value {
    let mut entry = json!({
        "name": name,
        "type": if config.scheme == "socks5" { "socks5" } else { "http" },
        "server": config.host,
        "port": config.port,
        "dialer-proxy": dialer,
        "udp": true,
    });
    if config.scheme == "https" {
        entry["tls"] = json!(true);
    }
    if config.has_credentials() {
        entry["username"] = json!(config.username.clone().unwrap_or_default());
        entry["password"] = json!(config.password.clone().unwrap_or_default());
    }
    entry
}

/// 把订阅原文改写成「只走选中节点」的独立配置。
///
/// 改写点（其余字段原样保留，尊重订阅自己的 DNS / 分组习惯）：
///   - 只留 mixed-port（随机），去掉它可能抢占的其它监听端口
///   - tun 关闭、external-controller/secret 去掉（不让内核开额外控制面）
///   - proxies 只保留选中节点（+ 可选上游），规则改成 MATCH 到唯一分组
pub fn build_config(
    raw: &str,
    node_name: &str,
    via: Option<&ProxyConfig>,
    mixed_port: u16,
) -> Result<Value, String> {
    let mut config = parse_config(raw)?;
    let proxies = config
        .get("proxies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if proxies.is_empty() {
        return Err("这份订阅里没有静态节点（只用了 proxy-providers？暂不支持）".into());
    }
    let selected = if node_name.trim().is_empty() {
        proxies[0].clone()
    } else {
        proxies
            .iter()
            .find(|item| item.get("name").and_then(Value::as_str) == Some(node_name.trim()))
            .cloned()
            .ok_or_else(|| format!("订阅里没有名为「{node_name}」的节点，先刷新订阅再选"))?
    };
    let jump = selected
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("node")
        .to_string();

    let mut kept = vec![selected];
    let mut group_members = vec![json!(jump)];
    if let Some(via) = via {
        // 上游与节点重名时换一个不冲突的名字，否则 mihomo 会拿错对象。
        let upstream_name = if jump == UPSTREAM_NAME {
            format!("{UPSTREAM_NAME}-2")
        } else {
            UPSTREAM_NAME.to_string()
        };
        kept.push(upstream_proxy(via, &upstream_name, &jump));
        // 默认出口 = 上游（跳板只是通路）。
        group_members.insert(0, json!(upstream_name));
    }

    let obj = config.as_object_mut().expect("ensure_object 已保证");
    for key in [
        "port", "socks-port", "redir-port", "tproxy-port", "mixed-port",
        "external-controller", "external-ui", "external-controller-cors",
        "secret", "authentication", "listeners", "tunnels", "proxy-providers",
        "rule-providers", "sub-rules",
    ] {
        obj.remove(key);
    }
    obj.insert("mixed-port".into(), json!(mixed_port));
    obj.insert("allow-lan".into(), json!(false));
    obj.insert("bind-address".into(), json!("127.0.0.1"));
    obj.insert("mode".into(), json!("rule"));
    obj.insert("log-level".into(), json!("warning"));
    obj.insert("proxies".into(), json!(kept));
    obj.insert(
        "proxy-groups".into(),
        json!([{ "name": GROUP_NAME, "type": "select", "proxies": group_members }]),
    );
    obj.insert("rules".into(), json!([format!("MATCH,{GROUP_NAME}")]));
    // 不落选中状态/假 IP 缓存，避免两个身份共用订阅时互相污染。
    obj.insert(
        "profile".into(),
        json!({ "store-selected": false, "store-fake-ip": false }),
    );

    // tun 必须关：它在全局接管路由，要 root，且会和用户自己的 Clash 打架。
    // 只留 enable 一个键：订阅里的 tun.stack / strict-route 等字段 meow 会警告“不支持”。
    obj.insert("tun".into(), json!({ "enable": false }));

    // dns.listen 会额外占 53 端口（常要 root），交给内核内部 DNS。
    if let Some(dns) = obj.get_mut("dns").and_then(Value::as_object_mut) {
        dns.remove("listen");
    }
    Ok(config)
}

pub fn stop_if_any(id: &str) {
    if let Some(pid) = store::read_core_pid(id) {
        if crate::chrome::pid_alive(pid) {
            let _ = crate::chrome::terminate_pid(pid);
        }
    }
    store::clear_core_pid(id);
    store::clear_core_info(id);
}

/// 已运行内核的 mixed-port（pid 活着且登记过端口才算）。
pub fn running_port(id: &str) -> Option<u16> {
    let pid = store::read_core_pid(id)?;
    if !crate::chrome::pid_alive(pid) {
        return None;
    }
    let text = std::fs::read_to_string(store::core_info_file(id)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("port").and_then(Value::as_u64).map(|port| port as u16)
}

fn write_core_info(id: &str, pid: i32, port: u16) -> Result<(), String> {
    let file = store::core_info_file(id);
    let dir = file.parent().map(PathBuf::from).unwrap_or_else(store::data_dir);
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    let body = json!({ "pid": pid, "port": port }).to_string();
    std::fs::write(&file, body).map_err(|err| format!("写入内核端口失败：{err}"))
}

/// 起一个身份专属内核，等 mixed-port 可连后返回。
pub fn start(profile_id: &str, raw: &str, node: &str, via: Option<&ProxyConfig>) -> Result<CoreRun, String> {
    stop_if_any(profile_id);
    let core_path = find_core()?;
    let mixed_port = free_port()?;
    let config = build_config(raw, node, via, mixed_port)?;
    let text = serde_yaml::to_string(&config).map_err(|err| format!("生成内核配置失败：{err}"))?;

    let dir = store::core_dir(profile_id);
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建内核目录失败：{err}"))?;
    let config_path = dir.join("config.yaml");
    std::fs::write(&config_path, text).map_err(|err| format!("写入内核配置失败：{err}"))?;

    let log_path = dir.join("core.log");
    let log = File::create(&log_path).map_err(|err| format!("创建内核日志失败：{err}"))?;
    let log_err = log.try_clone().map_err(|err| format!("复制内核日志句柄失败：{err}"))?;

    let mut child = Command::new(&core_path)
        .arg("-d")
        .arg(&dir)
        .arg("-f")
        .arg(&config_path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()
        .map_err(|err| format!("启动内核 {} 失败：{err}", core_path.display()))?;
    let pid = child.id() as i32;
    store::write_core_pid(profile_id, pid)?;
    write_core_info(profile_id, pid, mixed_port)?;

    for _ in 0..120 {
        if crate::proxy::tcp_reachable("127.0.0.1", mixed_port, Duration::from_millis(80)) {
            return Ok(CoreRun { pid, mixed_port, config_path, core_path });
        }
        if let Ok(Some(status)) = child.try_wait() {
            let tail = log_tail(&log_path);
            stop_if_any(profile_id);
            return Err(format!(
                "内核启动即退出（{status}）。日志尾部：{}",
                if tail.is_empty() { "（空）".into() } else { tail }
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    let tail = log_tail(&log_path);
    stop_if_any(profile_id);
    Err(format!(
        "等待内核监听端口超时（6s）。日志尾部：{}",
        if tail.is_empty() { "（空）".into() } else { tail }
    ))
}

fn log_tail(path: &PathBuf) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" / ")
}

/// 经已运行的内核取出口 IP（用于 launch 前的可用性验证与 probe）。
pub fn verify_exit(mixed_port: u16, timeout: Duration) -> Result<String, String> {
    let config = ProxyConfig {
        scheme: "http".into(),
        host: "127.0.0.1".into(),
        port: mixed_port,
        username: None,
        password: None,
    };
    crate::proxy::exit_ip(&config, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> &'static str {
        r#"
mixed-port: 7890
port: 7891
socks-port: 7892
external-controller: 127.0.0.1:9090
secret: hunter2
mode: rule
tun:
  enable: true
  stack: gvisor
  auto-route: true
dns:
  enable: true
  listen: 0.0.0.0:53
  enhanced-mode: fake-ip
proxies:
  - name: US-Home
    type: vmess
    server: home.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
  - name: JP-Relay
    type: trojan
    server: jp.example.com
    port: 8443
    password: secret
proxy-groups:
  - name: 默认家宽
    type: select
    proxies: [US-Home, JP-Relay]
rules:
  - DOMAIN-SUFFIX,example.com,默认家宽
  - MATCH,DIRECT
"#
    }

    #[test]
    fn rewrite_keeps_only_selected_node_and_closes_side_channels() {
        let config = build_config(sample(), "JP-Relay", None, 41000).unwrap();
        let obj = config.as_object().unwrap();
        assert_eq!(obj["mixed-port"], 41000);
        assert_eq!(obj["allow-lan"], false);
        assert_eq!(obj["bind-address"], "127.0.0.1");
        assert!(obj.get("port").is_none());
        assert!(obj.get("socks-port").is_none());
        assert!(obj.get("external-controller").is_none());
        assert!(obj.get("secret").is_none());
        assert_eq!(obj["tun"]["enable"], false);
        assert!(obj["dns"].get("listen").is_none());
        let proxies = obj["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0]["name"], "JP-Relay");
        assert_eq!(obj["rules"], json!(["MATCH,MCC-Egress"]));
        assert_eq!(obj["proxy-groups"][0]["proxies"], json!(["JP-Relay"]));
    }

    #[test]
    fn chain_puts_upstream_behind_jump_node() {
        let via = ProxyConfig {
            scheme: "http".into(),
            host: "residential.example.com".into(),
            port: 8080,
            username: Some("u".into()),
            password: Some("p".into()),
        };
        let config = build_config(sample(), "US-Home", Some(&via), 41001).unwrap();
        let proxies = config["proxies"].as_array().unwrap();
        assert_eq!(proxies.len(), 2);
        let upstream = &proxies[1];
        assert_eq!(upstream["type"], "http");
        assert_eq!(upstream["dialer-proxy"], "US-Home");
        assert_eq!(upstream["username"], "u");
        // 默认出口是上游，跳板只留在组里备选。
        assert_eq!(config["proxy-groups"][0]["proxies"], json!(["MCC-Upstream", "US-Home"]));
    }

    #[test]
    fn socks_upstream_maps_to_socks5_type() {
        let via = ProxyConfig::new("socks5", "10.0.0.2", 1080);
        let config = build_config(sample(), "US-Home", Some(&via), 41002).unwrap();
        assert_eq!(config["proxies"][1]["type"], "socks5");
        assert!(config["proxies"][1].get("username").is_none());
    }

    #[test]
    fn unknown_node_is_reported() {
        let err = build_config(sample(), "Nope", None, 41003).unwrap_err();
        assert!(err.contains("没有名为「Nope」的节点"));
    }

    #[test]
    fn base64_wrapped_yaml_is_understood() {
        let encoded = crate::proxy::base64_encode(sample().as_bytes());
        let names = node_names(&parse_config(&encoded).unwrap());
        assert_eq!(names, vec!["US-Home", "JP-Relay"]);
    }

    #[test]
    fn json_form_of_clash_config_is_understood() {
        let json_form = json!({
            "mixed-port": 7890,
            "proxies": [{ "name": "Only", "type": "ss", "server": "s.example.com", "port": 8388, "cipher": "aes-256-gcm", "password": "x" }]
        });
        let names = node_names(&parse_config(&json_form.to_string()).unwrap());
        assert_eq!(names, vec!["Only"]);
    }

    #[test]
    fn subscription_without_static_nodes_is_rejected() {
        let err = build_config("proxies: []\n", "", None, 41004).unwrap_err();
        assert!(err.contains("没有静态节点"));
    }
}
