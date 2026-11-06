// 阻止 Windows 上弹出控制台窗口（release 构建）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fetchweir_lib::run();
}
