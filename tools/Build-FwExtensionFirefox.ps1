#Requires -Version 7.0
<#
.SYNOPSIS
  生成 Firefox 版浏览器扩展（MV3 event page），产出可加载的目录与 zip。

.DESCRIPTION
  Chrome 版清单使用 background.service_worker + key；Firefox 不支持 service worker
  后台页，也会忽略 key，改用 browser_specific_settings.gecko.id。
  本脚本只转换清单并复制同一份 background.js / content.js，不改动业务代码。
  gecko id 必须与 src-tauri/src/nm.rs 的 FIREFOX_EXTENSION_ID 一致，否则
  Native Messaging 的 allowed_extensions 授权失败。

.EXAMPLE
  ./tools/Build-FwExtensionFirefox.ps1
#>
param(
  [string]$FwExtensionDir = 'extension',
  [string]$FwOutDir = 'dist/extension-firefox',
  [string]$FwZipPath = 'dist/fetchweir-extension-firefox.zip',
  [string]$FwGeckoId = 'fetchweir@yunyu697'
)

$ErrorActionPreference = 'Stop'

$src = (Resolve-Path $FwExtensionDir).Path
$manifestPath = Join-Path $src 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "找不到扩展清单：$manifestPath" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

if (Test-Path $FwOutDir) { Remove-Item $FwOutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $FwOutDir | Out-Null
Copy-Item (Join-Path $src '*') $FwOutDir -Recurse -Force

# Firefox 忽略 Chrome 的 key（扩展 ID 由 gecko.id 决定），service_worker 也不支持。
$manifest.PSObject.Properties.Remove('key') | Out-Null
$manifest.background = [pscustomobject]@{ scripts = @('background.js') }
$manifest | Add-Member -NotePropertyName browser_specific_settings -NotePropertyValue ([pscustomobject]@{
    gecko = [pscustomobject]@{
      id = $FwGeckoId
      strict_min_version = '140.0'
      # 扩展只做本地嗅探与 Native Messaging，不上传任何数据；新版 Firefox 要求显式声明。
      data_collection_permissions = [pscustomobject]@{ required = @('none') }
    }
    # 本扩展依赖桌面端 Native Messaging；Android 只声明一个满足数据声明的最低版本，
    # 避免 lint 报「清单键低于最低版本」。
    gecko_android = [pscustomobject]@{ strict_min_version = '142.0' }
  }) -Force

$manifest | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $FwOutDir 'manifest.json') -Encoding UTF8

$zipFull = [IO.Path]::GetFullPath($FwZipPath)
New-Item -ItemType Directory -Force -Path (Split-Path $zipFull -Parent) | Out-Null
if (Test-Path $zipFull) { Remove-Item $zipFull -Force }
Compress-Archive -Path (Join-Path $FwOutDir '*') -DestinationPath $zipFull -CompressionLevel Optimal

Write-Host "Firefox 扩展目录：$FwOutDir"
Write-Host "Firefox 扩展包：$FwZipPath（$([math]::Round((Get-Item $zipFull).Length / 1KB, 1)) KB，版本 $version）"
Write-Host "gecko id：$FwGeckoId（需与 src-tauri/src/nm.rs FIREFOX_EXTENSION_ID 一致）"
