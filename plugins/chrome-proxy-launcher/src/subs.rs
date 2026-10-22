//! 订阅拉取：https 走 ureq(rustls)，响应体交给 core::parse_config 统一解析。
//!
//! 订阅 URL 里通常带用户 token，任何错误信息都必须先脱敏再往外抛 ——
//! 插件 UI 会把错误原文显示出来。

use crate::core;
use std::time::Duration;

pub struct Fetched {
    pub raw: String,
    pub nodes: Vec<String>,
    pub traffic: Option<String>,
}

/// 把 URL 的 path/query 打码，只留 scheme+host（错误信息里用）。
fn redact(url: &str) -> String {
    match url.find("://") {
        Some(scheme_end) => {
            let rest = &url[scheme_end + 3..];
            let host_end = rest.find('/').map(|i| scheme_end + 3 + i).unwrap_or(url.len());
            format!("{}…", &url[..host_end])
        }
        None => "…".into(),
    }
}

/// 订阅服务器在国内时可能需要走本机代理，沿用常见环境变量。
fn env_proxy(url: &str) -> Option<ureq::Proxy> {
    let keys: &[&str] = if url.starts_with("https://") {
        &["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        &["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    };
    for key in keys {
        if let Ok(value) = std::env::var(key) {
            if value.trim().is_empty() {
                continue;
            }
            if let Ok(proxy) = ureq::Proxy::new(value.trim()) {
                return Some(proxy);
            }
        }
    }
    None
}

pub fn fetch(url: &str, timeout: Duration) -> Result<Fetched, String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("订阅地址必须以 http:// 或 https:// 开头".into());
    }
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout.max(Duration::from_secs(10)))
        // 机场常按 UA 决定返回 Clash 配置还是裸节点列表。
        .user_agent("clash-verge/v2.0 (mihomo)");
    if let Some(proxy) = env_proxy(url) {
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();
    let response = agent.get(url).call().map_err(|err| {
        let detail = format!("{err}").replace(url, &redact(url));
        format!("拉取订阅失败（{}）：{detail}", redact(url))
    })?;
    let traffic = response.header("subscription-userinfo").map(str::to_string);
    let raw = response
        .into_string()
        .map_err(|err| format!("读取订阅内容失败：{err}"))?;
    let config = core::parse_config(&raw)?;
    let nodes = core::node_names(&config);
    if nodes.is_empty() {
        return Err("订阅里没有节点（返回内容没有 proxies 列表，可能链接已失效或是节点链接格式）".into());
    }
    Ok(Fetched { raw, nodes, traffic })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_keeps_only_host() {
        assert_eq!(
            redact("https://api.example.com:41080/artifacts/secret/sub.yaml?token=abc"),
            "https://api.example.com:41080…"
        );
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(fetch("file:///etc/passwd", Duration::from_secs(1)).is_err());
        assert!(fetch("", Duration::from_secs(1)).is_err());
    }
}
