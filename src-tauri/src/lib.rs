// Fetchweir 主进程：装配引擎、命令与窗口。
mod commands;
pub mod engine;
pub mod nm;
pub mod platform;
pub mod settings;
pub mod sniff;
pub mod update;
pub mod video;

use tauri::Manager;

/// 版本号唯一来源：version.json（build.rs 注入），这里只读不写。
pub const VERSION: &str = env!("FETCHWEIR_VERSION");

/* ---------- 托盘 ---------- */

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "检查更新", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Fetchweir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &check, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Fetchweir 下载管理器");
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "check" => {
                show_main(app);
                if let Some(updater) = app.try_state::<std::sync::Arc<update::Updater>>() {
                    let updater = updater.inner().clone();
                    tauri::async_runtime::spawn(async move { updater.check().await });
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    // Native Messaging 宿主模式：浏览器按 stdio 帧直接驱动本二进制。
    // Chromium 启动宿主时只会把扩展的 origin 作为首个参数传进来（没有自定义参数位），
    // 所以除了手动调试用的 --nm-host，还要认 chrome-extension:// / moz-extension:// 形式。
    let host_mode = std::env::args().skip(1).any(|a| {
        a == "--nm-host" || a.starts_with("chrome-extension://") || a.starts_with("moz-extension://")
    });
    if host_mode {
        nm::run_host();
    }

    // 设置里开启「始终以管理员身份运行」后，每次启动都请求 UAC。
    // 用户在 UAC 里拒绝时 ShellExecute 返回失败，这里保持普通权限继续运行。
    // 冒烟/无头测试用 FW_NO_ELEVATE=1 关闭，避免弹出权限对话框。
    if cfg!(windows) && std::env::var("FW_NO_ELEVATE").is_err() {
        let saved = settings::load();
        if saved.run_as_admin && !platform::is_elevated() {
            if platform::request_elevation(Some("--elevated-launch")) {
                std::process::exit(0);
            }
        }
    }

    tauri::Builder::default()
        .setup(|app| {
            let settings = settings::load();
            let handle = app.handle().clone();
            let engine = engine::Engine::new(handle, settings);
            engine.spawn_ticker();
            app.manage(engine);
            app.manage(update::Updater::new(app.handle().clone()));

            let store = sniff::SniffStore::new();
            app.manage(store.clone());
            app.manage(video::VideoHost::new());
            nm::start_ipc(app.handle().clone(), store);
            // 幂等注册宿主清单：升级后路径变化也能被浏览器找到。
            let _ = nm::register_hosts();

            // 提权实例启动时把自启项对齐成最高权限计划任务（幂等）。
            let boot = settings::load();
            if cfg!(windows) && boot.run_as_admin && boot.autostart {
                let _ = platform::apply_autostart(true, true);
            }
            if std::env::var("FW_PLATFORM_PROBE").is_ok() {
                let body = serde_json::json!({
                    "install": platform::install_info(),
                    "elevation": platform::elevation_status(&boot),
                    "autostart": boot.autostart,
                });
                let path = settings::ensure_data_dir().join("platform-probe.json");
                let _ = std::fs::write(
                    path,
                    serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".to_string()),
                );
            }

            // 诊断钩子：FW_AUTOSTART_PROBE=1/0 时按指定值写或删自启动项，
            // 供无界面环境核对 HKCU Run / 计划任务的真实注册结果。
            if let Ok(want) = std::env::var("FW_AUTOSTART_PROBE") {
                let enabled = want.trim() == "1";
                let admin = settings::load().run_as_admin;
                let result = platform::apply_autostart(enabled, admin);
                let body = serde_json::json!({
                    "requested": enabled,
                    "admin": admin,
                    "ok": result.is_ok(),
                    "error": result.err(),
                    "taskRegistered": platform::task_registered(),
                    "runRegistered": platform::run_registered(),
                });
                let _ = std::fs::write(
                    settings::ensure_data_dir().join("autostart-probe.json"),
                    serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".to_string()),
                );
            }

            // 诊断钩子：FW_UPDATE_PROBE=1 时后台跑一次检查并把结果写进数据目录，
            // 供无界面环境（CI / 冒烟）验证更新链路。
            if std::env::var("FW_UPDATE_PROBE").is_ok() {
                let updater = app
                    .state::<std::sync::Arc<update::Updater>>()
                    .inner()
                    .clone();
                let fetch = std::env::var("FW_UPDATE_FETCH").is_ok();
                tauri::async_runtime::spawn(async move {
                    let dto = updater.check().await;
                    let path = settings::ensure_data_dir().join("update-probe.json");
                    let body = serde_json::to_string_pretty(&dto)
                        .unwrap_or_else(|_| "{}".to_string());
                    let _ = std::fs::write(path, body);

                    if fetch {
                        let _ = updater.start_download("only");
                        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
                        loop {
                            let snap = updater.snapshot();
                            if matches!(snap.stage.as_str(), "downloaded" | "failed") {
                                let body = serde_json::to_string_pretty(&snap)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let _ =
                                    std::fs::write(settings::ensure_data_dir().join("update-fetch.json"), body);
                                break;
                            }
                            if std::time::Instant::now() > deadline {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                    }
                });
            }

            // 诊断钩子：FW_VIDEO_PROBE=<url> 时后台解析一次并写入数据目录，
            // 供无浏览器环境验证 yt-dlp 接线与 DRM 拒绝。
            if let Ok(url) = std::env::var("FW_VIDEO_PROBE") {
                let host = app.state::<std::sync::Arc<video::VideoHost>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let body = match video::probe(&host, &url).await {
                        Ok(info) => serde_json::to_value(&info).unwrap_or_default(),
                        Err(e) => serde_json::json!({ "error": e }),
                    };
                    let _ = std::fs::write(
                        settings::ensure_data_dir().join("video-probe.json"),
                        serde_json::to_string_pretty(&body).unwrap_or_default(),
                    );
                });
            }

            // 诊断钩子：FW_SNIFF_PROBE=1 时把嗅探列表周期性写入数据目录，
            // 供无浏览器环境验证 扩展 → 宿主 → 主进程 全链路。
            if std::env::var("FW_SNIFF_PROBE").is_ok() {
                let store = app
                    .state::<std::sync::Arc<sniff::SniffStore>>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        let body = serde_json::to_string_pretty(&store.list())
                            .unwrap_or_else(|_| "[]".to_string());
                        let _ = std::fs::write(
                            settings::ensure_data_dir().join("sniff-probe.json"),
                            body,
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                    }
                });
            }

            // 托盘：显示主窗口 / 检查更新 / 退出。窗口关闭时按设置驻留后台。
            setup_tray(app)?;

            // 默认显示窗口；冒烟测试用 FW_SMOKE=1 保持隐藏，避免占用前台。
            if std::env::var("FW_SMOKE").is_err() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if settings::load().close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_tasks,
            commands::add_task,
            commands::pause_task,
            commands::resume_task,
            commands::remove_task,
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::open_data_dir,
            commands::install_info,
            commands::elevation_status,
            commands::set_run_as_admin,
            commands::set_autostart,
            commands::open_path,
            commands::reveal_path,
            commands::ui_ready,
            commands::update_status,
            commands::check_update,
            commands::set_update_mirror,
            commands::download_update,
            commands::cancel_update,
            commands::install_update,
            commands::open_homepage,
            commands::list_sniff,
            commands::clear_sniff,
            commands::remove_sniff,
            commands::add_sniff_task,
            commands::sniff_status,
            commands::set_sniff_tier,
            commands::probe_video,
            commands::add_video_task,
            commands::cancel_video,
            commands::video_status,
        ])
        .run(tauri::generate_context!())
        .expect("Fetchweir 启动失败");
}
