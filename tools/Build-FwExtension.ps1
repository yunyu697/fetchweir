#Requires -Version 7.0
<#
.SYNOPSIS
  打包浏览器扩展：产出可上架商店的 .zip；若提供签名私钥，同时产出 CRX3 的 .crx。

.DESCRIPTION
  CRX 的扩展 ID 由签名密钥决定，必须与 extension/manifest.json 的 key 字段
  （以及 src-tauri/src/nm.rs 的 EXTENSION_ID）一致，否则 Native Messaging 授权失败。

  本脚本先用私钥推导扩展 ID 并与预期值比对，不一致直接终止，
  避免打出一个「能装但连不上主程序」的 .crx。

  注意：正式版 Chrome/Edge 会拦截站外 .crx（CRX_REQUIRED_PROOF_MISSING）。
  .crx 只适用于内测、企业策略分发或自建更新源，日常安装请用「加载已解压」。

.EXAMPLE
  # 只打商店用的 zip
  ./tools/Build-FwExtension.ps1

.EXAMPLE
  # 同时打 CRX3（私钥不入库，由发布者本地持有）
  ./tools/Build-FwExtension.ps1 -FwKeyPath D:\keys\fetchweir-extension.pem
#>
param(
  [string]$FwExtensionDir = 'extension',
  [string]$FwKeyPath = '',
  [string]$FwOutDir = 'artifacts/extension',
  [string]$FwExpectId = 'fjngndhalbkfkfcfhleflcgkicknkele'
)

$ErrorActionPreference = 'Stop'

$src = (Resolve-Path $FwExtensionDir).Path
$manifestPath = Join-Path $src 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到扩展清单：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

New-Item -ItemType Directory -Force -Path $FwOutDir | Out-Null
$out = (Resolve-Path $FwOutDir).Path

# 1) 商店上传用的 zip（清单必须在压缩包根目录）
$zipPath = Join-Path $out "fetchweir-extension-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Host "已生成 zip：$zipPath（$([math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB）"

if (-not $FwKeyPath) {
  Write-Host ''
  Write-Host '未提供 -FwKeyPath，跳过 .crx。'
  Write-Host '生成签名密钥：openssl genrsa -out fetchweir-extension.pem 2048'
  Write-Host '若用的是 OpenSSL 1.x（PKCS#1 格式），浏览器会拒绝，需要转换：'
  Write-Host '  openssl pkcs8 -topk8 -nocrypt -in fetchweir-extension.pem -out fetchweir-extension-pkcs8.pem'
  Write-Host '（密钥须与 manifest.json 的 key 字段配对，否则扩展 ID 变化、Native Messaging 会失效）'
  return
}

$keyPath = (Resolve-Path $FwKeyPath).Path

# 2) 用私钥推导扩展 ID：SHA256(SPKI 公钥) 前 16 字节，每个半字节映射 a~p
$rsa = [System.Security.Cryptography.RSA]::Create()
$rsa.ImportFromPem((Get-Content $keyPath -Raw))
$spki = $rsa.ExportSubjectPublicKeyInfo()
$digest = [System.Security.Cryptography.SHA256]::HashData($spki)
$chars = -join ($digest[0..15] | ForEach-Object {
    [char]([int][char]'a' + ($_ -shr 4))
    [char]([int][char]'a' + ($_ -band 0x0f))
  })
$rsa.Dispose()

if ($chars -ne $FwExpectId) {
  throw @"
签名私钥与预期扩展 ID 不匹配：
  私钥推导：$chars
  预期值  ：$FwExpectId（src-tauri/src/nm.rs EXTENSION_ID）
打出来的 .crx 会以另一个 ID 安装，Native Messaging 的 allowed_origins 授权失败。
请改用与 manifest.json key 字段配对的私钥；若确实要换 ID，
需同步更新 manifest.json 的 key 与 nm.rs 的 EXTENSION_ID 后重新构建应用。
"@
}
Write-Host "扩展 ID 校验通过：$chars"

# 3) 调用本机 Chrome/Edge 完成 CRX3 打包（Chrome 自带签名与 ZIP 封装，避免自实现 protobuf）
$browser = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) {
  throw '未找到 Chrome/Edge，无法调用 --pack-extension 生成 CRX3'
}

$stage = Join-Path $out 'crx-build'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Copy-Item $src $stage -Recurse

$profileDir = Join-Path $env:TEMP ('fw-crx-' + [guid]::NewGuid().ToString('N'))
# 用调用运算符而不是 Start-Process：路径带空格时 Start-Process 的 -ArgumentList 不会自动加引号，
# 浏览器会把参数拆开并以 22（ERROR_BAD_COMMAND）退出。
& $browser "--pack-extension=$stage" "--pack-extension-key=$keyPath" `
  "--user-data-dir=$profileDir" '--no-first-run' '--no-default-browser-check'
$browserExit = $LASTEXITCODE
Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

$rawCrx = "$stage.crx"
# 部分 Chromium 版本会立刻退出、由子进程写文件，这里轮询等待产物落盘。
for ($i = 0; $i -lt 40 -and -not (Test-Path $rawCrx); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path $rawCrx)) { throw "浏览器未产出 .crx（退出码 $browserExit）" }

# 4) 校验 CRX3 头：magic = "Cr24"，version = 3（小端 uint32）
$bytes = [IO.File]::ReadAllBytes($rawCrx)
if ($bytes.Length -lt 12 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'Cr24') {
  throw '产出的文件不是 CRX（magic 不是 Cr24）'
}
$crxVersion = [BitConverter]::ToUInt32($bytes, 4)
if ($crxVersion -ne 3) { throw "CRX 版本为 $crxVersion，预期 CRX3" }

$crxPath = Join-Path $out "fetchweir-extension-$version.crx"
Move-Item $rawCrx $crxPath -Force
Remove-Item $stage -Recurse -Force

Write-Host "已生成 CRX3：$crxPath（$([math]::Round((Get-Item $crxPath).Length / 1KB, 1)) KB）"
Write-Host '提醒：正式版 Chrome/Edge 会拦截站外 .crx；仅用于内测、企业策略或自建更新源。'
