// HTTP 探测与文件名处理。
use reqwest::header::{ACCEPT_ENCODING, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::Client;
use tokio_util::sync::CancellationToken;

use super::EngineError;

pub struct ProbeMeta {
    pub total: u64,
    pub ranges: bool,
    pub file_name: Option<String>,
    pub final_url: String,
}

pub fn validate_url(raw: &str) -> Result<(), EngineError> {
    let parsed = url::Url::parse(raw.trim()).map_err(|e| EngineError::InvalidUrl(e.to_string()))?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        _ => Err(EngineError::UnsupportedScheme),
    }
}

/// 先用 `Range: bytes=0-0` 探测：能拿 206 说明支持分段，同时从
/// `Content-Range` 得到总长度；不支持时退化为单连接直连。
pub async fn probe(
    client: &Client,
    raw_url: &str,
    token: &CancellationToken,
) -> Result<ProbeMeta, EngineError> {
    let resp = tokio::select! {
        _ = token.cancelled() => return Err(EngineError::Aborted),
        r = client
            .get(raw_url)
            .header(RANGE, "bytes=0-0")
            .header(ACCEPT_ENCODING, "identity")
            .send() => r?,
    };

    let status = resp.status();
    let final_url = resp.url().to_string();
    let headers = resp.headers().clone();

    let file_name = headers
        .get(CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_disposition_filename)
        .map(|n| sanitize_file_name(&n))
        .or_else(|| {
            let guessed = guess_file_name(&final_url);
            if guessed.is_empty() {
                None
            } else {
                Some(guessed)
            }
        });

    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let total = headers
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_total)
            .unwrap_or(0);
        return Ok(ProbeMeta {
            total,
            ranges: total > 0,
            file_name,
            final_url,
        });
    }

    if status.is_success() {
        let total = headers
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        return Ok(ProbeMeta {
            total,
            ranges: false,
            file_name,
            final_url,
        });
    }

    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let total = headers
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0);
        return Ok(ProbeMeta {
            total,
            ranges: total > 0,
            file_name,
            final_url,
        });
    }

    Err(EngineError::Http(format!("HTTP {status}")))
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    // bytes 0-0/12345
    value.rsplit('/').next()?.trim().parse::<u64>().ok()
}

fn parse_disposition_filename(value: &str) -> Option<String> {
    // 优先 filename*=UTF-8''xxx，其次 filename="xxx"
    if let Some(idx) = value.to_ascii_lowercase().find("filename*=") {
        let rest = &value[idx + "filename*=".len()..];
        let rest = rest.split(';').next().unwrap_or(rest);
        let encoded = rest
            .rsplit_once("''")
            .map(|(_, v)| v)
            .unwrap_or(rest)
            .trim()
            .trim_matches('"');
        let decoded = percent_decode(encoded);
        if !decoded.trim().is_empty() {
            return Some(decoded);
        }
    }
    if let Some(idx) = value.to_ascii_lowercase().find("filename=") {
        let rest = &value[idx + "filename=".len()..];
        let rest = rest.split(';').next().unwrap_or(rest).trim();
        let decoded = percent_decode(rest.trim_matches('"'));
        if !decoded.trim().is_empty() {
            return Some(decoded);
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn guess_file_name(raw_url: &str) -> String {
    let parsed = match url::Url::parse(raw_url) {
        Ok(p) => p,
        Err(_) => return String::new(),
    };
    let last = parsed
        .path_segments()
        .and_then(|s| s.filter(|p| !p.is_empty()).last())
        .map(|s| s.to_string())
        .unwrap_or_default();
    percent_decode(&last)
}

/// 去掉 Windows 非法字符、保留扩展名、避免空白文件名。
pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "download.bin".to_string();
    }

    let stem_upper = trimmed.to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let base = stem_upper.split('.').next().unwrap_or("");
    let mut out = if reserved.contains(&base) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    };

    if out.chars().count() > 180 {
        let ext = std::path::Path::new(&out)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let stem: String = out.chars().take(180 - ext.chars().count()).collect();
        out = format!("{stem}{ext}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_extension_and_strips_illegal() {
        assert_eq!(sanitize_file_name("a<b>:c?.mp4"), "a_b__c_.mp4");
        assert_eq!(sanitize_file_name("   "), "download.bin");
        assert_eq!(sanitize_file_name("con.txt"), "_con.txt");
    }

    #[test]
    fn disposition_prefers_rfc5987() {
        let v = "attachment; filename=\"fallback.mp4\"; filename*=UTF-8''%E8%A7%86%E9%A2%91.mp4";
        assert_eq!(parse_disposition_filename(v).as_deref(), Some("视频.mp4"));
    }

    #[test]
    fn content_range_total_parsed() {
        assert_eq!(parse_content_range_total("bytes 0-0/1048576"), Some(1048576));
    }
}
