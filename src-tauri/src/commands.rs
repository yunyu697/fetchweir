// 前端可调用的命令层。
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::engine::{Engine, TaskDto};
use crate::nm::{self, NmStatus};
use crate::settings::{self, Settings};
use crate::sniff::{SniffItem, SniffStore};
use crate::update::{UpdateDto, Updater};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub download_dir: String,
    pub data_dir: String,
}

#[tauri::command(async)]
pub fn app_info(engine: State<'_, Arc<Engine>>) -> AppInfo {
    let settings = engine.settings.read().unwrap().clone();
    AppInfo {
        version: crate::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        download_dir: settings.download_dir,
        data_dir: settings::data_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command(async)]
pub fn list_tasks(engine: State<'_, Arc<Engine>>) -> Vec<TaskDto> {
    engine.list()
}

/// 宿主进程当前工作集（字节）；拿不到时返回 null，前端显示「—」。
#[tauri::command(async)]
pub fn engine_memory() -> Option<u64> {
    crate::platform::process_memory()
}

/// 把当前配置导出为 JSON 到下载目录；更新令牌属于凭据，导出时清空。
#[tauri::command(async)]
pub fn export_settings(engine: State<'_, Arc<Engine>>) -> Result<String, String> {
    let settings = engine.settings.read().unwrap().clone();
    let dir = PathBuf::from(&settings.download_dir);
    let path = write_settings_export(&settings, &dir)?;
    Ok(path.to_string_lossy().to_string())
}

fn settings_export_body(settings: &Settings) -> Result<String, String> {
    serde_json::to_string_pretty(settings).map_err(|e| e.to_string())
}

fn write_settings_export(settings: &Settings, dir: &Path) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("fetchweir-settings-{stamp}.json");
    let path = if dir.is_dir() {
        dir.join(&name)
    } else {
        settings::ensure_data_dir().join(&name)
    };
    std::fs::write(&path, settings_export_body(settings)?).map_err(|e| e.to_string())?;
    Ok(path)
}

#[tauri::command]
pub fn add_task(
    engine: State<'_, Arc<Engine>>,
    url: String,
    save_dir: Option<String>,
    file_name: Option<String>,
    connections: Option<u32>,
    auto_start: Option<bool>,
) -> Result<TaskDto, String> {
    engine
        .add(
            url,
            save_dir,
            file_name,
            connections,
            auto_start.unwrap_or(true),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pause_task(engine: State<'_, Arc<Engine>>, id: u64) {
    engine.pause(id);
}

#[tauri::command]
pub fn resume_task(engine: State<'_, Arc<Engine>>, id: u64) {
    engine.resume(id);
}

#[tauri::command]
pub fn remove_task(engine: State<'_, Arc<Engine>>, id: u64, delete_file: Option<bool>) -> Result<(), String> {
    engine
        .remove(id, delete_file.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn get_settings(engine: State<'_, Arc<Engine>>) -> Settings {
    engine.settings.read().unwrap().clone()
}

#[tauri::command(async)]
pub fn save_settings(engine: State<'_, Arc<Engine>>, settings: Settings) -> Result<(), String> {
    if !settings.download_dir.trim().is_empty() {
        std::fs::create_dir_all(&settings.download_dir).map_err(|e| e.to_string())?;
    }
    let mut next = settings;
    // 镜像由 set_update_mirror 独占维护，避免普通保存把用户选择重置回默认。
    next.update_mirror = engine.settings.read().unwrap().update_mirror.clone();
    settings::save(&next)?;
    engine.pacer.set_bps(next.global_limit_bps);
    engine.budget.set_enabled(next.auto_concurrency);
    *engine.settings.write().unwrap() = next;
    engine.step_budget();
    Ok(())
}

/// 重置为默认设置（不影响已下载文件与任务列表）。
#[tauri::command(async)]
pub fn reset_settings(engine: State<'_, Arc<Engine>>) -> Result<Settings, String> {
    let next = Settings::default();
    settings::save(&next)?;
    engine.pacer.set_bps(next.global_limit_bps);
    engine.budget.set_enabled(next.auto_concurrency);
    *engine.settings.write().unwrap() = next.clone();
    engine.step_budget();
    Ok(next)
}

#[tauri::command(async)]
pub fn open_data_dir() -> Result<(), String> {
    let dir = settings::ensure_data_dir();
    open_target(&dir, false)
}

/// 浏览器扩展与 Native Messaging 宿主的真实状态（设置页展示与引导用）。
#[derive(serde::Serialize)]
pub struct ExtensionInfo {
    /// 扩展目录是否存在（清单齐全）。
    pub present: bool,
    pub dir: Option<String>,
    /// 宿主清单是否已写进至少一个浏览器的 HKCU 注册表项。
    pub host_registered: bool,
    pub browsers: Vec<String>,
    pub extension_id: String,
}

#[tauri::command(async)]
pub fn extension_info(app: AppHandle) -> ExtensionInfo {
    let dir = crate::platform::extension_dir(&app);
    let browsers: Vec<String> = crate::nm::browser_registration()
        .into_iter()
        .filter(|(_, ok)| *ok)
        .map(|(name, _)| name)
        .collect();
    ExtensionInfo {
        present: dir.is_some(),
        dir: dir.map(|p| p.to_string_lossy().to_string()),
        host_registered: !browsers.is_empty(),
        browsers,
        extension_id: crate::nm::EXTENSION_ID.to_string(),
    }
}

#[tauri::command(async)]
pub fn open_extension_dir(app: AppHandle) -> Result<(), String> {
    let dir = crate::platform::extension_dir(&app).ok_or_else(|| "未找到扩展目录".to_string())?;
    open_target(&dir, false)
}

/// 安装范围、安装目录与数据目录；切换范围只能重装。
#[tauri::command(async)]
pub fn install_info() -> crate::platform::InstallInfo {
    crate::platform::install_info()
}

#[tauri::command(async)]
pub fn elevation_status(engine: State<'_, Arc<Engine>>) -> crate::platform::ElevationStatus {
    crate::platform::elevation_status(&engine.settings.read().unwrap())
}

/// 开启「始终以管理员身份运行」：写入设置并尝试以管理员身份重新拉起。
/// 返回 `relaunching = true` 时前端应予提示，当前进程随后退出。
#[tauri::command(async)]
pub fn set_run_as_admin(engine: State<'_, Arc<Engine>>, enabled: bool) -> Result<bool, String> {
    if !cfg!(windows) {
        return Err("该选项仅在 Windows 生效".to_string());
    }
    {
        let mut guard = engine.settings.write().unwrap();
        guard.run_as_admin = enabled;
        settings::save(&guard)?;
    }
    if !enabled {
        // 关闭：撤掉最高权限自启，避免下次仍以计划任务拉起。
        let _ = crate::platform::apply_autostart(false, true);
        return Ok(false);
    }
    if crate::platform::is_elevated() {
        // 已经是提权状态，直接把自启项升级为最高权限计划任务。
        crate::platform::apply_autostart(true, true)?;
        return Ok(false);
    }
    if crate::platform::request_elevation(Some("--elevated-launch")) {
        return Ok(true);
    }
    Err("未获得管理员权限，已保持普通权限运行".to_string())
}

/// 显式提权重启：只在用户点「以管理员身份重启」时调用。
/// 正常启动路径不调用这里，因此不会出现「每次双击图标都弹 UAC」。
#[tauri::command(async)]
pub fn restart_elevated(app: AppHandle) -> bool {
    if !cfg!(windows) || crate::platform::is_elevated() {
        return false;
    }
    if crate::platform::request_elevation(Some("--elevated-launch")) {
        app.exit(0);
        true
    } else {
        false
    }
}

/// 开机自启动：管理员模式下走计划任务，普通模式写 HKCU Run。
#[tauri::command(async)]
pub fn set_autostart(engine: State<'_, Arc<Engine>>, enabled: bool) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("当前平台的自启动注册未接入，仅 Windows 生效".to_string());
    }
    let admin = engine.settings.read().unwrap().run_as_admin;
    crate::platform::apply_autostart(enabled, admin)?;
    let mut guard = engine.settings.write().unwrap();
    guard.autostart = enabled;
    settings::save(&guard)
}

fn updater(app: &AppHandle) -> Arc<Updater> {
    app.state::<Arc<Updater>>().inner().clone()
}

#[tauri::command(async)]
pub fn update_status(app: AppHandle) -> UpdateDto {
    updater(&app).snapshot()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateDto, String> {
    Ok(updater(&app).check().await)
}

#[tauri::command(async)]
pub fn set_update_mirror(app: AppHandle, mirror: String) -> Result<UpdateDto, String> {
    updater(&app).set_mirror(&mirror)
}

#[tauri::command(async)]
pub fn download_update(app: AppHandle, mode: String) -> Result<UpdateDto, String> {
    updater(&app).start_download(&mode)
}

#[tauri::command]
pub fn cancel_update(app: AppHandle) -> UpdateDto {
    updater(&app).cancel()
}

#[tauri::command(async)]
pub fn install_update(app: AppHandle) -> Result<UpdateDto, String> {
    updater(&app).install()
}

#[tauri::command(async)]
pub fn open_homepage() -> Result<(), String> {
    let url = {
        let s = settings::load();
        if s.homepage.trim().is_empty() {
            "https://github.com/yunyu697/fetchweir".to_string()
        } else {
            s.homepage.trim().to_string()
        }
    };
    open_url(&url)
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/* ---------- 资源嗅探 ---------- */

#[tauri::command(async)]
pub fn list_sniff(store: State<'_, Arc<SniffStore>>) -> Vec<SniffItem> {
    store.list()
}

#[tauri::command]
pub fn clear_sniff(store: State<'_, Arc<SniffStore>>) -> usize {
    store.clear()
}

#[tauri::command]
pub fn remove_sniff(store: State<'_, Arc<SniffStore>>, id: String) -> bool {
    store.remove(&id)
}

#[tauri::command(async)]
pub fn sniff_status() -> NmStatus {
    nm::status()
}

#[tauri::command(async)]
pub fn set_sniff_tier(app: AppHandle, tier: String) -> Result<String, String> {
    if !matches!(tier.as_str(), "A" | "B" | "C") {
        return Err("档位只能是 A / B / C".to_string());
    }
    let mut next = settings::load();
    next.sniff_tier = tier.clone();
    settings::save(&next)?;
    if let Some(engine) = app.try_state::<Arc<Engine>>() {
        *engine.settings.write().unwrap() = next;
    }
    Ok(tier)
}

/// 把嗅探项交给引擎。受保护内容在这里硬拒绝，不依赖前端按钮状态。
#[tauri::command(async)]
pub fn add_sniff_task(
    app: AppHandle,
    store: State<'_, Arc<SniffStore>>,
    id: String,
    save_dir: Option<String>,
) -> Result<TaskDto, String> {
    let item = store.get(&id).ok_or_else(|| "嗅探项不存在或已过期".to_string())?;
    if item.protected || item.drm_suspect {
        return Err(
            item.note
                .clone()
                .unwrap_or_else(|| "检测到受保护内容（DRM/样本级加密），按产品边界不提供下载".to_string()),
        );
    }
    let engine = app.state::<Arc<Engine>>().inner().clone();
    let headers = vec![
        ("referer".to_string(), item.referer.clone()),
        ("cookie".to_string(), item.cookie.clone()),
        ("user-agent".to_string(), item.ua.clone()),
    ];
    engine
        .add_with_headers(item.url, save_dir, None, None, true, headers)
        .map_err(|e| e.to_string())
}

/* ---------- 视频解析 ---------- */

#[tauri::command]
pub async fn probe_video(
    app: AppHandle,
    url: String,
) -> Result<crate::video::VideoInfoDto, String> {
    let host = app.state::<std::sync::Arc<crate::video::VideoHost>>().inner().clone();
    crate::video::probe(&host, &url).await
}

#[tauri::command]
pub fn add_video_task(
    app: AppHandle,
    url: String,
    format_id: String,
    save_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    let host = app.state::<std::sync::Arc<crate::video::VideoHost>>().inner().clone();
    crate::video::download(&app, &host, &url, &format_id, save_dir)
}

#[tauri::command]
pub fn cancel_video(app: AppHandle, job_id: u64) -> bool {
    let host = app.state::<std::sync::Arc<crate::video::VideoHost>>().inner().clone();
    crate::video::cancel(&host, job_id)
}

#[tauri::command(async)]
pub fn video_status() -> serde_json::Value {
    crate::video::status()
}

/// 解析器与合并工具的真实位置；前端设置页据此显示「已随包 / 缺失」，不写死。
#[derive(Serialize)]
pub struct VideoTools {
    pub ytdlp: Option<String>,
    pub ffmpeg: Option<String>,
}

#[tauri::command(async)]
pub fn video_tools() -> VideoTools {
    let path = |p: Option<PathBuf>| p.map(|x| x.to_string_lossy().to_string());
    VideoTools {
        ytdlp: path(crate::video::ytdlp_path()),
        ffmpeg: path(crate::video::ffmpeg_path()),
    }
}

/// 前端启动完成的探针：写标记文件，供无头冒烟测试判断 WebView 已加载且 IPC 可用。
#[tauri::command]
pub fn ui_ready() -> Result<(), String> {
    let marker = settings::ensure_data_dir().join("ui-ready.txt");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::fs::write(marker, format!("{} {stamp}\n", crate::VERSION)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    open_target(&target, false)
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        let parent = target.parent().map(Path::to_path_buf);
        if let Some(parent) = parent.filter(|p| p.exists()) {
            return open_target(&parent, false);
        }
        return Err(format!("路径不存在：{path}"));
    }
    open_target(&target, true)
}

fn open_target(target: &Path, reveal: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        if reveal {
            cmd.arg("/select,").arg(target);
        } else {
            cmd.arg(target);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(target).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    {
        let _ = reveal;
        let path = if target.is_dir() {
            target.to_path_buf()
        } else {
            target.parent().unwrap_or(target).to_path_buf()
        };
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_writes_json_settings() {
        let dir = std::env::temp_dir().join(format!("fw-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut settings = Settings::default();
        settings.download_dir = dir.to_string_lossy().to_string();
        let path = write_settings_export(&settings, &dir).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"downloadDir\""));
        assert!(raw.contains("\"updateRepo\""));
        // 客户端不再保存任何更新访问令牌
        assert!(!raw.contains("updateToken"));
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
