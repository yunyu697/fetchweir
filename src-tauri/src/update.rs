// 更新器：检查自有仓库 Release、镜像下载、字节校验与分平台安装。
// 交互基准：常驻「检查更新」「打开主页」；发现新版本才出现「更新」「仅下载」及镜像下拉；
// 「更新」= 下载 → 安装 → 重启；「仅下载」= 落到系统下载目录，之后可「安装」「打开下载目录」。
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::settings::{self, Settings};
use crate::VERSION;

const DEFAULT_REPO: &str = "yunyu697/fetchweir";
const GITHUB_API: &str = "https://api.github.com";
const CANCELLED: &str = "__cancelled__";

pub struct MirrorDef {
    pub id: &'static str,
    pub label: &'static str,
    /// 前缀转发：拼接在原始 GitHub 链接前面，不改变资源内容。
    pub prefix: &'static str,
}

pub const MIRRORS: &[MirrorDef] = &[
    MirrorDef { id: "github", label: "GitHub 直连", prefix: "" },
    MirrorDef { id: "ghfast", label: "加速镜像 ghfast.top", prefix: "https://ghfast.top/" },
    MirrorDef { id: "ghproxy", label: "加速镜像 gh-proxy.com", prefix: "https://gh-proxy.com/" },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorDto {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDto {
    /// idle / checking / upToDate / updateAvailable / downloading / downloaded / installing / failed
    pub stage: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size: Option<u64>,
    pub mirrors: Vec<MirrorDto>,
    pub mirror: String,
    pub progress: f64,
    pub downloaded: u64,
    pub total: u64,
    pub path: Option<String>,
    pub message: Option<String>,
    pub can_install: bool,
    pub download_dir: String,
}

#[derive(Clone)]
struct Latest {
    version: String,
    notes: String,
    published_at: String,
    asset_name: String,
    asset_size: u64,
    asset_id: u64,
    browser_url: String,
}

struct Inner {
    stage: &'static str,
    latest: Option<Latest>,
    mirror: String,
    progress: f64,
    downloaded: u64,
    total: u64,
    path: Option<PathBuf>,
    message: Option<String>,
    cancel: Option<CancellationToken>,
    mode: String,
    download_dir: String,
}

pub struct Updater {
    app: AppHandle,
    inner: Mutex<Inner>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    /// GitHub 的「预发布」标记；看板上的 alpha/beta 包不应推给正式版用户。
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    id: u64,
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// 语义化版本：<major>.<minor>.<patch>[-pre][+build]。
/// 各段一律按数字比较（因此 1.0.10 > 1.0.9）；预发布按 semver 规则逐段比较，
/// 且同号预发布永远低于正式版。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Ver {
    major: u64,
    minor: u64,
    patch: u64,
    /// 预发布标识符，空表示正式版。
    pre: Vec<String>,
}

impl Ver {
    fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Ver {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| cmp_prerelease(&self.pre, &other.pre))
    }
}

impl PartialOrd for Ver {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// semver 预发布优先级：空串 > 非空；逐段数字优先于字母；前缀相同则段数少的更小。
fn cmp_prerelease(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.iter().zip(b.iter()) {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => cmp_alpha_ident(x, y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            a.len().cmp(&b.len())
        }
    }
}

/// 字母标识符的比较。本项目的预发布长期写成 `alpha1`/`alpha10`（无点号），
/// 严格按 ASCII 字典序会得出 alpha10 < alpha9，历史 tag 会造成误判；
/// 因此同前缀且都以数字结尾时按数值比较，其余情况仍按 semver 的字典序。
fn cmp_alpha_ident(x: &str, y: &str) -> Ordering {
    fn split(s: &str) -> (&str, Option<u64>) {
        match s.find(|c: char| c.is_ascii_digit()) {
            Some(i) if i > 0 && s[i..].chars().all(|c| c.is_ascii_digit()) => {
                (&s[..i], s[i..].parse().ok())
            }
            _ => (s, None),
        }
    }
    let (px, nx) = split(x);
    let (py, ny) = split(y);
    match (nx, ny) {
        (Some(nx), Some(ny)) if px == py => nx.cmp(&ny),
        _ => x.cmp(y),
    }
}

fn parse_ver(raw: &str) -> Option<Ver> {
    let s = raw.trim().trim_start_matches(['v', 'V']);
    // 构建元数据（+build.7）不参与比较
    let s = s.split_once('+').map(|(head, _)| head).unwrap_or(s);
    let (num, pre) = match s.split_once('-') {
        Some((n, p)) => {
            let parts: Vec<String> = p.split('.').map(|x| x.to_string()).collect();
            if parts.iter().any(|x| x.is_empty()) {
                return None;
            }
            (n, parts)
        }
        None => (s, Vec::new()),
    };
    let parts: Vec<&str> = num.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(Ver {
        major: parts[0].parse().ok()?,
        minor: parts[1].parse().ok()?,
        patch: parts[2].parse().ok()?,
        pre,
    })
}

#[cfg(target_os = "windows")]
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    // 所有用户安装必须更新为 perMachine 包，否则会静默装出第二份用户级副本。
    let per_machine = crate::platform::install_info().scope == "perMachine";
    let suffix = if per_machine {
        "-setup-allusers.exe"
    } else {
        "-setup.exe"
    };
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(suffix))
}

#[cfg(target_os = "macos")]
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_asset(assets: &[GhAsset]) -> Option<&GhAsset> {
    assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".appimage"))
        .or_else(|| assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(".deb")))
}

fn token_of(s: &Settings) -> Option<String> {
    let t = s.update_token.trim();
    if !t.is_empty() {
        return Some(t.to_string());
    }
    std::env::var("FETCHWEIR_GITHUB_TOKEN")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn brief(err: &reqwest::Error) -> String {
    let raw = err.to_string();
    let mut s: String = raw.chars().take(160).collect();
    if raw.chars().count() > 160 {
        s.push('…');
    }
    s
}

impl Updater {
    pub fn new(app: AppHandle) -> Arc<Self> {
        let s = settings::load();
        let mirror = if MIRRORS.iter().any(|m| m.id == s.update_mirror) {
            s.update_mirror.clone()
        } else {
            "github".to_string()
        };
        Arc::new(Self {
            app,
            inner: Mutex::new(Inner {
                stage: "idle",
                latest: None,
                mirror,
                progress: 0.0,
                downloaded: 0,
                total: 0,
                path: None,
                message: None,
                cancel: None,
                mode: "install".to_string(),
                download_dir: settings::system_download_dir().to_string_lossy().to_string(),
            }),
        })
    }

    /// 供命令层读取当前状态（窗口重载后恢复界面）。
    pub fn snapshot(&self) -> UpdateDto {
        self.dto()
    }

    fn dto(&self) -> UpdateDto {
        let inner = self.inner.lock().unwrap();
        let total = inner.total;
        let downloaded = inner.downloaded;
        UpdateDto {
            stage: inner.stage.to_string(),
            current_version: VERSION.to_string(),
            latest_version: inner.latest.as_ref().map(|l| l.version.clone()),
            notes: inner.latest.as_ref().map(|l| l.notes.clone()),
            published_at: inner.latest.as_ref().map(|l| l.published_at.clone()),
            asset_name: inner.latest.as_ref().map(|l| l.asset_name.clone()),
            asset_size: inner.latest.as_ref().map(|l| l.asset_size),
            mirrors: MIRRORS
                .iter()
                .map(|m| MirrorDto { id: m.id.to_string(), label: m.label.to_string() })
                .collect(),
            mirror: inner.mirror.clone(),
            progress: inner.progress,
            downloaded,
            total,
            path: inner.path.as_ref().map(|p| p.to_string_lossy().to_string()),
            message: inner.message.clone(),
            can_install: inner
                .path
                .as_ref()
                .map(|p| p.exists())
                .unwrap_or(false),
            download_dir: inner.download_dir.clone(),
        }
    }

    fn emit(&self) {
        let dto = self.dto();
        let _ = self.app.emit("fw://update", dto);
    }

    fn set_stage(&self, stage: &'static str, message: Option<String>) -> UpdateDto {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.stage = stage;
            inner.message = message;
            if stage == "downloading" {
                inner.path = None;
            }
        }
        self.emit();
        self.dto()
    }

    fn fail(&self, message: String) -> UpdateDto {
        self.set_stage("failed", Some(message))
    }

    pub async fn check(self: &Arc<Self>) -> UpdateDto {
        self.set_stage("checking", None);
        let s = settings::load();
        let repo = if s.update_repo.trim().is_empty() {
            DEFAULT_REPO.to_string()
        } else {
            s.update_repo.trim().to_string()
        };
        let token = token_of(&s);

        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("Fetchweir/{VERSION}"))
            .build()
        {
            Ok(c) => c,
            Err(e) => return self.fail(format!("初始化网络客户端失败：{e}")),
        };

        let url = format!("{GITHUB_API}/repos/{repo}/releases?per_page=20");
        let mut req = client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(t) = token.as_deref() {
            req = req.bearer_auth(t);
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                return self.fail(format!(
                    "无法连接更新源：{}。可稍后重试，或为源码构建配置代理/镜像。",
                    brief(&e)
                ))
            }
        };

        let status = resp.status();
        let body = match resp.bytes().await {
            Ok(b) => b,
            Err(e) => return self.fail(format!("读取更新源响应失败：{}", brief(&e))),
        };

        if !status.is_success() {
            let msg = match status.as_u16() {
                401 => "访问令牌无效或权限不足：请在设置中重新填写访问令牌。".to_string(),
                404 => format!(
                    "更新源不可访问（{repo} 为私有或不存在）：请在设置中填写有该仓库读取权限的访问令牌。"
                ),
                403 => "更新源拒绝访问（可能触发速率限制）：请稍后重试，或配置访问令牌。".to_string(),
                code => format!("更新源返回 HTTP {code}。"),
            };
            return self.fail(msg);
        }

        let releases: Vec<GhRelease> = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return self.fail("更新源返回了非预期的数据格式。".to_string()),
        };

        // 当前版本先算出来：预发布过滤与后面的「是否更新」都用同一份解析结果。
        let current = parse_ver(VERSION).unwrap_or(Ver {
            major: 0,
            minor: 0,
            patch: 0,
            pre: Vec::new(),
        });

        // 选「本平台有安装包」的最高版本；草稿与无法识别版本号的条目跳过。
        // 预发布只有在当前版本本身是预发布时才参与比较，避免把 alpha/beta 推给正式版用户。
        let mut best: Option<(Ver, &GhRelease, &GhAsset)> = None;
        for r in &releases {
            if r.draft {
                continue;
            }
            let Some(v) = parse_ver(&r.tag_name) else { continue };
            if (r.prerelease || v.is_prerelease()) && !current.is_prerelease() {
                continue;
            }
            let Some(asset) = pick_asset(&r.assets) else { continue };
            if best.as_ref().map(|b| v > b.0).unwrap_or(true) {
                best = Some((v, r, asset));
            }
        }

        let Some((ver, release, asset)) = best else {
            return self.fail("更新源中没有适用于当前平台的安装包。".to_string());
        };

        let latest = Latest {
            version: release
                .tag_name
                .trim()
                .trim_start_matches(['v', 'V'])
                .to_string(),
            notes: release.body.clone().unwrap_or_else(|| "该版本未提供更新说明。".to_string()),
            published_at: release.published_at.clone().unwrap_or_default(),
            asset_name: asset.name.clone(),
            asset_size: asset.size,
            asset_id: asset.id,
            browser_url: asset.browser_download_url.clone(),
        };

        {
            let mut inner = self.inner.lock().unwrap();
            // 版本变了就丢弃旧的半成品，避免把上一版字节拼到新版里。
            if inner.latest.as_ref().map(|l| l.version.clone()) != Some(latest.version.clone()) {
                if let Some(p) = inner.path.take() {
                    let _ = std::fs::remove_file(p);
                }
                inner.downloaded = 0;
                inner.total = 0;
                inner.progress = 0.0;
            }
            inner.latest = Some(latest);
        }

        if ver <= current {
            return self.set_stage("upToDate", None);
        }

        self.set_stage("updateAvailable", None)
    }

    pub fn set_mirror(self: &Arc<Self>, mirror: &str) -> Result<UpdateDto, String> {
        if !MIRRORS.iter().any(|m| m.id == mirror) {
            return Err(format!("未知镜像：{mirror}"));
        }
        {
            let mut inner = self.inner.lock().unwrap();
            inner.mirror = mirror.to_string();
            // 换镜像后从头下载，避免不同来源的字节拼接。
            if let Some(p) = inner.path.take() {
                let _ = std::fs::remove_file(p);
            }
            inner.downloaded = 0;
            inner.progress = 0.0;
        }
        let mut s = settings::load();
        s.update_mirror = mirror.to_string();
        settings::save(&s)?;
        self.emit();
        Ok(self.dto())
    }

    pub fn start_download(self: &Arc<Self>, mode: &str) -> Result<UpdateDto, String> {
        if mode != "install" && mode != "only" {
            return Err(format!("未知下载模式：{mode}"));
        }
        let latest = {
            let inner = self.inner.lock().unwrap();
            if inner.stage == "downloading" {
                return Err("更新包正在下载中".to_string());
            }
            inner
                .latest
                .clone()
                .ok_or_else(|| "请先检查更新".to_string())?
        };

        let s = settings::load();
        let repo = if s.update_repo.trim().is_empty() {
            DEFAULT_REPO.to_string()
        } else {
            s.update_repo.trim().to_string()
        };
        let token = token_of(&s);
        let (dir, out_dir_label) = if mode == "only" {
            (settings::system_download_dir(), settings::system_download_dir())
        } else {
            let dir = settings::ensure_data_dir().join("updates");
            (dir.clone(), dir)
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败：{e}"))?;

        let name = http_safe_name(&latest.asset_name);
        let target = dir.join(&name);
        let part = PathBuf::from(format!("{}.part", target.to_string_lossy()));

        let cancel = CancellationToken::new();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.mode = mode.to_string();
            inner.path = None;
            inner.downloaded = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            inner.total = latest.asset_size;
            inner.progress = if latest.asset_size > 0 {
                (inner.downloaded as f64 / latest.asset_size as f64) * 100.0
            } else {
                0.0
            };
            inner.message = None;
            inner.download_dir = out_dir_label.to_string_lossy().to_string();
            inner.cancel = Some(cancel.clone());
        }
        self.set_stage("downloading", None);

        let this = self.clone();
        let mirror = self.inner.lock().unwrap().mirror.clone();
        tauri::async_runtime::spawn(async move {
            this.run_download(latest, repo, token, mirror, target, part, cancel).await;
        });

        Ok(self.dto())
    }

    async fn run_download(
        self: Arc<Self>,
        latest: Latest,
        repo: String,
        token: Option<String>,
        mirror: String,
        target: PathBuf,
        part: PathBuf,
        cancel: CancellationToken,
    ) {
        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .user_agent(format!("Fetchweir/{VERSION}"))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                self.fail(format!("初始化网络客户端失败：{e}"));
                return;
            }
        };

        let candidates = download_candidates(&latest, &repo, token.as_deref(), &mirror);
        let mut failures: Vec<String> = Vec::new();
        let mut done = false;

        for cand in &candidates {
            if cancel.is_cancelled() {
                self.cancelled();
                return;
            }
            match self
                .fetch_one(&client, cand, token.as_deref(), &part, latest.asset_size, &cancel)
                .await
            {
                Ok(size) => {
                    let expected = latest.asset_size;
                    if expected > 0 && size != expected {
                        let _ = std::fs::remove_file(&part);
                        failures.push(format!(
                            "{} 下载不完整（预期 {expected} 字节，实际 {size} 字节）",
                            cand.label
                        ));
                        continue;
                    }
                    if !part.exists() {
                        failures.push(format!("{} 下载后未找到临时文件", cand.label));
                        continue;
                    }
                    let _ = std::fs::remove_file(&target);
                    if let Err(e) = std::fs::rename(&part, &target) {
                        self.fail(format!("保存安装包失败：{e}"));
                        return;
                    }
                    {
                        let mut inner = self.inner.lock().unwrap();
                        inner.path = Some(target.clone());
                        inner.downloaded = size;
                        inner.total = expected.max(size);
                        inner.progress = 100.0;
                        inner.message = Some(format!(
                            "已通过{}下载完成，共 {}。",
                            cand.label,
                            human_bytes(size)
                        ));
                        inner.cancel = None;
                    }
                    done = true;
                    break;
                }
                Err(err) => {
                    if err == CANCELLED {
                        self.cancelled();
                        return;
                    }
                    failures.push(err);
                }
            }
        }

        if !done {
            let msg = if failures.is_empty() {
                "下载失败：没有可用的下载源。".to_string()
            } else {
                format!(
                    "下载失败：{}。可切换镜像或稍后重试。",
                    failures.join("；")
                )
            };
            self.fail(msg);
            return;
        }

        let mode = self.inner.lock().unwrap().mode.clone();
        if mode == "install" {
            self.set_stage("installing", None);
            if let Err(e) = self.install_now() {
                self.fail(e);
            }
        } else {
            let msg = self.inner.lock().unwrap().message.clone();
            self.set_stage("downloaded", msg);
        }
    }

    async fn fetch_one(
        &self,
        client: &reqwest::Client,
        cand: &Candidate,
        token: Option<&str>,
        part: &Path,
        total_hint: u64,
        cancel: &CancellationToken,
    ) -> Result<u64, String> {
        let mut offset = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        if total_hint > 0 && offset >= total_hint {
            let _ = std::fs::remove_file(part);
            offset = 0;
        }

        let mut req = client.get(&cand.url);
        if cand.api_asset {
            req = req.header("Accept", "application/octet-stream");
            if let Some(t) = token {
                req = req.bearer_auth(t);
            }
        }
        if offset > 0 {
            req = req.header("Range", format!("bytes={offset}-"));
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("{} 连接失败：{}", cand.label, brief(&e)))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("{} 返回 HTTP {}", cand.label, status.as_u16()));
        }

        let append = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !append {
            offset = 0;
        }
        let total = match resp.content_length() {
            Some(len) => offset + len,
            None => total_hint,
        };

        {
            let mut inner = self.inner.lock().unwrap();
            inner.downloaded = offset;
            inner.total = total;
            inner.progress = if total > 0 { (offset as f64 / total as f64) * 100.0 } else { 0.0 };
            inner.message = Some(format!("正在通过{}下载…", cand.label));
        }
        self.emit();

        let mut file = if append {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(part)
                .await
                .map_err(|e| format!("打开临时文件失败：{e}"))?
        } else {
            tokio::fs::File::create(part)
                .await
                .map_err(|e| format!("创建临时文件失败：{e}"))?
        };

        let mut stream = resp.bytes_stream();
        let mut downloaded = offset;
        let mut last_emit = Instant::now();

        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(CANCELLED.to_string()),
                item = stream.next() => item,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| format!("{} 传输中断：{}", cand.label, brief(&e)))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入安装包失败：{e}"))?;
            downloaded += chunk.len() as u64;

            {
                let mut inner = self.inner.lock().unwrap();
                inner.downloaded = downloaded;
                if total > 0 {
                    inner.progress = (downloaded as f64 / total as f64).clamp(0.0, 100.0);
                }
            }
            if last_emit.elapsed() >= Duration::from_millis(150) {
                self.emit();
                last_emit = Instant::now();
            }
            if cancel.is_cancelled() {
                return Err(CANCELLED.to_string());
            }
        }

        file.flush().await.map_err(|e| format!("写入安装包失败：{e}"))?;
        drop(file);
        self.emit();
        Ok(downloaded)
    }

    fn cancelled(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.cancel = None;
            inner.stage = "updateAvailable";
            inner.progress = if inner.total > 0 {
                (inner.downloaded as f64 / inner.total as f64) * 100.0
            } else {
                0.0
            };
            inner.message = Some("已取消。已下载的部分会保留，下次继续。".to_string());
        }
        self.emit();
    }

    pub fn cancel(&self) -> UpdateDto {
        let token = self.inner.lock().unwrap().cancel.clone();
        if let Some(t) = token {
            t.cancel();
        }
        self.dto()
    }

    pub fn install(&self) -> Result<UpdateDto, String> {
        {
            let inner = self.inner.lock().unwrap();
            if inner.path.is_none() {
                return Err("没有已下载的安装包".to_string());
            }
        }
        self.set_stage("installing", None);
        self.install_now()?;
        Ok(self.dto())
    }

    fn install_now(&self) -> Result<(), String> {
        let path = {
            let inner = self.inner.lock().unwrap();
            inner.path.clone().ok_or_else(|| "没有已下载的安装包".to_string())?
        };
        if !path.exists() {
            return Err(format!("安装包不存在：{}", path.display()));
        }
        install_package(&self.app, &path)
    }
}

struct Candidate {
    label: &'static str,
    url: String,
    api_asset: bool,
}

/// 私有仓库必须走 API 资源端点（带令牌）；公开仓库才可用前缀加速镜像。
fn download_candidates(latest: &Latest, repo: &str, token: Option<&str>, selected: &str) -> Vec<Candidate> {
    if token.is_some() {
        return vec![Candidate {
            label: "GitHub API",
            url: format!("{GITHUB_API}/repos/{repo}/releases/assets/{}", latest.asset_id),
            api_asset: true,
        }];
    }
    let mut list: Vec<Candidate> = Vec::new();
    for m in MIRRORS {
        let label = m.label;
        let url = if m.prefix.is_empty() {
            latest.browser_url.clone()
        } else {
            format!("{}{}", m.prefix, latest.browser_url)
        };
        list.push(Candidate { label, url, api_asset: false });
    }
    // 用户选中的镜像排第一，其余按内置顺序兜底。
    if let Some(pos) = MIRRORS.iter().position(|m| m.id == selected) {
        let mut chosen = list.remove(pos);
        chosen.label = "所选镜像";
        list.insert(0, chosen);
    }
    list
}

fn human_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

fn http_safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\"/\\:*?<>|".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "fetchweir-update.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(windows)]
fn ps_quote(p: &str) -> String {
    format!("'{}'", p.replace('\'', "''"))
}

#[cfg(windows)]
fn install_package(app: &AppHandle, installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败：{e}"))?;
    // 先让主程序退出再静默安装，避免安装器与运行中的 exe 抢文件；
    // 安装结束后重新拉起程序。整个过程交给独立的 PowerShell，主程序可以立即退出。
    let script = format!(
        "Start-Sleep -Milliseconds 1200; Start-Process -FilePath {inst} -ArgumentList '/S' -Wait; Start-Sleep -Seconds 1; if (Test-Path {exe}) {{ Start-Process -FilePath {exe} }}",
        inst = ps_quote(&installer.to_string_lossy()),
        exe = ps_quote(&exe.to_string_lossy()),
    );

    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.spawn().map_err(|e| format!("启动安装程序失败：{e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_package(app: &AppHandle, package: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(package)
        .spawn()
        .map_err(|e| format!("打开磁盘映像失败：{e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn install_package(_app: &AppHandle, package: &Path) -> Result<(), String> {
    let name = package
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name.ends_with(".appimage") {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(package).map(|m| m.permissions().mode()).unwrap_or(0);
        let _ = std::fs::set_permissions(package, std::fs::Permissions::from_mode(mode | 0o755));
        std::process::Command::new(package)
            .spawn()
            .map_err(|e| format!("启动新版本失败：{e}"))?;
        return Ok(());
    }
    // deb 交给包管理器：这里只打开所在目录，由用户在系统界面里安装。
    let parent = package.parent().unwrap_or(package);
    std::process::Command::new("xdg-open")
        .arg(parent)
        .spawn()
        .map_err(|e| format!("打开下载目录失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_ordering_matches_semver() {
        // 1) 当前 == 最新：相等，不应提示更新
        assert_eq!(parse_ver("v1.0.2").unwrap(), parse_ver("1.0.2").unwrap());
        assert!(!(parse_ver("1.0.2").unwrap() > parse_ver("v1.0.2").unwrap()));
        // 2) 当前更高（本地开发版）
        assert!(parse_ver("1.0.3").unwrap() > parse_ver("1.0.2").unwrap());
        // 3) 最新为预发布：同号预发布低于正式版，但高于上一正式版
        assert!(parse_ver("1.0.2-alpha2").unwrap() < parse_ver("1.0.2").unwrap());
        assert!(parse_ver("1.0.3-alpha1").unwrap() > parse_ver("1.0.2").unwrap());
        assert!(parse_ver("1.0.0-alpha10").unwrap() > parse_ver("1.0.0-alpha9").unwrap());
        // 4) 两位数字按数值比较，不是字典序
        assert!(parse_ver("1.0.10").unwrap() > parse_ver("1.0.9").unwrap());
        assert!(parse_ver("1.10.0").unwrap() > parse_ver("1.9.0").unwrap());
        // 构建元数据不参与比较
        assert_eq!(parse_ver("1.0.3+build.7").unwrap(), parse_ver("1.0.3").unwrap());
        // semver 预发布优先级：数字段低于字母段，数字段按数值比较
        assert!(parse_ver("1.0.0-alpha.1").unwrap() < parse_ver("1.0.0-alpha.beta").unwrap());
        assert!(parse_ver("1.0.0-beta.2").unwrap() < parse_ver("1.0.0-beta.11").unwrap());
        // 非法输入不应被当成某个版本
        assert!(parse_ver("1.2").is_none());
        assert!(parse_ver("1.0.3-").is_none());
        assert!(parse_ver("").is_none());
    }

    #[test]
    fn candidates_prefer_selected_mirror() {
        let latest = Latest {
            version: "1.0.0".into(),
            notes: String::new(),
            published_at: String::new(),
            asset_name: "Fetchweir_1.0.0_x64-setup.exe".into(),
            asset_size: 10,
            asset_id: 1,
            browser_url: "https://github.com/yunyu697/fetchweir/releases/download/v1.0.0/a.exe".into(),
        };
        let list = download_candidates(&latest, DEFAULT_REPO, None, "ghproxy");
        assert_eq!(list[0].label, "所选镜像");
        assert!(list[0].url.starts_with("https://gh-proxy.com/https://github.com/"));
        assert!(list.iter().any(|c| c.url == latest.browser_url));

        let with_token = download_candidates(&latest, DEFAULT_REPO, Some("t"), "ghproxy");
        assert_eq!(with_token.len(), 1);
        assert!(with_token[0].api_asset);
    }

    #[test]
    fn unsafe_file_names_are_sanitized() {
        assert_eq!(http_safe_name("a/b:c?.exe"), "a_b_c_.exe");
        assert_eq!(http_safe_name("  ..exe.. "), "exe");
    }
}
