// 构建脚本：把 version.json 作为唯一版本来源注入到编译期常量。
// 硬校验：major 不限；minor / patch 必须 0–10（不允许出现 11）；alpha 编号不限。
use std::path::Path;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let version_file = root.join("version.json");
    println!("cargo:rerun-if-changed={}", version_file.display());

    let raw = std::fs::read_to_string(&version_file)
        .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", version_file.display()));
    let json: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} 不是合法 JSON: {e}", version_file.display()));
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{} 缺少 version 字段", version_file.display()))
        .trim()
        .to_string();

    validate_version(&version);
    println!("cargo:rustc-env=FETCHWEIR_VERSION={version}");

    tauri_build::build();

    // tauri-build 只把 Windows 资源（含 Common Controls v6 清单）链接进 bin，
    // windows-gnu 下测试 / example 二进制不会从 libresource.a 里拉取该资源对象，
    // 于是退回 comctl32 v5，因 TaskDialogIndirect 缺失而无法启动
    // （STATUS_ENTRYPOINT_NOT_FOUND）。这里把已生成的 resource.rc 编译成 COFF
    // 目标文件补给它。
    // 只能用 -tests / -examples 限定作用域：如果对所有目标追加，bin 会同时拿到
    // tauri 的 resource 对象和这份副本，ld 报 duplicate leaf ICON/GROUP_ICON，
    // 图标资源可能被丢弃。
    // windows-msvc 不需要：link.exe 会把 resource.lib 一并转换，清单已在其中；
    // 再加 /MANIFESTINPUT 会与它冲突（CVT1100 duplicate resource MANIFEST）。
    #[cfg(windows)]
    link_resource_for_non_bin_targets();
}

#[cfg(windows)]
fn link_resource_for_non_bin_targets() {
    if std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default() != "gnu" {
        return;
    }
    let out_dir = match std::env::var("OUT_DIR") {
        Ok(v) => std::path::PathBuf::from(v),
        Err(_) => return,
    };
    let rc = out_dir.join("resource.rc");
    if !rc.exists() {
        return;
    }
    let obj = out_dir.join("resource-all.coff.o");
    let ok = std::process::Command::new("windres")
        .arg("-i")
        .arg(&rc)
        .arg("-o")
        .arg(&obj)
        .arg("--output-format=coff")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        println!("cargo:rustc-link-arg-tests={}", obj.display());
        println!("cargo:rustc-link-arg-examples={}", obj.display());
    }
}

/// 与 docs/版本号规则.md 一致的硬校验，任何越界都直接让构建失败。
fn validate_version(version: &str) {
    let (numeric, alpha) = match version.split_once("-alpha") {
        Some((n, a)) => (n, Some(a)),
        None => (version, None),
    };

    if let Some(alpha) = alpha {
        if alpha.is_empty() || !alpha.chars().all(|c| c.is_ascii_digit()) {
            panic!("alpha 编号必须是纯数字，当前为 {version}");
        }
    }

    let parts: Vec<&str> = numeric.split('.').collect();
    if parts.len() != 3 {
        panic!("版本号必须是 <major>.<minor>.<patch>[-alphaN]，当前为 {version}");
    }
    if !parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        panic!("版本号各段必须是纯数字，当前为 {version}");
    }

    let minor: u32 = parts[1].parse().expect("minor 解析失败");
    let patch: u32 = parts[2].parse().expect("patch 解析失败");
    if minor > 10 || patch > 10 {
        panic!(
            "版本号越界：除第一位与 alpha 编号外，其余各位不得超过 10，当前 {version}（minor={minor}, patch={patch}）"
        );
    }
}
