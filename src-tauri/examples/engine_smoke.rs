// 本地冒烟入口：与 tests/engine_core.rs 共用同一套场景。
// 用途：Windows GNU 工具链下测试二进制可能因 comctl32 v6 清单缺失而无法加载，
// 这里用 example（能正确嵌入清单）跑同样的核心链路验证。
//
//   cargo run --example engine_smoke
#[path = "../tests/common/mod.rs"]
mod common;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("[1/3] 分段下载结果与源文件字节一致 ...");
    common::segmented_download_matches_source_bytes()?;
    println!("      ok");

    println!("[2/3] 暂停后继续下载并保持进度 ...");
    common::pause_then_resume_keeps_progress()?;
    println!("      ok");

    println!("[3/3] 拒绝非 http/https 链接 ...");
    common::rejects_non_http_scheme()?;
    println!("      ok");

    println!("ALL PASSED");
    Ok(())
}
