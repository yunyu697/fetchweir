// Native Messaging 宿主与本地回环桥接。
// 链路：扩展 --(stdio, NM 帧)--> 本程序 --(127.0.0.1:临时端口 + 令牌)--> 主进程。
// 宿主与主进程是同一可执行文件，以 `--nm-host` 启动即进入宿主模式。
use std::io::{BufRead, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings;
use crate::sniff::{SniffItem, SniffStore};

pub const HOST_NAME: &str = "dev.fetchweir.nmh";
/// 扩展公钥固定在 manifest 的 key 字段，扩展 ID 因此可预测，宿主清单才能静态授权。
pub const EXTENSION_ID: &str = "fjngndhalbkfkfcfhleflcgkicknkele";
pub const FIREFOX_EXTENSION_ID: &str = "fetchweir@yunyu697";

#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
    pid: u32,
    version: String,
}

fn endpoint_path() -> PathBuf {
    settings::ensure_data_dir().join("nm-endpoint.json")
}

fn inbox_path() -> PathBuf {
    settings::ensure_data_dir().join("nm-inbox.jsonl")
}

fn token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}

/* ============ 主进程侧：回环监听 ============ */

pub fn start_ipc(app: AppHandle, store: Arc<SniffStore>) {
    let _ = std::fs::remove_file(endpoint_path());
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(_) => return,
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(_) => return,
        };
        let token = token();
        let endpoint = Endpoint {
            port,
            token: token.clone(),
            pid: std::process::id(),
            version: crate::VERSION.to_string(),
        };
        if let Ok(raw) = serde_json::to_string(&endpoint) {
            let _ = std::fs::write(endpoint_path(), raw);
        }

        drain_inbox(&app, &store);
        // 定时清理过期嗅探项，并补收宿主排队的消息。
        {
            let app = app.clone();
            let store = store.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let hours = settings::load().sniff_ttl_hours;
                    if hours > 0 {
                        store.prune(hours as i64 * 60 * 60 * 1000);
                    }
                    drain_inbox(&app, &store);
                }
            });
        }

        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            let store = store.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(stream, &token, app, store).await;
            });
        }
    });
}

async fn serve(
    stream: tokio::net::TcpStream,
    token: &str,
    app: AppHandle,
    store: Arc<SniffStore>,
) -> std::io::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (rd, mut wr) = tokio::io::split(stream);
    let mut lines = BufReader::new(rd).lines();
    let first = match lines.next_line().await? {
        Some(l) => l,
        None => return Ok(()),
    };
    if first.trim() != format!("AUTH {token}") {
        let _ = wr.write_all(b"{\"ok\":false,\"error\":\"unauthorized\"}\n").await;
        return Ok(());
    }
    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle_message(&app, &store, msg).await,
            Err(e) => json!({"ok": false, "error": format!("JSON 解析失败: {e}")}),
        };
        let _ = wr.write_all(format!("{}\n", reply).as_bytes()).await;
    }
    Ok(())
}

async fn handle_message(app: &AppHandle, store: &Arc<SniffStore>, msg: Value) -> Value {
    let kind = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "sniff" => {
            let raw = msg.get("item").cloned().unwrap_or(Value::Null);
            let Ok(mut item) = serde_json::from_value::<SniffItem>(raw) else {
                return json!({"ok": false, "error": "sniff item 字段不合法"});
            };
            item.normalize(crate::sniff::now());
            let id = item.id.clone();
            let is_manifest = matches!(item.kind.as_str(), "hls" | "dash");
            let push = store.push(item);
            let total = store.list().len();
            if let Some(item) = push {
                let _ = app.emit("fw://sniff", json!({"item": item, "total": total}));
                if is_manifest {
                    let app2 = app.clone();
                    let store2 = store.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(item) = store2.get(&id) {
                            let client = reqwest::Client::new();
                            if let crate::sniff::Protection::Protected(note) =
                                crate::sniff::inspect_manifest(&client, &item).await
                            {
                                store2.mark_protected(&id, note.clone());
                                if let Some(fresh) = store2.get(&id) {
                                    let _ = app2.emit(
                                        "fw://sniff",
                                        json!({"item": fresh, "total": store2.list().len(), "protected": true}),
                                    );
                                }
                            }
                        }
                    });
                }
            }
            json!({"ok": true, "total": total})
        }
        "capture" | "add" => {
            let raw = msg.get("item").cloned().unwrap_or(Value::Null);
            let Ok(item) = serde_json::from_value::<SniffItem>(raw) else {
                return json!({"ok": false, "error": "任务字段不合法"});
            };
            add_from_browser(app, store, item)
        }
        "activate" => {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
                json!({"ok": true})
            } else {
                json!({"ok": false, "error": "窗口尚未就绪"})
            }
        }
        "hello" | "ping" => {
            let tier = settings::load().sniff_tier;
            json!({"ok": true, "version": crate::VERSION, "tier": tier, "total": store.list().len()})
        }
        _ => json!({"ok": false, "error": "未知消息类型"}),
    }
}

fn add_from_browser(app: &AppHandle, store: &Arc<SniffStore>, mut item: SniffItem) -> Value {
    item.normalize(crate::sniff::now());
    if let Some(prev) = store.get(&item.id) {
        if prev.protected {
            return json!({"ok": false, "error": "该资源判定为受保护内容，按产品边界不提供下载"});
        }
        if !prev.url.is_empty() {
            item.url = prev.url.clone();
        }
    }
    let engine = app.state::<Arc<crate::engine::Engine>>().inner().clone();
    let headers = vec![
        ("referer".to_string(), item.referer.clone()),
        ("cookie".to_string(), item.cookie.clone()),
        ("user-agent".to_string(), item.ua.clone()),
    ];
    match engine.add_with_headers(
        item.url.clone(),
        None,
        None,
        None,
        true,
        headers,
    ) {
        Ok(dto) => json!({"ok": true, "task": dto}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

fn drain_inbox(app: &AppHandle, store: &Arc<SniffStore>) {
    let path = inbox_path();
    let Ok(raw) = std::fs::read_to_string(&path) else { return };
    let mut touched = false;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(msg) = serde_json::from_str::<Value>(line) {
            let app = app.clone();
            let store = store.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_message(&app, &store, msg).await;
            });
            touched = true;
        }
    }
    if touched {
        let _ = std::fs::remove_file(path);
    }
}

/* ============ 宿主侧：stdio NM 帧 ============ */

pub fn run_host() -> ! {
    loop {
        let mut len = [0u8; 4];
        if std::io::stdin().read_exact(&mut len).is_err() {
            std::process::exit(0);
        }
        let size = u32::from_le_bytes(len) as usize;
        if size == 0 || size > 4 * 1024 * 1024 {
            std::process::exit(0);
        }
        let mut buf = vec![0u8; size];
        if std::io::stdin().read_exact(&mut buf).is_err() {
            std::process::exit(0);
        }
        let msg: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(e) => {
                write_frame(&json!({"ok": false, "error": format!("请求不是合法 JSON: {e}")}));
                continue;
            }
        };
        let wants_launch = msg.get("type").and_then(|v| v.as_str()) == Some("activate");
        let reply = match forward(&msg) {
            Ok(v) => v,
            Err(_) if wants_launch => {
                launch_app();
                match wait_endpoint(Duration::from_secs(6)) {
                    Some(ep) => forward_with(&ep, &msg).unwrap_or_else(|_| queued()),
                    None => queued(),
                }
            }
            Err(_) => queued(),
        };
        let tier = settings::load().sniff_tier;
        let mut payload = reply;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("tier".to_string(), json!(tier));
        }
        write_frame(&payload);
    }
}

fn queued() -> Value {
    json!({"ok": true, "queued": true, "note": "桌面端未运行，消息已排队"})
}

fn forward(msg: &Value) -> std::io::Result<Value> {
    let ep = read_endpoint().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no endpoint"))?;
    forward_with(&ep, msg)
}

fn forward_with(ep: &Endpoint, msg: &Value) -> std::io::Result<Value> {
    let addr = ("127.0.0.1", ep.port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no addr"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(1200))?;
    stream.set_read_timeout(Some(Duration::from_millis(1200)))?;
    stream.set_write_timeout(Some(Duration::from_millis(1200)))?;
    writeln!(stream, "AUTH {}", ep.token)?;
    writeln!(stream, "{}", serde_json::to_string(msg)?)?;
    let mut reader = std::io::BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(serde_json::from_str::<Value>(line.trim()).unwrap_or(json!({"ok": true})))
}

fn read_endpoint() -> Option<Endpoint> {
    let raw = std::fs::read_to_string(endpoint_path()).ok()?;
    serde_json::from_str::<Endpoint>(&raw).ok()
}

fn wait_endpoint(timeout: Duration) -> Option<Endpoint> {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        let ep = read_endpoint();
        if ep.is_some() && forward(&json!({"type": "ping"})).is_ok() {
            return ep;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    None
}

fn launch_app() {
    let Ok(exe) = std::env::current_exe() else { return };
    let _ = std::process::Command::new(exe).spawn();
}

fn write_frame(value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut out = std::io::stdout();
    let _ = out.write_all(&(bytes.len() as u32).to_le_bytes());
    let _ = out.write_all(&bytes);
    let _ = out.flush();
}

/* ============ 宿主清单注册 ============ */

/// 幂等注册：每次启动都重写一遍清单与注册表项，保证升级后路径仍然正确。
pub fn register_hosts() -> Vec<String> {
    let mut log: Vec<String> = Vec::new();
    let Ok(exe) = std::env::current_exe() else {
        return vec!["无法获取可执行文件路径".to_string()];
    };
    let dir = settings::ensure_data_dir().join("nm");
    let _ = std::fs::create_dir_all(&dir);

    let chromium = json!({
        "name": HOST_NAME,
        "description": "Fetchweir 浏览器接管宿主",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let firefox = json!({
        "name": HOST_NAME,
        "description": "Fetchweir 浏览器接管宿主",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_extensions": [FIREFOX_EXTENSION_ID],
    });

    let chromium_file = dir.join(format!("{HOST_NAME}.json"));
    let firefox_file = dir.join(format!("{HOST_NAME}.firefox.json"));
    if let Ok(raw) = serde_json::to_string_pretty(&chromium) {
        if std::fs::write(&chromium_file, raw).is_ok() {
            log.push(format!("manifest {}", chromium_file.display()));
        }
    }
    if let Ok(raw) = serde_json::to_string_pretty(&firefox) {
        if std::fs::write(&firefox_file, raw).is_ok() {
            log.push(format!("manifest {}", firefox_file.display()));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let chromium_keys = [
            r"Software\Google\Chrome\NativeMessagingHosts",
            r"Software\Chromium\NativeMessagingHosts",
            r"Software\Microsoft\Edge\NativeMessagingHosts",
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
            r"Software\Vivaldi\NativeMessagingHosts",
        ];
        for key in chromium_keys {
            let full = format!("{key}\\{HOST_NAME}");
            match std::process::Command::new("reg")
                .args([
                    "add",
                    &full,
                    "/ve",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &chromium_file.to_string_lossy(),
                    "/f",
                ])
                .output()
            {
                Ok(o) if o.status.success() => log.push(format!("registry {full}")),
                Ok(o) => log.push(format!(
                    "registry {full} 失败：{}",
                    String::from_utf8_lossy(&o.stderr).trim()
                )),
                Err(e) => log.push(format!("registry {full} 失败：{e}")),
            }
        }
        let ff = format!(r"Software\Mozilla\NativeMessagingHosts\{HOST_NAME}");
        match std::process::Command::new("reg")
            .args([
                "add",
                &ff,
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                &firefox_file.to_string_lossy(),
                "/f",
            ])
            .output()
        {
            Ok(o) if o.status.success() => log.push(format!("registry {ff}")),
            Ok(o) => log.push(format!(
                "registry {ff} 失败：{}",
                String::from_utf8_lossy(&o.stderr).trim()
            )),
            Err(e) => log.push(format!("registry {ff} 失败：{e}")),
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let bases = [
                "Library/Application Support/Google/Chrome/NativeMessagingHosts",
                "Library/Application Support/Chromium/NativeMessagingHosts",
                "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
                "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                "Library/Application Support/Vivaldi/NativeMessagingHosts",
            ];
            for base in bases {
                log.push(link_manifest(&home.join(base), &chromium_file));
            }
            log.push(link_manifest(&home.join(".mozilla/native-messaging-hosts"), &firefox_file));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(home) = dirs::home_dir() {
            let bases = [
                ".config/google-chrome/NativeMessagingHosts",
                ".config/chromium/NativeMessagingHosts",
                ".config/microsoft-edge/NativeMessagingHosts",
                ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                ".config/vivaldi/NativeMessagingHosts",
            ];
            for base in bases {
                log.push(link_manifest(&home.join(base), &chromium_file));
            }
            log.push(link_manifest(&home.join(".mozilla/native-messaging-hosts"), &firefox_file));
        }
    }

    let report = log.join("\n");
    let _ = std::fs::write(settings::ensure_data_dir().join("nm-register.log"), &report);
    log
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn link_manifest(dir: &Path, source: &Path) -> String {
    let _ = std::fs::create_dir_all(dir);
    let dest = dir.join(source.file_name().unwrap_or_default());
    match std::fs::copy(source, &dest) {
        Ok(_) => format!("manifest {}", dest.display()),
        Err(e) => format!("manifest {} 失败：{e}", dest.display()),
    }
}

/// 供前端展示：注册结果与当前桥接端口。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NmStatus {
    pub host_name: String,
    pub extension_id: String,
    pub endpoint_port: u16,
    pub registered: Vec<String>,
    pub tier: String,
}

pub fn status() -> NmStatus {
    let ep = read_endpoint();
    NmStatus {
        host_name: HOST_NAME.to_string(),
        extension_id: EXTENSION_ID.to_string(),
        endpoint_port: ep.as_ref().map(|e| e.port).unwrap_or(0),
        registered: std::fs::read_to_string(settings::ensure_data_dir().join("nm-register.log"))
            .map(|s| s.lines().map(|l| l.to_string()).collect())
            .unwrap_or_default(),
        tier: settings::load().sniff_tier,
    }
}
