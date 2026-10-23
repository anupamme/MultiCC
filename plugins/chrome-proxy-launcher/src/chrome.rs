//! Chrome 定位与启动：每个身份一个独立 user-data-dir + 强制 --proxy-server。
//!
//! 固定单代理没有 DIRECT 备用：代理不可达时，受代理控制的网页请求失败。
//! 禁止非代理 WebRTC UDP / QUIC，压掉目标域名本地解析；这些参数不是系统防火墙。
//! 启动探测只用于提前报错，不能作为运行期间的断网保护。

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

pub fn wait_exit(pid: i32, limit: Duration) -> bool {
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

pub fn build_args(profile: &Profile, url: Option<&str>, proxy_arg: &str) -> Vec<String> {
    let data_dir = store::user_data_dir(&profile.id);
    let mut args = vec![
        format!("--user-data-dir={}", data_dir.display()),
        proxy_arg.to_string(),
        "--proxy-bypass-list=<-loopback>".to_string(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string(),
        "--disable-quic".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-features=ChromeWhatsNewUI".to_string(),
        // 每次都接着上次的会话打开：恢复标签页，也保住没勾「记住我」的会话
        // cookie（不加它 Chrome 启动时会清掉会话 cookie，等于又要重新登录）。
        // 「启动时继续浏览」那个设置项写进 Preferences 不管用：它受 Secure
        // Preferences 校验，外部改写会被 Chrome 当作篡改重置。
        "--restore-last-session".to_string(),
    ];
    // HTTP / SOCKS5 的目标域名由代理解析。限制 Chrome 的其他本地解析，
    // 仅为代理服务器自身保留 DNS（若代理地址使用域名，仍需先找到代理）。
    let proxy_host = proxy_arg.split_once("://")
        .and_then(|(_, authority)| authority.rsplit_once(':'))
        .map(|(host, _)| host.trim_matches(['[', ']']))
        .unwrap_or("127.0.0.1");
    args.push(format!("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE {proxy_host}"));
    if let Some(target) = url {
        if !target.trim().is_empty() {
            args.push(target.trim().to_string());
        }
    }
    args
}

/// 拉起带凭据代理的本地中继并等它就绪，返回本地端口。
/// 中继使用独立子进程；不是系统托管服务，进程组或服务整体停止仍可能终止它。
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

/// Chrome 不会把新启动参数应用到已经运行的同 profile 实例。
/// 必须在触碰中继/内核之前拒绝，避免旧浏览器仍指向刚被收掉的端口。
pub fn ensure_not_running(id: &str) -> Result<(), String> {
    if store::read_pid(id).is_some_and(pid_alive) {
        return Err("该身份浏览器仍在运行，请先点击「停止」再启动或修改出口；浏览器内可直接新建窗口".into());
    }
    Ok(())
}

/// 启动一个身份对应的隔离浏览器实例。
/// check_proxy=true（默认）先验证出口可用：无凭据查 TCP 可达；带凭据直接做
/// 一次认证探测（凭据错就拒绝启动，不让 Chrome 挂在中继上白等）；订阅出口
/// 则经刚起的本地内核取一次出口 IP。
/// 带凭据的直连代理会先拉起本地中继；订阅出口会先拉起身份专属 meow 内核。
pub fn launch(profile: &Profile, url: Option<&str>, check_proxy: bool, automatic_fingerprint: bool) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(18);
    let _lock = crate::browser_session::launch_lock(&profile.id)?;
    ensure_not_running(&profile.id)?;
    if url.is_some_and(|u| u.trim_start().starts_with('-')) { return Err("网页地址不能是启动参数".into()); }
    let browser = find_browser(profile.chrome_path.as_deref())?;
    let extension = if automatic_fingerprint { Some(crate::fingerprint::prepare(profile)?) } else { None };
    let data_dir = store::user_data_dir(&profile.id);
    std::fs::create_dir_all(&data_dir).map_err(|err| format!("创建隔离 profile 目录失败：{err}"))?;

    let mut extras = serde_json::Map::new();
    let proxy_arg = if let Some(egress) = &profile.subscription {
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
                    "订阅出口不可用，已拒绝启动（未改用直连）：{err}"
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
        proxy_arg
    } else if let Some(proxy) = &profile.proxy {
        if check_proxy {
            if proxy.has_credentials() {
                crate::proxy::exit_ip(proxy, Duration::from_secs(6))?;
            } else if !crate::proxy::tcp_reachable(&proxy.host, proxy.port, Duration::from_millis(1500)) {
                return Err(format!(
                    "代理 {}://{}:{} 不可达，已拒绝启动（未改用直连）",
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
            // 中继是 http 代理，目标域名交中继/上游解析。
            Some(port) => format!("--proxy-server=http://127.0.0.1:{port}"),
            None => format!("--proxy-server={}://{}:{}", proxy.scheme, proxy.host, proxy.port),
        }
    } else {
        return Err("这个身份还没有配置出口".into());
    };

    let args = build_args(profile, url, &proxy_arg);
    let session = (if let Some(extension) = extension {
        match deadline.checked_duration_since(std::time::Instant::now()) {
            Some(budget) => crate::browser_session::launch(&profile.id, &browser, &args, &extension, budget),
            None => Err("出口准备耗时过长，请重新启动浏览器".into()),
        }
    } else {
        Command::new(&browser).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().map(|child| json!({"pid":child.id(),"fingerprint":{"status":"notRequested","installationVerified":false}}))
            .map_err(|e| format!("启动浏览器失败：{e}"))
    }).map_err(|err| {
        stop_relay_if_any(&profile.id);
        crate::core::stop_if_any(&profile.id);
        err
    })?;
    let pid = session["pid"].as_i64().ok_or("浏览器未返回进程号")? as i32;
    if let Err(error) = store::write_pid(&profile.id, pid) {
        let _ = crate::browser_session::request_stop(&profile.id, pid);
        let _ = quit_gracefully(pid);
        stop_relay_if_any(&profile.id);
        crate::core::stop_if_any(&profile.id);
        return Err(error);
    }
    let mut result = json!({
        "pid": pid,
        "browser": browser.display().to_string(),
        "userDataDir": data_dir.display().to_string(),
        "args": args,
        "fingerprint": session["fingerprint"],
        "supervisorPid": session["supervisorPid"],
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
        );
        assert!(args.iter().any(|a| a == "--proxy-server=http://127.0.0.1:7897"));
        assert!(args.iter().any(|a| a.starts_with("--user-data-dir=")));
        assert!(args.iter().any(|a| a == "--restore-last-session"));
        assert!(args.iter().any(|a| a == "https://example.com"));
        assert!(args.iter().any(|a| a == "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"));
    }

    #[test]
    fn all_proxy_types_disable_bypasses_without_blocking_proxy_dns() {
        for scheme in ["http", "https", "socks5"] {
            let proxy = format!("--proxy-server={scheme}://proxy.example:8080");
            let args = build_args(&profile(scheme), None, &proxy);
            for flag in [
                "--proxy-bypass-list=<-loopback>",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-quic",
                "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE proxy.example",
            ] {
                assert!(args.iter().any(|a| a == flag), "{scheme}: {flag}");
            }
            assert!(!args.iter().any(|a| a.contains("direct://")));
        }
    }

    #[test]
    fn socks5_pins_dns_too() {
        let args = build_args(&profile("socks5"), None, "--proxy-server=socks5://127.0.0.1:7897");
        assert!(args.iter().any(|a| a.starts_with("--host-resolver-rules")));
    }

    #[test]
    fn relay_redirects_proxy_and_leaves_dns_to_upstream() {
        let mut with_creds = profile("socks5");
        if let Some(proxy) = with_creds.proxy.as_mut() {
            proxy.username = Some("u".into());
            proxy.password = Some("p".into());
        }
        let args = build_args(&with_creds, None, "--proxy-server=http://127.0.0.1:41000");
        assert!(args.iter().any(|a| a == "--proxy-server=http://127.0.0.1:41000"));
        // 目标 DNS 交给中继/上游，Chrome 本地只允许解析代理地址。
        assert!(args.iter().any(|a| a == "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"));
    }
}
