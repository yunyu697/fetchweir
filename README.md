# Fetchweir

跨平台下载管理器（Rust + Tauri 2）。分段并发下载、断点续传、浏览器扩展资源嗅探、视频格式解析（yt-dlp sidecar）。

## 完成度（如实分级）

| 级别 | 内容 |
| --- | --- |
| 已实现且本机实测 | 分段下载引擎与断点续传（本地回环集成测试）、限速与队列调度、任务表/详情/视频/嗅探/设置五屏渲染（无头截图，0 console error）、Windows 用户级安装与卸载、自启动开关（注册表实测）、扩展三档嗅探（真实 Chromium 加载扩展验证） |
| 已实现、未做全链路实机 | 更新检查与镜像下载（字节数校验，无签名校验）、yt-dlp 视频解析（本地样例，真实站点未跑）、提权开关（代码路径完成，开启需 UAC 未实测）、所有用户安装包（CI 产出，本机未安装） |
| 未接通（界面禁用并标注） | 字幕轨下载、解析器独立更新、导出配置、通知中心、原生拖放导入 |
| 平台受限 | macOS 公证、Linux 发行版差异与系统级安装（本机与 CI 未验证） |

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
pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask bundle   # 安装包（Windows 产出 NSIS）
```

无头验证：

```powershell
node tools/Verify-FwUI.mjs "file:///.../src/index.html?demo" docs/ui-shots/app-main.png 1280 800
node tools/Test-FwBrowser.mjs            # 真实 Chromium 三档嗅探 + 浮动条
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
