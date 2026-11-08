# 从 GitHub Release 下载资产的公共实现。
# 2026-11-08 起 github.com/.../releases/download 直链在 CI 与本机持续回 504，
# 而 API 资产端点（api.github.com，302 到另一套签名地址）正常，所以有这个脚本。
# 有 token 时优先走 API，失败再退回直链；两种情况都做重试与可选的 sha1 校验。
#
# 用法（点源后调用）：
#   . (Join-Path $PSScriptRoot 'Get-FwGitHubAsset.ps1')
#   Get-FwGitHubReleaseAsset -FwRepo 'yt-dlp/yt-dlp' -FwAsset 'yt-dlp.exe' -FwOut $target
function Get-FwGitHubReleaseAsset {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$FwRepo,
        [Parameter(Mandatory)][string]$FwAsset,
        [Parameter(Mandatory)][string]$FwOut,
        # 留空取「最新正式版」；传值则按该 tag 精确查找（例如 BtbN 的字面 tag 'latest'）。
        [string]$FwTag = '',
        # 非空时校验 sha1（十六进制，大小写不敏感）。
        [string]$FwSha1 = '',
        [int]$FwAttempts = 3
    )

    $FwToken = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { '' }
    $FwIsLatest = [string]::IsNullOrEmpty($FwTag)
    $FwDirect = if ($FwIsLatest) {
        "https://github.com/$FwRepo/releases/latest/download/$FwAsset"
    } else {
        "https://github.com/$FwRepo/releases/download/$FwTag/$FwAsset"
    }

    for ($FwAttempt = 1; $FwAttempt -le $FwAttempts; $FwAttempt++) {
        $FwErr = $null
        try {
            if ($FwToken) {
                $FwHeaders = @{ Authorization = "Bearer $FwToken"; 'User-Agent' = 'fetchweir' }
                $FwRelUri = if ($FwIsLatest) {
                    "https://api.github.com/repos/$FwRepo/releases/latest"
                } else {
                    "https://api.github.com/repos/$FwRepo/releases/tags/$FwTag"
                }
                $FwRel = Invoke-RestMethod -Uri $FwRelUri -Headers $FwHeaders -TimeoutSec 120
                $FwFound = $FwRel.assets | Where-Object { $_.name -eq $FwAsset } | Select-Object -First 1
                if (-not $FwFound) { throw "tag $FwTag 下没有资产 $FwAsset" }
                $FwHeaders['Accept'] = 'application/octet-stream'
                Invoke-WebRequest -Uri $FwFound.url -Headers $FwHeaders -OutFile $FwOut -TimeoutSec 900
            } else {
                Invoke-WebRequest -Uri $FwDirect -OutFile $FwOut -TimeoutSec 900
            }
            if (-not (Test-Path $FwOut) -or (Get-Item $FwOut).Length -le 0) { throw "下载结果为空：$FwAsset" }
            if ($FwSha1) {
                $FwActual = (Get-FileHash $FwOut -Algorithm SHA1).Hash
                if ($FwActual -ne $FwSha1.ToUpper()) { throw "sha1 不符：$FwAsset 期望 $FwSha1 实际 $FwActual" }
            }
            return
        } catch {
            $FwErr = $_.Exception.Message
        }
        Write-Host "第 $FwAttempt 次下载失败（$FwAsset）：$FwErr"
        if ($FwAttempt -ge $FwAttempts) { throw "下载失败（$FwAsset，共 $FwAttempts 次）：$FwErr" }
        Start-Sleep -Seconds (10 * $FwAttempt)
    }
}
