//! 身份（profile）存取：所有落盘都在 `~/.multicc/plugins-data/chrome-proxy-launcher/`。
//!
//! 布局：
//!   profiles.json                     身份清单（原子写：tmp + rename）
//!   run/<id>.pid                      launch 后记录的主进程 pid
//!   chrome-profiles/<id>/             每个身份独立的 Chrome user-data-dir
//!
//! id 只含 ASCII 安全字符（slug 或 profile-N），目录名直接用 id，不会出现
//! 中文/空格路径被各层编码搞坏的问题；显示名（name）保持用户原文。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub scheme: String, // http | https | socks5
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub chrome_path: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn home_dir() -> PathBuf {
    // 不引 dirs crate：两个平台变量足够，缺省落到 /tmp（只影响极端环境）。
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub fn data_dir() -> PathBuf {
    home_dir().join(".multicc").join("plugins-data").join("chrome-proxy-launcher")
}

pub fn profiles_file() -> PathBuf {
    data_dir().join("profiles.json")
}

pub fn pid_file(id: &str) -> PathBuf {
    data_dir().join("run").join(format!("{id}.pid"))
}

pub fn user_data_dir(id: &str) -> PathBuf {
    data_dir().join("chrome-profiles").join(id)
}

pub fn load_profiles() -> Result<Vec<Profile>, String> {
    let raw = match fs::read(profiles_file()) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("读取身份清单失败：{err}")),
    };
    serde_json::from_slice(&raw).map_err(|err| format!("身份清单不是合法 JSON：{err}"))
}

pub fn save_profiles(profiles: &[Profile]) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败：{err}"))?;
    let file = profiles_file();
    let tmp = dir.join(".profiles.json.tmp");
    let bytes = serde_json::to_vec_pretty(profiles).map_err(|err| err.to_string())?;
    fs::write(&tmp, bytes).map_err(|err| format!("写入身份清单失败：{err}"))?;
    fs::rename(&tmp, &file).map_err(|err| format!("替换身份清单失败：{err}"))
}

pub fn read_pid(id: &str) -> Option<i32> {
    let text = fs::read_to_string(pid_file(id)).ok()?;
    text.trim().parse::<i32>().ok()
}

pub fn write_pid(id: &str, pid: i32) -> Result<(), String> {
    let dir = data_dir().join("run");
    fs::create_dir_all(&dir).map_err(|err| format!("创建运行目录失败：{err}"))?;
    fs::write(pid_file(id), pid.to_string()).map_err(|err| format!("写入 pid 失败：{err}"))
}

pub fn clear_pid(id: &str) {
    let _ = fs::remove_file(pid_file(id));
}

/// name → 目录安全的 id：ASCII 字母数字保留、其余压成 '-'。
/// 纯中文名会得到空 slug，由调用方落回 profile-N。
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// 在既有清单里为 name 挑一个不冲突的 id；空 slug 落回 profile-N。
pub fn allocate_id(name: &str, existing: &[Profile]) -> String {
    let base = {
        let slug = slugify(name);
        if slug.is_empty() {
            "profile".to_string()
        } else {
            slug.chars().take(40).collect::<String>()
        }
    };
    let taken = |id: &str| existing.iter().any(|p| p.id == id);
    if !taken(&base) {
        return base;
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("profile-{}", now_secs())
}

pub fn validate_proxy(scheme: &str, host: &str, port: u16) -> Result<(), String> {
    if !matches!(scheme, "http" | "https" | "socks5") {
        return Err(format!("不支持的代理类型 `{scheme}`（支持 http / https / socks5）"));
    }
    if host.trim().is_empty() {
        return Err("代理地址不能为空".into());
    }
    if port == 0 {
        return Err("代理端口不能为 0".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_keeps_ascii_and_compresses_separators() {
        assert_eq!(slugify("My Shop 2"), "my-shop-2");
        assert_eq!(slugify("纯中文"), "");
        assert_eq!(slugify("A--B__c"), "a-b-c");
    }

    #[test]
    fn allocate_id_falls_back_and_dedupes() {
        let existing = vec![Profile {
            id: "shop".into(), name: "Shop".into(),
            proxy: ProxyConfig { scheme: "http".into(), host: "127.0.0.1".into(), port: 7897 },
            note: String::new(), chrome_path: None, created_at: 0, updated_at: 0,
        }];
        assert_eq!(allocate_id("Shop", &existing), "shop-2");
        assert_eq!(allocate_id("纯中文", &[]), "profile");
        assert_eq!(allocate_id("纯中文", &existing), "profile");
    }

    #[test]
    fn validate_proxy_rejects_unknown_scheme() {
        assert!(validate_proxy("socks5", "127.0.0.1", 1080).is_ok());
        assert!(validate_proxy("vmess", "127.0.0.1", 1080).is_err());
        assert!(validate_proxy("http", "", 8080).is_err());
    }
}
