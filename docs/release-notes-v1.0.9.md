# 1.0.9

## 新增：视频解析 Cookie 来源

站点要求登录验证（例如 YouTube 的 `Sign in to confirm you're not a bot`）时，现在可以在
设置 → 视频与格式 → Cookie 来源里选择凭据，不用再把原始报错甩给你：

- **不使用**（默认）：保持原行为，行为与旧版完全一致。
- **从浏览器读取**：解析时直接读取浏览器 Cookie 库（`--cookies-from-browser`），
  可选 Chrome / Edge / Firefox / Brave / Vivaldi；profile 可留空（用默认），也可填目录名或完整路径。
- **本地 cookies.txt**：系统文件选择器挑选或手动填写路径（`--cookies`），路径随设置保存；
  文件被删或读不到时，状态行明确提示，本次解析自动回退为「不使用」，并有对应提醒。

隐私边界：Cookie 内容只在本地传给解析器，不写进设置、日志，也不复制到应用数据目录；
cookies.txt 按原路径只读；浏览器 Cookie 库的临时副本由解析器在系统临时目录处理并自行清理。

## 改进：解析失败的错误引导

- 解析失败时识别「人机校验 / 需要登录 / HTTP 403」三类特征，界面给出可操作文案
  与「前往设置选择 Cookie 来源」跳转按钮，原始 stderr 收进「查看原始错误」折叠区。
- 下载任务因认证类错误失败时，同样显示引导而不是解析器退出异常。
- 解析输出强制 UTF-8，修正错误原文里的引号在中文系统上显示为乱码的问题。

## 实测情况（如实）

- 用出问题的同一条视频 `-yqNI2GfXMQ` 离屏验证：默认来源复现原错误并展示新引导、
  原始错误在详情、cookies.txt 缺失时保存与回退正确、浏览器 profile 确实传给解析器、
  缺失文件不影响直链解析。证据见仓库 `docs/ui-shots/cookie-*.png` 与 `cookie-result.json`。
- **成功路径未验证**：本机没有任何可用于 YouTube 的登录 Cookie。
  Chrome 被 App-Bound Encryption 挡住（`Failed to decrypt with DPAPI`）；
  Edge 测试时正在被占用未完成验证；Firefox 本机 profile 无登录态；Brave / Vivaldi 未安装。
  配上可用 Cookie 后能否解析成功，取决于你提供的登录态，未编造下载结果。

## 升级方式

应用内「检查更新」或从 Release 下载安装包覆盖安装（普通版 / 全用户版二选一）。
升级后设置自动保留，Cookie 来源默认「不使用」。
