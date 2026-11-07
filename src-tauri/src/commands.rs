// 前端可调用的命令层。
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::engine::{Engine, TaskDto};
use crate::settings::{self, Settings};
use crate::update::{UpdateDto, Updater};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub download_dir: String,
    pub data_dir: String,
}

#[tauri::command]
pub fn app_info(engine: State<'_, Arc<Engine>>) -> AppInfo {
    let settings = engine.settings.read().unwrap().clone();
    AppInfo {
        version: crate::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        download_dir: settings.download_dir,
        data_dir: settings::data_dir().to_string_lossy().to_string(),
    }
}

#[tauri::command]
pub fn list_tasks(engine: State<'_, Arc<Engine>>) -> Vec<TaskDto> {
    engine.list()
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

#[tauri::command]
pub fn get_settings(engine: State<'_, Arc<Engine>>) -> Settings {
    engine.settings.read().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(engine: State<'_, Arc<Engine>>, settings: Settings) -> Result<(), String> {
    if !settings.download_dir.trim().is_empty() {
        std::fs::create_dir_all(&settings.download_dir).map_err(|e| e.to_string())?;
    }
    let mut next = settings;
    // 镜像由 set_update_mirror 独占维护，避免普通保存把用户选择重置回默认。
    next.update_mirror = engine.settings.read().unwrap().update_mirror.clone();
    settings::save(&next)?;
    engine.pacer.set_bps(next.global_limit_bps);
    *engine.settings.write().unwrap() = next;
    Ok(())
}

fn updater(app: &AppHandle) -> Arc<Updater> {
    app.state::<Arc<Updater>>().inner().clone()
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateDto {
    updater(&app).snapshot()
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateDto, String> {
    Ok(updater(&app).check().await)
}

#[tauri::command]
pub fn set_update_mirror(app: AppHandle, mirror: String) -> Result<UpdateDto, String> {
    updater(&app).set_mirror(&mirror)
}

#[tauri::command]
pub fn download_update(app: AppHandle, mode: String) -> Result<UpdateDto, String> {
    updater(&app).start_download(&mode)
}

#[tauri::command]
pub fn cancel_update(app: AppHandle) -> UpdateDto {
    updater(&app).cancel()
}

#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<UpdateDto, String> {
    updater(&app).install()
}

#[tauri::command]
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
