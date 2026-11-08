# Fetchweir

跨平台下载管理器（Rust + Tauri 2）。分段并发下载、断点续传、浏览器扩展资源嗅探、视频格式解析（yt-dlp sidecar）。

当前版本 **1.0.4**。发布说明见 [docs/release-notes-v1.0.4.md](docs/release-notes-v1.0.4.md)，
其中区分「已实测 / 未验证 / 被环境挡住」并写明原因。

**发布口径**：CI 在 tag 上只校验 `version.json`，**不打包、不上传**；安装包在本地构建，
Release 由本地产物手动创建（`gh release create` 上传安装包与签名清单）。
本轮**只构建了 Windows x64**（currentUser / perMachine 两个包），macOS dmg 与 Linux
deb/AppImage **未在本地构建**，因此本次 Release 里没有这两个平台的产物。
构建命令见下方「构建与测试」。

## 完成度（如实分级）

| 级别 | 内容 |
| --- | --- |
| 已实现且本机实测 | 分段下载引擎与断点续传（本地回环集成测试）、限速与队列调度、任务表/详情/视频/嗅探/设置五屏渲染（无头截图，0 console error）、两种安装范围（仅当前用户 / 所有用户，均用 1.0.0 安装包实测安装→核对→卸载清理）、自启动开关（注册表与计划任务实测）、「始终以管理员身份运行」（令牌 `TokenIsElevated` + 完整性级别 `S-1-16-12288` 确认提权，计划任务 `RunLevel=HighestAvailable`，关闭后恢复普通权限）、单实例（普通与提权状态下第二实例退出码 0 且参数转发到达首实例）、扩展三档嗅探与浮动条（真实 Chromium 加载扩展，8/8 通过，2026-11-07）、引擎内存卡（PSAPI 工作集，真实应用实测 41.4 MB）、设置页导出配置（真实应用写出 JSON，更新令牌清空）、托盘实拍 |
| 已实现、未做全链路实机 | 更新检查与镜像下载（Ed25519 清单验签 + SHA256 校验，本地静态源闭环实测；默认源为公开主仓库 `yunyu697/fetchweir` 的 Release 资产，签名清单随 v1.0.4 发布）、yt-dlp 视频解析（本地样例，真实站点未跑） |
| 未接通（界面禁用并标注） | 字幕轨下载、解析器独立更新、通知中心、原生拖放导入 |
| 平台受限 | macOS 公证、Linux 发行版差异与系统级安装（本机与 CI 未验证）；v1.0.4 未构建 dmg/deb/AppImage |

## 技术栈

- 后端：Rust + Tauri 2（Tokio、reqwest、windows-sys）
- 前端：静态 HTML/CSS/JS（无打包步骤，`frontendDist` 指向 `src/`）
- 视频解析：yt-dlp 作为 sidecar 随包（`src-tauri/binaries/yt-dlp.exe`）
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

## 已知限制

- `windows-gnu` 链接器会报 `.rsrc merge failure: multiple non-default manifests`：rustc 默认清单与
  Tauri 的 Common-Controls 清单同为资源 id 1，保留前者；不使用 Win32 通用控件对话框，功能不受影响。
- 连接明细不展示分连接速率：后端只上报任务总速率，界面不做平均分配造假。
- 关闭窗口是否驻留后台、自启动、管理员运行等开关在设置页真实生效；未接通的按钮一律禁用并标注「未生效」。
- 界面与设计稿的逐屏差异见 [docs/界面还原对照.md](docs/界面还原对照.md)。
