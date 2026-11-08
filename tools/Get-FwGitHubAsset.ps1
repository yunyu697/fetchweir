# 从 GitHub Release 下载资产的公共实现。
# 2026-11-08 起 github.com/.../releases/download 直链在 CI 与本机持续回 504，
# 而 API 资产端点（api.github.com，302 到另一套签名地址）正常，所以有这个脚本。
# 有 token 时优先走 API，失败再退回直链；两种情况都做重试与可选的 sha1 校验。
#
# 资产既可以按完整文件名指定（-FwAsset），也可以按名称模式匹配（-FwAssetPattern）。
# 上游会把资产从 .zip 改成 .tar.xz、或在前缀里加版本号，写死完整文件名必然过期；
# 需要长期稳定时用模式匹配，由本脚本从发布资产列表里挑出当前真实存在的那个。
#
# 用法（点源后调用）：
#   . (Join-Path $PSScriptRoot 'Get-FwGitHubAsset.ps1')
#   Get-FwGitHubReleaseAsset -FwRepo 'yt-dlp/yt-dlp' -FwAsset 'yt-dlp.exe' -FwOut $target
#   Get-FwGitHubReleaseAsset -FwRepo 'BtbN/FFmpeg-Builds' -FwTag 'latest' `
#       -FwAssetPattern '^ffmpeg-(master|n[0-9.]+)-latest-linux64-gpl(?:-[0-9.]+)?\.(tar\.xz|zip)$' -FwOut $zip
# 返回实际选中的资产名（模式匹配时据此决定解压方式）。
function Get-FwGitHubReleaseAsset {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FwRepo,
        # 与 -FwAssetPattern 二选一：完整文件名。
        [string]$FwAsset = '',
        # 与 -FwAsset 二选一：资产名的正则。多个命中时 master 构建优先，其次按名称降序（版本新的在前）。
        [string]$FwAssetPattern = '',
        [Parameter(Mandatory)][string]$FwOut,
        # 留空取「最新正式版」；传值则按该 tag 精确查找（例如 BtbN 的字面 tag 'latest'）。
        [string]$FwTag = '',
        # 非空时校验 sha1（十六进制，大小写不敏感）。
        [string]$FwSha1 = '',
        [int]$FwAttempts = 3
    )

    if ([string]::IsNullOrEmpty($FwAsset) -eq [string]::IsNullOrEmpty($FwAssetPattern)) {
        throw '必须且只能指定 -FwAsset 或 -FwAssetPattern 之一。'
    }

    $FwToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { '' }
    $FwIsLatest = [string]::IsNullOrEmpty($FwTag)
    $FwHeaders = @{ 'User-Agent' = 'fetchweir' }
    if ($FwToken) { $FwHeaders.Authorization = "Bearer $FwToken" }
    $FwRelUri = if ($FwIsLatest) {
        "https://api.github.com/repos/$FwRepo/releases/latest"
    } else {
        "https://api.github.com/repos/$FwRepo/releases/tags/$FwTag"
    }

    # 模式匹配必须先拿到资产列表；未登录也能调 API，只是额度更低。
    $FwRelease = $null
    $FwName = $FwAsset
    if ($FwAssetPattern) {
        $FwRelease = Invoke-RestMethod -Uri $FwRelUri -Headers $FwHeaders -TimeoutSec 120
        $FwHits = @(
            $FwRelease.assets |
                Where-Object { $_.name -match $FwAssetPattern } |
                Select-Object -ExpandProperty name
        )
        if (-not $FwHits) {
            throw "tag $FwTag 下没有匹配 $FwAssetPattern 的资产"
        }
        $FwName = $FwHits |
            Sort-Object @{ Expression = { if ($_ -match '^ffmpeg-master-latest') { 0 } else { 1 } } },
                        @{ Expression = { $_ }; Descending = $true } |
            Select-Object -First 1
        Write-Host "匹配到资产：$FwName"
    }

    $FwDirect = if ($FwIsLatest) {
        "https://github.com/$FwRepo/releases/latest/download/$FwName"
    } else {
        "https://github.com/$FwRepo/releases/download/$FwTag/$FwName"
    }

    for ($FwAttempt = 1; $FwAttempt -le $FwAttempts; $FwAttempt++) {
        $FwErr = $null
        try {
            if ($FwToken -or $FwAssetPattern) {
                if (-not $FwRelease) {
                    $FwRelease = Invoke-RestMethod -Uri $FwRelUri -Headers $FwHeaders -TimeoutSec 120
                }
                $FwFound = $FwRelease.assets | Where-Object { $_.name -eq $FwName } | Select-Object -First 1
                if (-not $FwFound) { throw "tag $FwTag 下没有资产 $FwName" }
                $FwHeaders['Accept'] = 'application/octet-stream'
                Invoke-WebRequest -Uri $FwFound.url -Headers $FwHeaders -OutFile $FwOut -TimeoutSec 900
            } else {
                Invoke-WebRequest -Uri $FwDirect -OutFile $FwOut -TimeoutSec 900
            }
            if (-not (Test-Path $FwOut) -or (Get-Item $FwOut).Length -le 0) { throw "下载结果为空：$FwName" }
            if ($FwSha1) {
                $FwActual = (Get-FileHash $FwOut -Algorithm SHA1).Hash
                if ($FwActual -ne $FwSha1.ToUpper()) { throw "sha1 不符：$FwName 期望 $FwSha1 实际 $FwActual" }
            }
            return $FwName
        } catch {
            $FwErr = $_.Exception.Message
        }
        Write-Host "第 $FwAttempt 次下载失败（$FwName）：$FwErr"
        if ($FwAttempt -ge $FwAttempts) { throw "下载失败（$FwName，共 $FwAttempts 次）：$FwErr" }
        Start-Sleep -Seconds (10 * $FwAttempt)
    }
}
