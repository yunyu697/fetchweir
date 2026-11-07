// 下载引擎：任务模型、调度与事件。
pub mod http;
pub mod pacer;
pub mod speed;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::settings::Settings;

use self::pacer::Pacer;
use self::speed::SpeedMeter;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Queued,
    Active,
    Paused,
    Completed,
    Failed,
}

impl TaskState {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskState::Queued => "queued",
            TaskState::Active => "active",
            TaskState::Paused => "paused",
            TaskState::Completed => "completed",
            TaskState::Failed => "failed",
        }
    }
}

/// 送给前端的任务快照（完整字段，用于新增/状态变更）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: u64,
    pub url: String,
    pub file_name: String,
    pub save_path: String,
    pub total_bytes: u64,
    pub done_bytes: u64,
    pub speed_bps: u64,
    pub state: TaskState,
    pub error: Option<String>,
    pub created_at: i64,
    pub supports_ranges: bool,
    pub connections: u32,
}

/// 高频进度事件里的精简字段。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    pub id: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub state: TaskState,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("仅支持 http/https 链接")]
    UnsupportedScheme,
    #[error("链接不合法：{0}")]
    InvalidUrl(String),
    #[error("网络错误：{0}")]
    Http(String),
    #[error("服务端不支持分段下载（Range）")]
    RangeUnsupported,
    #[error("磁盘错误：{0}")]
    Io(String),
    #[error("任务已结束")]
    Aborted,
}

impl From<reqwest::Error> for EngineError {
    fn from(e: reqwest::Error) -> Self {
        EngineError::Http(e.to_string())
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        EngineError::Io(e.to_string())
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StopKind {
    None,
    Pause,
    Remove,
}

/// 一个分段独占 [start, end)，done 为已落盘字节数（可用于续传）。
#[derive(Clone, Copy, Debug)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub done: u64,
}

pub struct Task {
    pub id: u64,
    pub url: String,
    pub save_dir: PathBuf,
    pub file_name: Mutex<String>,
    /// 用户显式指定了文件名：探测阶段不得用 URL / Content-Disposition 推断的名字覆盖它。
    pub user_named: bool,
    pub connections: u32,
    /// 浏览器接管带来的额外请求头（Referer / Cookie / UA）。仅内存保存，不落盘。
    pub headers: Vec<(String, String)>,
    pub total: AtomicU64,
    pub done: AtomicU64,
    pub state: Mutex<TaskState>,
    pub error: Mutex<Option<String>>,
    pub supports_ranges: AtomicBool,
    pub created_at: i64,
    pub speed: SpeedMeter,
    pub cancel: Mutex<Option<CancellationToken>>,
    /// 运行代次：每启动一次 +1，用于让上一轮任务彻底退出后再动手。
    pub run_id: AtomicU64,
    pub stop: Mutex<StopKind>,
    pub segments: Mutex<Vec<Segment>>,
    pub part_path: Mutex<Option<PathBuf>>,
    pub final_path: Mutex<Option<PathBuf>>,
}

impl Task {
    fn new(
        id: u64,
        url: String,
        save_dir: PathBuf,
        file_name: String,
        user_named: bool,
        connections: u32,
        headers: Vec<(String, String)>,
    ) -> Self {
        Self {
            id,
            url,
            save_dir,
            file_name: Mutex::new(file_name),
            user_named,
            connections: connections.clamp(1, 16),
            headers,
            total: AtomicU64::new(0),
            done: AtomicU64::new(0),
            state: Mutex::new(TaskState::Queued),
            error: Mutex::new(None),
            supports_ranges: AtomicBool::new(false),
            created_at: now_ms(),
            speed: SpeedMeter::new(),
            cancel: Mutex::new(None),
            run_id: AtomicU64::new(0),
            stop: Mutex::new(StopKind::None),
            segments: Mutex::new(Vec::new()),
            part_path: Mutex::new(None),
            final_path: Mutex::new(None),
        }
    }

    pub fn set_state(&self, next: TaskState) {
        *self.state.lock().unwrap() = next;
    }

    pub fn state(&self) -> TaskState {
        *self.state.lock().unwrap()
    }

    pub fn file_name(&self) -> String {
        self.file_name.lock().unwrap().clone()
    }

    pub fn part_path(&self) -> Option<PathBuf> {
        self.part_path.lock().unwrap().clone()
    }

    pub fn final_path(&self) -> Option<PathBuf> {
        self.final_path.lock().unwrap().clone()
    }

    fn set_error(&self, msg: Option<String>) {
        *self.error.lock().unwrap() = msg;
    }

    pub fn snapshot(&self) -> TaskDto {
        TaskDto {
            id: self.id,
            url: self.url.clone(),
            file_name: self.file_name(),
            save_path: self
                .final_path()
                .unwrap_or_else(|| {
                    self.part_path()
                        .unwrap_or_else(|| self.save_dir.join(self.file_name()))
                })
                .to_string_lossy()
                .to_string(),
            total_bytes: self.total.load(Ordering::Relaxed),
            done_bytes: self.done.load(Ordering::Relaxed),
            speed_bps: self.speed.bps(),
            state: self.state(),
            error: self.error.lock().unwrap().clone(),
            created_at: self.created_at,
            supports_ranges: self.supports_ranges.load(Ordering::Relaxed),
            connections: self.connections,
        }
    }
}

/// 事件出口抽象：生产环境走 Tauri 事件，测试用内存收集器，隔离 GUI 依赖。
pub trait TaskEvents: Send + Sync {
    fn task(&self, dto: &TaskDto);
    fn progress(&self, items: &[ProgressItem]);
    fn removed(&self, id: u64);
}

pub struct TauriEvents {
    app: AppHandle,
}

impl TaskEvents for TauriEvents {
    fn task(&self, dto: &TaskDto) {
        let _ = self.app.emit("fw://task", dto.clone());
    }
    fn progress(&self, items: &[ProgressItem]) {
        let _ = self
            .app
            .emit("fw://progress", serde_json::json!({ "items": items }));
    }
    fn removed(&self, id: u64) {
        let _ = self.app.emit("fw://removed", serde_json::json!({ "id": id }));
    }
}

pub struct Engine {
    events: Arc<dyn TaskEvents>,
    pub client: reqwest::Client,
    tasks: Mutex<Vec<Arc<Task>>>,
    next_id: AtomicU64,
    pub settings: RwLock<Settings>,
    pub pacer: Pacer,
}

impl Engine {
    pub fn new(app: AppHandle, settings: Settings) -> Arc<Self> {
        let events: Arc<dyn TaskEvents> = Arc::new(TauriEvents { app });
        Self::with_events(events, settings)
    }

    pub fn with_events(events: Arc<dyn TaskEvents>, settings: Settings) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(settings.connect_timeout_sec.clamp(3, 120) as u64))
            .read_timeout(Duration::from_secs(settings.read_timeout_sec.clamp(5, 300) as u64))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent(format!(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Fetchweir/{}",
                crate::VERSION
            ))
            .build()
            .expect("构建 HTTP 客户端失败");

        Arc::new(Self {
            events,
            client,
            tasks: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            pacer: Pacer::new(settings.global_limit_bps),
            settings: RwLock::new(settings),
        })
    }

    pub fn list(&self) -> Vec<TaskDto> {
        let tasks = self.tasks.lock().unwrap();
        tasks.iter().map(|t| t.snapshot()).collect()
    }

    pub fn find(&self, id: u64) -> Option<Arc<Task>> {
        self.tasks.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    pub fn add(
        self: &Arc<Self>,
        url: String,
        save_dir: Option<String>,
        file_name: Option<String>,
        connections: Option<u32>,
        auto_start: bool,
    ) -> Result<TaskDto, EngineError> {
        self.add_with_headers(url, save_dir, file_name, connections, auto_start, Vec::new())
    }

    /// 带浏览器上下文的入队：Referer / Cookie 等只在内存里用于本次请求。
    pub fn add_with_headers(
        self: &Arc<Self>,
        url: String,
        save_dir: Option<String>,
        file_name: Option<String>,
        connections: Option<u32>,
        auto_start: bool,
        headers: Vec<(String, String)>,
    ) -> Result<TaskDto, EngineError> {
        http::validate_url(&url)?;
        let settings = self.settings.read().unwrap().clone();
        let dir = save_dir
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&settings.download_dir));

        std::fs::create_dir_all(&dir)?;

        let name_given = file_name.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);
        let name = file_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| http::guess_file_name(&url));
        let name = http::sanitize_file_name(&name);

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let task = Arc::new(Task::new(
            id,
            url,
            dir,
            name,
            name_given,
            connections.unwrap_or(settings.connections).clamp(1, settings.max_connections.clamp(1, 16)),
            headers,
        ));
        self.tasks.lock().unwrap().push(task.clone());

        if auto_start {
            self.start(&task);
        }
        Ok(task.snapshot())
    }

    pub fn start(self: &Arc<Self>, task: &Arc<Task>) {
        let current = task.state();
        if matches!(current, TaskState::Active) {
            return;
        }
        *task.stop.lock().unwrap() = StopKind::None;
        task.set_state(TaskState::Active);
        let token = CancellationToken::new();
        *task.cancel.lock().unwrap() = Some(token.clone());
        // 每次启动递增运行代次：上一轮即便还没退出，也不能再改文件或写状态，
        // 否则"暂停后立刻继续"时旧任务会把 .part 重命名成成品，导致新任务重新预分配清零。
        let run_id = task.run_id.fetch_add(1, Ordering::SeqCst) + 1;

        let engine = self.clone();
        let running = task.clone();
        tauri::async_runtime::spawn(async move {
            engine.run_task(running, token, run_id).await;
        });
        self.emit_task(&task);
    }

    pub fn pause(&self, id: u64) {
        if let Some(task) = self.find(id) {
            let st = task.state();
            if !matches!(st, TaskState::Active | TaskState::Queued) {
                return;
            }
            *task.stop.lock().unwrap() = StopKind::Pause;
            if let Some(token) = task.cancel.lock().unwrap().take() {
                token.cancel();
            }
            task.speed.reset();
            task.set_state(TaskState::Paused);
            self.emit_task(&task);
        }
    }

    pub fn resume(self: &Arc<Self>, id: u64) {
        if let Some(task) = self.find(id) {
            if matches!(task.state(), TaskState::Paused | TaskState::Failed) {
                task.set_error(None);
                self.start(&task);
            }
        }
    }

    pub fn remove(&self, id: u64, delete_file: bool) -> Result<(), EngineError> {
        let task = {
            let mut tasks = self.tasks.lock().unwrap();
            let pos = tasks.iter().position(|t| t.id == id);
            pos.map(|p| tasks.remove(p))
        };
        let Some(task) = task else { return Ok(()) };

        *task.stop.lock().unwrap() = StopKind::Remove;
        if let Some(token) = task.cancel.lock().unwrap().take() {
            token.cancel();
        }

        if delete_file {
            if let Some(path) = task.part_path() {
                let _ = std::fs::remove_file(path);
            }
            if let Some(path) = task.final_path() {
                let _ = std::fs::remove_file(path);
            }
        }
        self.events.removed(id);
        Ok(())
    }

    pub fn emit_task(&self, task: &Task) {
        self.events.task(&task.snapshot());
    }

    /// 10Hz 合并进度事件，避免 UI 重绘风暴。
    pub fn spawn_ticker(self: &Arc<Self>) {
        let engine = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut last: Vec<ProgressItem> = Vec::new();
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tick.tick().await;
                let mut items = Vec::new();
                {
                    let tasks = engine.tasks.lock().unwrap();
                    for t in tasks.iter() {
                        let state = t.state();
                        if !matches!(state, TaskState::Active) {
                            continue;
                        }
                        items.push(ProgressItem {
                            id: t.id,
                            done_bytes: t.done.load(Ordering::Relaxed),
                            total_bytes: t.total.load(Ordering::Relaxed),
                            speed_bps: t.speed.bps(),
                            state,
                        });
                    }
                }
                let changed = items.len() != last.len()
                    || items.iter().zip(last.iter()).any(|(a, b)| {
                        a.id != b.id || a.done_bytes != b.done_bytes || a.state != b.state
                    });
                if changed {
                    engine.events.progress(&items);
                    last = items;
                }
            }
        });
    }

    async fn run_task(self: Arc<Self>, task: Arc<Task>, token: CancellationToken, run_id: u64) {
        // 探测只发一次请求，网络抖动（TLS 重置、瞬时 5xx）会让整个任务直接失败；
        // 这里补两次重试，仍然失败才如实报错。
        let meta = {
            let mut attempt: u32 = 0;
            loop {
                match http::probe(&self.client, &task.url, &token, &task.headers).await {
                    Ok(meta) => break meta,
                    Err(e) => {
                        let fatal = matches!(e, EngineError::Aborted | EngineError::RangeUnsupported)
                            || attempt >= 2;
                        if fatal {
                            if !matches!(e, EngineError::Aborted) {
                                self.fail(&task, e.to_string());
                            }
                            return;
                        }
                        attempt += 1;
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(700 * attempt as u64)) => {}
                            _ = token.cancelled() => return,
                        }
                    }
                }
            }
        };

        if !task.user_named {
            if let Some(name) = meta.file_name {
                *task.file_name.lock().unwrap() = name;
            }
        }
        task.total.store(meta.total, Ordering::Relaxed);
        task.supports_ranges.store(meta.ranges, Ordering::Relaxed);

        let file_name = task.file_name();
        let final_path = unique_path(&task.save_dir, &file_name);
        let part_path = final_path.with_extension(format!(
            "{}part",
            final_path
                .extension()
                .map(|e| format!("{}.", e.to_string_lossy()))
                .unwrap_or_default()
        ));
        *task.part_path.lock().unwrap() = Some(part_path.clone());
        *task.final_path.lock().unwrap() = Some(final_path.clone());

        // 预分配：NTFS/APFS/ext4 上是稀疏分配，瞬间完成，收尾时无需合并分片。
        let need_create = match std::fs::metadata(&part_path) {
            Ok(m) => m.len() != meta.total,
            Err(_) => true,
        };
        if need_create && meta.total > 0 {
            let created = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&part_path);
            match created {
                Ok(f) => {
                    if let Err(e) = f.set_len(meta.total) {
                        self.fail(&task, format!("预分配文件失败：{e}"));
                        return;
                    }
                }
                Err(e) => {
                    self.fail(&task, format!("创建文件失败：{e}"));
                    return;
                }
            }
        }

        // 分片规划：仅当服务端支持 Range 且体积已知时切段。
        let plan = {
            let mut segments = task.segments.lock().unwrap();
            if segments.is_empty() {
                *segments = plan_segments(meta.total, if meta.ranges { task.connections } else { 1 });
            }
            segments.clone()
        };

        if plan.is_empty() {
            self.fail(&task, "服务端未返回文件大小，无法开始下载".into());
            return;
        }

        let mut handles = Vec::new();
        for (idx, _) in plan.iter().enumerate() {
            let engine = self.clone();
            let task = task.clone();
            let token = token.clone();
            let path = part_path.clone();
            let url = meta.final_url.clone();
            handles.push(tauri::async_runtime::spawn(async move {
                engine
                    .run_segment(task, idx, url, path, token)
                    .await
            }));
        }

        let mut first_err: Option<String> = None;
        for h in handles {
            match h.await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_err.is_none() && !matches!(e, EngineError::Aborted) {
                        first_err = Some(e.to_string());
                    }
                }
                Err(e) => {
                    if first_err.is_none() {
                        first_err = Some(format!("任务异常：{e}"));
                    }
                }
            }
        }

        let stop = *task.stop.lock().unwrap();
        // 本轮已被新的运行代次取代（暂停后立刻继续）：交还控制权，不碰文件、不改状态。
        if !same_run(&task, run_id) {
            return;
        }
        if stop == StopKind::Remove {
            return;
        }
        if stop == StopKind::Pause {
            task.speed.reset();
            return;
        }
        if let Some(msg) = first_err {
            self.fail(&task, msg);
            return;
        }

        // 收尾：.part -> 最终文件名（同目录 rename，不做合并）
        task.speed.reset();
        match std::fs::rename(&part_path, &final_path) {
            Ok(()) => {
                task.done
                    .store(meta.total, Ordering::Relaxed);
                task.total.store(meta.total, Ordering::Relaxed);
                task.set_state(TaskState::Completed);
                self.emit_task(&task);
            }
            Err(e) => self.fail(&task, format!("重命名失败：{e}")),
        }
    }

    async fn run_segment(
        self: Arc<Self>,
        task: Arc<Task>,
        idx: usize,
        url: String,
        path: PathBuf,
        token: CancellationToken,
    ) -> Result<(), EngineError> {
        let mut attempt: u32 = 0;
        loop {
            if token.is_cancelled() {
                return Err(EngineError::Aborted);
            }

            let (from, end) = {
                let segments = task.segments.lock().unwrap();
                let seg = segments[idx];
                (seg.start + seg.done, seg.end)
            };
            if from >= end {
                return Ok(());
            }

            let result = self
                .stream_segment(&task, idx, &url, &path, from, end, &token)
                .await;

            match result {
                Ok(()) => return Ok(()),
                Err(EngineError::Aborted) => return Err(EngineError::Aborted),
                Err(EngineError::RangeUnsupported) => return Err(EngineError::RangeUnsupported),
                Err(e) => {
                    if token.is_cancelled() {
                        return Err(EngineError::Aborted);
                    }
                    attempt += 1;
                    if attempt >= 7 {
                        return Err(e);
                    }
                    // 429/503 是服务端限速：退避要更长，否则重试会继续撞限流。
                    // 各分段按 idx 错开，避免所有连接同一毫秒重试形成突发。
                    let throttled = matches!(&e, EngineError::Http(s) if s.starts_with("HTTP 429") || s.starts_with("HTTP 503"));
                    let base = if throttled { 1500 } else { 300 };
                    let backoff = Duration::from_millis(base * 2u64.pow(attempt.min(4)) + 97 * idx as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(backoff) => {}
                        _ = token.cancelled() => return Err(EngineError::Aborted),
                    }
                }
            }
        }
    }

    async fn stream_segment(
        self: &Arc<Self>,
        task: &Arc<Task>,
        idx: usize,
        url: &str,
        path: &PathBuf,
        from: u64,
        end: u64,
        token: &CancellationToken,
    ) -> Result<(), EngineError> {
        let resp = http::with_headers(
            self.client
                .get(url)
                .header(reqwest::header::RANGE, format!("bytes={}-{}", from, end - 1))
                .header(reqwest::header::ACCEPT_ENCODING, "identity"),
            &task.headers,
        )
        .send()
        .await?;

        let status = resp.status();
        if from > 0 && status == reqwest::StatusCode::OK {
            return Err(EngineError::RangeUnsupported);
        }
        if !status.is_success() {
            return Err(EngineError::Http(format!("HTTP {status}")));
        }

        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .await?;
        file.seek(std::io::SeekFrom::Start(from)).await?;

        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if token.is_cancelled() {
                return Err(EngineError::Aborted);
            }
            let chunk = chunk?;
            let len = chunk.len() as u64;
            if len == 0 {
                continue;
            }

            self.pacer.consume(len).await;

            file.write_all(&chunk).await?;
            file.flush().await?;

            {
                let mut segments = task.segments.lock().unwrap();
                segments[idx].done += len;
            }
            let done = task.done.fetch_add(len, Ordering::Relaxed) + len;
            task.speed.update(done);
        }

        // 校验该分段是否补齐（服务端可能提前断开）
        let covered = {
            let segments = task.segments.lock().unwrap();
            segments[idx].start + segments[idx].done >= segments[idx].end
        };
        if covered {
            Ok(())
        } else {
            Err(EngineError::Http("连接提前结束，准备重试".into()))
        }
    }

    fn fail(&self, task: &Task, msg: String) {
        task.speed.reset();
        task.set_error(Some(msg));
        task.set_state(TaskState::Failed);
        self.emit_task(task);
    }
}

fn plan_segments(total: u64, connections: u32) -> Vec<Segment> {
    if total == 0 {
        return Vec::new();
    }
    let count = (connections.max(1) as u64).min(total.max(1));
    let chunk = total / count;
    let mut segments = Vec::with_capacity(count as usize);
    for i in 0..count {
        let start = i * chunk;
        let end = if i == count - 1 { total } else { start + chunk };
        segments.push(Segment {
            start,
            end,
            done: 0,
        });
    }
    segments
}

/// 同名文件存在时追加 (1)(2)…，不覆盖用户已有文件。
fn unique_path(dir: &PathBuf, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(file_name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.to_string());
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..1000 {
        let next = dir.join(format!("{stem} ({i}){ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}-{}{ext}", now_ms()))
}

fn same_run(task: &Task, run_id: u64) -> bool {
    task.run_id.load(Ordering::SeqCst) == run_id
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
