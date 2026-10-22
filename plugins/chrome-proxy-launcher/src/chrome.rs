//! Chrome 定位与启动：每个身份一个独立 user-data-dir + 强制 --proxy-server。
//!
//! 「强制」的关键：Chrome 的代理是启动参数级（--proxy-server），整个实例的
//! 所有请求都走它；socks5 再配 --host-resolver-rules 把 DNS 解析也压进代理
//! （Chrome 对 socks5 默认本地解析 DNS，不压会漏）。launch 前先做一次 TCP
//! 可达检查 —— 代理挂了就拒绝启动，因为 Chrome 代理失效时会静默直连，
//! 那正是这个插件要杜绝的泄漏。

use crate::store::{self, Profile};
use serde_json::json;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

pub fn candidate_paths() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        let home = store::home_dir();
        vec![
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ]
    } else if cfg!(target_os = "windows") {
        let prefixes = [
            r"C:\Program Files\Google\Chrome\Application",
            r"C:\Program Files (x86)\Google\Chrome\Application",
        ];
        let mut out = Vec::new();
        for prefix in prefixes {
            out.push(PathBuf::from(prefix).join("chrome.exe"));
        }
        out.push(PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"));
        out
    } else {
        vec![
            PathBuf::from("/usr/bin/google-chrome"),
            PathBuf::from("/usr/bin/google-chrome-stable"),
            PathBuf::from("/usr/bin/chromium"),
            PathBuf::from("/usr/bin/chromium-browser"),
            PathBuf::from("/snap/bin/chromium"),
        ]
    }
}

/// 找浏览器：preferred（身份里存的）优先，其后按平台候选表。
/// macOS 上路径带空格是常态，调用方走 argv 数组、绝不拼 shell 字符串。
pub fn find_browser(preferred: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = preferred {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!("身份里配置的浏览器不存在：{raw}"));
    }
    for path in candidate_paths() {
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("没找到 Chrome / Chromium / Edge，请在身份里手动填写浏览器路径".into())
}

pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // ps -p 在 macOS/Linux 都有；Windows 走 tasklist（本插件暂以 unix 为主）。
    Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn terminate_pid(pid: i32) -> Result<(), String> {
    let ok = Command::new("kill")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!("终止进程 {pid} 失败（可能已退出）"))
    }
}

pub fn build_args(profile: &Profile, url: Option<&str>) -> Vec<String> {
    let data_dir = store::user_data_dir(&profile.id);
    let mut args = vec![
        format!("--user-data-dir={}", data_dir.display()),
        format!("--proxy-server={}://{}:{}", profile.proxy.scheme, profile.proxy.host, profile.proxy.port),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-features=ChromeWhatsNewUI".to_string(),
    ];
    if profile.proxy.scheme == "socks5" {
        // socks5 下 Chrome 默认在本地解析 DNS（socks5 而非 socks5h），等于
        // 把访问了哪些域名漏给本地网络栈。压掉本地解析，解析失败宁可不连。
        args.push("--host-resolver-rules=MAP * ~NOTFOUND , DIRECT".to_string());
    }
    if let Some(target) = url {
        if !target.trim().is_empty() {
            args.push(target.trim().to_string());
        }
    }
    args
}

/// 启动一个身份对应的隔离浏览器实例。
/// check_proxy=true（默认）时先验证代理端口可达，不通直接拒绝 —— Chrome 代理
/// 失效会静默直连，泄漏真实出口，宁可失败也不能裸奔。
pub fn launch(profile: &Profile, url: Option<&str>, check_proxy: bool) -> Result<serde_json::Value, String> {
    let browser = find_browser(profile.chrome_path.as_deref())?;
    if check_proxy && !crate::proxy::tcp_reachable(&profile.proxy.host, profile.proxy.port, Duration::from_millis(1500)) {
        return Err(format!(
            "代理 {}://{}:{} 不可达，已拒绝启动（Chrome 代理失效会直连泄漏真实出口）",
            profile.proxy.scheme, profile.proxy.host, profile.proxy.port
        ));
    }
    let data_dir = store::user_data_dir(&profile.id);
    std::fs::create_dir_all(&data_dir).map_err(|err| format!("创建隔离 profile 目录失败：{err}"))?;

    let args = build_args(profile, url);
    let child = Command::new(&browser)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("启动浏览器失败：{err}"))?;
    let pid = child.id() as i32;
    store::write_pid(&profile.id, pid)?;
    Ok(json!({
        "pid": pid,
        "browser": browser.display().to_string(),
        "userDataDir": data_dir.display().to_string(),
        "args": args,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ProxyConfig;

    fn profile(scheme: &str) -> Profile {
        Profile {
            id: "shop".into(),
            name: "Shop".into(),
            proxy: ProxyConfig { scheme: scheme.into(), host: "127.0.0.1".into(), port: 7897 },
            note: String::new(),
            chrome_path: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn args_pin_proxy_and_isolate_profile() {
        let args = build_args(&profile("http"), Some("https://example.com"));
        assert!(args.iter().any(|a| a == "--proxy-server=http://127.0.0.1:7897"));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        assert!(args.iter().any(|a| a == "https://example.com"));
        assert!(!args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }

    #[test]
    fn socks5_pins_dns_too() {
        let args = build_args(&profile("socks5"), None);
        assert!(args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }
}
