//! 生成每个身份独立的 Manifest V3 扩展。种子持久化和文件生成由 Rust 承担，
//! JS 仅在浏览器页面中运行。不打开调试端口，不修改 Chrome 的签名或 Preferences。
use crate::store::{self, Profile};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

const SCRIPT: &str = include_str!("../extension/fingerprint.js");

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn seed(dir: &Path) -> Result<[u32; 4], String> {
    let file = dir.join("identity.json");
    if !file.exists() {
        if dir.join("extension").exists() {
            return Err("已有扩展的指纹配置缺失，已停止生成；不会自动更换指纹".into());
        }
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| "生成指纹配置失败".to_string())?;
        let values: Vec<u32> = bytes.chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect();
        let tmp = dir.join(format!(".identity.{}.tmp", std::process::id()));
        let write = || -> Result<(), String> {
            let mut f = private_options().open(&tmp).map_err(|_| "创建指纹配置临时文件失败")?;
            f.write_all(json!(values).to_string().as_bytes()).map_err(|_| "写入指纹配置失败")?;
            f.sync_all().map_err(|_| "保存指纹配置失败")?;
            // 原子地发布完整种子。并发生成时保留先发布者，绝不覆盖已有身份。
            match fs::hard_link(&tmp, &file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
                Err(_) => Err("保存指纹配置失败".into()),
            }
        };
        let result = write();
        let _ = fs::remove_file(&tmp);
        result?;
    }
    let text = fs::read_to_string(&file).map_err(|_| "读取指纹配置失败")?;
    serde_json::from_str(&text).map_err(|_| "指纹配置损坏，已停止生成；不会自动更换已有身份的指纹".into())
}

fn write_atomic(dir: &Path, name: &str, contents: &str) -> Result<(), String> {
    let file = dir.join(name);
    if fs::read_to_string(&file).ok().as_deref() == Some(contents) { return Ok(()); }
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let write = || -> Result<(), String> {
        let mut f = private_options().open(&tmp).map_err(|_| "创建扩展临时文件失败")?;
        f.write_all(contents.as_bytes()).map_err(|_| "写入扩展失败")?;
        f.sync_all().map_err(|_| "保存扩展失败")?;
        fs::rename(&tmp, &file).map_err(|_| "安装扩展文件失败".into())
    };
    let result = write();
    let _ = fs::remove_file(tmp);
    result
}

fn prepare_at(profile: &Profile, base: &Path) -> Result<Value, String> {
    if profile.id.is_empty() || !profile.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("身份 ID 不合法".into());
    }
    let dir = base.join(&profile.id);
    fs::create_dir_all(&dir).map_err(|_| "创建指纹扩展目录失败")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| "设置指纹目录权限失败")?;
    }
    let identity = seed(&dir)?;
    let extension_dir = dir.join("extension");
    fs::create_dir_all(&extension_dir).map_err(|_| "创建扩展目录失败")?;
    write_atomic(&extension_dir, "fingerprint.js", &SCRIPT.replace("__MULTICC_FINGERPRINT_SEED__", &json!(identity).to_string()))?;
    let manifest = json!({
        "manifest_version": 3,
        "name": format!("MultiCC 轻量指纹 · {}", profile.id.chars().take(40).collect::<String>()),
        "version": "1.0.0",
        "minimum_chrome_version": "119",
        "description": "为这个身份轻微调整网页 Canvas / WebGL 像素读取；不提供完整设备指纹隔离。",
        "content_scripts": [{
            "matches": ["http://*/*", "https://*/*"],
            "js": ["fingerprint.js"],
            "run_at": "document_start",
            "world": "MAIN",
            "all_frames": true,
            "match_origin_as_fallback": true
        }]
    });
    // 最后发布 manifest，生成失败不返回可加载成功。
    write_atomic(&extension_dir, "manifest.json", &serde_json::to_string_pretty(&manifest).unwrap())?;
    Ok(json!({
        "extensionPath": extension_dir.display().to_string(),
        "status": "prepared", "installationVerified": false,
        "message": "扩展文件已准备；启用自动指纹启动后会自动加载并验证，无需手动安装。"
    }))
}

pub fn prepare(profile: &Profile) -> Result<Value, String> {
    prepare_at(profile, &store::data_dir().join("fingerprints"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_is_stable_isolated_and_corruption_never_reseeds() {
        let dir = std::env::temp_dir().join(format!("multicc-fingerprint-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut profile: Profile = serde_json::from_value(json!({"id":"one", "name":"one"})).unwrap();
        let one = prepare_at(&profile, &dir).unwrap();
        let script = fs::read_to_string(dir.join("one/extension/fingerprint.js")).unwrap();
        profile.name = "renamed".into();
        assert_eq!(one, prepare_at(&profile, &dir).unwrap());
        assert_eq!(script, fs::read_to_string(dir.join("one/extension/fingerprint.js")).unwrap());
        profile.id = "two".into();
        prepare_at(&profile, &dir).unwrap();
        assert_ne!(script, fs::read_to_string(dir.join("two/extension/fingerprint.js")).unwrap());
        fs::write(dir.join("two/identity.json"), "broken").unwrap();
        assert!(prepare_at(&profile, &dir).unwrap_err().contains("损坏"));
        assert_eq!(fs::read_to_string(dir.join("two/identity.json")).unwrap(), "broken");
        profile.id = "../bad".into();
        assert!(prepare_at(&profile, &dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
