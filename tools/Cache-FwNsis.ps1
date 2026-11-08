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

function Get-FwReleaseAsset {
    param([string]$FwRepo, [string]$FwTag, [string]$FwAsset, [string]$FwOut, [string]$FwSha1)
    $FwDirect = "https://github.com/$FwRepo/releases/download/$FwTag/$FwAsset"
    $FwToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } else { $env:GITHUB_TOKEN }
    for ($FwAttempt = 1; $FwAttempt -le 3; $FwAttempt++) {
        try {
            if ($FwToken) {
                # 直链走的是 release 资产 CDN，本仓库两次 CI 都在这里连续 504；
                # API 资产端点返回 302 到另一套签名地址，实测可用。
                $FwHeaders = @{ Authorization = "Bearer $FwToken"; 'User-Agent' = 'fetchweir-ci' }
                $FwRel = Invoke-RestMethod -Uri "https://api.github.com/repos/$FwRepo/releases/tags/$FwTag" -Headers $FwHeaders -TimeoutSec 120
                $FwFound = $FwRel.assets | Where-Object { $_.name -eq $FwAsset } | Select-Object -First 1
                if (-not $FwFound) { throw "tag $FwTag 下没有资产 $FwAsset" }
                $FwHeaders['Accept'] = 'application/octet-stream'
                Invoke-WebRequest -Uri $FwFound.url -Headers $FwHeaders -OutFile $FwOut -TimeoutSec 300
            } else {
                Invoke-WebRequest -Uri $FwDirect -OutFile $FwOut -TimeoutSec 300
            }
            if (-not (Test-Path $FwOut) -or (Get-Item $FwOut).Length -le 0) { throw "下载结果为空：$FwAsset" }
            $FwActual = (Get-FileHash $FwOut -Algorithm SHA1).Hash
            if ($FwActual -ne $FwSha1) { throw "sha1 不符：$FwAsset 期望 $FwSha1 实际 $FwActual" }
            return
        } catch {
            Write-Host "第 $FwAttempt 次下载失败（$FwAsset）：$($_.Exception.Message)"
            if ($FwAttempt -ge 3) { throw }
            Start-Sleep -Seconds (10 * $FwAttempt)
        }
    }
}

$FwZip = Join-Path ([IO.Path]::GetTempPath()) ("fw-nsis-" + [Guid]::NewGuid().ToString('N') + '.zip')
$FwTmp = Join-Path ([IO.Path]::GetTempPath()) ("fw-nsis-" + [Guid]::NewGuid().ToString('N'))
try {
    Get-FwReleaseAsset -FwRepo 'tauri-apps/binary-releases' -FwTag "nsis-$FwNsisVersion" `
        -FwAsset "nsis-$FwNsisVersion.zip" -FwOut $FwZip -FwSha1 $FwNsisZipSha1

    if (Test-Path $FwNsisDir) { Remove-Item $FwNsisDir -Recurse -Force }
    New-Item -ItemType Directory $FwNsisDir -Force | Out-Null
    Expand-Archive -Path $FwZip -DestinationPath $FwTmp -Force
    $FwInner = Get-ChildItem $FwTmp -Directory | Select-Object -First 1
    if (-not $FwInner) { throw "压缩包里没有目录：$FwZip" }
    Copy-Item (Join-Path $FwInner.FullName '*') $FwNsisDir -Recurse -Force

    New-Item -ItemType Directory $FwUtilsDir -Force | Out-Null
    Get-FwReleaseAsset -FwRepo 'tauri-apps/nsis-tauri-utils' -FwTag "nsis_tauri_utils-v$FwUtilsVersion" `
        -FwAsset 'nsis_tauri_utils.dll' -FwOut $FwUtilsDll -FwSha1 $FwUtilsDllSha1

    if (-not (Test-Path (Join-Path $FwNsisDir 'makensis.exe'))) { throw "缺少 makensis.exe：$FwNsisDir" }
    Write-Host "NSIS 已预置：$FwNsisDir（$((Get-ChildItem $FwNsisDir -Recurse -File).Count) 个文件）"
} finally {
    Remove-Item $FwZip, $FwTmp -Recurse -Force -ErrorAction SilentlyContinue
}
