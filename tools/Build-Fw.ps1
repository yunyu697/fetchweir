#Requires -Version 7.0
<#
.SYNOPSIS
  Fetchweir 本地构建入口：自动补全 Rust / mingw 工具链 PATH 后执行 cargo 或 tauri 命令。
.DESCRIPTION
  在只有 GNU 工具链的 Windows 机器上，rustc 需要 dlltool.exe / windres.exe；
  且 mingw 安装路径不能含空格，否则 ld 会解析失败。脚本按顺序探测可用路径。
.EXAMPLE
  pwsh -File .\tools\Build-Fw.ps1 -FwTask test
.EXAMPLE
  pwsh -File .\tools\Build-Fw.ps1 -FwTask bundle
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'test', 'build', 'bundle', 'dev')]
    [string]$FwTask = 'build'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$FwRepoRoot = Split-Path -Parent $PSScriptRoot
$FwCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path $FwCargoBin) {
    $env:Path = "$FwCargoBin;$env:Path"
}

# mingw 需要提供 dlltool / windres，且目录不能含空格
$FwMingwCandidates = @(
    'D:\fw-tools\mingw64\bin',
    (Join-Path $env:LOCALAPPDATA 'winlibs\mingw64\bin')
)
foreach ($FwCandidate in $FwMingwCandidates) {
    if (Test-Path (Join-Path $FwCandidate 'dlltool.exe')) {
        $env:Path = "$FwCandidate;$env:Path"
        break
    }
}

$FwCargoArgs = @('--manifest-path', (Join-Path $FwRepoRoot 'src-tauri\Cargo.toml'))

# windres 无法处理含空格的输出路径：仓库路径有空格时，把 target 目录指到无空格位置
if ($FwRepoRoot -match ' ') {
    $FwTargetDir = 'D:\fw-build\fetchweir'
    if (-not (Test-Path $FwTargetDir)) {
        New-Item -ItemType Directory -Path $FwTargetDir -Force | Out-Null
    }
    $env:CARGO_TARGET_DIR = $FwTargetDir
    Write-Host "CARGO_TARGET_DIR = $FwTargetDir（仓库路径含空格，规避 windres 失败）"
}

switch ($FwTask) {
    'check' { & cargo check @FwCargoArgs --all-targets }
    'test' { & cargo test @FwCargoArgs --all-targets }
    'build' { & cargo build @FwCargoArgs }
    'bundle' { & npm run build --prefix $FwRepoRoot }
    'dev' { & npm run dev --prefix $FwRepoRoot }
}

exit $LASTEXITCODE
