//! 代理探测：TCP 可达性 + 通过代理取出口 IP。
//!
//! 只用 std 的 TcpStream —— http 代理发绝对 URL 的 GET，socks5 手写
//! 无认证握手（greeting → CONNECT 域名 → HTTP GET），不引 reqwest/tokio。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const IP_ENDPOINTS: [(&str, &str, &str); 2] = [
    // (host, path, 说明)
    ("ifconfig.me", "/ip", "ifconfig.me"),
    ("api.ip.sb", "/ip", "api.ip.sb"),
];

pub fn tcp_reachable(host: &str, port: u16, timeout: Duration) -> bool {
    let Ok(addr) = format!("{host}:{port}").to_socket_addrs() else { return false };
    let Some(addr) = addr.into_iter().next() else { return false };
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn looks_like_ip(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() || text.len() > 45 {
        return false;
    }
    text.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ':')
}

fn http_get_over(mut stream: TcpStream, host: &str, path: &str) -> Result<String, String> {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: multicc-plugin/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送请求失败：{err}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    let text = String::from_utf8_lossy(&buf);
    let body = match text.find("\r\n\r\n") {
        Some(at) => &text[at + 4..],
        None => "",
    };
    let body = body.trim();
    if !text.starts_with("HTTP/") || !looks_like_ip(body) {
        return Err(format!("出口 IP 应答不合规：{}", &body[..body.len().min(60)]));
    }
    Ok(body.to_string())
}

/// 通过 http/https 代理取出口 IP（GET 绝对 URL，CONNECT 不需要）。
fn exit_ip_via_http_proxy(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    let addr: SocketAddr = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|err| format!("解析代理地址失败：{err}"))?
        .next()
        .ok_or("代理地址解析为空")?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|err| format!("连接代理失败：{err}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();
    let request = format!(
        "GET http://{endpoint}{path} HTTP/1.1\r\nHost: {endpoint}\r\nUser-Agent: multicc-plugin/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        endpoint = IP_ENDPOINTS[0].0, path = IP_ENDPOINTS[0].1
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送请求失败：{err}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|err| format!("读取响应失败：{err}"))?;
    let text = String::from_utf8_lossy(&buf);
    let body = match text.find("\r\n\r\n") {
        Some(at) => &text[at + 4..],
        None => "",
    };
    let body = body.trim();
    if !looks_like_ip(body) {
        return Err("代理应答里没有出口 IP".into());
    }
    Ok(body.to_string())
}

/// 无认证 socks5：greeting → CONNECT（按域名，DNS 由代理解析）→ 上面跑 HTTP。
fn socks5_connect(host: &str, port: u16, target: &str, target_port: u16, timeout: Duration) -> Result<TcpStream, String> {
    let addr: SocketAddr = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|err| format!("解析代理地址失败：{err}"))?
        .next()
        .ok_or("代理地址解析为空")?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).map_err(|err| format!("连接代理失败：{err}"))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    stream.write_all(&[0x05, 0x01, 0x00]).map_err(|err| format!("socks5 握手失败：{err}"))?;
    let mut greeting = [0u8; 2];
    stream.read_exact(&mut greeting).map_err(|err| format!("socks5 握手失败：{err}"))?;
    if greeting[0] != 0x05 || greeting[1] != 0x00 {
        return Err("socks5 代理要求认证（本插件只支持无认证的本地出口）".into());
    }

    if target.len() > 255 {
        return Err("目标域名过长".into());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, target.len() as u8];
    request.extend_from_slice(target.as_bytes());
    request.push((target_port >> 8) as u8);
    request.push((target_port & 0xff) as u8);
    stream.write_all(&request).map_err(|err| format!("socks5 CONNECT 失败：{err}"))?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).map_err(|err| format!("socks5 应答不完整：{err}"))?;
    if head[1] != 0x00 {
        return Err(format!("socks5 代理拒绝连接（REP={}）", head[1]));
    }
    match head[3] {
        0x01 => { let mut rest = [0u8; 6]; stream.read_exact(&mut rest).map_err(|err| err.to_string())?; }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).map_err(|err| err.to_string())?;
            let mut rest = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut rest).map_err(|err| err.to_string())?;
        }
        0x04 => { let mut rest = [0u8; 18]; stream.read_exact(&mut rest).map_err(|err| err.to_string())?; }
        other => return Err(format!("socks5 应答地址类型未知（{other}）")),
    }
    Ok(stream)
}

fn exit_ip_via_socks5(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    let mut last_err = String::from("没有可用探测目标");
    for (target, path, _) in IP_ENDPOINTS {
        match socks5_connect(host, port, target, 80, timeout) {
            Ok(stream) => return http_get_over(stream, target, path),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
}

/// 通过指定代理取出口 IP。返回 Err 时消息可直接展示给用户。
pub fn exit_ip(scheme: &str, host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    match scheme {
        "socks5" => exit_ip_via_socks5(host, port, timeout),
        // Chrome 对 https:// 代理同样先走 HTTP 语义的绝对 URL 请求可测通；
        // 若代理要求 TLS 而失败，报错文案会带出原因。
        _ => exit_ip_via_http_proxy(host, port, timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_ip_filters_html_garbage() {
        assert!(looks_like_ip("1.2.3.4"));
        assert!(looks_like_ip("2600::1"));
        assert!(!looks_like_ip("<html>blocked</html>"));
        assert!(!looks_like_ip(""));
    }
}
