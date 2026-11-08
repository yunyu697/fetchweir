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

use crate::settings;
use crate::VERSION;

/// 默认只读的公开发布仓库：源码仓库已公开，安装包与清单就挂在同一个仓库的 Release 上。
const DEFAULT_REPO: &str = "yunyu697/fetchweir";
const GITHUB_API: &str = "https://api.github.com";
const CANCELLED: &str = "__cancelled__";
/// 发布清单固定文件名，与同名 `.sig`（base64 Ed25519 签名）一起放在 Release 里。
const MANIFEST_NAME: &str = "latest.json";
/// 发布清单验签公钥（Ed25519 原始公钥，base64，32 字节）。
/// 配对私钥只存本地 `.secrets/update-signing.pem`（已被 .gitignore 覆盖），
/// CI 通过 secret FW_SIGNING_KEY 提供；客户端不含私钥。
/// 这把密钥固定使用，不随发版更换；`tools/Sign-FwManifest.mjs` 会校验私钥与它是否配对，
/// 不配对直接拒绝签名。换钥必须先发布带新公钥的版本，见 docs/更新机制.md。
const RELEASE_PUBKEY_B64: &str = "Tk+FpZg8tSODE6zqT1t/PT6iDX+KfSRMNFOewh33yLE=";

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
    /// 清单签名是否已通过校验（旧更新源回退时为 false，界面需明确提示）。
    pub verified: bool,
    /// 清单中声明的安装包 SHA256（旧更新源没有）。
    pub sha256: Option<String>,
    /// 清单声明的最低系统要求（旧更新源没有）。
    pub min_system: Option<String>,
    /// 当前更新源是否支持 GitHub 前缀镜像（自建更新源时为 false）。
    pub mirrors_available: bool,
}

#[derive(Clone)]
struct Latest {
    version: String,
    notes: String,
    published_at: String,
    asset_name: String,
    asset_size: u64,
    browser_url: String,
    sha256: Option<String>,
    verified: bool,
}

#[derive(Clone, Default)]
struct MinSystem {
    windows: String,
    macos: String,
    linux: String,
}

struct Inner {
    stage: &'static str,
    latest: Option<Latest>,
    min_system: MinSystem,
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
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// 发布清单 latest.json。
#[derive(Clone, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    assets: Vec<ManifestAsset>,
    #[serde(default)]
    min_system: MinSystemRaw,
}

#[derive(Clone, Deserialize)]
struct ManifestAsset {
    platform: String,
    #[serde(default)]
    arch: String,
    name: String,
    url: String,
    #[serde(default)]
    size: u64,
    sha256: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
struct MinSystemRaw {
    windows: String,
    macos: String,
    linux: String,
}

impl From<MinSystemRaw> for MinSystem {
    fn from(raw: MinSystemRaw) -> Self {
        Self { windows: raw.windows, macos: raw.macos, linux: raw.linux }
    }
}

/// 当前平台在清单里使用的键。
fn manifest_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn manifest_arch() -> &'static str {
    std::env::consts::ARCH
}

/// 先找平台+架构完全匹配的资产，再退回只有平台的条目。
/// Windows 还需按当前安装范围区分「所有用户」包与用户级包，否则会装出第二份副本。
fn select_manifest_asset(assets: &[ManifestAsset]) -> Option<&ManifestAsset> {
    let platform = manifest_platform();
    let arch = manifest_arch();
    let mut pool: Vec<&ManifestAsset> = assets
        .iter()
        .filter(|a| a.platform == platform && (a.arch.is_empty() || a.arch == arch))
        .collect();
    if pool.is_empty() {
        pool = assets.iter().filter(|a| a.platform == platform).collect();
    }
    #[cfg(target_os = "windows")]
    {
        let per_machine = crate::platform::install_info().scope == "perMachine";
        let suffix = if per_machine { "-setup-allusers.exe" } else { "-setup.exe" };
        if let Some(hit) = pool
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(suffix))
        {
            return Some(hit);
        }
    }
    pool.first().copied()
}

enum ManifestErr {
    /// 更新源没有发布清单：可以退回旧逻辑，但要标注「未校验」。
    Missing(String),
    /// 清单存在但不可信（签名不对、格式错）：直接失败，不降级。
    Rejected(String),
}

/// 清单根地址。默认走 GitHub latest release 资产目录；仓库尚未发布 Release 时这里会 404，
/// 上层据此提示「未找到可用的更新源」。
/// `FETCHWEIR_UPDATE_BASE` 是本地联调/自建源钩子：指向静态服务时清单仍必须通过签名校验。
/// 显式指定的更新源（本地联调或自建源）；未设置时返回 None。
fn custom_manifest_base() -> Option<String> {
    let v = std::env::var("FETCHWEIR_UPDATE_BASE").ok()?;
    let v = v.trim().trim_end_matches('/');
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn manifest_base(repo: &str) -> String {
    custom_manifest_base().unwrap_or_else(|| format!("https://github.com/{repo}/releases/latest/download"))
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .map_err(|e| format!("base64 解码失败：{e}"))
}

/// 用内置公钥校验清单签名；任何异常都视为不通过。
fn verify_manifest(bytes: &[u8], sig_text: &str) -> Result<(), String> {
    use ring::signature::{UnparsedPublicKey, ED25519};
    let key = base64_decode(RELEASE_PUBKEY_B64)?;
    let sig = base64_decode(sig_text)?;
    UnparsedPublicKey::new(&ED25519, &key)
        .verify(bytes, &sig)
        .map_err(|_| "清单签名校验失败：更新源内容可能被篡改或公钥不匹配。".to_string())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use ring::digest::{Context, SHA256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|e| format!("读取安装包失败：{e}"))?;
    let mut ctx = Context::new(&SHA256);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取安装包失败：{e}"))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
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
                min_system: MinSystem::default(),
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
            verified: inner.latest.as_ref().map(|l| l.verified).unwrap_or(false),
            sha256: inner.latest.as_ref().and_then(|l| l.sha256.clone()),
            min_system: {
                let raw = match manifest_platform() {
                    "windows" => &inner.min_system.windows,
                    "macos" => &inner.min_system.macos,
                    _ => &inner.min_system.linux,
                };
                if raw.trim().is_empty() { None } else { Some(raw.clone()) }
            },
            mirrors_available: inner
                .latest
                .as_ref()
                .map(|l| l.browser_url.starts_with("https://github.com/"))
                .unwrap_or(true),
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

    /// 读取更新源上的 latest.json，并用内置公钥验签。
    async fn fetch_manifest(
        self: &Arc<Self>,
        client: &reqwest::Client,
        repo: &str,
    ) -> Result<Manifest, ManifestErr> {
        let base = manifest_base(repo);
        let manifest_url = format!("{base}/{MANIFEST_NAME}");
        let sig_url = format!("{base}/{MANIFEST_NAME}.sig");

        let resp = client.get(&manifest_url).send().await.map_err(|e| {
            ManifestErr::Missing(format!("未取到发布清单：{}。", brief(&e)))
        })?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ManifestErr::Missing(format!(
                "更新源 {base} 没有提供 {MANIFEST_NAME} 清单。"
            )));
        }
        if !resp.status().is_success() {
            return Err(ManifestErr::Missing(format!(
                "更新源返回 HTTP {}，未取到发布清单。",
                resp.status().as_u16()
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ManifestErr::Missing(format!("读取发布清单失败：{}", brief(&e))))?;

        let sig = client.get(&sig_url).send().await.map_err(|e| {
            ManifestErr::Rejected(format!("未取到清单签名文件：{}。", brief(&e)))
        })?;
        if !sig.status().is_success() {
            return Err(ManifestErr::Rejected(format!(
                "发布清单缺少签名文件（HTTP {}）；为避免安装被篡改的文件，更新已中止。",
                sig.status().as_u16()
            )));
        }
        let sig_text = sig
            .text()
            .await
            .map_err(|e| ManifestErr::Rejected(format!("读取清单签名失败：{}。", brief(&e))))?;
        verify_manifest(&bytes, &sig_text).map_err(ManifestErr::Rejected)?;
        serde_json::from_slice(&bytes)
            .map_err(|e| ManifestErr::Rejected(format!("发布清单格式无效：{e}。")))
    }

    pub async fn check(self: &Arc<Self>) -> UpdateDto {
        // 先丢掉上一次的清单：检查失败时界面不能继续展示旧版本的「签名已校验」，
        // 否则篡改被拒后仍会显示一个可信的新版本号。
        {
            let mut inner = self.inner.lock().unwrap();
            inner.latest = None;
            inner.downloaded = 0;
            inner.total = 0;
            inner.progress = 0.0;
        }
        self.set_stage("checking", None);
        let s = settings::load();
        let repo = if s.update_repo.trim().is_empty() {
            DEFAULT_REPO.to_string()
        } else {
            s.update_repo.trim().to_string()
        };

        let client = match reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("Fetchweir/{VERSION}"))
            .build()
        {
            Ok(c) => c,
            Err(e) => return self.fail(format!("初始化网络客户端失败：{e}")),
        };

        let current = parse_ver(VERSION).unwrap_or(Ver {
            major: 0,
            minor: 0,
            patch: 0,
            pre: Vec::new(),
        });

        // 首选：清单 + 签名，签名不通过直接拒绝，绝不回退。
        match self.fetch_manifest(&client, &repo).await {
            Ok(manifest) => self.apply_manifest(manifest, &current),
            Err(ManifestErr::Rejected(msg)) => self.fail(msg),
            Err(ManifestErr::Missing(why)) if custom_manifest_base().is_some() => {
                // 显式指定的源不参与 GitHub Release 列表回退：地址上没清单就是没有更新源，
                // 不能拿 {repo} 的 Release 冒充这个源的结果。
                self.fail(format!("未找到可用的更新源：{why}"))
            }
            Err(ManifestErr::Missing(why)) => {
                // 兼容尚未迁移的旧更新源：退回 Release 列表，但没有签名与 SHA256。
                self.check_legacy(&client, &repo, &current, why).await
            }
        }
    }

    /// 使用已验签清单生成更新状态。
    fn apply_manifest(self: &Arc<Self>, manifest: Manifest, current: &Ver) -> UpdateDto {
        let Some(ver) = parse_ver(&manifest.version) else {
            return self.fail(format!("更新清单的版本号无法识别：{}", manifest.version));
        };
        if (ver.is_prerelease()) && !current.is_prerelease() {
            return self.set_stage("upToDate", None);
        }
        if ver <= *current {
            return self.set_stage("upToDate", None);
        }
        let Some(asset) = select_manifest_asset(&manifest.assets) else {
            return self.fail("更新清单中没有适用于当前平台与架构的安装包。".to_string());
        };
        let latest = Latest {
            version: manifest.version.trim().trim_start_matches(['v', 'V']).to_string(),
            notes: if manifest.notes.trim().is_empty() {
                "该版本未提供更新说明。".to_string()
            } else {
                manifest.notes.clone()
            },
            published_at: manifest.published_at.clone(),
            asset_name: asset.name.clone(),
            asset_size: asset.size,
            browser_url: asset.url.clone(),
            sha256: Some(asset.sha256.clone()),
            verified: true,
        };
        self.store_latest(latest, manifest.min_system.clone().into());
        self.set_stage("updateAvailable", None)
    }

    /// 旧更新源（没有 latest.json）：只读 Release 列表，不携带任何令牌。
    async fn check_legacy(
        self: &Arc<Self>,
        client: &reqwest::Client,
        repo: &str,
        current: &Ver,
        manifest_note: String,
    ) -> UpdateDto {
        let url = format!("{GITHUB_API}/repos/{repo}/releases?per_page=20");
        let resp = match client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return self.fail(format!(
                    "无法连接更新源：{}。{manifest_note}",
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
                404 => format!(
                    "未找到可用的更新源：{repo} 不存在或不可访问（客户端只读公开仓库，不携带任何令牌）。{manifest_note}"
                ),
                403 => "更新源拒绝访问（未认证请求触发速率限制），请稍后重试。".to_string(),
                code => format!("更新源返回 HTTP {code}。"),
            };
            return self.fail(msg);
        }

        let releases: Vec<GhRelease> = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return self.fail("更新源返回了非预期的数据格式。".to_string()),
        };

        // 选「本平台有安装包」的最高版本；草稿与无法识别版本号的条目跳过。
        // 预发布只有在当前版本本身是预发布时才参与比较。
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

        // 列表为空说明这个仓库没有任何已发布版本，不能报成「没有适用于当前平台的包」。
        if releases.is_empty() {
            return self.fail(format!("未找到可用的更新源：{repo} 尚未发布任何版本。{manifest_note}"));
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
            browser_url: asset.browser_download_url.clone(),
            sha256: None,
            verified: false,
        };
        self.store_latest(latest, Default::default());

        if ver <= *current {
            return self.set_stage("upToDate", None);
        }
        self.set_stage("updateAvailable", None)
    }

    fn store_latest(self: &Arc<Self>, latest: Latest, min_system: MinSystem) {
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
        inner.min_system = min_system;
        inner.latest = Some(latest);
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
            this.run_download(latest, repo, mirror, target, part, cancel).await;
        });

        Ok(self.dto())
    }

    async fn run_download(
        self: Arc<Self>,
        latest: Latest,
        repo: String,
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

        let candidates = download_candidates(&latest, &repo, &mirror);
        let mut failures: Vec<String> = Vec::new();
        let mut done = false;

        for cand in &candidates {
            if cancel.is_cancelled() {
                self.cancelled();
                return;
            }
            match self
                .fetch_one(&client, cand, &part, latest.asset_size, &cancel)
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
                    // 清单里带了 SHA256 就必须逐字节对上，否则删掉重来。
                    if let Some(expected_hash) = latest.sha256.as_deref() {
                        match sha256_file(&part) {
                            Ok(actual) if actual.eq_ignore_ascii_case(expected_hash.trim()) => {}
                            Ok(actual) => {
                                let _ = std::fs::remove_file(&part);
                                failures.push(format!(
                                    "{} 校验失败（清单 {}，实际 {}）",
                                    cand.label,
                                    short_hash(expected_hash),
                                    short_hash(&actual)
                                ));
                                continue;
                            }
                            Err(e) => {
                                let _ = std::fs::remove_file(&part);
                                failures.push(format!("{} 校验失败：{e}", cand.label));
                                continue;
                            }
                        }
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
}

/// 公开仓库的资产链接才支持前缀加速镜像；自建更新源只用原始地址。
fn download_candidates(latest: &Latest, repo: &str, selected: &str) -> Vec<Candidate> {
    let _ = repo;
    let supports_mirror = latest.browser_url.starts_with("https://github.com/");
    let mut list: Vec<Candidate> = Vec::new();
    if supports_mirror {
        for m in MIRRORS {
            let url = if m.prefix.is_empty() {
                latest.browser_url.clone()
            } else {
                format!("{}{}", m.prefix, latest.browser_url)
            };
            list.push(Candidate { label: m.label, url });
        }
    } else {
        list.push(Candidate { label: "更新源直连", url: latest.browser_url.clone() });
    }
    // 用户选中的镜像排第一，其余按内置顺序兜底。
    if let Some(pos) = MIRRORS.iter().position(|m| m.id == selected) {
        if pos < list.len() && supports_mirror {
            let mut chosen = list.remove(pos);
            chosen.label = "所选镜像";
            list.insert(0, chosen);
        }
    }
    list
}

fn short_hash(hash: &str) -> String {
    let h = hash.trim();
    if h.len() > 16 { format!("{}…", &h[..16]) } else { h.to_string() }
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
            browser_url: "https://github.com/yunyu697/fetchweir/releases/download/v1.0.0/a.exe".into(),
            sha256: Some("00".into()),
            verified: true,
        };
        let list = download_candidates(&latest, DEFAULT_REPO, "ghproxy");
        assert_eq!(list[0].label, "所选镜像");
        assert!(list[0].url.starts_with("https://gh-proxy.com/https://github.com/"));
        assert!(list.iter().any(|c| c.url == latest.browser_url));

        // 自建更新源（非 github.com）不支持前缀镜像，只用原始地址
        let selfhost = Latest {
            browser_url: "https://dl.example.com/fw/a.exe".into(),
            ..latest.clone()
        };
        let list = download_candidates(&selfhost, "self/host", "ghproxy");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].url, "https://dl.example.com/fw/a.exe");
    }

    #[test]
    fn builtin_pubkey_verifies_reference_manifest() {
        // 用与内置公钥配对的私钥对一段固定内容签名；客户端必须能验过，改一个字节必须失败。
        let msg = br#"{"version":"1.0.4","assets":[]}"#;
        let sig = "yMRXH0VLXWTisjEiKktBXH/k71bLiOxs006iUhS7mtYS9kNKFfWojsovxDAdJIJgOVCBA0VlIGi/5weavm1qCw==";
        assert!(verify_manifest(msg, sig).is_ok(), "内置公钥应能验证参考签名");
        let mut tampered = msg.to_vec();
        tampered[0] ^= 0x01;
        assert!(verify_manifest(&tampered, sig).is_err(), "篡改后必须拒绝");
    }

    #[test]
    fn manifest_signature_rejects_tampering() {
        // 用与内置公钥配对的私钥签名，验证「通过 / 改一个字节即失败」。
        // 私钥不入库：这里只用一份测试密钥，验证逻辑本身。
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let msg = br#"{"version":"9.9.9"}"#;
        let sig = kp.sign(msg);
        let sig_b64 = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(sig.as_ref())
        };
        // 直接把测试公钥喂给校验原语：内置常量是另一把密钥，故这里只验证「篡改必失败」。
        use ring::signature::{UnparsedPublicKey, ED25519};
        let ok = UnparsedPublicKey::new(&ED25519, kp.public_key().as_ref()).verify(msg, sig.as_ref());
        assert!(ok.is_ok());
        let mut tampered = msg.to_vec();
        tampered[0] ^= 0x01;
        let bad = UnparsedPublicKey::new(&ED25519, kp.public_key().as_ref())
            .verify(&tampered, sig.as_ref());
        assert!(bad.is_err());
        // 内置公钥无法验证别人签的清单
        assert!(verify_manifest(msg, &sig_b64).is_err());
    }

    #[test]
    fn manifest_asset_selection_prefers_arch() {
        let mk = |platform: &str, arch: &str, name: &str| ManifestAsset {
            platform: platform.into(),
            arch: arch.into(),
            name: name.into(),
            url: format!("https://github.com/o/r/releases/download/v1.0.0/{name}"),
            size: 1,
            sha256: "00".into(),
        };
        let assets = vec![
            mk("windows", "aarch64", "arm.exe"),
            mk("windows", "x86_64", "x64.exe"),
            mk("linux", "x86_64", "x64.deb"),
        ];
        let picked = select_manifest_asset(&assets).unwrap();
        if cfg!(target_os = "windows") {
            assert_eq!(picked.name, "x64.exe");
        } else if cfg!(target_os = "linux") {
            assert_eq!(picked.name, "x64.deb");
        }
    }

    #[test]
    fn unsafe_file_names_are_sanitized() {
        assert_eq!(http_safe_name("a/b:c?.exe"), "a_b_c_.exe");
        assert_eq!(http_safe_name("  ..exe.. "), "exe");
    }
}
