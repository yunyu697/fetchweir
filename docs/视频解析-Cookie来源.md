# 视频解析：Cookie 来源（2026-11-13）

YouTube 等站点在未登录或不带登录态时会给 `Sign in to confirm you're not a bot`。
本页记录应用里新增的 Cookie 来源能力、边界与**本机实测结果**，不包含任何绕过站点验证的做法。

## 设置项

设置 → 视频与格式 → Cookie 来源，默认「不使用」，保持原有行为：

| 来源 | 传参 | 说明 |
| --- | --- | --- |
| 不使用 | 无 | 默认；解析失败时给人机校验/登录/403 的可操作引导 |
| 从浏览器读取 | `--cookies-from-browser <browser>[:profile]` | 浏览器可选 Chrome / Edge / Firefox / Brave / Vivaldi；profile 留空用默认，也可填目录名或完整路径 |
| 本地 cookies.txt | `--cookies <path>` | 系统文件选择或手填路径，路径随设置保存 |

来源只在本地传给解析器：Cookie 内容不写进设置、日志，也不复制到应用数据目录。
`settings.json` 里只有来源、浏览器名、profile 与 cookies.txt 路径。

### 不可用时的回退

- cookies.txt 被删、不是文件或打不开：设置页状态行直接显示「不存在 / 无法读取」，
  标签变为「回退为不使用」；解析与下载本次按「不使用」执行，并在结果里带一条警告。
- 浏览器来源不在这里预检：真正读取时由解析器报错（见下表的实测）。

## 本机实测（yt-dlp 2026.10.26，Windows x64）

用出问题的同一条视频 `-yqNI2GfXMQ` 直连测试，命令行等价于应用下发的参数：

| 来源 | 结果 | 原始报错 |
| --- | --- | --- |
| 不使用 | 复现用户原始错误 | `ERROR: [youtube] -yqNI2GfXMQ: Sign in to confirm you're not a bot...` |
| Chrome | **不可用** | `ERROR: Failed to decrypt with DPAPI. See .../issues/10927`（App-Bound Encryption） |
| Edge | **未完成验证** | `ERROR: Could not copy Chrome cookie database. See .../issues/7271`；测试时 Edge 正在使用（有打开的窗口），Cookie 库被占用，不能关掉用户的浏览器去重试 |
| Firefox | 能读库，但**没有登录态** | 该 profile 没有 `cookies.sqlite`，解析器只能空手请求，仍被人机校验挡住 |
| Brave / Vivaldi | **未安装** | 无法验证 |

结论：本机没有任何可用于 YouTube 的登录 Cookie，因此**成功解析/下载路径未验证**，不编造成功结果。
Chromium 系（Chrome/Edge/Brave/Vivaldi）在 Windows 上还受 App-Bound Encryption 影响，
Chrome 已明确失败；Firefox 的读取路径本身可用（cookies.txt 导出同样可用），前提是该 profile 实际登录过站点。

## 错误引导

解析失败时后端识别 stderr 特征，返回 `FW_AUTH::<类别>` + 原始 stderr：
`bot`（`Sign in to confirm ... not a bot`）、`login`（登录/年龄限制）、`forbidden`（403）。
视频页显示对应引导与「前往设置选择 Cookie 来源」按钮（跳到视频设置并聚焦来源选择），
原始错误收进「查看原始错误」折叠区；下载任务失败时也会把最后一条认证类 stderr 换成同样的引导。

同时给解析器加了 `--encoding utf-8`：管道输出默认走系统 ANSI 代码页，
否则原始错误里的 `’` 会变成乱码（`you��re`）。

## 证据

离屏脚本 `tools/Test-FwCookie.mjs`（`FW_SMOKE=1` + WebView2 CDP，不抢前台）：

- 默认来源 → 界面出现引导文案、原始错误在详情里、空态不再直接展示 stderr；
- cookies.txt 指向不存在的路径 → 设置保存成功、状态行提示回退；
- 浏览器 + 不存在的 profile → yt-dlp 报错里出现 `NoSuchProfileFwTest`，证明 profile 确实从设置传到了解析器；
- 直链 mp4 + 缺失的 cookies.txt → 仍能解析成功，并弹出「已回退为不使用 Cookie」。

结果与截图：`docs/ui-shots/cookie-result.json`、`cookie-auth-guidance.png`、
`cookie-settings-file-missing.png`、`cookie-browser-profile-error.png`、`cookie-fallback-direct.mp4.png`。

复跑：

```powershell
node tools/Test-FwCookie.mjs '<debug 或 release 的 fetchweir.exe>'
```

## 仍然没做到的

- 有登录态的真实成功路径（解析 → 选档 → 下载 → ffprobe）未验证：本机没有可用账号 Cookie。
- Edge / Brave / Vivaldi 在 Windows 上的实际可用性没有结论；Edge 仅在运行中被占用时测过。
- 需要 PO token / JS runtime 的 YouTube 场景不在本轮范围；日志里仍可能出现
  `No supported JavaScript runtime` 的警告。
- 导出 cookies.txt 需要用户自行在浏览器侧完成；应用不提供导出功能，也不接触账号密码。
