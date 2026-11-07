// Fetchweir 主进程：装配引擎、命令与窗口。
mod commands;
pub mod engine;
pub mod nm;
pub mod settings;
pub mod sniff;
pub mod update;

use tauri::Manager;

/// 版本号唯一来源：version.json（build.rs 注入），这里只读不写。
pub const VERSION: &str = env!("FETCHWEIR_VERSION");

pub fn run() {
    // Native Messaging 宿主模式：浏览器按 stdio 帧直接驱动本二进制。
    if std::env::args().any(|a| a == "--nm-host") {
        nm::run_host();
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
            nm::start_ipc(app.handle().clone(), store);
            // 幂等注册宿主清单：升级后路径变化也能被浏览器找到。
            let _ = nm::register_hosts();

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

            // 默认显示窗口；冒烟测试用 FW_SMOKE=1 保持隐藏，避免占用前台。
            if std::env::var("FW_SMOKE").is_err() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
            Ok(())
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
        ])
        .run(tauri::generate_context!())
        .expect("Fetchweir 启动失败");
}
