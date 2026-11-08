# Fetchweir 1.0.4 发布说明

> **本次发布的平台范围**：只有 **Windows x64**（currentUser 与 perMachine 两个安装包）。
> macOS 的 `.dmg` 与 Linux 的 `.deb` / `.AppImage` **本轮未在本地构建**，本 Release 里
> 没有这两个平台的产物。macOS 公证、Linux 发行版差异与系统级安装仍未验证。
>
> **已知限制**：字幕轨下载、解析器独立更新、通知中心、原生拖放导入未接通（界面禁用并标注）；
> `windows-gnu` 链接器会报 `.rsrc merge failure: multiple non-default manifests`（不影响功能）；
> 连接明细不展示分连接速率；设置页未实现的选项标注「未生效」。详见 `README.md`「已知限制」。

## 一、设置页顶部分组导航

v1.0.2 用户反馈「设置界面顶部那一排按钮没有功能」。核对结果：那一排是
`常规 / 下载引擎 / 网络与限速 / 嗅探与浏览器 / 视频与格式 / 外观 / 数据与边界` 七个
分组导航，DOM 上只有 `data-jump` 属性，**没有任何点击监听**，所以点了完全没反应。

本版逐个接线，行为如下：

| 按钮 | 原状态 | 现在点击后的行为 |
| --- | --- | --- |
| 常规 | 无事件 | 滚动到 `#s1`，该项高亮 |
| 下载引擎 | 无事件 | 滚动到 `#s2`，该项高亮 |
| 网络与限速 | 无事件 | 滚动到 `#s3`，该项高亮 |
| 嗅探与浏览器 | 无事件 | 滚动到 `#s4`，该项高亮 |
| 视频与格式 | 无事件 | 滚动到 `#s5`，该项高亮 |
| 外观 | 无事件 | 滚动到 `#s6`，该项高亮 |
| 数据与边界 | 无事件 | 滚动到 `#s7`；滚到底部时也保持高亮（最后一组到不了顶端） |

同时加了滚动同步高亮，以及「滚动到底部 = 最后一组」的判定。
实测（headless Edge + CDP，视口 1400×1000）：点击 s3 / s7 / s1 后分组距容器顶部均为
12 px，高亮项与点击项一致。

设置页其余按钮核对：`导出配置`、`检查更新`、`打开主页`、扩展安装/打开目录/复制步骤、
数据目录、恢复默认等均已有绑定；未实现的选项以「未生效」文字标注，不放空按钮。

## 二、已是最新版本仍提示有更新

- **版本比较**改为语义化规则：主/次/修订逐段按数字比较（`1.0.10 > 1.0.9`），
  预发布逐段比较且同号预发布低于正式版，忽略 `v` 前缀与 `+build` 构建元数据。
  历史上写成 `alpha9 / alpha10` 的 tag 仍按数值排序，不会反向。
- **预发布不再推荐给正式版用户**：`prerelease` 标记或版本号带预发布后缀的条目，
  只有在当前版本本身是预发布时才参与比较。
- **界面**：`已是最新版本` 时不再展示版本详情块与「更新 / 仅下载」按钮
  （旧实现会留着这两颗按钮，看起来像还有更新）。

边界实测（Rust 单测 `version_ordering_matches_semver`）：

| 情形 | 结果 |
| --- | --- |
| 当前 = 最新（`v1.0.2` vs `1.0.2`） | 相等，不提示 |
| 当前更高（`1.0.3` vs `1.0.2`） | 不提示 |
| 最新为预发布（`1.0.2-alpha2` vs `1.0.2`） | 预发布更低；`1.0.3-alpha1` 仍高于 `1.0.2` |
| `1.0.10` vs `1.0.9` | 前者更新（数值比较） |
| `1.0.3+build.7` vs `1.0.3` | 相等 |
| 非法版本（`1.2`、`1.0.3-`、空串） | 解析失败，不会当成 0.0.0 误报 |

## 三、更新机制（公开主仓库 + 签名清单）

源码仓库已公开（`yunyu697/fetchweir`），更新源与 Release 都在同一个仓库，
不再维护单独的产物仓库。本版做了这些：

- 客户端不再携带任何令牌；本地设置里的「访问令牌」输入框与 `updateToken` 字段已删除。
- 默认更新源改为 `https://github.com/yunyu697/fetchweir/releases/latest/download`。
- 支持带签名的 `latest.json` 清单（版本、发布时间、说明、最低系统要求、
  各平台资产名/大小/SHA256）与 `latest.json.sig`（Ed25519 签名），两个文件随本版
  Release 一起上传。
- 客户端用内置公钥验签，**签名不通过直接中止**；下载完成后校验 SHA256，不匹配则删除并拒绝安装。
- 旧更新源没有清单时回退到 Release 列表，但界面明确标注「未校验来源」。
- 显式指定的更新源（`FETCHWEIR_UPDATE_BASE`）不回退：没清单就报「未找到可用的更新源」。
- 镜像选项按来源判定：资产不是 `github.com` 直链（自建源）时下拉框禁用并提示
  「镜像加速不可用」，不留点了没反应的选项。

**发布口径**：CI 在 tag 上只校验 `version.json`，不打包、不上传；安装包在本地用
`pwsh tools/Build-Fw.ps1 -FwTask release` 生成，Release 用 `gh release create` 手动创建，
把两个 Windows 安装包与签名清单一起挂上去。清单生成用 `tools/New-FwManifest.mjs`，
签名用 `tools/Sign-FwManifest.mjs`。

> 本版源码里的 `RELEASE_PUBKEY_B64` 已固定为本项目公钥，`dist` 里的两个安装包
> 都是替换之后构建的。签名私钥只保存在本机 `.secrets/update-signing.pem`；
> `tools/Sign-FwManifest.mjs` 会校验私钥与内置公钥是否一致，不一致直接拒绝签名，
> 不会自动生成新密钥。换钥流程见 `docs/更新机制.md`。

### 1.0.0 ~ 1.0.3 用户必须手动升级

这几个版本内置的是**旧公钥**。用新私钥签出的 `latest.json` 在它们那里验签必然失败，
更新检查会直接中止（这是设计行为，不是故障）。因此：

- 这批用户**收不到自动更新**，必须手动下载本版安装包覆盖安装；
- 1.0.4 是这批用户的"迁移版本"：装上它之后内置公钥才与新私钥配对；
- 1.0.4 及之后的版本可以走「检查更新 → 验签 → 下载 → SHA256 校验」。

方案取舍、清单格式与密钥约束见 `docs/更新机制.md`。

## 四、浏览器扩展 .crx

- 本地打包可行：`tools/Build-FwExtension.ps1` 调用本机 Chrome/Edge 的 `--pack-extension`
  产出 CRX3，脚本先校验「私钥推导出的扩展 ID」与 `nm.rs` 的 `EXTENSION_ID` 一致，避免打出连不上主程序的包。
- 实测：zip 23.1 KB、CRX3 24,476 字节（magic `Cr24`、版本 3）；PKCS#1 私钥会被浏览器拒绝，
  必须是 PKCS#8 PEM。
- **普通用户装不上**：正式版 Chrome/Edge 会以 `CRX_REQUIRED_PROOF_MISSING` 拦截站外 `.crx`，
  只有商店或企业策略（托管设备）可用。界面与复制出的步骤已写明这一点，`.crx` 只用于内测/企业。
- 分发组合与成本见 `docs/浏览器扩展分发.md`。

## 五、CI 与计费（v1.0.3 历史记录）

- tag `v1.0.3` 的 release run（`42360405263`）**失败**，三个打包 job 均未启动（0 个步骤，3~4 秒结束）。
- GitHub 注解原文：*“The job was not started because recent account payments have failed or
  your spending limit needs to be increased.”* —— 账户付款/额度问题，与代码无关。
- 因此 **v1.0.3 没有 Release，也没有任何安装包产出**（`gh release view v1.0.3` 返回 not found）。
- 对照：v1.0.2 的五个产物当时仍在（`x64-setup.exe` 25,135,098 B、`x64-setup-allusers.exe`
  25,132,995 B、`amd64.deb` 43,413,904 B、`amd64.AppImage` 123,902,456 B、`aarch64.dmg` 40,179,674 B）。
- 从 v1.0.4 起发布方式改为「CI 在 tag 上只校验版本号；安装包本地构建，Release 手动创建」。
  v1.0.4 的 Release 由本地产物上传，不依赖 CI 打包，也不受上述计费失败影响。

## 六、发版步骤（本地构建 + 手动 Release）

1. `pwsh -NoProfile -File tools/Build-Fw.ps1 -FwTask release`
   —— 产出 currentUser 与 perMachine 两个安装包，落到 `dist/` 并打印 SHA256。
2. 核对终端打印的版本号与 `version.json` 一致、两个包都来自本次构建。
3. `node tools/New-FwManifest.mjs` 生成 `dist/latest.json`；
   把本机私钥放进 `FW_SIGNING_KEY` 后跑
   `node tools/Sign-FwManifest.mjs --in dist/latest.json` 生成 `latest.json.sig`。
4. 在对应提交打 tag `v1.0.4` 并推送（CI 只做版本校验，不打包）。
5. `gh release create v1.0.4 --notes-file docs/release-notes-v1.0.4.md` 上传两个 exe 与
   `latest.json` / `latest.json.sig`。
6. `gh release view v1.0.4` 核对资产；1.0.0 ~ 1.0.3 用户手动覆盖安装。
