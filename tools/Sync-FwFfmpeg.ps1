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

$url = if ($FwTriple -like '*windows*') {
    'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
} elseif ($FwTriple -like '*apple-darwin*') {
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macos64-gpl.zip'
} else {
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.zip'
}
$zip = Join-Path ([IO.Path]::GetTempPath()) ("fw-ffmpeg-" + [Guid]::NewGuid().ToString('N') + '.zip')
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("fw-ffmpeg-" + [Guid]::NewGuid().ToString('N'))
Write-Host "下载 $url"
if ($FwTriple -like '*windows*') {
    # gyan.dev 不是 GitHub 资产，自己重试。
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 900
            break
        } catch {
            Write-Host "第 $attempt 次下载失败：$($_.Exception.Message)"
            if ($attempt -ge 3) { throw }
            Start-Sleep -Seconds (10 * $attempt)
        }
    }
} else {
    # BtbN 的发布 tag 字面就叫 latest，走公共实现的「精确 tag」分支。
    $asset = if ($FwTriple -like '*apple-darwin*') { 'ffmpeg-master-latest-macos64-gpl.zip' } else { 'ffmpeg-master-latest-linux64-gpl.zip' }
    . (Join-Path $PSScriptRoot 'Get-FwGitHubAsset.ps1')
    Get-FwGitHubReleaseAsset -FwRepo 'BtbN/FFmpeg-Builds' -FwTag 'latest' -FwAsset $asset -FwOut $zip
}
if (-not (Test-Path $zip) -or (Get-Item $zip).Length -le 0) { throw "下载结果为空：$url" }
Write-Host "解压…"
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$exe = Get-ChildItem $tmp -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
if (-not $exe) {
    $exe = Get-ChildItem $tmp -Recurse -File -Filter 'ffmpeg' | Select-Object -First 1
}
if (-not $exe) { throw "压缩包里没有找到 ffmpeg 可执行文件：$url" }
Copy-Item $exe.FullName $target -Force
if (-not $IsWindows) { chmod +x $target 2>$null }
Remove-Item $zip, $tmp -Recurse -Force
$hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
Write-Host "完成：$target（$((Get-Item $target).Length) 字节，sha256=$hash）"
