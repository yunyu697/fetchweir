#Requires -Version 7.0
<#
.SYNOPSIS
  Fetchweir 版本号工具：预览/写回唯一来源 version.json。
.DESCRIPTION
  规则（与 docs/版本号规则.md 一致）：
    · major 不设上限；minor / patch 取值 0–10，超过 10 向前进位并归零。
    · alpha 编号不设上限，只对 alpha 本身递增。
    · 除第一位与 alpha 编号外，其余各位不得超过 10 —— 越界直接拒绝。
.EXAMPLE
  pwsh -File .\tools\Next-FwVersion.ps1 -FwBump alpha
.EXAMPLE
  pwsh -File .\tools\Next-FwVersion.ps1 -FwBump release -FwApply
.EXAMPLE
  pwsh -File .\tools\Next-FwVersion.ps1 -FwBump patch -FwApply
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [ValidateSet('patch', 'minor', 'major', 'alpha', 'release')]
    [string]$FwBump = 'patch',

    [switch]$FwApply,

    # 仅用于预览/核对规则，不读文件
    [string]$FwCurrent = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$FwRepoRoot = Split-Path -Parent $PSScriptRoot
$FwVersionFile = Join-Path $FwRepoRoot 'version.json'

if ([string]::IsNullOrWhiteSpace($FwCurrent)) {
    $FwJson = Get-Content -LiteralPath $FwVersionFile -Raw | ConvertFrom-Json
    $FwCurrent = [string]$FwJson.version
}

$FwParse = [regex]::Match($FwCurrent, '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-alpha([0-9]+))?$')
if (-not $FwParse.Success) {
    throw "当前版本格式不合法: $FwCurrent（期望 1.0.0 或 1.0.0-alpha1）。"
}

$FwMajor = [int]$FwParse.Groups[1].Value
$FwMinor = [int]$FwParse.Groups[2].Value
$FwPatch = [int]$FwParse.Groups[3].Value
$FwAlpha = if ($FwParse.Groups[4].Success) { [int]$FwParse.Groups[4].Value } else { -1 }

if ($FwMinor -gt 10 -or $FwPatch -gt 10) {
    throw "当前版本越界: $FwCurrent（minor / patch 必须在 0–10，不允许出现 11）。"
}

$FwNextMajor = $FwMajor
$FwNextMinor = $FwMinor
$FwNextPatch = $FwPatch
$FwNextAlpha = $FwAlpha

switch ($FwBump) {
    'alpha' {
        $FwNextAlpha = if ($FwAlpha -lt 1) { 1 } else { $FwAlpha + 1 }
    }
    'release' {
        if ($FwAlpha -lt 1) {
            throw "当前版本不是 alpha 预发布: $FwCurrent，无需转正式。"
        }
        $FwNextAlpha = -1
    }
    'patch' {
        $FwNextPatch = $FwPatch + 1
        $FwNextAlpha = -1
        if ($FwNextPatch -gt 10) {
            $FwNextPatch = 0
            $FwNextMinor = $FwMinor + 1
            if ($FwNextMinor -gt 10) {
                $FwNextMinor = 0
                $FwNextMajor = $FwMajor + 1
            }
        }
    }
    'minor' {
        $FwNextMinor = $FwMinor + 1
        $FwNextPatch = 0
        $FwNextAlpha = -1
        if ($FwNextMinor -gt 10) {
            $FwNextMinor = 0
            $FwNextMajor = $FwMajor + 1
        }
    }
    'major' {
        $FwNextMajor = $FwMajor + 1
        $FwNextMinor = 0
        $FwNextPatch = 0
        $FwNextAlpha = -1
    }
}

$FwNextVersion = "$FwNextMajor.$FwNextMinor.$FwNextPatch"
if ($FwNextAlpha -ge 1) {
    $FwNextVersion += "-alpha$FwNextAlpha"
}

Write-Host "当前版本: $FwCurrent"
Write-Host "升级类型: $FwBump"
Write-Host "下一版本: $FwNextVersion" -ForegroundColor Green

if (-not $FwApply) {
    Write-Host '（预览模式，未写回。加 -FwApply 才会修改 version.json。）' -ForegroundColor DarkGray
    return
}

if (-not $PSCmdlet.ShouldProcess($FwVersionFile, "把版本从 $FwCurrent 改为 $FwNextVersion")) {
    return
}

$FwUpdated = [ordered]@{ version = $FwNextVersion }
$FwUpdated | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $FwVersionFile -Encoding utf8
Write-Host "已写回 $FwVersionFile（git tag 请用 v$FwNextVersion）。" -ForegroundColor Green
