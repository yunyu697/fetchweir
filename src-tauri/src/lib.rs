// Fetchweir 主进程：装配引擎、命令与窗口。
mod commands;
pub mod engine;
pub mod settings;
pub mod update;

use tauri::Manager;

/// 版本号唯一来源：version.json（build.rs 注入），这里只读不写。
pub const VERSION: &str = env!("FETCHWEIR_VERSION");

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let settings = settings::load();
            let handle = app.handle().clone();
            let engine = engine::Engine::new(handle, settings);
            engine.spawn_ticker();
            app.manage(engine);
            app.manage(update::Updater::new(app.handle().clone()));

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
        ])
        .run(tauri::generate_context!())
        .expect("Fetchweir 启动失败");
}
