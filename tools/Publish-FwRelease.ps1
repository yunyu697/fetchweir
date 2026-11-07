#Requires -Version 7.0
<#
.SYNOPSIS
  把本次构建产物整理成 latest.json（含 SHA256）、签名，并推送到公开「发布产物」仓库。

.DESCRIPTION
  源码仓库保持私有；客户端只读公开仓库的 releases/latest/download/latest.json，
  用内置 Ed25519 公钥验签，再按清单里的 SHA256 校验安装包。

  需要两个凭据（均只在 CI 使用，不进客户端）：
    FW_RELEASES_PAT  对公开仓库有 contents:write 权限的 PAT
    FW_SIGNING_KEY   与客户端内置公钥配对的 Ed25519 私钥（PKCS#8 PEM）

  未配置 PAT 时脚本直接跳过并返回 0，方便流水线先落地、凭据到位即启用。

.EXAMPLE
  ./tools/Publish-FwRelease.ps1 -FwTag v1.0.4 -FwDir dist
#>
param(
  [Parameter(Mandatory = $true)][string]$FwTag,
  [Parameter(Mandatory = $true)][string]$FwDir,
  [string]$FwRepo = 'yunyu697/fetchweir-releases',
  [string]$FwNotesFile = '',
  [switch]$FwDryRun
)

$ErrorActionPreference = 'Stop'

$FwVersion = $FwTag -replace '^[vV]', ''
if ($FwVersion -notmatch '^\d+\.\d+\.\d+') {
  throw "tag 不是语义化版本：$FwTag"
}

if (-not $FwDryRun -and [string]::IsNullOrWhiteSpace($env:FW_RELEASES_PAT)) {
  Write-Host '跳过公开仓库发布：未配置 FW_RELEASES_PAT'
  return
}
if (-not $FwDryRun -and [string]::IsNullOrWhiteSpace($env:FW_SIGNING_KEY)) {
  throw '缺少 FW_SIGNING_KEY：无法给发布清单签名，拒绝发布未签名清单'
}
# 名称 -> 平台/架构；识别不了的产物仍上传，但不会写进清单（客户端不会选它）。
function Get-FwAssetTarget([string]$Name) {
  $n = $Name.ToLowerInvariant()
  $arm = $n -match 'aarch64|arm64'
  if ($n -match '\.(exe|msi)$') { return @{ platform = 'windows'; arch = $(if ($arm) { 'aarch64' } else { 'x86_64' }) } }
  if ($n -match '\.dmg$') { return @{ platform = 'macos'; arch = $(if ($arm) { 'aarch64' } else { 'x86_64' }) } }
  if ($n -match '\.(appimage|deb|rpm)$' -or $n -match '\.app\.tar\.gz$') {
    return @{ platform = 'linux'; arch = $(if ($arm) { 'aarch64' } else { 'x86_64' }) }
  }
  return $null
}

$files = Get-ChildItem -Path $FwDir -File | Where-Object { $_.Name -notmatch '^latest\.json(\.sig)?$' }
if (-not $files) { throw "产物目录为空：$FwDir" }

$assets = @()
foreach ($f in $files) {
  $target = Get-FwAssetTarget $f.Name
  if (-not $target) { Write-Host "跳过（无法识别平台）：$($f.Name)"; continue }
  $assets += [ordered]@{
    platform = $target.platform
    arch     = $target.arch
    name     = $f.Name
    url      = "https://github.com/$FwRepo/releases/download/$FwTag/$($f.Name)"
    size     = $f.Length
    sha256   = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
if (-not $assets) { throw '没有任何可识别的安装包，无法生成清单' }

$notes = ''
if ($FwNotesFile -and (Test-Path $FwNotesFile)) {
  $notes = Get-Content -Path $FwNotesFile -Raw
}

$manifest = [ordered]@{
  version      = $FwVersion
  published_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  notes        = $notes
  min_system   = [ordered]@{
    windows = 'Windows 10 1809 及以上'
    macos   = 'macOS 11 及以上'
    linux   = 'glibc 2.31 及以上'
  }
  assets       = $assets
}

$manifestPath = Join-Path $FwDir 'latest.json'
$manifestJson = $manifest | ConvertTo-Json -Depth 8
[IO.File]::WriteAllText($manifestPath, $manifestJson, [Text.UTF8Encoding]::new($false))

$sigPath = "$manifestPath.sig"
if (-not [string]::IsNullOrWhiteSpace($env:FW_SIGNING_KEY)) {
  # 签名脚本会校验「私钥推导出的公钥」与内置 RELEASE_PUBKEY_B64 是否一致；
  # 不一致直接失败。这里不会、也不允许在发版流程中生成新密钥。
  node ./tools/Sign-FwManifest.mjs --in $manifestPath --out $sigPath
  if ($LASTEXITCODE -ne 0) {
    throw '清单签名失败：私钥与客户端内置公钥可能不一致（发布密钥固定，不会自动换钥；见 docs/更新机制.md）'
  }
} elseif ($FwDryRun) {
  Write-Host '（dry-run）未提供 FW_SIGNING_KEY，跳过签名'
} else {
  throw '缺少 FW_SIGNING_KEY，拒绝发布未签名清单'
}

Write-Host "清单已生成：$manifestPath（$($assets.Count) 个安装包）"
if ($FwDryRun) {
  Write-Host $manifestJson
  return
}

$gh = 'gh'
if (Test-Path 'C:\Program Files\GitHub CLI\gh.exe') { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }

$exists = & $gh release view $FwTag --repo $FwRepo 2>$null
if ($LASTEXITCODE -ne 0) {
  $createArgs = @('release', 'create', $FwTag, '--repo', $FwRepo, '--title', "Fetchweir $FwTag")
  if ($notes) { $createArgs += @('--notes', $notes) } else { $createArgs += @('--notes', "Fetchweir $FwTag 发布产物") }
  if ($FwVersion -match '-') { $createArgs += '--prerelease' }
  & $gh @createArgs
  if ($LASTEXITCODE -ne 0) { throw '创建公开 Release 失败' }
}

$upload = @('release', 'upload', $FwTag, '--repo', $FwRepo, '--clobber') + ($files | ForEach-Object { $_.FullName }) + @($manifestPath, $sigPath)
& $gh @upload
if ($LASTEXITCODE -ne 0) { throw '上传产物到公开仓库失败' }

Write-Host "已发布到 $FwRepo 的 $FwTag（含 latest.json 与 latest.json.sig）"
