//! 带凭据代理的本地中继。
//!
//! Chrome 的 --proxy-server 带不了用户名密码（只支持无认证代理，遇到要认证
//! 的上游会弹框或直接失败），所以「强制走带账密的出口」必须有个翻译层：
//! 本进程在 127.0.0.1 起一个无认证 http 代理给 Chrome 连，自己作为客户端
//! 去连真正的上游 —— http 上游附 Proxy-Authorization: Basic，socks5 上游做
//! RFC 1929 用户名密码认证 —— 凭据永远不经过 Chrome，出口仍然强制。
//!
//! 生命周期：launch 用 `chrome-proxy-launcher relay` 拉起本进程后父进程随即
//! 退出，中继可独立存活，但不是系统托管服务；就绪后把 {pid, port} 写进
//! run/<id>.relay.json 供 launch 对账、stop 收割。兜底：连续 30 分钟没有
//! 任何流量且对应浏览器不在运行才退出，避免浏览器空闲后失去出口。

use crate::proxy::{basic_authorization, connect_tcp};
use crate::store::{self, ProxyConfig};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const IDLE_EXIT_SECS: u64 = 30 * 60;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 读到请求头结束（\r\n\r\n）。返回 (读到的全部字节, 头结束后的首字节下标)。
fn read_head(stream: &mut TcpStream) -> Result<(Vec<u8>, usize), String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .map_err(|err| format!("读取请求头失败：{err}"))?;
        if n == 0 {
            return Err("对端在发完请求头之前断开".into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok((buf, at + 4));
        }
        if buf.len() > 32 * 1024 {
            return Err("请求头过大".into());
        }
    }
}

fn status_is_success(response: &[u8]) -> bool {
    let text = String::from_utf8_lossy(response);
    text.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .map(|code| code.starts_with('2'))
        .unwrap_or(false)
}

/// "host:port" → (host, port)；无端口按 80。
fn parse_authority(target: &str) -> (String, u16) {
    match target.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse().unwrap_or(80))
        }
        _ => (target.to_string(), 80),
    }
}

/// `GET http://host:port/path?q HTTP/1.1` → ("host:port", "/path?q")。
fn split_absolute_url(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("中继只转发 http:// 明文请求，收到 {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], rest[at..].to_string()),
        None => (rest, "/".to_string()),
    };
    if authority.is_empty() {
        return Err("请求 URL 没有主机部分".into());
    }
    let authority = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    Ok((authority, path))
}

fn auth_header_line(config: &ProxyConfig) -> String {
    match (config.has_credentials(), &config.username, &config.password) {
        (true, Some(user), Some(pass)) => format!("{}\r\n", basic_authorization(user, pass)),
        _ => String::new(),
    }
}

/// 中继的路由：上游代理 + 可选跳板。
///
/// 跳板 = 只跑订阅节点的本地内核（socks5）。有跳板时先经它连到上游代理，
/// 再由上游代理去目标站：本机 → 跳板节点 → 上游住宅代理 → 目标站。
/// 内核的 `dialer-proxy` 也能表达同一条链，但由中继串链更可控：凭据、
/// 失败报错、生命周期都在插件手里，不依赖内核版本的行为。
pub struct Route {
    pub upstream: ProxyConfig,
    pub hop: Option<ProxyConfig>,
}

/// 连到「上游代理本身」；有跳板时先经跳板内核出去。
fn connect_upstream(route: &Route, timeout: Duration) -> Result<TcpStream, String> {
    match &route.hop {
        Some(hop) => crate::proxy::socks5_connect(hop, &route.upstream.host, route.upstream.port, timeout),
        None => connect_tcp(&route.upstream.host, route.upstream.port, timeout),
    }
}

/// 与上游建好隧道：http 上游做 CONNECT（带认证），socks5 上游做认证 CONNECT。
/// 两种情况都先经过 connect_upstream（可能经跳板）。
fn open_tunnel(route: &Route, host: &str, port: u16) -> Result<TcpStream, String> {
    let config = &route.upstream;
    match config.scheme.as_str() {
        "socks5" => {
            let stream = connect_upstream(route, Duration::from_secs(15))?;
            crate::proxy::socks5_over(stream, config, host, port)
        }
        _ => {
            let mut stream = connect_upstream(route, Duration::from_secs(15))?;
            let request = format!(
                "CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n{}User-Agent: multicc-relay/1.0\r\n\r\n",
                auth_header_line(config)
            );
            stream
                .write_all(request.as_bytes())
                .map_err(|err| format!("向上游发 CONNECT 失败：{err}"))?;
            let (response, _) = read_head(&mut stream)?;
            if !status_is_success(&response) {
                let text = String::from_utf8_lossy(&response);
                let first = text.lines().next().unwrap_or_default().to_string();
                return Err(format!("上游代理拒绝隧道：{first}"));
            }
            Ok(stream)
        }
    }
}

fn pump(reader: &mut TcpStream, writer: &mut TcpStream, last_active: &AtomicU64) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                if writer.write_all(&buf[..n]).is_err() {
                    return;
                }
                last_active.store(now_secs(), Ordering::Relaxed);
            }
            Err(_) => return,
        }
    }
}

/// 双向搬运直到任一方关闭。
fn pipe_bidi(client: TcpStream, upstream: TcpStream, last_active: &Arc<AtomicU64>) {
    // 隧道已建立，去掉超时（默认超时会掐断长连接）；死连接由对端关闭和
    // 中继空闲自杀兜底。
    for stream in [&client, &upstream] {
        let _ = stream.set_read_timeout(None);
        let _ = stream.set_write_timeout(None);
    }
    let mut c_reader = match client.try_clone() { Ok(s) => s, Err(_) => return };
    let mut u_writer = match upstream.try_clone() { Ok(s) => s, Err(_) => return };
    let mut u_reader = match upstream.try_clone() { Ok(s) => s, Err(_) => return };
    let mut c_writer = match client.try_clone() { Ok(s) => s, Err(_) => return };
    let up = {
        let last_active = Arc::clone(last_active);
        thread::spawn(move || pump(&mut c_reader, &mut u_writer, &last_active))
    };
    let down = {
        let last_active = Arc::clone(last_active);
        thread::spawn(move || pump(&mut u_reader, &mut c_writer, &last_active))
    };
    let _ = up.join();
    let _ = down.join();
}

fn refuse(mut client: TcpStream, message: &str) {
    let body = format!("relay: {message}");
    let _ = client.write_all(
        format!(
            "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .as_bytes(),
    );
}

fn handle_client(mut client: TcpStream, route: &Route, last_active: &Arc<AtomicU64>) {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = client.set_write_timeout(Some(Duration::from_secs(30)));
    let (head, body_at) = match read_head(&mut client) {
        Ok(value) => value,
        Err(_) => return,
    };
    let head_text = String::from_utf8_lossy(&head[..body_at]).into_owned();
    let first_line = head_text.lines().next().unwrap_or_default().to_string();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() {
        return;
    }
    // 第一行之后的头字段。剥掉行尾自带的 \r\n：认证行要插在第一行和
    // Host 之间，各行自己带 \r\n 结尾，多剥一个会拼出空行截断请求头。
    let rest_headers = head_text[first_line.len()..]
        .trim_start_matches(['\r', '\n'])
        .to_string();

    if method == "CONNECT" {
        let (host, port) = parse_authority(&target);
        match open_tunnel(route, &host, port) {
            Ok(upstream) => {
                if client
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .is_err()
                {
                    return;
                }
                pipe_bidi(client, upstream, last_active);
            }
            Err(message) => refuse(client, &message),
        }
        return;
    }

    // 非 CONNECT：http 明文站点的绝对 URL 请求。
    let (authority, path) = match split_absolute_url(&target) {
        Ok(value) => value,
        Err(message) => {
            refuse(client, &message);
            return;
        }
    };
    let (host, port) = parse_authority(&authority);
    match route.upstream.scheme.as_str() {
        "socks5" => {
            let stream = match connect_upstream(route, Duration::from_secs(15)) {
                Ok(stream) => stream,
                Err(message) => {
                    refuse(client, &message);
                    return;
                }
            };
            let mut upstream = match crate::proxy::socks5_over(stream, &route.upstream, &host, port) {
                Ok(stream) => stream,
                Err(message) => {
                    refuse(client, &message);
                    return;
                }
            };
            // socks5 隧道里走 origin-form 请求行。
            let rewritten = format!("{method} {path} HTTP/1.1\r\n{rest_headers}");
            if upstream.write_all(rewritten.as_bytes()).is_err() {
                return;
            }
            let _ = upstream.write_all(&head[body_at..]);
            pipe_bidi(client, upstream, last_active);
        }
        _ => {
            let mut upstream = match connect_upstream(route, Duration::from_secs(15)) {
                Ok(stream) => stream,
                Err(message) => {
                    refuse(client, &message);
                    return;
                }
            };
            // http 代理接受绝对 URL，注入认证头后原样转发。
            let forwarded = format!(
                "{method} {target} HTTP/1.1\r\n{}{rest_headers}",
                auth_header_line(&route.upstream)
            );
            if upstream.write_all(forwarded.as_bytes()).is_err() {
                return;
            }
            let _ = upstream.write_all(&head[body_at..]);
            pipe_bidi(client, upstream, last_active);
        }
    }
}

fn should_exit_idle(now: u64, last_active: u64, browser_alive: bool) -> bool {
    !browser_alive && now.saturating_sub(last_active) >= IDLE_EXIT_SECS
}

/// relay 子命令入口：常驻直到空闲自杀，正常情况下不会返回。
pub fn run(id: &str, route: &Route) -> Result<(), String> {
    if route.upstream.scheme == "https" {
        return Err("https 上游暂不支持账密中继（请用 http 或 socks5 代理）".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("中继监听失败：{err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("获取中继端口失败：{err}"))?
        .port();
    let run_dir = store::data_dir().join("run");
    std::fs::create_dir_all(&run_dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    let record = serde_json::json!({ "pid": std::process::id(), "port": port });
    std::fs::write(
        store::relay_file(id),
        serde_json::to_string(&record).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("写中继记录失败：{err}"))?;

    let route = Arc::new(Route {
        upstream: route.upstream.clone(),
        hop: route.hop.clone(),
    });
    let last_active = Arc::new(AtomicU64::new(now_secs()));
    let profile_id = id.to_string();
    {
        let last_active = Arc::clone(&last_active);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(60));
            let browser_alive = store::read_pid(&profile_id).is_some_and(crate::chrome::pid_alive);
            if should_exit_idle(now_secs(), last_active.load(Ordering::Relaxed), browser_alive) {
                std::process::exit(0);
            }
        });
    }
    for stream in listener.incoming() {
        last_active.store(now_secs(), Ordering::Relaxed);
        let Ok(stream) = stream else { continue };
        let config = Arc::clone(&route);
        let last_active = Arc::clone(&last_active);
        thread::spawn(move || handle_client(stream, &config, &last_active));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_browser_keeps_its_proxy_until_browser_exits() {
        assert!(!should_exit_idle(5000, 0, true));
        assert!(!should_exit_idle(100, 0, false));
        assert!(should_exit_idle(5000, 0, false));
        assert!(!should_exit_idle(0, 5000, false));
    }

    #[test]
    fn dead_upstream_or_hop_never_connects_directly_to_target() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let destination = target.local_addr().unwrap();
        // 每轮申请并关闭一个临时端口，模拟不可达的上游或跳板。
        for scheme in ["http", "socks5"] {
            for with_hop in [false, true] {
                let dead = TcpListener::bind("127.0.0.1:0").unwrap();
                let dead_port = dead.local_addr().unwrap().port();
                drop(dead);
                let route = Route {
                    upstream: ProxyConfig::new(scheme, "127.0.0.1", dead_port),
                    hop: with_hop.then(|| ProxyConfig::new("socks5", "127.0.0.1", dead_port)),
                };
                for request in [
                    format!("CONNECT {destination} HTTP/1.1\r\n\r\n"),
                    format!("GET http://{destination}/ HTTP/1.1\r\nHost: {destination}\r\n\r\n"),
                ] {
                    let relay = TcpListener::bind("127.0.0.1:0").unwrap();
                    let mut client = TcpStream::connect(relay.local_addr().unwrap()).unwrap();
                    client.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    client.write_all(request.as_bytes()).unwrap();
                    let (server, _) = relay.accept().unwrap();
                    handle_client(server, &route, &Arc::new(AtomicU64::new(now_secs())));
                    let mut response = String::new();
                    client.read_to_string(&mut response).unwrap();
                    assert!(response.starts_with("HTTP/1.1 502"), "{response}");
                    assert_eq!(target.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
                }
            }
        }
    }

    #[test]
    fn authority_and_url_split() {
        assert_eq!(parse_authority("example.com:443"), ("example.com".into(), 443));
        assert_eq!(parse_authority("example.com"), ("example.com".into(), 80));
        let (authority, path) = split_absolute_url("http://a.b:8080/x?y=1").unwrap();
        assert_eq!(authority, "a.b:8080");
        assert_eq!(path, "/x?y=1");
        let (authority, path) = split_absolute_url("http://a.b").unwrap();
        assert_eq!(authority, "a.b:80");
        assert_eq!(path, "/");
        assert!(split_absolute_url("https://a.b/x").is_err());
    }

    #[test]
    fn success_status_detection() {
        assert!(status_is_success(b"HTTP/1.1 200 Connection established\r\n\r\n"));
        assert!(status_is_success(b"HTTP/1.0 201 \r\n\r\n"));
        assert!(!status_is_success(b"HTTP/1.1 407 auth\r\n\r\n"));
        assert!(!status_is_success(b"garbage"));
    }
}
