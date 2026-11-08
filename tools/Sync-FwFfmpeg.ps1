# 下载 ffmpeg 静态构建并放到 src-tauri/binaries/，供视频「纯视频流 + 最佳音轨」合并使用。
# 不入库（体积大）；本机首次构建与本机出包前各跑一次。
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

$name = if ($FwTriple -like '*windows*') { "ffmpeg-$FwTriple.exe" } else { "ffmpeg-$FwTriple" }
$target = Join-Path $FwDest $name
if ((Test-Path $target) -and -not $FwForce) {
    Write-Host "已存在：$target（$((Get-Item $target).Length) 字节）"
    exit 0
}

$download = Join-Path ([IO.Path]::GetTempPath()) ("fw-ffmpeg-" + [Guid]::NewGuid().ToString('N') + '.bin')
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("fw-ffmpeg-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

if ($FwTriple -like '*windows*') {
    # gyan.dev 不是 GitHub 资产，自己重试。
    $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    Write-Host "下载 $url"
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Invoke-WebRequest -Uri $url -OutFile $download -TimeoutSec 900
            break
        } catch {
            Write-Host "第 $attempt 次下载失败：$($_.Exception.Message)"
            if ($attempt -ge 3) { throw }
            Start-Sleep -Seconds (10 * $attempt)
        }
    }
    $archiveName = 'ffmpeg-release-essentials.zip'
} elseif ($FwTriple -like '*apple-darwin*') {
    # BtbN/FFmpeg-Builds 只有 Windows 与 Linux 产物。CI 在 macOS 上放占位文件，
    # 这里不虚构一个上游并不存在的资产名。
    throw "BtbN/FFmpeg-Builds 不提供 macOS 构建：请手动把 ffmpeg 放到 $target（CI 见 .github/workflows/ci.yml 的占位分支）。"
} else {
    # BtbN 的发布 tag 字面就叫 latest。资产名会随上游调整（2026-11-08 起 linux 从 .zip 改为 .tar.xz，
    # 并新增 n9.0 等带版本号的前缀），所以按名称模式匹配，不写死完整文件名。
    $platform = if ($FwTriple -like 'aarch64*') { 'linuxarm64' } else { 'linux64' }
    $assetPattern = "^ffmpeg-(master|n[0-9.]+)-latest-$platform-gpl(?:-[0-9.]+)?\.(tar\.xz|zip)$"
    Write-Host "在 BtbN/FFmpeg-Builds 的 latest 发布里匹配 $assetPattern"
    . (Join-Path $PSScriptRoot 'Get-FwGitHubAsset.ps1')
    $archiveName = Get-FwGitHubReleaseAsset -FwRepo 'BtbN/FFmpeg-Builds' -FwTag 'latest' `
        -FwAssetPattern $assetPattern -FwOut $download
}
if (-not (Test-Path $download) -or (Get-Item $download).Length -le 0) { throw "下载结果为空：$archiveName" }

Write-Host "解压 $archiveName …"
if ($archiveName -like '*.zip') {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($download, $tmp)
} else {
    # .tar.xz：Windows 10+ 自带 bsdtar，Linux 自带 tar，均支持 xz。
    & tar -xf $download -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "解压失败（tar 退出码 $LASTEXITCODE）：$archiveName" }
}
$exe = Get-ChildItem $tmp -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $exe) {
    $exe = Get-ChildItem $tmp -Recurse -File -Filter 'ffmpeg' | Select-Object -First 1
}
if (-not $exe) { throw "压缩包里没有找到 ffmpeg 可执行文件：$archiveName" }
Copy-Item $exe.FullName $target -Force
if (-not $IsWindows) { chmod +x $target 2>$null }
Remove-Item $download, $tmp -Recurse -Force
$hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
Write-Host "完成：$target（$((Get-Item $target).Length) 字节，sha256=$hash）"
