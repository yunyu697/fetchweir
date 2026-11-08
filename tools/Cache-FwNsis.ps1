# 预置 tauri 需要的 NSIS 工具链，绕开 github.com/.../releases/download 的 504。
# tauri-cli 2.12.4 固定用 nsis-3.13 与 nsis_tauri_utils v0.5.3：升级 @tauri-apps/cli 时同步改下面的版本与 sha1。
# 缓存目录与 tauri 自己解压的位置一致（Windows: %LOCALAPPDATA%\tauri\NSIS）；缺 nsis_tauri_utils.dll 时
# tauri 判定「缺少文件」并整目录删掉重下，所以两样都必须就位。
param(
    [string]$FwCacheDir = "",
    [switch]$FwForce
)

$ErrorActionPreference = 'Stop'
$progressPreference = 'SilentlyContinue'

$FwNsisVersion = '3.13'
$FwNsisZipSha1 = 'DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E'
$FwUtilsVersion = '0.5.3'
$FwUtilsDllSha1 = '75197FEE3C6A814FE035788D1C34EAD39349B860'

if (-not $FwCacheDir) {
    $FwBase = if ($IsWindows) { $env:LOCALAPPDATA }
    elseif ($IsMacOS) { Join-Path $HOME 'Library/Caches' }
    else { if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME } else { Join-Path $HOME '.cache' } }
    $FwCacheDir = Join-Path $FwBase 'tauri'
}

$FwNsisDir = Join-Path $FwCacheDir 'NSIS'
$FwUtilsDir = Join-Path $FwNsisDir 'Plugins\x86-unicode\additional'
$FwUtilsDll = Join-Path $FwUtilsDir 'nsis_tauri_utils.dll'

if (-not $FwForce -and (Test-Path (Join-Path $FwNsisDir 'makensis.exe')) -and (Test-Path $FwUtilsDll)) {
    Write-Host "已就绪：$FwNsisDir"
    exit 0
}

. (Join-Path $PSScriptRoot 'Get-FwGitHubAsset.ps1')

$FwZip = Join-Path ([IO.Path]::GetTempPath()) ("fw-nsis-" + [Guid]::NewGuid().ToString('N') + '.zip')
$FwTmp = Join-Path ([IO.Path]::GetTempPath()) ("fw-nsis-" + [Guid]::NewGuid().ToString('N'))
try {
    Get-FwGitHubReleaseAsset -FwRepo 'tauri-apps/binary-releases' -FwTag "nsis-$FwNsisVersion" `
        -FwAsset "nsis-$FwNsisVersion.zip" -FwOut $FwZip -FwSha1 $FwNsisZipSha1

    if (Test-Path $FwNsisDir) { Remove-Item $FwNsisDir -Recurse -Force }
    New-Item -ItemType Directory $FwNsisDir -Force | Out-Null
    Expand-Archive -Path $FwZip -DestinationPath $FwTmp -Force
    $FwInner = Get-ChildItem $FwTmp -Directory | Select-Object -First 1
    if (-not $FwInner) { throw "压缩包里没有目录：$FwZip" }
    Copy-Item (Join-Path $FwInner.FullName '*') $FwNsisDir -Recurse -Force

    New-Item -ItemType Directory $FwUtilsDir -Force | Out-Null
    Get-FwGitHubReleaseAsset -FwRepo 'tauri-apps/nsis-tauri-utils' -FwTag "nsis_tauri_utils-v$FwUtilsVersion" `
        -FwAsset 'nsis_tauri_utils.dll' -FwOut $FwUtilsDll -FwSha1 $FwUtilsDllSha1

    if (-not (Test-Path (Join-Path $FwNsisDir 'makensis.exe'))) { throw "缺少 makensis.exe：$FwNsisDir" }
    Write-Host "NSIS 已预置：$FwNsisDir（$((Get-ChildItem $FwNsisDir -Recurse -File).Count) 个文件）"
} finally {
    Remove-Item $FwZip, $FwTmp -Recurse -Force -ErrorAction SilentlyContinue
}
