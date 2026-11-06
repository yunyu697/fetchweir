#Requires -Version 7.0
<#
.SYNOPSIS
  校验 version.json：格式合法、minor/patch ≤ 10、tag 与版本一致。
.DESCRIPTION
  供本地与 CI 调用；任何违规都返回非零退出码，让构建直接红灯。
.EXAMPLE
  pwsh -File .\tools\Test-FwVersion.ps1
.EXAMPLE
  pwsh -File .\tools\Test-FwVersion.ps1 -FwTag v1.0.0-alpha1
#>
[CmdletBinding()]
param(
    [string]$FwTag = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$FwRepoRoot = Split-Path -Parent $PSScriptRoot
$FwVersionFile = Join-Path $FwRepoRoot 'version.json'

$FwJson = Get-Content -LiteralPath $FwVersionFile -Raw | ConvertFrom-Json
$FwVersion = [string]$FwJson.version

if ($FwVersion -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-alpha([0-9]+))?$') {
    Write-Error "版本号格式不合法: $FwVersion"
    exit 1
}

$FwMinor = [int]$Matches[2]
$FwPatch = [int]$Matches[3]
if ($FwMinor -gt 10 -or $FwPatch -gt 10) {
    Write-Error "版本号越界: $FwVersion（除第一位与 alpha 编号外，其余各位不得超过 10）"
    exit 1
}

if (-not [string]::IsNullOrWhiteSpace($FwTag)) {
    if (-not $FwTag.StartsWith('v')) {
        Write-Error "tag 必须以 v 开头: $FwTag"
        exit 1
    }
    $FwTagVersion = $FwTag.Substring(1)
    if ($FwTagVersion -ne $FwVersion) {
        Write-Error "tag 与 version.json 不一致: tag=$FwTagVersion, version.json=$FwVersion"
        exit 1
    }
}

# 纯数字位（用于 AssemblyVersion/FileVersion 一类字段）
$FwNumeric = ($FwVersion -split '-')[0]

Write-Host "版本: $FwVersion"
Write-Host "数字位: $FwNumeric"
Write-Host "校验通过" -ForegroundColor Green
