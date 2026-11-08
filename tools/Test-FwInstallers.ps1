#Requires -Version 7.0
<#
.SYNOPSIS
  校验 dist/ 下两个安装范围包：字节不同，内嵌执行级别分别是 asInvoker / requireAdministrator。
.DESCRIPTION
  · 两个文件都存在且非空；
  · SHA256 不同（证明确实是两个不同的包，不是同一个文件复制两份）；
  · 当前用户包内嵌 asInvoker，且不含 requireAdministrator；
  · 所有用户包内嵌 requireAdministrator。
  CI 里会把结论写进 GITHUB_STEP_SUMMARY；本地跑则直接打印。
.EXAMPLE
  pwsh -NoProfile -File tools/Test-FwInstallers.ps1
.EXAMPLE
  pwsh -NoProfile -File tools/Test-FwInstallers.ps1 -FwDist D:\fw-dist
#>
[CmdletBinding()]
param(
    [string]$FwDist = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$FwRepo = Split-Path -Parent $PSScriptRoot
if (-not $FwDist) { $FwDist = Join-Path $FwRepo 'dist' }
$FwVer = (Get-Content (Join-Path $FwRepo 'version.json') -Raw | ConvertFrom-Json).version

$FwUser = Join-Path $FwDist "Fetchweir_${FwVer}_x64-setup.exe"
$FwAll = Join-Path $FwDist "Fetchweir_${FwVer}_x64-setup-allusers.exe"

foreach ($FwPath in @($FwUser, $FwAll)) {
    if (-not (Test-Path -LiteralPath $FwPath)) {
        throw "缺少安装包：$FwPath（先跑 tools/Build-Fw.ps1 -FwTask release）"
    }
    if ((Get-Item -LiteralPath $FwPath).Length -le 0) { throw "安装包为空：$FwPath" }
}

# NSIS 把安装器清单以明文嵌在 exe 里，按 ASCII 扫就够（asInvoker / requireAdministrator 都是 ASCII）。
$FwUserText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($FwUser))
$FwAllText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($FwAll))
$FwUserHash = (Get-FileHash -LiteralPath $FwUser -Algorithm SHA256).Hash
$FwAllHash = (Get-FileHash -LiteralPath $FwAll -Algorithm SHA256).Hash

$FwChecks = @(
    @{ Name = '两包字节不同'; Pass = ($FwUserHash -ne $FwAllHash); Detail = "$FwUserHash vs $FwAllHash" }
    @{ Name = '当前用户包内嵌 asInvoker'; Pass = ($FwUserText -match 'asInvoker'); Detail = $FwUser }
    @{ Name = '当前用户包不要求管理员'; Pass = ($FwUserText -notmatch 'requireAdministrator'); Detail = $FwUser }
    @{ Name = '所有用户包要求管理员'; Pass = ($FwAllText -match 'requireAdministrator'); Detail = $FwAll }
)

$FwLines = foreach ($FwCheck in $FwChecks) {
    $FwMark = if ($FwCheck.Pass) { 'PASS' } else { 'FAIL' }
    $FwLine = "[$FwMark] $($FwCheck.Name) — $($FwCheck.Detail)"
    Write-Host $FwLine
    $FwLine
}
Write-Host ("用户级包 {0} 字节 / 所有用户包 {1} 字节" -f (Get-Item -LiteralPath $FwUser).Length, (Get-Item -LiteralPath $FwAll).Length)

if ($env:GITHUB_STEP_SUMMARY) {
    Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @(
        '### 安装包校验',
        '',
        "| 检查 | 结果 |",
        "| --- | --- |",
        ($FwChecks | ForEach-Object { "| $($_.Name) | $(if ($_.Pass) { 'PASS' } else { 'FAIL' }) |" }),
        ''
    )
}

if ($FwChecks | Where-Object { -not $_.Pass }) { exit 1 }
exit 0
