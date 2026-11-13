// 视频解析凭据：把设置里的 Cookie 来源翻译成 yt-dlp 参数。
//
// 边界：
// - 只读取浏览器 Cookie 库或用户指定的 cookies.txt，凭据内容不写设置、日志、应用数据目录；
// - 来源不可用时回退为「不使用」，同时给出一条可展示的警告；
// - 不在这里发起网络请求，也不复制、解析或持久化 Cookie 内容。
use std::path::Path;

use crate::settings::Settings;

/// 合法的来源取值；与前端下拉框一一对应。
pub const SOURCES: [&str; 3] = ["none", "browser", "file"];
/// `--cookies-from-browser` 支持的浏览器。
pub const BROWSERS: [&str; 5] = ["chrome", "edge", "firefox", "brave", "vivaldi"];

#[derive(Debug)]
pub struct CookieArgs {
    pub args: Vec<String>,
    /// 来源不可用时的回退说明；None 表示按当前来源正常传参。
    pub warning: Option<String>,
}

pub fn normalize_source(value: &str) -> String {
    let v = value.trim().to_ascii_lowercase();
    if SOURCES.contains(&v.as_str()) {
        v
    } else {
        "none".to_string()
    }
}

pub fn normalize_browser(value: &str) -> String {
    let v = value.trim().to_ascii_lowercase();
    if BROWSERS.contains(&v.as_str()) {
        v
    } else {
        "chrome".to_string()
    }
}

/// 只做可读性探测：打开即关闭，不读取内容。
fn probe_file(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("尚未选择 cookies.txt 文件".to_string());
    }
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("cookies.txt 不存在：{path}"));
    }
    if !p.is_file() {
        return Err(format!("所选路径不是文件：{path}"));
    }
    std::fs::File::open(p)
        .map(|_| ())
        .map_err(|e| format!("cookies.txt 无法读取：{path}（{e}）"))
}

fn browser_spec(settings: &Settings) -> String {
    let browser = normalize_browser(&settings.cookie_browser);
    let profile = settings.cookie_profile.trim();
    if profile.is_empty() {
        browser
    } else {
        // yt-dlp 用第一个冒号分隔浏览器与 profile，Windows 路径里的盘符冒号不受影响。
        format!("{browser}:{profile}")
    }
}

pub fn build(settings: &Settings) -> CookieArgs {
    let mut out = CookieArgs {
        args: Vec::new(),
        warning: None,
    };
    match normalize_source(&settings.cookie_source).as_str() {
        "browser" => {
            out.args.push("--cookies-from-browser".to_string());
            out.args.push(browser_spec(settings));
        }
        "file" => {
            let path = settings.cookie_file.trim();
            match probe_file(path) {
                Ok(()) => {
                    out.args.push("--cookies".to_string());
                    out.args.push(path.to_string());
                }
                Err(msg) => {
                    out.warning = Some(format!("{msg}；本次已回退为不使用 Cookie"));
                }
            }
        }
        _ => {}
    }
    out
}

/// 设置页状态：usable 表示当前来源能否原样传给解析器。
pub fn status(settings: &Settings) -> (bool, String) {
    match normalize_source(&settings.cookie_source).as_str() {
        "browser" => (
            true,
            format!(
                "解析时直接读取 {} 的 Cookie 库，不复制到应用目录。",
                browser_spec(settings)
            ),
        ),
        "file" => match probe_file(settings.cookie_file.trim()) {
            Ok(()) => (true, format!("可读取：{}", settings.cookie_file.trim())),
            Err(msg) => (
                false,
                format!("{msg}；解析会回退为不使用 Cookie"),
            ),
        },
        _ => (
            true,
            "不使用 Cookie（默认）。遇到站点要求登录验证时会给出可操作提示。".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_source(source: &str) -> Settings {
        let mut s = Settings::default();
        s.cookie_source = source.to_string();
        s
    }

    #[test]
    fn default_is_none_without_args() {
        let c = build(&Settings::default());
        assert!(c.args.is_empty());
        assert!(c.warning.is_none());
    }

    #[test]
    fn invalid_source_falls_back_to_none() {
        let c = build(&with_source("unknown"));
        assert!(c.args.is_empty());
    }

    #[test]
    fn browser_without_profile() {
        let mut s = with_source("browser");
        s.cookie_browser = "firefox".to_string();
        let c = build(&s);
        assert_eq!(c.args, vec!["--cookies-from-browser", "firefox"]);
        assert!(c.warning.is_none());
    }

    #[test]
    fn browser_with_profile_and_invalid_browser() {
        let mut s = with_source("browser");
        s.cookie_browser = "netscape".to_string();
        s.cookie_profile = "Profile 2".to_string();
        let c = build(&s);
        assert_eq!(c.args, vec!["--cookies-from-browser", "chrome:Profile 2"]);
    }

    #[test]
    fn missing_file_warns_and_falls_back() {
        let mut s = with_source("file");
        s.cookie_file = std::env::temp_dir()
            .join("fw-cookie-not-exist-12345.txt")
            .to_string_lossy()
            .to_string();
        let c = build(&s);
        assert!(c.args.is_empty());
        let warning = c.warning.expect("missing file should warn");
        assert!(warning.contains("不存在"));
        assert!(warning.contains("回退"));
        assert!(!status(&s).0);
    }

    #[test]
    fn existing_file_is_passed_untouched() {
        let path = std::env::temp_dir().join("fw-cookie-test-ok.txt");
        std::fs::write(&path, "# Netscape HTTP Cookie File\n").unwrap();
        let mut s = with_source("file");
        s.cookie_file = path.to_string_lossy().to_string();
        let c = build(&s);
        assert_eq!(c.args.len(), 2);
        assert_eq!(c.args[0], "--cookies");
        assert_eq!(c.args[1], s.cookie_file);
        assert!(c.warning.is_none());
        assert!(status(&s).0);
        let _ = std::fs::remove_file(&path);
    }
}
