// 安装范围识别、提权状态与自启动注册。
//
// 安装范围在运行期按可执行文件位置推断，安装器不再重复写一份状态：
// Windows  Program Files 下 = 所有用户；%LOCALAPPDATA% 下 = 当前用户；其他位置 = 便携。
// macOS    /Applications = 所有用户；~/Applications = 当前用户；其他 = 便携。
// Linux    /usr、/opt = 系统级；其余（含 AppImage）= 用户级。
//
// 数据目录始终按用户隔离（%LOCALAPPDATA% / ~/.local/share），
// 这样同一台机器的多个用户不会互相覆盖设置与下载记录。
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::settings;

pub const TASK_NAME: &str = "FetchweirElevated";
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Fetchweir";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    /// perUser / perMachine / portable
    pub scope: String,
    pub scope_label: String,
    /// 安装范围切换只能通过重装，界面据此提示。
    pub maintenance: String,
    pub install_dir: String,
    pub data_dir: String,
    pub platform: String,
    pub current_user: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationStatus {
    pub platform: String,
    /// 当前进程是否真的处于提权状态（读进程令牌，不看窗口标题）。
    pub elevated: bool,
    pub elevation_label: String,
    /// 设置里「始终以管理员身份运行」的开关值。
    pub run_as_admin: bool,
    /// 计划任务（最高权限自启）是否已注册。
    pub task_registered: bool,
    /// HKCU Run 项是否已注册。
    pub run_registered: bool,
    pub autostart: bool,
    pub note: String,
}

pub fn exe_path() -> PathBuf {
    std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."))
}

/// 启动子进程时一律不创建控制台窗口。
/// 只重定向 stdio 并不能阻止 conhost 弹窗：GUI 父进程没有控制台，
/// 子进程默认会新开一个控制台窗口（任务栏里看到的就是它）。
/// Windows 上用 CREATE_NO_WINDOW；其它平台原样返回。
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// tokio 版：视频解析与下载都走异步子进程，同样必须隐藏控制台。
pub fn hidden_tokio_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn norm(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

pub fn install_info() -> InstallInfo {
    let exe = exe_path();
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let (scope, scope_label, platform) = if cfg!(windows) {
        let program_files = std::env::var("ProgramFiles").unwrap_or_default();
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
        let local_app = dirs::data_local_dir().unwrap_or_default();
        let p = norm(&dir);
        if (!program_files.is_empty() && p.starts_with(&norm(Path::new(&program_files))))
            || (!program_files_x86.is_empty() && p.starts_with(&norm(Path::new(&program_files_x86))))
        {
            ("perMachine", "所有用户（Program Files）", "windows")
        } else if !local_app.as_os_str().is_empty() && p.starts_with(&norm(&local_app)) {
            ("perUser", "当前用户（用户目录）", "windows")
        } else {
            ("portable", "便携运行（未安装）", "windows")
        }
    } else if cfg!(target_os = "macos") {
        let p = norm(&dir);
        let home_apps = dirs::home_dir().unwrap_or_default().join("Applications");
        if p.starts_with("/applications") {
            ("perMachine", "所有用户（/Applications）", "macos")
        } else if p.starts_with(&norm(&home_apps)) {
            ("perUser", "当前用户（~/Applications）", "macos")
        } else {
            ("portable", "便携运行（未安装）", "macos")
        }
    } else {
        let p = norm(&dir);
        if p.starts_with("/usr/") || p.starts_with("/opt/") || p == "/usr" {
            ("perMachine", "系统级（/usr 或 /opt）", "linux")
        } else {
            ("perUser", "用户级（AppImage 或本地目录）", "linux")
        }
    };

    InstallInfo {
        scope: scope.to_string(),
        scope_label: scope_label.to_string(),
        maintenance: "切换安装范围需要卸载后重装；设置、下载记录与已完成文件保留在用户目录。"
            .to_string(),
        install_dir: dir.to_string_lossy().to_string(),
        data_dir: settings::data_dir().to_string_lossy().to_string(),
        platform: platform.to_string(),
        current_user: whoami(),
    }
}

fn whoami() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 当前进程工作集（字节）。用于主界面「引擎内存」统计卡，取自 PSAPI，非估算。
/// 用 K32 前缀：Windows 的 psapi.dll 本身只导出 K32GetProcessMemoryInfo，
/// 直接链 psapi!GetProcessMemoryInfo 会在加载时 STATUS_ENTRYPOINT_NOT_FOUND。
#[cfg(windows)]
pub fn process_memory() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb);
        if ok == 0 {
            return None;
        }
        Some(counters.WorkingSetSize as u64)
    }
}

#[cfg(not(windows))]
pub fn process_memory() -> Option<u64> {
    None
}

#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: *mut core::ffi::c_void = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    // Windows 之外没有 UAC 概念；Linux 以 root 运行时 uid 为 0。
    #[cfg(target_os = "linux")]
    {
        return unsafe { libc_geteuid() == 0 };
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

/// 以管理员身份重新拉起自身；返回 true 表示新进程已启动（当前进程应立即退出）。
#[cfg(windows)]
pub fn request_elevation(extra_arg: Option<&str>) -> bool {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe = exe_path();
    let exe_w: Vec<u16> = exe.to_string_lossy().encode_utf16().chain([0]).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain([0]).collect();
    let args = extra_arg.unwrap_or("");
    let args_w: Vec<u16> = args.encode_utf16().chain([0]).collect();
    let ret = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            exe_w.as_ptr(),
            args_w.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // 用户在 UAC 对话框点“否”时返回 <= 0，此时保持普通权限继续运行。
    ret as isize > 0
}

#[cfg(not(windows))]
pub fn request_elevation(_extra_arg: Option<&str>) -> bool {
    false
}

pub fn task_registered() -> bool {
    #[cfg(windows)]
    {
        return hidden_command("schtasks")
            .args(["/Query", "/TN", TASK_NAME])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

pub fn run_registered() -> bool {
    #[cfg(windows)]
    {
        // 值名不是子键：必须 query 键本身再 /v 指定值名，否则永远查不到。
        return hidden_command("reg")
            .args(["query", RUN_KEY, "/v", RUN_VALUE])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

/// 自启动注册状态查询要拉起 schtasks/reg 子进程，频繁调用会拖慢设置页。
/// 结果缓存 15 秒：切换自启动后会主动失效。
static AUTOSTART_CACHE: std::sync::Mutex<Option<(std::time::Instant, bool, bool)>> =
    std::sync::Mutex::new(None);

pub fn autostart_registered() -> (bool, bool) {
    if let Ok(guard) = AUTOSTART_CACHE.lock() {
        if let Some((at, task, run)) = *guard {
            if at.elapsed() < std::time::Duration::from_secs(15) {
                return (task, run);
            }
        }
    }
    let task = task_registered();
    let run = run_registered();
    if let Ok(mut guard) = AUTOSTART_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), task, run));
    }
    (task, run)
}

pub fn invalidate_autostart_cache() {
    if let Ok(mut guard) = AUTOSTART_CACHE.lock() {
        *guard = None;
    }
}

/// 写 / 删自启动。管理员模式走计划任务（最高权限），普通模式走 HKCU Run。
pub fn apply_autostart(enabled: bool, admin: bool) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("当前平台的自启动注册未接入，仅 Windows 生效".to_string());
    }
    #[cfg(windows)]
    {
        let exe = exe_path();
        let exe_s = exe.to_string_lossy().to_string();
        if enabled {
            if admin {
                if !is_elevated() {
                    return Err("注册最高权限计划任务需要管理员权限".to_string());
                }
                let tr = format!("\"{exe_s}\"");
                let out = hidden_command("schtasks")
                    .args([
                        "/Create", "/F", "/SC", "ONLOGON", "/RL", "HIGHEST", "/TN", TASK_NAME,
                        "/TR", &tr,
                    ])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!(
                        "schtasks 创建失败：{}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
                // 提权自启不能同时留 Run 项，否则会出现一个普通权限实例抢先启动。
                let _ = hidden_command("reg")
                    .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
                    .output();
            } else {
                let out = hidden_command("reg")
                    .args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &exe_s, "/f"])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!(
                        "reg add 失败：{}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
        } else {
            if task_registered() {
                if !is_elevated() {
                    return Err("移除最高权限计划任务需要管理员权限".to_string());
                }
                let out = hidden_command("schtasks")
                    .args(["/Delete", "/F", "/TN", TASK_NAME])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!(
                        "schtasks 删除失败：{}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
            let _ = hidden_command("reg")
                .args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
                .output();
        }
        invalidate_autostart_cache();
    }
    Ok(())
}

pub fn elevation_status(settings: &settings::Settings) -> ElevationStatus {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let elevated = is_elevated();
    let note = if cfg!(windows) {
        if elevated {
            "当前进程已提权。提权窗口受 UIPI 限制：从资源管理器拖入文件/链接会被系统拦截，请改用「粘贴链接」或浏览器扩展。"
        } else if settings.run_as_admin {
            "已开启但当前进程未提权：下次启动会请求管理员权限；在 UAC 中拒绝则退回普通权限。"
        } else {
            "当前为普通权限，拖放、扩展通信与自启动均按当前用户身份运行。"
        }
    } else {
        "当前平台不使用 UAC；该开关仅在 Windows 生效。"
    };
    ElevationStatus {
        platform: platform.to_string(),
        elevated,
        elevation_label: if elevated { "已提权（管理员）" } else { "普通权限" }.to_string(),
        run_as_admin: settings.run_as_admin,
        task_registered: autostart_registered().0,
        run_registered: autostart_registered().1,
        autostart: settings.autostart,
        note: note.to_string(),
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn process_memory_reports_working_set() {
        let bytes = super::process_memory().expect("PSAPI 应能读到当前进程工作集");
        assert!(bytes > 0, "工作集应大于 0，实际 {bytes}");
    }
}
