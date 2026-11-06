// 核心链路集成测试：真实 HTTP（本地回环）+ 分段下载 + 暂停续传。
// 场景实现放在 common/mod.rs，便于 examples/engine_smoke.rs 复用。
mod common;

use common::TestResult;

#[test]
fn segmented_download_matches_source_bytes() -> TestResult<()> {
    common::segmented_download_matches_source_bytes()
}

#[test]
fn pause_then_resume_keeps_progress() -> TestResult<()> {
    common::pause_then_resume_keeps_progress()
}

#[test]
fn rejects_non_http_scheme() -> TestResult<()> {
    common::rejects_non_http_scheme()
}
