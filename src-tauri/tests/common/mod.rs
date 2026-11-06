// 核心链路测试场景：供 tests/engine_core.rs 与 examples/engine_smoke.rs 共用。
// 说明：Windows GNU 工具链下测试二进制可能因 comctl32 v6 清单缺失而无法加载，
// 所以同样场景也做成 example，便于本地用 `cargo run --example engine_smoke` 验证。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use fetchweir_lib::engine::{Engine, ProgressItem, TaskDto, TaskEvents, TaskState};
use fetchweir_lib::settings::Settings;

pub struct SilentEvents;

impl TaskEvents for SilentEvents {
    fn task(&self, _dto: &TaskDto) {}
    fn progress(&self, _items: &[ProgressItem]) {}
    fn removed(&self, _id: u64) {}
}

pub type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

fn make_payload(size: usize) -> Arc<Vec<u8>> {
    let mut v = Vec::with_capacity(size);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    for _ in 0..size {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        v.push((x >> 24) as u8);
    }
    Arc::new(v)
}

/// 支持 Range 的极简 HTTP/1.1 服务端，按 256KB 分块慢速发送，便于测试暂停。
fn spawn_server(payload: Arc<Vec<u8>>, chunk_delay: Duration) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定测试端口");
    let addr = listener.local_addr().unwrap();
    let conns = Arc::new(AtomicUsize::new(0));
    let counter = conns.clone();

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let payload = payload.clone();
            let delay = chunk_delay;
            counter.fetch_add(1, Ordering::Relaxed);
            thread::spawn(move || {
                let _ = handle_conn(&mut stream, &payload, delay);
            });
        }
    });

    (format!("http://{addr}/file.bin"), conns)
}

fn handle_conn(
    stream: &mut std::net::TcpStream,
    payload: &[u8],
    delay: Duration,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return Ok(());
        }
    }

    let head = String::from_utf8_lossy(&buf);
    let mut start = 0usize;
    let mut end = payload.len() - 1;
    let mut ranged = false;
    for line in head.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("range: bytes=") {
            ranged = true;
            let spec = rest.split('-').collect::<Vec<_>>();
            start = spec[0].trim().parse().unwrap_or(0);
            if spec.len() > 1 && !spec[1].trim().is_empty() {
                end = spec[1].trim().parse().unwrap_or(end);
            }
            end = end.min(payload.len() - 1);
        }
    }
    if start > end || start >= payload.len() {
        let _ = write!(
            stream,
            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        return Ok(());
    }

    let body = &payload[start..=end];
    if ranged {
        write!(
            stream,
            "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            body.len(),
            start,
            end,
            payload.len()
        )?;
    } else {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            body.len()
        )?;
    }

    for chunk in body.chunks(256 * 1024) {
        stream.write_all(chunk)?;
        stream.flush()?;
        if !delay.is_zero() {
            thread::sleep(delay);
        }
    }
    Ok(())
}

fn temp_dir(tag: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "fetchweir-test-{tag}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("创建测试目录");
    dir
}

fn engine_for(dir: &PathBuf) -> Arc<Engine> {
    let settings = Settings {
        download_dir: dir.to_string_lossy().to_string(),
        connections: 8,
        global_limit_bps: 0,
        theme: "dark".into(),
    };
    Engine::with_events(Arc::new(SilentEvents), settings)
}

fn wait_state(engine: &Arc<Engine>, id: u64, want: TaskState, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(t) = engine.list().into_iter().find(|t| t.id == id) {
            if t.state == want {
                return true;
            }
            if t.state == TaskState::Failed {
                panic!("任务失败: {:?}", t.error);
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

pub fn segmented_download_matches_source_bytes() -> TestResult<()> {
    let size = 6 * 1024 * 1024;
    let payload = make_payload(size);
    let (url, _conns) = spawn_server(payload.clone(), Duration::ZERO);
    let dir = temp_dir("full");
    let engine = engine_for(&dir);

    let dto = engine.add(url, None, Some("source.bin".into()), Some(8), true)?;
    assert!(wait_state(
        &engine,
        dto.id,
        TaskState::Completed,
        Duration::from_secs(30)
    ));

    let file = dir.join("source.bin");
    let bytes = std::fs::read(&file)?;
    assert_eq!(bytes.len(), size);
    assert_eq!(bytes.as_slice(), payload.as_slice(), "分段下载结果与源文件字节不一致");

    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

pub fn pause_then_resume_keeps_progress() -> TestResult<()> {
    let size = 8 * 1024 * 1024;
    let payload = make_payload(size);
    let (url, _conns) = spawn_server(payload.clone(), Duration::from_millis(8));
    let dir = temp_dir("resume");
    let engine = engine_for(&dir);

    let dto = engine.add(url, None, Some("resume.bin".into()), Some(4), true)?;

    // 等下载到一定进度再暂停
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(20) {
            panic!("下载未在预期时间内产生进度");
        }
        let t = engine.list().into_iter().find(|t| t.id == dto.id).unwrap();
        if t.done_bytes > 256 * 1024 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    engine.pause(dto.id);
    assert!(
        wait_state(&engine, dto.id, TaskState::Paused, Duration::from_secs(5)),
        "暂停后状态未切换"
    );
    let paused = engine.list().into_iter().find(|t| t.id == dto.id).unwrap();
    assert!(paused.done_bytes > 0, "暂停时已下载字节丢失");

    engine.resume(dto.id);
    assert!(
        wait_state(&engine, dto.id, TaskState::Completed, Duration::from_secs(40)),
        "续传未完成"
    );

    let bytes = std::fs::read(dir.join("resume.bin"))?;
    assert_eq!(bytes.as_slice(), payload.as_slice(), "续传后的文件与源文件不一致");

    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

pub fn rejects_non_http_scheme() -> TestResult<()> {
    let dir = temp_dir("scheme");
    let engine = engine_for(&dir);
    let err = engine
        .add("file:///etc/passwd".into(), None, None, None, false)
        .unwrap_err();
    assert!(err.to_string().contains("仅支持 http/https"));
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}
