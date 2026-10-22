//! Chrome 定位与启动：每个身份一个独立 user-data-dir + 强制 --proxy-server。
//!
//! 「强制」的关键：Chrome 的代理是启动参数级（--proxy-server），整个实例的
//! 所有请求都走它；socks5 再配 --host-resolver-rules 把 DNS 解析也压进代理
//! （Chrome 对 socks5 默认本地解析 DNS，不压会漏）。launch 前先做一次 TCP
//! 可达检查 —— 代理挂了就拒绝启动，因为 Chrome 代理失效时会静默直连，
//! 那正是这个插件要杜绝的泄漏。

use crate::store::{self, Profile};
use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
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

/// 像 ⌘Q 一样让这个 Chrome 实例正常退出，等它把 cookie 等写完盘。
///
/// 不能直接 kill：Chrome 把 SIGTERM 当成「系统注销」走快速退出（exit_type
/// SessionEnded），cookie 库每 30 秒才批量落盘一次，刚登录的会话实测 5 次里
/// 4 次丢失 —— 这正是「每次打开都要重新登录」的根因。macOS 上按 pid 发标准退出
/// 事件（NSRunningApplication.terminate，只作用于这一个实例，不会误关用户自己的
/// Chrome），实测 cookie 全部保留、exit_type=Normal。超时仍未退出才退回 SIGTERM。
pub fn quit_gracefully(pid: i32) -> Result<(), String> {
    if !pid_alive(pid) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "ObjC.import('AppKit'); var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}); a.isNil() ? false : a.terminate"
        );
        let _ = Command::new("osascript")
            .args(["-l", "JavaScript", "-e", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if wait_exit(pid, Duration::from_secs(15)) {
            return Ok(());
        }
    }
    terminate_pid(pid)?;
    if wait_exit(pid, Duration::from_secs(5)) {
        Ok(())
    } else {
        Err(format!("浏览器进程 {pid} 未能在限定时间内退出"))
    }
}

fn wait_exit(pid: i32, limit: Duration) -> bool {
    let step = Duration::from_millis(250);
    let mut waited = Duration::ZERO;
    while waited < limit {
        if !pid_alive(pid) {
            return true;
        }
        thread::sleep(step);
        waited += step;
    }
    !pid_alive(pid)
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

pub fn build_args(profile: &Profile, url: Option<&str>, proxy_arg: &str, pin_dns: bool) -> Vec<String> {
    let data_dir = store::user_data_dir(&profile.id);
    let mut args = vec![
        format!("--user-data-dir={}", data_dir.display()),
        proxy_arg.to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-features=ChromeWhatsNewUI".to_string(),
        // 每次都接着上次的会话打开：恢复标签页，也保住没勾「记住我」的会话
        // cookie（不加它 Chrome 启动时会清掉会话 cookie，等于又要重新登录）。
        // 「启动时继续浏览」那个设置项写进 Preferences 不管用：它受 Secure
        // Preferences 校验，外部改写会被 Chrome 当作篡改重置。
        "--restore-last-session".to_string(),
    ];
    // socks5 直连时 Chrome 默认在本地解析 DNS（socks5 而非 socks5h），等于
    // 把访问了哪些域名漏给本地网络栈。压掉本地解析，解析失败宁可不连。
    // 走中继/内核时不需要：域名由代理侧解析。
    if pin_dns {
        args.push("--host-resolver-rules=MAP * ~NOTFOUND , DIRECT".to_string());
    }
    if let Some(target) = url {
        if !target.trim().is_empty() {
            args.push(target.trim().to_string());
        }
    }
    args
}

/// 拉起带凭据代理的本地中继并等它就绪，返回本地端口。
/// 中继进程与 launcher（本进程）脱钩：父进程退出后由 launchd 收养常驻。
pub fn spawn_relay(
    id: &str,
    upstream: &crate::store::ProxyConfig,
    hop: Option<crate::store::ProxyConfig>,
) -> Result<u16, String> {
    // 上次 launch 残留的中继先收掉，避免旧凭据/旧端口混进本次会话。
    if let Some((pid, _)) = store::read_relay(id) {
        if pid_alive(pid) {
            let _ = terminate_pid(pid);
        }
        store::clear_relay(id);
    }
    let exe = std::env::current_exe().map_err(|err| format!("定位插件二进制失败：{err}"))?;
    let mut child = Command::new(&exe)
        .arg("relay")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("启动本地中继失败：{err}"))?;
    let input = serde_json::json!({ "id": id, "proxy": upstream, "hop": hop });
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.to_string().as_bytes());
    } // stdin 随 drop 关闭，中继读完后进入服务循环
    for _ in 0..60 {
        thread::sleep(Duration::from_millis(50));
        if let Some((pid, port)) = store::read_relay(id) {
            if pid_alive(pid) {
                return Ok(port);
            }
            return Err("本地中继启动后立即退出（上游代理配置可能有误）".into());
        }
        if let Ok(Some(_)) = child.try_wait() {
            return Err("本地中继启动失败".into());
        }
    }
    Err("等待本地中继就绪超时".into())
}

/// stop / remove 时收割中继（有就杀，没有静默）。
pub fn stop_relay_if_any(id: &str) {
    if let Some((pid, _)) = store::read_relay(id) {
        if pid_alive(pid) {
            let _ = terminate_pid(pid);
        }
    }
    store::clear_relay(id);
}

/// 启动一个身份对应的隔离浏览器实例。
/// check_proxy=true（默认）先验证出口可用：无凭据查 TCP 可达；带凭据直接做
/// 一次认证探测（凭据错就拒绝启动，不让 Chrome 挂在中继上白等）；订阅出口
/// 则经刚起的本地内核取一次出口 IP。
/// 带凭据的直连代理会先拉起本地中继；订阅出口会先拉起身份专属 meow 内核。
pub fn launch(profile: &Profile, url: Option<&str>, check_proxy: bool) -> Result<serde_json::Value, String> {
    let browser = find_browser(profile.chrome_path.as_deref())?;
    let data_dir = store::user_data_dir(&profile.id);
    std::fs::create_dir_all(&data_dir).map_err(|err| format!("创建隔离 profile 目录失败：{err}"))?;

    let mut extras = serde_json::Map::new();
    let (proxy_arg, pin_dns) = if let Some(egress) = &profile.subscription {
        let subscriptions = store::load_subscriptions()?;
        let subscription = subscriptions
            .iter()
            .find(|item| item.id == egress.id)
            .ok_or_else(|| format!("身份引用的订阅「{}」不存在，先到订阅管理里刷新", egress.id))?;
        let raw = store::read_subscription_config(&egress.id)?;
        let node = if egress.node.trim().is_empty() {
            subscription.nodes.first().cloned().unwrap_or_default()
        } else {
            egress.node.clone()
        };
        let run = crate::core::start(&profile.id, &raw, &node)?;
        // 有上游住宅代理时：内核只跑跳板节点，中继自己串「跳板 → 上游」的链。
        let (listen_port, proxy_arg) = if let Some(via) = &egress.via {
            let hop = crate::store::ProxyConfig {
                scheme: "socks5".into(),
                host: "127.0.0.1".into(),
                port: run.mixed_port,
                username: None,
                password: None,
            };
            let relay_port = spawn_relay(&profile.id, via, Some(hop))?;
            extras.insert("relayPort".into(), json!(relay_port));
            (relay_port, format!("--proxy-server=http://127.0.0.1:{relay_port}"))
        } else {
            (
                run.mixed_port,
                format!("--proxy-server=http://127.0.0.1:{}", run.mixed_port),
            )
        };
        if check_proxy {
            if let Err(err) = crate::core::verify_exit(listen_port, Duration::from_secs(12)) {
                stop_relay_if_any(&profile.id);
                crate::core::stop_if_any(&profile.id);
                return Err(format!(
                    "订阅出口不可用，已拒绝启动（Chrome 代理失效会直连泄漏真实出口）：{err}"
                ));
            }
        }
        extras.insert("corePort".into(), json!(run.mixed_port));
        extras.insert("corePid".into(), json!(run.pid));
        extras.insert("core".into(), json!(run.core_path.display().to_string()));
        extras.insert("config".into(), json!(run.config_path.display().to_string()));
        extras.insert("node".into(), json!(node));
        extras.insert("subscription".into(), json!(subscription.name));
        if let Some(via) = &egress.via {
            extras.insert(
                "upstream".into(),
                json!(format!("{}://{}:{}", via.scheme, via.host, via.port)),
            );
        }
        (proxy_arg, false)
    } else if let Some(proxy) = &profile.proxy {
        if check_proxy {
            if proxy.has_credentials() {
                crate::proxy::exit_ip(proxy, Duration::from_secs(6))?;
            } else if !crate::proxy::tcp_reachable(&proxy.host, proxy.port, Duration::from_millis(1500)) {
                return Err(format!(
                    "代理 {}://{}:{} 不可达，已拒绝启动（Chrome 代理失效会直连泄漏真实出口）",
                    proxy.scheme, proxy.host, proxy.port
                ));
            }
        }
        let relay_port = if proxy.has_credentials() {
            Some(spawn_relay(&profile.id, proxy, None)?)
        } else {
            None
        };
        extras.insert("relayPort".into(), json!(relay_port));
        match relay_port {
            // 中继是 http 代理，域名交中继解析，不必压本地 DNS。
            Some(port) => (format!("--proxy-server=http://127.0.0.1:{port}"), false),
            None => (
                format!("--proxy-server={}://{}:{}", proxy.scheme, proxy.host, proxy.port),
                proxy.scheme == "socks5",
            ),
        }
    } else {
        return Err("这个身份还没有配置出口".into());
    };

    let args = build_args(profile, url, &proxy_arg, pin_dns);
    let child = Command::new(&browser)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| {
            // 浏览器没起来就别留下空转的中继/内核。
            stop_relay_if_any(&profile.id);
            crate::core::stop_if_any(&profile.id);
            format!("启动浏览器失败：{err}")
        })?;
    let pid = child.id() as i32;
    // 这个身份的 Chrome 已经在跑时，新进程只是把参数转交给它（开个新窗口/标签）
    // 然后立刻退出。保留原来那个主进程的 pid，否则「停止」会找不到它。
    let pid = match store::read_pid(&profile.id) {
        Some(existing) if existing != pid && pid_alive(existing) => existing,
        _ => {
            store::write_pid(&profile.id, pid)?;
            pid
        }
    };
    let mut result = json!({
        "pid": pid,
        "browser": browser.display().to_string(),
        "userDataDir": data_dir.display().to_string(),
        "args": args,
    });
    if let Some(map) = result.as_object_mut() {
        for (key, value) in extras {
            map.insert(key, value);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ProxyConfig;

    fn profile(scheme: &str) -> Profile {
        Profile {
            id: "shop".into(),
            name: "Shop".into(),
            proxy: Some(ProxyConfig::new(scheme, "127.0.0.1", 7897)),
            subscription: None,
            note: String::new(),
            chrome_path: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn args_pin_proxy_and_isolate_profile() {
        let args = build_args(
            &profile("http"),
            Some("https://example.com"),
            "--proxy-server=http://127.0.0.1:7897",
            false,
        );
        assert!(args.iter().any(|a| a == "--proxy-server=http://127.0.0.1:7897"));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        assert!(args.iter().any(|a| a == "--restore-last-session"));
        assert!(args.iter().any(|a| a == "https://example.com"));
        assert!(!args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }

    #[test]
    fn socks5_pins_dns_too() {
        let args = build_args(&profile("socks5"), None, "--proxy-server=socks5://127.0.0.1:7897", true);
        assert!(args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }

    #[test]
    fn relay_redirects_proxy_and_leaves_dns_to_upstream() {
        let mut with_creds = profile("socks5");
        if let Some(proxy) = with_creds.proxy.as_mut() {
            proxy.username = Some("u".into());
            proxy.password = Some("p".into());
        }
        let args = build_args(&with_creds, None, "--proxy-server=http://127.0.0.1:41000", false);
        assert!(args.iter().any(|a| a == "--proxy-server=http://127.0.0.1:41000"));
        // DNS 交给中继/上游解析，不再压本地解析。
        assert!(!args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }
}
