// Fetchweir 主进程：装配引擎、命令与窗口。
mod commands;
pub mod engine;
pub mod settings;

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
        ])
        .run(tauri::generate_context!())
        .expect("Fetchweir 启动失败");
}
