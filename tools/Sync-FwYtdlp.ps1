# 按目标三元组下载 yt-dlp sidecar 到 src-tauri/binaries/。
# 不入库：体积大且各平台二进制不同。CI 与本机首次构建前各跑一次。
param(
    [string]$FwTriple = "",
    [string]$FwDest = "",
    [switch]$FwForce
)

$ErrorActionPreference = 'Stop'
$progressPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $FwTriple) {
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x86_64' } else { 'i686' }
    $FwTriple = if ($IsWindows) { "$arch-pc-windows-msvc" }
    elseif ($IsMacOS) { "$(if ($arch -eq 'x86_64') { 'x86_64' } else { 'aarch64' })-apple-darwin" }
    else { "$arch-unknown-linux-gnu" }
}
if (-not $FwDest) { $FwDest = Join-Path $repo 'src-tauri\binaries' }
New-Item -ItemType Directory -Force -Path $FwDest | Out-Null

$name = if ($FwTriple -like '*windows*') { "yt-dlp-$FwTriple.exe" } else { "yt-dlp-$FwTriple" }
$target = Join-Path $FwDest $name
if ((Test-Path $target) -and -not $FwForce) {
    Write-Host "已存在：$target（$((Get-Item $target).Length) 字节）"
    exit 0
}

$asset = if ($FwTriple -like '*windows*') { 'yt-dlp.exe' }
elseif ($FwTriple -like '*apple-darwin*') { 'yt-dlp_macos' }
else { 'yt-dlp_linux' }
$url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset"
Write-Host "下载 $asset → $target"
# GitHub 的 release 资产偶尔回 504（本轮 CI 就栽在这），重试 3 次再报错。
$attempt = 0
while ($true) {
    $attempt++
    try {
        Invoke-WebRequest -Uri $url -OutFile $target -TimeoutSec 300
        break
    } catch {
        Write-Host "第 $attempt 次下载失败：$($_.Exception.Message)"
        if ($attempt -ge 3) { throw }
        Start-Sleep -Seconds (10 * $attempt)
    }
}
if (-not (Test-Path $target) -or (Get-Item $target).Length -le 0) { throw "下载结果为空：$url" }
if (-not $IsWindows -and -not $IsMacOS) { chmod +x $target 2>$null }
Write-Host "完成：$target（$((Get-Item $target).Length) 字节）"
