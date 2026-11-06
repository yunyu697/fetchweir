# Fetchweir

跨平台下载管理器（Rust + Tauri 2）。第一轮工程骨架：可编译、可运行、下载主链路可用。

## 技术栈

- 后端：Rust + Tauri 2（Tokio 异步 I/O、reqwest）
- 前端：静态 HTML/CSS/JS（无打包步骤，`frontendDist` 直接指向 `src/`）
- 视频解析：后续以 yt-dlp sidecar 随包，第一轮不接入
- 嗅探：后续以浏览器扩展 + Native Messaging 为主，MITM 代理默认关闭

## 目录

```
.
├── src/                    前端（index.html / styles.css / app.js）
├── src-tauri/              Rust 主进程
│   ├── src/engine/         下载引擎（探测、分段、定位写、限速、速度计）
│   ├── src/commands.rs     Tauri 命令层
│   ├── capabilities/       Tauri 2 权限声明
│   └── tauri.conf.json
├── tools/                  版本号工具（PowerShell）
├── docs/                   技术方案与版本规则
└── version.json            版本号唯一来源
```

## 本地构建

前置：Rust stable（Windows 推荐 MSVC 工具链；本机若只有 GNU 工具链也能编译）、Node 20+（仅用于 `@tauri-apps/cli`）、Windows 需 WebView2 运行时。

```powershell
npm install
npm run dev        # 开发模式
npm run build      # 产物在 src-tauri/target/release/bundle（Windows 打包需 NSIS/WiX）
```

仓库路径含空格时（例如 `D:\Users\Tyler Zhang\...`），`windres` 会因输出路径被按空格拆开而失败；
把 Cargo 目标目录指到无空格位置即可绕开，`tools/Build-Fw.ps1` 已自动处理：

```powershell
$env:CARGO_TARGET_DIR = 'D:\fw-build\fetchweir'
npm run build
```

只有 GNU 工具链的机器（没有 MSVC / Windows SDK）需要额外准备 mingw-w64，提供 `dlltool.exe` 与
`windres.exe`，且安装路径不能含空格（`ld` 会因空格解析失败）；`tools/Build-Fw.ps1` 会自动探测
`D:\fw-tools\mingw64\bin` 与 `%LOCALAPPDATA%\winlibs\mingw64\bin` 并前置到 PATH：

```powershell
pwsh -File ./tools/Build-Fw.ps1 -FwTask test    # 引擎集成测试（本地回环，无 GUI）
pwsh -File ./tools/Build-Fw.ps1 -FwTask bundle  # 打包
```

无头冒烟：设置 `FW_SMOKE=1` 启动产物，窗口保持隐藏；前端加载成功后会通过 `ui_ready` 命令在
数据目录写入 `ui-ready.txt`，可用它判断 WebView 与 IPC 是否正常。

引擎自测：`cargo test --all-targets`（3 个单测 + 3 个本地回环集成测试）；也可以跑
`cargo run --example engine_smoke`，场景与集成测试完全共用（`tests/common/mod.rs`）。
Windows GNU 工具链下测试二进制也需要 Common Controls v6 清单，`build.rs` 会把资源额外链接给
所有目标（否则会以 `STATUS_ENTRYPOINT_NOT_FOUND` 直接退出）。

## 核心链路（已实现）

1. `Range: bytes=0-0` 探测：支持分段则按 `Content-Range` 取总长度并切段，否则退化单连接。
2. 预分配 + 分段顺序写：开始时 `set_len(total)`，每段独占 `[start,end)` 顺序写入，**没有收尾合并步骤**。
3. 断点续传：分段内 `done` 计数保留，暂停后从断点继续；分段级指数退避重试（最多 5 次）。
4. 进度事件：引擎侧 10Hz 合并（`fw://progress`），状态变更走 `fw://task`。
5. 暂停 / 继续 / 取消（可选删文件）/ 完成后打开与定位文件夹。

## 边界

**不实现任何 DRM、付费墙、访问控制的绕过**，包括不对外发布的私有版本。理由与依据见 `docs/download-manager-plan.md` §8.1。

## 版本号

唯一来源是 `version.json`，界面、日志、CI 产物名全部由它派生；格式 `<major>.<minor>.<patch>[-alphaN]`，
**除第一位与 alpha 编号外，其余各位不得超过 10**（构建脚本硬校验，越界直接失败）。

```powershell
pwsh -File ./tools/Test-FwVersion.ps1              # 校验
pwsh -File ./tools/Next-FwVersion.ps1 -FwBump alpha # 预览下一版
pwsh -File ./tools/Next-FwVersion.ps1 -FwBump alpha -FwApply
```

tag 带 `v` 前缀（`v1.0.0-alpha1`），CI 在 tag 触发时校验 tag 与 `version.json` 一致后打包发布。
