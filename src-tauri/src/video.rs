// 视频解析：yt-dlp sidecar 取格式全集；直连格式走自家引擎，清单类格式委派子进程。
// 受 DRM 保护的格式整行禁选，后端硬拒绝，不依赖前端按钮状态。
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const PROBE_TIMEOUT_SECS: u64 = 60;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDto {
    pub format_id: String,
    pub ext: String,
    pub width: u64,
    pub height: u64,
    pub fps: f64,
    pub vcodec: String,
    pub acodec: String,
    pub size: u64,
    pub tbr: f64,
    pub protocol: String,
    pub url: String,
    pub drm: bool,
    pub drm_reason: Option<String>,
    pub needs_mux: bool,
    pub recommended: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfoDto {
    pub title: String,
    pub duration: f64,
    pub uploader: String,
    pub thumbnail: String,
    pub webpage_url: String,
    pub message: Option<String>,
    pub drm_only: bool,
    pub formats: Vec<FormatDto>,
    /// Cookie 来源不可用时的回退说明（例如 cookies.txt 被删）；来源正常时为 None。
    pub cookie_warning: Option<String>,
}

/// 解析失败的凭据类错误前缀；前端据此展示操作引导，`\n` 之后仍是原始错误。
pub const AUTH_ERROR_PREFIX: &str = "FW_AUTH::";

/// 识别站点要求登录/人机校验的 stderr 特征。
/// 返回 bot / login / forbidden 三类，便于界面给出对应文案。
pub fn auth_issue(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_ascii_lowercase();
    let has = |needle: &str| s.contains(needle);
    if has("sign in to confirm") && has("not a bot") {
        return Some("bot");
    }
    if has("confirm your age") || has("age-restricted") || has("inappropriate for some users") {
        return Some("login");
    }
    if has("http error 403") || has("403 forbidden") || has("response status 403") {
        return Some("forbidden");
    }
    if has("login required") || has("sign in to continue") || has("please log in") || has("requires authentication") {
        return Some("login");
    }
    None
}

pub struct VideoHost {
    cache: Mutex<HashMap<String, VideoInfoDto>>,
    jobs: Mutex<HashMap<u64, Arc<tokio::sync::Mutex<tokio::process::Child>>>>,
    next_job: Mutex<u64>,
}

impl VideoHost {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cache: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            next_job: Mutex::new(1),
        })
    }
}

/// 解析器路径：优先环境变量，其次与主程序同目录（安装后的 sidecar 位置）。
pub fn ytdlp_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FETCHWEIR_YTDLP") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let name = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let local = dir.join(name);
    if local.exists() {
        return Some(local);
    }
    // 开发态：仓库内 binaries 目录
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(if cfg!(windows) {
            "yt-dlp-x86_64-pc-windows-msvc.exe"
        } else {
            "yt-dlp"
        });
    dev.exists().then_some(dev)
}

fn fnum(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn sval(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn uval(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn is_http(u: &str) -> bool {
    u.starts_with("https://") || u.starts_with("http://")
}

fn has_video(f: &FormatDto) -> bool {
    !matches!(f.vcodec.as_str(), "" | "none")
}

fn has_audio(f: &FormatDto) -> bool {
    !matches!(f.acodec.as_str(), "" | "none")
}

/// 只有「纯视频」才需要把另一条音轨合并进来；纯音频格式本身就是完整文件。
fn mux_needed(vcodec: &str, acodec: &str) -> bool {
    let video = !matches!(vcodec, "" | "none");
    let audio = !matches!(acodec, "" | "none");
    video && !audio
}

/// 完整文件（音视频已在同一个文件里）。
/// 有些站点只给画面尺寸、不标注编码（archive.org 的直链 mp4/ogv），这类按整文件处理。
fn complete_file(f: &FormatDto) -> bool {
    if f.vcodec.is_empty() && f.acodec.is_empty() {
        return f.height > 0;
    }
    has_video(f) && has_audio(f)
}

/// ffmpeg 位置：优先环境变量，其次主程序目录（安装后 sidecar 位置），
/// 再找开发态 binaries，最后查 PATH。
pub fn ffmpeg_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FETCHWEIR_FFMPEG") {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let local = dir.join(name);
            if local.exists() {
                return Some(local);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(if cfg!(windows) {
            "ffmpeg-x86_64-pc-windows-msvc.exe"
        } else {
            "ffmpeg"
        });
    if dev.exists() {
        return Some(dev);
    }
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|d| d.join(name))
        .find(|p| p.exists())
}

pub async fn probe(host: &Arc<VideoHost>, url: &str, settings: &crate::settings::Settings) -> Result<VideoInfoDto, String> {
    if let Some(cached) = host.cache.lock().unwrap().get(url) {
        return Ok(cached.clone());
    }
    let exe = ytdlp_path().ok_or_else(|| "未找到视频解析器（yt-dlp sidecar）".to_string())?;
    let cookies = crate::cookies::build(settings);
    let mut cmd = crate::platform::hidden_tokio_command(&exe);
    cmd.args(["-J", "--no-playlist", "--no-warnings", "--skip-download"])
        .args(&cookies.args)
        .arg(url)
        .stdin(Stdio::null());
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(PROBE_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| "解析超时（60 秒）".to_string())?
    .map_err(|e| format!("启动解析器失败：{e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("解析失败");
        let brief: String = line.chars().take(200).collect();
        if err.to_ascii_lowercase().contains("drm protected") {
            return Err("该视频受 DRM 保护，按产品边界不提供解析与下载".to_string());
        }
        if let Some(kind) = auth_issue(&err) {
            // 原始 stderr 附在前缀之后，界面的「查看原始错误」直接展示这段。
            let raw: String = err.trim().chars().take(1200).collect();
            return Err(format!("{AUTH_ERROR_PREFIX}{kind}\n{raw}"));
        }
        return Err(format!("解析器返回失败：{brief}"));
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(&raw).map_err(|e| format!("解析器输出不是合法 JSON：{e}"))?;

    let entry = match v.get("entries").and_then(|e| e.as_array()) {
        Some(list) if !list.is_empty() => list[0].clone(),
        _ => v.clone(),
    };
    let title = sval(&entry, "title");
    let webpage_url = sval(&entry, "webpage_url");
    let duration = fnum(&entry, "duration");
    let uploader = entry
        .get("uploader")
        .or_else(|| entry.get("channel"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let thumbnail = sval(&entry, "thumbnail");

    let mut formats: Vec<FormatDto> = Vec::new();
    if let Some(list) = entry.get("formats").and_then(|f| f.as_array()) {
        for f in list {
            let format_id = sval(f, "format_id");
            if format_id.is_empty() {
                continue;
            }
            let drm = f.get("has_drm").and_then(|x| x.as_bool()).unwrap_or(false)
                || sval(f, "protocol").to_ascii_lowercase().contains("drm");
            let vcodec = sval(f, "vcodec");
            let acodec = sval(f, "acodec");
            let size = uval(f, "filesize")
                .max(uval(f, "filesize_approx"));
            let mut dto = FormatDto {
                format_id,
                ext: sval(f, "ext"),
                width: uval(f, "width"),
                height: uval(f, "height"),
                fps: fnum(f, "fps"),
                vcodec,
                acodec,
                size,
                tbr: fnum(f, "tbr"),
                protocol: sval(f, "protocol"),
                url: sval(f, "url"),
                drm,
                drm_reason: if drm {
                    Some("解析器标记 has_drm，判定为受保护内容".to_string())
                } else {
                    None
                },
                needs_mux: false,
                recommended: false,
            };
            // 纯视频流需要配一条音轨合并；纯音频流本身完整，可直接下载。
            dto.needs_mux = mux_needed(&dto.vcodec, &dto.acodec);
            formats.push(dto);
        }
    }

    let drm_only = !formats.is_empty() && formats.iter().all(|f| f.drm);
    // 推荐：优先 1080p 以内、音视频合一的 mp4；否则取体积最大的合一格式。
    let pick = formats
        .iter()
        .filter(|f| !f.drm && !f.needs_mux && complete_file(f))
        .max_by(|a, b| {
            let score = |f: &FormatDto| {
                let mp4 = if f.ext == "mp4" { 1 } else { 0 };
                let cap = if f.height > 0 && f.height <= 1080 { 1 } else { 0 };
                (mp4, cap, f.height.min(1080), f.size)
            };
            score(a).cmp(&score(b))
        })
        .map(|f| f.format_id.clone());
    if let Some(id) = pick {
        if let Some(f) = formats.iter_mut().find(|x| x.format_id == id) {
            f.recommended = true;
        }
    }

    let dto = VideoInfoDto {
        title,
        duration,
        uploader,
        thumbnail,
        webpage_url: if webpage_url.is_empty() { url.to_string() } else { webpage_url },
        message: if drm_only {
            Some("该页面全部可用格式均受 DRM/访问控制保护，按产品边界不提供下载".to_string())
        } else {
            None
        },
        drm_only,
        formats,
        cookie_warning: cookies.warning.clone(),
    };
    // 带警告的结果不写缓存：用户修好 cookies.txt 后重新解析应立即按新来源执行。
    if cookies.warning.is_none() {
        host.cache.lock().unwrap().insert(url.to_string(), dto.clone());
    }
    Ok(dto)
}

/// 下载：能在自家引擎里直连的格式走引擎；需要子进程的走 yt-dlp 并回报进度。
pub fn download(
    app: &AppHandle,
    host: &Arc<VideoHost>,
    url: &str,
    format_id: &str,
    save_dir: Option<String>,
) -> Result<Value, String> {
    let info = host
        .cache
        .lock()
        .unwrap()
        .get(url)
        .cloned()
        .ok_or_else(|| "请先解析该页面，再选择格式".to_string())?;
    let fmt = info
        .formats
        .iter()
        .find(|f| f.format_id == format_id)
        .ok_or_else(|| format!("格式 {format_id} 不在解析结果里"))?;
    if fmt.drm {
        return Err(fmt
            .drm_reason
            .clone()
            .unwrap_or_else(|| "受保护内容，按产品边界不提供下载".to_string()));
    }
    if info.drm_only {
        return Err("该页面全部格式受保护，按产品边界不提供下载".to_string());
    }
    // 保存目录可能来自 TEMP 等环境变量，本身是 8.3 短路径；统一还原成长路径。
    let save_dir = save_dir.map(normalize_dir);
    if fmt.needs_mux {
        // 纯视频流：交给解析器取该视频 + 最佳音轨，由 ffmpeg 合并。
        let ff = ffmpeg_path().ok_or_else(|| {
            "该格式只含视频流，需要 ffmpeg 合并音轨；未找到 ffmpeg（应随安装包提供，或用 FETCHWEIR_FFMPEG 指定）"
                .to_string()
        })?;
        let spec = format!("{format_id}+bestaudio/best");
        return delegate(app, host, url, format_id, save_dir, Some(spec), Some(ff));
    }
    // 纯音频格式（如 B 站的 m4a 音轨）必须由解析器处理：它的直链带签名与请求头。
    let audio_only = !has_video(fmt) && has_audio(fmt);
    // 只有真正的直链文件才交给自家引擎；m3u8_native / http_dash 必须由解析器处理。
    let direct =
        !audio_only && matches!(fmt.protocol.as_str(), "http" | "https" | "ftp") && is_http(&fmt.url);
    if direct {
        let engine = app.state::<Arc<crate::engine::Engine>>().inner().clone();
        let task = engine
            .add_with_headers(fmt.url.clone(), save_dir.clone(), None, None, true, Vec::new())
            .map_err(|e| e.to_string())?;
        return Ok(json!({"mode": "direct", "task": task}));
    }
    delegate(app, host, url, format_id, save_dir, None, None)
}

fn delegate(
    app: &AppHandle,
    host: &Arc<VideoHost>,
    url: &str,
    format_id: &str,
    save_dir: Option<String>,
    spec: Option<String>,
    ffmpeg: Option<PathBuf>,
) -> Result<Value, String> {
    let exe = ytdlp_path().ok_or_else(|| "未找到视频解析器（yt-dlp sidecar）".to_string())?;
    let settings = app
        .state::<Arc<crate::engine::Engine>>()
        .inner()
        .settings
        .read()
        .unwrap()
        .clone();
    let cookies = crate::cookies::build(&settings);
    let dir = save_dir
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::settings::system_download_dir().to_string_lossy().to_string());
    let dir = normalize_dir(dir);
    let job_id = {
        let mut n = host.next_job.lock().unwrap();
        let id = *n;
        *n += 1;
        id
    };

    let mut cmd = crate::platform::hidden_tokio_command(&exe);
    cmd.arg("-f")
        .arg(spec.unwrap_or_else(|| format_id.to_string()))
        .arg("--no-playlist")
        .arg("--newline")
        .arg("--no-warnings")
        // Cookie 来源不可用时这里为空，本次按「不使用」下载，并在返回里带警告。
        .args(&cookies.args)
        // Windows 控制台默认用本地代码页输出；标题含中文时路径会变成乱码字节，
        // 读日志按 UTF-8 解码就会整行失败。强制 UTF-8 后路径才能被正确取回。
        .arg("--encoding")
        .arg("utf-8")
        .arg("--print")
        .arg("after_move:FETCHWEIR:%(filepath)s")
        .arg("-P")
        .arg(&dir)
        .arg("-o")
        .arg("%(title)s.%(ext)s");
    if let Some(ff) = ffmpeg.as_ref().and_then(|p| p.parent()) {
        cmd.arg("--ffmpeg-location").arg(ff);
    }
    let mut child = cmd
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动解析器失败：{e}"))?;

    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let handle = Arc::new(tokio::sync::Mutex::new(child));
    host.jobs.lock().unwrap().insert(job_id, handle.clone());
    let app2 = app.clone();
    let host2 = host.clone();

    tauri::async_runtime::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        // 按字节读行再按 UTF-8 有损解码：解析器偶尔仍会吐出非 UTF-8 字节，
        // 不能因为一行编码坏掉就中断整个进度监听（早前会丢掉成品路径）。
        let mut out = BufReader::new(stdout);
        let mut err = BufReader::new(stderr);
        let mut out_line: Vec<u8> = Vec::new();
        let mut err_line: Vec<u8> = Vec::new();
        let mut path: Option<String> = None;
        let mut last_err = String::new();
        let mut last = json!({"jobId": job_id, "stage": "starting", "percent": 0.0});

        let emit = |app: &AppHandle, payload: Value| {
            let _ = app.emit("fw://video", payload);
        };

        loop {
            tokio::select! {
                n = out.read_until(b'\n', &mut out_line) => {
                    if n.unwrap_or(0) == 0 { break; }
                    let text = String::from_utf8_lossy(&out_line);
                    let t = text.trim();
                    if let Some(printed) = t.strip_prefix("FETCHWEIR:") {
                        path = Some(output_path(printed, &dir));
                    } else if let Some(p) = parse_progress(t) {
                        last = json!({
                            "jobId": job_id,
                            "stage": "running",
                            "percent": p.percent,
                            "speed": p.speed,
                            "eta": p.eta,
                            "message": t.chars().take(160).collect::<String>(),
                        });
                        emit(&app2, last.clone());
                    }
                    out_line.clear();
                },
                n = err.read_until(b'\n', &mut err_line) => {
                    if n.unwrap_or(0) == 0 { break; }
                    let text = String::from_utf8_lossy(&err_line);
                    let t: String = text.trim().chars().take(200).collect();
                    err_line.clear();
                    if !t.trim().is_empty() {
                        last_err = t.clone();
                        emit(&app2, json!({"jobId": job_id, "stage": "running", "percent": last.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0), "message": t}));
                    }
                }
            }
        }

        let mut guard = handle.lock().await;
        let status = guard.wait().await;
        drop(guard);
        host2.jobs.lock().unwrap().remove(&job_id);
        let ok = status.map(|s| s.success()).unwrap_or(false);
        let message = if ok {
            "已完成".to_string()
        } else if auth_issue(&last_err).is_some() {
            "站点要求登录验证：请在设置 → 视频与格式里选择 Cookie 来源".to_string()
        } else {
            "解析器退出异常，请查看日志".to_string()
        };
        emit(&app2, json!({
            "jobId": job_id,
            "stage": if ok { "done" } else { "failed" },
            "percent": if ok { 100.0 } else { last.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0) },
            "path": path,
            "message": message,
        }));
    });

    Ok(json!({"mode": "delegate", "jobId": job_id, "cookieWarning": cookies.warning}))
}

struct Progress {
    percent: f64,
    speed: String,
    eta: String,
}

/// `--print after_move:` 打出的实际落盘路径：相对文件名按保存目录拼接，
/// 含非 ASCII 文件名时 Windows 上可能是 8.3 短路径，统一还原成存在的长路径。
fn output_path(printed: &str, dir: &str) -> String {
    let p = PathBuf::from(printed);
    let abs = if p.is_absolute() {
        p
    } else {
        PathBuf::from(dir).join(p)
    };
    let real = std::fs::canonicalize(&abs).unwrap_or(abs);
    strip_verbatim(real.to_string_lossy().into_owned())
}

/// 保存目录若是 8.3 短路径，还原成长路径；还原失败时原样返回。
fn normalize_dir(dir: String) -> String {
    match std::fs::canonicalize(&dir) {
        Ok(p) => strip_verbatim(p.to_string_lossy().into_owned()),
        Err(_) => dir,
    }
}

/// `canonicalize` 在 Windows 上返回 `\\?\C:\...` 形式，去掉前缀才是用户能看懂的路径。
fn strip_verbatim(s: String) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s
}

/// 解析 `[download]  12.3% of ~ 1.20GiB at 5.34MiB/s ETA 00:34`
fn parse_progress(line: &str) -> Option<Progress> {
    if !line.starts_with("[download]") || line.contains("Destination") {
        return None;
    }
    let pct_at = line.find('%')?;
    let start = line[10..pct_at]
        .rfind(|c: char| c == ' ' || c == ']')
        .map(|i| i + 10 + 1)
        .unwrap_or(10);
    let percent = line[start..pct_at].trim().parse::<f64>().ok()?;
    let rest = &line[pct_at + 1..];
    let speed = rest
        .find(" at ")
        .map(|i| rest[i + 4..].split(" ETA").next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    let eta = rest
        .find("ETA ")
        .map(|i| rest[i + 4..].trim().to_string())
        .unwrap_or_default();
    Some(Progress { percent, speed, eta })
}

pub fn cancel(host: &Arc<VideoHost>, job_id: u64) -> bool {
    let handle = host.jobs.lock().unwrap().remove(&job_id);
    if let Some(h) = handle {
        tauri::async_runtime::spawn(async move {
            let mut child = h.lock().await;
            let _ = child.start_kill();
        });
        true
    } else {
        false
    }
}

/// 解析器版本探测要拉起 yt-dlp 子进程（冷启动 1-8 秒），
/// 每次打开视频页都跑一次会直接卡住界面，因此按可执行文件路径缓存。
pub fn status() -> Value {
    static CACHE: std::sync::Mutex<Option<(PathBuf, Value)>> = std::sync::Mutex::new(None);
    let path = ytdlp_path();
    if let Ok(guard) = CACHE.lock() {
        if let Some((cached_path, value)) = guard.as_ref() {
            if Some(cached_path) == path.as_ref() {
                return value.clone();
            }
        }
    }
    let version = path.as_ref().and_then(|p| {
        crate::platform::hidden_command(p)
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    let value = json!({
        "present": path.is_some(),
        "path": path.as_ref().map(|p| p.to_string_lossy().to_string()),
        "version": version,
    });
    if let (Some(p), Ok(mut guard)) = (path, CACHE.lock()) {
        *guard = Some((p, value.clone()));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{auth_issue, mux_needed, output_path, parse_progress, strip_verbatim};

    #[test]
    fn output_path_joins_relative_and_strips_verbatim() {
        assert_eq!(strip_verbatim(r"\\?\C:\a\b.mp4".into()), r"C:\a\b.mp4");
        assert_eq!(strip_verbatim(r"\\?\UNC\srv\share\b.mp4".into()), r"\\srv\share\b.mp4");
        assert_eq!(strip_verbatim("/tmp/a.m4a".into()), "/tmp/a.m4a");
        // 文件不存在时 canonicalize 失败，退回拼接结果，不丢路径
        let got = output_path("no-such-file.m4a", "/tmp/fw-test");
        assert!(got.replace('\\', "/").ends_with("fw-test/no-such-file.m4a"), "{got}");
    }

    #[test]
    fn mux_only_for_video_only_streams() {
        assert!(mux_needed("avc1.640028", "none"), "纯视频流需要配音轨");
        assert!(!mux_needed("avc1.640028", "mp4a.40.2"), "已含音轨不合并");
        assert!(!mux_needed("none", "mp4a.40.2"), "纯音频本身完整");
        assert!(!mux_needed("", ""), "解析器没给编码信息时不臆测");
    }

    #[test]
    fn parse_download_line() {
        let p = parse_progress("[download]  12.3% of ~ 1.20GiB at 5.34MiB/s ETA 00:34").unwrap();
        assert!((p.percent - 12.3).abs() < 0.01);
        assert_eq!(p.speed, "5.34MiB/s");
        assert_eq!(p.eta, "00:34");
    }

    #[test]
    fn ignore_destination_line() {
        assert!(parse_progress("[download] Destination: out.mp4").is_none());
    }

    #[test]
    fn classify_bot_check_and_status_codes() {
        let bot = "ERROR: [youtube] -yqNI2GfXMQ: Sign in to confirm you're not a bot. This helps protect our community.\nUse --cookies-from-browser or --cookies";
        assert_eq!(auth_issue(bot), Some("bot"));
        assert_eq!(auth_issue("ERROR: [youtube] x: HTTP Error 403: Forbidden"), Some("forbidden"));
        assert_eq!(auth_issue("ERROR: This video is age-restricted"), Some("login"));
        assert_eq!(auth_issue("ERROR: Login required"), Some("login"));
        assert_eq!(auth_issue("ERROR: unable to download video data: timeout"), None);
    }
}
