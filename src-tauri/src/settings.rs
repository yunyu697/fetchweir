// 本地数据目录与设置持久化。
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub fn data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Fetchweir")
}

pub fn ensure_data_dir() -> PathBuf {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn default_download_dir() -> String {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .to_string_lossy()
        .to_string()
}

/// 系统默认下载目录，「仅下载」与普通下载的默认落点。
pub fn system_download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub download_dir: String,
    pub connections: u32,
    pub global_limit_bps: u64,
    pub theme: String,
    /// 更新源仓库（owner/name）。默认指向自有仓库，替换为公开镜像仓库也可。
    pub update_repo: String,
    /// 私有仓库的读取令牌；为空时回退到 FETCHWEIR_GITHUB_TOKEN 环境变量。
    pub update_token: String,
    /// 更新下载镜像 id（见 update::MIRRORS）。
    pub update_mirror: String,
    pub homepage: String,
    /// 浮动条档位：A 自动出条 / B 仅顶层按网络信号 / C 只用徽标。
    pub sniff_tier: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir(),
            connections: 8,
            global_limit_bps: 0,
            theme: "dark".to_string(),
            update_repo: "yunyu697/fetchweir".to_string(),
            update_token: String::new(),
            update_mirror: "github".to_string(),
            homepage: "https://github.com/yunyu697/fetchweir".to_string(),
            sniff_tier: "B".to_string(),
        }
    }
}

fn settings_path() -> PathBuf {
    ensure_data_dir().join("settings.json")
}

pub fn load() -> Settings {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => {
            let settings = Settings::default();
            let _ = save(&settings);
            settings
        }
    }
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // 原子替换：先写 .tmp 再 rename
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
