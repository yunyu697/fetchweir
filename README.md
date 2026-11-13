# Fetchweir

跨平台下载管理器（Rust + Tauri 2）。分段并发下载、断点续传、浏览器扩展资源嗅探、视频格式解析与音轨合并（yt-dlp + ffmpeg sidecar）。
目前**只发布 Windows x64**；macOS / Linux 仅通过 CI 的编译与单测，产物未构建、运行时未验证。

当前版本 **1.0.5**。发布说明见 [docs/release-notes-v1.0.5.md](docs/release-notes-v1.0.5.md)，
其中区分「已实测 / 未验证 / 被环境挡住」并写明原因。

**发布口径**：推送 tag 后 CI 构建两个安装范围包并上传 Release（`.github/workflows/release.yml`），
同时校验两包字节不同与内嵌执行级别（`asInvoker` / `requireAdministrator`）。
CI 只构建 **Windows x64**：macOS 缺 arm64 版 ffmpeg sidecar 且没有公证/签名流程，
Linux 的 deb/AppImage 安装路径未实测，不做"看起来支持"的产物。
仓库未配置 `FW_SIGNING_KEY` 时，流水线会显式标注本次为**未签名发布**，客户端检测不到该版本。

## 平台支持矩阵（只写实测到的）

| 平台 | CI 验证到哪一步 | 本版产物 | 实际可用性 |
| --- | --- | --- | --- |
| Windows x64（MSVC） | `cargo check` + 单测；安装包、GUI、更新、扩展均在本机实测 | `setup.exe` / `setup-allusers.exe` | 可用 |
| macOS（CI 为 aarch64） | `cargo check` + 单测通过；未运行 GUI、未打包、未签名/公证 | 无 | 未验证，不可分发 |
| Linux x64（CI 为 ubuntu-22.04，glibc 2.35） | `cargo check` + 单测通过；未在桌面环境启动、未打包 deb/AppImage | 无 | 未验证，不可分发 |

- 「CI 三平台都过」只代表同一份 Rust 代码在三个平台**能编译、单测能过**，不包含运行时验证
  （WebView 启动、托盘、Native Messaging 注册、系统级安装、代码签名与公证）。
- 非 Windows 的路径（数据目录、Native Messaging 注册、安装范围识别）是 `cfg` 分支，
  CI 只做编译检查，从未实际执行；macOS 公证与 Linux 各发行版差异均无结论。

## 完成度（如实分级）

| 级别 | 内容 |
| --- | --- |
| 已实现且本机实测 | 分段下载引擎与断点续传（本地回环集成测试）、限速与队列调度（含 4 任务同下的全局降档/回退实测）、任务表/详情/视频/嗅探/设置五屏渲染（无头截图，0 console error）、两种安装范围（1.0.4 安装包：currentUser 1.0.2→1.0.4 静默升级、perMachine 安装→核对 Program Files/HKLM/公共快捷方式→卸载清理）、自启动开关（注册表与计划任务实测）、「始终以管理员身份运行」（令牌 `TokenIsElevated` + 完整性级别 `S-1-16-12288` 确认提权，计划任务 `RunLevel=HighestAvailable`，关闭后恢复普通权限）、单实例（普通与提权状态下第二实例退出码 0 且参数转发到达首实例）、扩展三档嗅探与浮动条（真实 Chromium 加载扩展，8/8 通过，2026-11-07）、引擎内存卡（PSAPI 工作集，真实应用实测 41.4 MB）、设置页导出配置（真实应用写出 JSON，更新令牌清空）、托盘实拍 |
| 已实现、未做全链路实机 | 更新检查与镜像下载（Ed25519 清单验签 + SHA256 校验；应用内 GUI 全流程已用真实 Release 作源实测：检查 → 发现新版本 → 下载 → SHA256 → 落盘，逐阶段截图；镜像加速下载未逐一实测） |
| 已实现且真实站点实测 | 视频解析 → 选档 → 下载 → ffprobe 校验：Bilibili（15 档矩阵，1080p H.264 纯视频流 + 最佳音轨自动合并、纯音频档）、archive.org（直链整文件走自家引擎），界面字段与 yt-dlp `-J` 逐档一致；YouTube/Vimeo 无登录态时被 bot 校验 / 403 挡住。YouTube 现可选浏览器 Cookie 或本地 cookies.txt（默认不使用），但本机无可用登录态、成功路径未验证，见 [docs/视频站点实测.md](docs/视频站点实测.md) 与 [docs/视频解析-Cookie来源.md](docs/视频解析-Cookie来源.md) |
| 未接通（界面禁用并标注） | 字幕轨下载、解析器独立更新、通知中心、原生拖放导入 |
| 平台受限 | macOS 公证、Linux 发行版差异与系统级安装（本机与 CI 未验证）；v1.0.5 未构建 dmg/deb/AppImage（macOS 缺 arm64 ffmpeg sidecar 与公证流程，Linux 安装路径未实测） |

## 技术栈

- 后端：Rust + Tauri 2（Tokio、reqwest、windows-sys）
- 前端：静态 HTML/CSS/JS（无打包步骤，`frontendDist` 指向 `src/`）
- 视频解析与合并：yt-dlp、ffmpeg 作为 sidecar 随包（`src-tauri/binaries/`）；首次构建前跑 `tools/Sync-FwYtdlp.ps1` 与 `tools/Sync-FwFfmpeg.ps1`
- 嗅探：Chrome MV3 扩展 + Native Messaging（stdio 帧），本地回环地址仅绑定 `127.0.0.1`

不做任何 DRM / 付费墙 / 访问控制绕过；受保护流在解析阶段直接拒绝并在界面标注。

## 构建与测试

前置：Rust stable、Node 20+、Windows 需 WebView2 运行时。仓库路径含空格时必须把目标目录指到无空格位置，
`tools/Build-Fw.ps1` 已自动设置 `CARGO_TARGET_DIR`：

```powershell
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask check    # 编译检查（含测试目标）
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask test     # 引擎集成测试（本地回环，无 GUI）
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask build    # 调试二进制
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask bundle   # 只打当前用户安装包
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask bundle -FwScope perMachine   # 只打所有用户安装包
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask release  # 一条命令：两种安装范围 → dist，并打印 SHA256
```

`-FwTask release` 会先构建 currentUser 包、再构建 perMachine 包，把
`Fetchweir_<version>_x64-setup.exe` 与 `Fetchweir_<version>_x64-setup-allusers.exe`
复制到仓库根目录 `dist/`，并在终端输出版本号、字节数与 SHA256。版本号取自
`version.json`，不需要额外参数。

无头验证：

```powershell
node tools/Verify-FwUI.mjs "file:///.../src/index.html?demo" docs/ui-shots/app-main.png 1280 800
node tools/Test-FwBrowser.mjs D:\fw-build\fetchweir\debug\fetchweir.exe   # 真实 Chromium 三档嗅探 + 浮动条
node tools/Inspect-FwExeIcon.mjs         # exe 图标资源清单
```

版本号唯一来源 `version.json`；`tools/Test-FwVersion.ps1` 校验规则，`tools/Next-FwVersion.ps1` 推进。

## 安装范围与数据目录

Windows 默认「仅当前用户」安装：程序在 `%LOCALAPPDATA%\Fetchweir`，数据在 `%APPDATA%\Fetchweir`，
卸载不会删除设置与记录。「所有用户」安装包需要 UAC。macOS / Linux / Flatpak 的差异、
提权开关与 UIPI 限制见 [docs/安装范围与权限.md](docs/安装范围与权限.md)。

## 浏览器扩展

1. 打开 `chrome://extensions`，开启开发者模式，选择「加载已解压的扩展程序」→ `extension/`。
2. 扩展 ID 由 manifest 里的 `key` 决定，固定为 `fjngndhalbkfkfcfhleflcgkicknkele`。
3. 应用启动时会幂等注册 Native Messaging 宿主清单（Chrome/Chromium/Edge/Firefox 六处注册表键）。
4. 扩展三档：A 主动浮动条、B 徽标+右键、C 仅记录；在「资源嗅探」页可切换。

Firefox（140+）：`pwsh tools/Build-FwExtensionFirefox.ps1` 生成 `dist/extension-firefox/`，
打开 `about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选该目录的 `manifest.json`。
gecko id 固定为 `fetchweir@yunyu697`，与 Native Messaging 的 `allowed_extensions` 配对；
清单已通过 `web-ext lint`（0 error / 0 warning），运行时往返尚未联调。

## 已知限制

- **安装包未做代码签名**：项目暂无代码签名证书，`Fetchweir_*_x64-setup.exe` 以未签名形式发布。
  新用户首次运行会触发 Windows SmartScreen 拦截，需点「更多信息」→「仍要运行」才能继续；
  请只从本仓库 Releases 页下载，不要从第三方站点获取。
- **浏览器扩展需要手动加载**：发布包内没有"已安装"的扩展，也没有一键安装入口；
  必须解压扩展目录后，在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」。
  Native Messaging 宿主清单由应用自动注册，这一步不需要手动改注册表。
- `windows-gnu` 链接器会报 `.rsrc merge failure: multiple non-default manifests`：rustc 默认清单与
  Tauri 的 Common-Controls 清单同为资源 id 1，保留前者；不使用 Win32 通用控件对话框，功能不受影响。
- 连接明细不展示分连接速率：后端只上报任务总速率，界面不做平均分配造假。
- 关闭窗口是否驻留后台、自启动、管理员运行等开关在设置页真实生效；未接通的按钮一律禁用并标注「未生效」。
- 界面与设计稿的逐屏差异见 [docs/界面还原对照.md](docs/界面还原对照.md)。
