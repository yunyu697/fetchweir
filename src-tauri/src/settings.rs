// 本地数据目录与设置持久化。
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub fn data_dir() -> PathBuf {
    // 必须与安装目录分开：Windows「仅当前用户」安装落在 %LOCALAPPDATA%\Fetchweir，
    // 如果数据也放这里，卸载时会被一并删掉。改用漫游目录，卸载/重装后设置与记录仍在。
    dirs::data_dir()
        .or_else(dirs::data_local_dir)
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
    /// 限速站点自动降并发：用户设定值是上限，自动策略只在其下调整。
    pub auto_concurrency: bool,
    pub global_limit_bps: u64,
    pub theme: String,
    /// 颜色主题：violet / azure / emerald / amber。与 theme 独立保存，互不覆盖。
    pub color_theme: String,
    /// 更新源仓库（owner/name）。默认为只放发布产物的公开仓库；
    /// 客户端只读，不携带任何访问令牌。
    pub update_repo: String,
    /// 更新下载镜像 id（见 update::MIRRORS）。
    pub update_mirror: String,
    pub homepage: String,
    /// 浮动条档位：A 自动出条 / B 仅顶层按网络信号 / C 只用徽标。
    pub sniff_tier: String,
    /// 嗅探记录保留小时数；0 表示直到手动清除。
    pub sniff_ttl_hours: u32,
    /// 每任务连接数的硬上限（新建任务对话框不得超过此值）。
    pub max_connections: u32,
    /// 强调色（十六进制），外观页色板直接写入。
    pub accent: String,
    /// 列表密度：comfortable / compact。
    pub density: String,
    pub reduce_motion: bool,
    /// 关闭窗口时保持后台运行。
    pub close_to_tray: bool,
    /// 开机自启动（Windows：普通权限写 HKCU Run，管理员模式写计划任务）。
    pub autostart: bool,
    /// 始终以管理员身份运行（仅 Windows；开启后每次启动都会请求 UAC）。
    pub run_as_admin: bool,
    /// 首次连接与读取超时；改动在下次启动引擎时生效。
    pub connect_timeout_sec: u32,
    pub read_timeout_sec: u32,
    /// 视频首选组合：compat（1080p H.264 MP4）/ best / small。
    pub video_preferred: String,
    /// 视频解析凭据来源：none（默认）/ browser / file。
    /// 只在这里记录来源，Cookie 内容不落应用数据目录。
    pub cookie_source: String,
    /// 来源为 browser 时读取哪个浏览器：chrome / edge / firefox / brave / vivaldi。
    pub cookie_browser: String,
    /// 浏览器 profile 目录名或完整路径；留空表示浏览器默认 profile。
    pub cookie_profile: String,
    /// 来源为 file 时的 cookies.txt 绝对路径；原文件只读，不复制。
    pub cookie_file: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            download_dir: default_download_dir(),
            connections: 8,
            auto_concurrency: true,
            global_limit_bps: 0,
            theme: "dark".to_string(),
            color_theme: "violet".to_string(),
            update_repo: "yunyu697/fetchweir".to_string(),
            update_mirror: "github".to_string(),
            homepage: "https://github.com/yunyu697/fetchweir".to_string(),
            sniff_tier: "B".to_string(),
            sniff_ttl_hours: 24,
            max_connections: 16,
            accent: "#6C8CFF".to_string(),
            density: "comfortable".to_string(),
            reduce_motion: false,
            close_to_tray: true,
            autostart: false,
            run_as_admin: false,
            connect_timeout_sec: 10,
            read_timeout_sec: 30,
            video_preferred: "compat".to_string(),
            cookie_source: "none".to_string(),
            cookie_browser: "chrome".to_string(),
            cookie_profile: String::new(),
            cookie_file: String::new(),
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
