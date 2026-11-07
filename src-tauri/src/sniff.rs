// 资源嗅探存储：去重、保护性判定与生命周期管理。
// 只放内存：Cookie 与页面上下文不落盘，应用退出即清空（对齐方案 §5.5 隐私口径）。
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

const MAX_ITEMS: usize = 500;
/// 默认保留 24 小时，与方案 §5.4 一致。
pub const DEFAULT_TTL_MS: i64 = 24 * 60 * 60 * 1000;

const DROP_PARAMS: &[&str] = &[
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "ref", "spm", "_t", "from",
];
const KEEP_PARAMS: &[&str] = &[
    "token", "expires", "sig", "signature", "key", "auth", "hdnts", "md5", "e",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SniffItem {
    /// 去重键的短哈希，同时作为前端操作句柄。
    pub id: String,
    pub url: String,
    pub page_url: String,
    pub page_title: String,
    pub browser: String,
    /// video / audio / hls / dash / image / doc / archive / file
    pub kind: String,
    pub mime: String,
    pub size: u64,
    pub ranges: bool,
    /// 扩展侧的受保护迹象（MIME/URL 命中 DRM 特征）。
    pub drm_suspect: bool,
    /// 应用侧抓取清单后的判定结论。
    pub protected: bool,
    pub note: Option<String>,
    pub disposition: String,
    pub cookie: String,
    pub referer: String,
    pub ua: String,
    pub tab_id: i64,
    pub source: String,
    pub at: i64,
    pub hits: u32,
}

impl Default for SniffItem {
    fn default() -> Self {
        Self {
            id: String::new(),
            url: String::new(),
            page_url: String::new(),
            page_title: String::new(),
            browser: String::new(),
            kind: "file".to_string(),
            mime: String::new(),
            size: 0,
            ranges: false,
            drm_suspect: false,
            protected: false,
            note: None,
            disposition: String::new(),
            cookie: String::new(),
            referer: String::new(),
            ua: String::new(),
            tab_id: 0,
            source: String::new(),
            at: 0,
            hits: 0,
        }
    }
}

impl SniffItem {
    /// 补齐派生字段：id、kind、at。
    pub fn normalize(&mut self, now_ms: i64) {
        if self.at <= 0 {
            self.at = now_ms;
        }
        self.kind = normalize_kind(&self.url, &self.mime, &self.kind);
        if self.id.is_empty() {
            self.id = short_id(&canonical(&self.url));
        }
    }
}

fn normalize_kind(url: &str, mime: &str, given: &str) -> String {
    let m = mime.to_ascii_lowercase();
    let path = url::Url::parse(url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_else(|_| url.to_ascii_lowercase());
    if m.contains("mpegurl") || path.ends_with(".m3u8") {
        return "hls".to_string();
    }
    if m.contains("dash+xml") || path.ends_with(".mpd") {
        return "dash".to_string();
    }
    if m.starts_with("video/") {
        return "video".to_string();
    }
    if m.starts_with("audio/") {
        return "audio".to_string();
    }
    if m.starts_with("image/") {
        return "image".to_string();
    }
    let known = matches!(given, "video" | "audio" | "hls" | "dash" | "image" | "doc" | "archive" | "file");
    if known {
        given.to_string()
    } else {
        "file".to_string()
    }
}

/// scheme + 小写 host + path + 仅保留签名类查询参数；与扩展侧算法一致。
pub fn canonical(raw: &str) -> String {
    let Ok(u) = url::Url::parse(raw) else {
        return raw.to_string();
    };
    let mut keep: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !DROP_PARAMS.contains(&k.as_str())
                && (KEEP_PARAMS.contains(&k.as_str()) || k.starts_with("x-"))
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    keep.sort();
    let query = keep
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let path = {
        let p = u.path().trim_end_matches('/');
        if p.is_empty() { "/".to_string() } else { p.to_string() }
    };
    format!(
        "{}://{}{}{}",
        u.scheme(),
        u.host_str().unwrap_or("").to_ascii_lowercase(),
        path,
        if query.is_empty() { String::new() } else { format!("?{query}") }
    )
}

fn short_id(input: &str) -> String {
    let mut h = DefaultHasher::new();
    input.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub struct SniffStore {
    items: Mutex<Vec<SniffItem>>,
}

impl SniffStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { items: Mutex::new(Vec::new()) })
    }

    /// 入队（去重）。返回被写入的条目快照；重复条目只累加命中次数。
    pub fn push(&self, mut item: SniffItem) -> Option<SniffItem> {
        if item.url.trim().is_empty() {
            return None;
        }
        item.normalize(now());
        let id = item.id.clone();
        let mut items = self.items.lock().unwrap();
        if let Some(prev) = items.iter_mut().find(|x| x.id == id) {
            prev.hits += 1;
            prev.at = item.at;
            if item.size > 0 {
                prev.size = item.size;
            }
            if prev.page_title.is_empty() && !item.page_title.is_empty() {
                prev.page_title = item.page_title;
            }
            if prev.cookie.is_empty() && !item.cookie.is_empty() {
                prev.cookie = item.cookie;
            }
            return Some(prev.clone());
        }
        item.hits = 1;
        items.push(item.clone());
        while items.len() > MAX_ITEMS {
            items.remove(0);
        }
        Some(item)
    }

    pub fn list(&self) -> Vec<SniffItem> {
        let items = self.items.lock().unwrap();
        let mut out: Vec<SniffItem> = items.clone();
        out.sort_by_key(|x| -x.at);
        out
    }

    pub fn get(&self, id: &str) -> Option<SniffItem> {
        self.items.lock().unwrap().iter().find(|x| x.id == id).cloned()
    }

    pub fn remove(&self, id: &str) -> bool {
        let mut items = self.items.lock().unwrap();
        let before = items.len();
        items.retain(|x| x.id != id);
        items.len() != before
    }

    pub fn clear(&self) -> usize {
        let mut items = self.items.lock().unwrap();
        let n = items.len();
        items.clear();
        n
    }

    pub fn mark_protected(&self, id: &str, note: String) {
        if let Some(item) = self.items.lock().unwrap().iter_mut().find(|x| x.id == id) {
            item.protected = true;
            item.note = Some(note);
        }
    }

    pub fn prune(&self, ttl_ms: i64) -> usize {
        let cutoff = now() - ttl_ms;
        let mut items = self.items.lock().unwrap();
        let before = items.len();
        items.retain(|x| x.at >= cutoff);
        before - items.len()
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 清单保护性判定结果。
#[derive(Clone, Debug, PartialEq)]
pub enum Protection {
    Clear,
    Protected(String),
}

/// 抓取 HLS/DASH 清单，只做"是否受保护"的判定，不做任何解密或密钥获取。
pub async fn inspect_manifest(
    client: &reqwest::Client,
    item: &SniffItem,
) -> Protection {
    let headers: Vec<(String, String)> = vec![
        ("referer".to_string(), item.referer.clone()),
        ("cookie".to_string(), item.cookie.clone()),
        ("user-agent".to_string(), item.ua.clone()),
    ];
    let req = crate::engine::http::with_headers(client.get(&item.url), &headers);
    let resp = match tokio::time::timeout(std::time::Duration::from_secs(10), req.send()).await {
        Ok(Ok(r)) if r.status().is_success() => r,
        _ => return Protection::Clear,
    };
    let body = match tokio::time::timeout(std::time::Duration::from_secs(10), resp.text()).await {
        Ok(Ok(t)) => t,
        _ => return Protection::Clear,
    };
    if body.len() > 8 * 1024 * 1024 {
        return Protection::Clear;
    }
    let upper = body.to_ascii_uppercase();
    if upper.contains("<CONTENTPROTECTION") {
        return Protection::Protected("清单含 ContentProtection，判定为受保护内容".to_string());
    }
    for line in body.lines() {
        let l = line.trim();
        if l.starts_with("#EXT-X-KEY") || l.starts_with("#EXT-X-SESSION-KEY") {
            let u = l.to_ascii_uppercase();
            let strong = u.contains("SAMPLE-AES")
                || u.contains("KEYFORMAT=\"COM.APPLE.STREAMINGKEYDELIVERY")
                || u.contains("KEYFORMAT=\"URN:UUID:")
                || u.contains("WIDEVINE")
                || u.contains("PLAYREADY");
            if strong {
                return Protection::Protected(
                    "流使用样本级加密/DRM 密钥体系（非 AES-128 常规封装），按产品边界不提供下载"
                        .to_string(),
                );
            }
        }
    }
    Protection::Clear
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_drops_tracking_keeps_signature() {
        let a = canonical("https://CDN.Example.com/a/b/file.mp4?utm_source=x&token=abc&sig=zz&ref=home");
        let b = canonical("https://cdn.example.com/a/b/file.mp4?sig=zz&token=abc");
        assert_eq!(a, b);
    }

    #[test]
    fn dedupe_accumulates_hits() {
        let store = SniffStore::new();
        let mut item = SniffItem {
            url: "https://example.com/v.mp4?t=1".to_string(),
            kind: "video".to_string(),
            size: 100,
            ..Default::default()
        };
        store.push(item.clone());
        item.url = "https://example.com/v.mp4?t=1&utm_source=x".to_string();
        store.push(item);
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].hits, 2);
    }

    #[test]
    fn kind_from_manifest_url() {
        assert_eq!(normalize_kind("https://x/a.m3u8", "", ""), "hls");
        assert_eq!(normalize_kind("https://x/a.mpd", "", ""), "dash");
        assert_eq!(normalize_kind("https://x/a.mp4", "video/mp4", ""), "video");
    }

    #[test]
    fn prune_removes_expired() {
        let store = SniffStore::new();
        store.push(SniffItem {
            url: "https://example.com/old.bin".to_string(),
            at: now() - 2 * DEFAULT_TTL_MS,
            ..Default::default()
        });
        store.push(SniffItem {
            url: "https://example.com/new.bin".to_string(),
            ..Default::default()
        });
        assert_eq!(store.prune(DEFAULT_TTL_MS), 1);
        assert_eq!(store.list().len(), 1);
    }
}
