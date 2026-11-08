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
  pwsh -File .\tools\Build-Fw.ps1 -FwTask bundle -FwScope perMachine   # 额外产出 *-setup-allusers.exe
.EXAMPLE
  pwsh -File .\tools\Build-Fw.ps1 -FwTask release   # 一条命令：两种安装范围 + 落 dist + 打印 SHA256
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'test', 'build', 'bundle', 'release', 'dev')]
    [string]$FwTask = 'build',
    [ValidateSet('currentUser', 'perMachine')]
    [string]$FwScope = 'currentUser'
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
    'bundle' {
        if ($FwScope -eq 'perMachine') {
            # 覆盖 NSIS 安装范围，安装到 Program Files 并写 HKLM 卸载项；
            # 产物改名带 -setup-allusers 后缀，供更新器按安装范围匹配。
            # tauri 两种范围产出同名文件：先备份已构建的用户级包，perMachine 构建完再还原，
            # 避免把用户级包覆盖成提权安装包。
            $FwBundleRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $FwRepoRoot 'src-tauri\target' }
            $FwNsisDir = Join-Path $FwBundleRoot 'release\bundle\nsis'
            $FwVer = (Get-Content (Join-Path $FwRepoRoot 'version.json') -Raw | ConvertFrom-Json).version
            $FwSetup = Join-Path $FwNsisDir "Fetchweir_${FwVer}_x64-setup.exe"
            $FwBackup = "$FwSetup.userbak"
            $FwHadUser = Test-Path $FwSetup
            if ($FwHadUser) { Copy-Item $FwSetup $FwBackup -Force }
            $FwJson = '{"bundle":{"windows":{"nsis":{"installMode":"perMachine"}}}}'
            & npm run build --prefix $FwRepoRoot -- --config $FwJson
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            if (-not (Test-Path $FwSetup)) { throw "未找到 perMachine 安装包：$FwSetup" }
            $FwAllUsers = $FwSetup -replace '-setup\.exe$', '-setup-allusers.exe'
            Copy-Item $FwSetup $FwAllUsers -Force
            if ($FwHadUser) {
                Move-Item $FwBackup $FwSetup -Force
                Write-Host '已还原用户级安装包'
            } else {
                Write-Host '未发现既有用户级安装包，请再跑一次默认范围构建' -ForegroundColor Yellow
            }
            Write-Host "perMachine 安装包：$FwAllUsers"
        } else {
            & npm run build --prefix $FwRepoRoot
        }
    }
    'release' {
        # 一条命令出包：先用户级、再所有用户级，最后统一落到 dist 并打印 SHA256。
        # CI 只打版本标记，安装包只在本机产出（见 docs/发布检查清单.md）。
        & $PSCommandPath -FwTask bundle
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $PSCommandPath -FwTask bundle -FwScope perMachine
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        $FwRelRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $FwRepoRoot 'src-tauri\target' }
        $FwRelNsis = Join-Path $FwRelRoot 'release\bundle\nsis'
        $FwRelVer = (Get-Content (Join-Path $FwRepoRoot 'version.json') -Raw | ConvertFrom-Json).version
        $FwRelDist = Join-Path $FwRepoRoot 'dist'
        New-Item -ItemType Directory -Path $FwRelDist -Force | Out-Null
        $FwRelNames = @(
            "Fetchweir_${FwRelVer}_x64-setup.exe",
            "Fetchweir_${FwRelVer}_x64-setup-allusers.exe"
        )
        foreach ($FwName in $FwRelNames) {
            $FwSrc = Join-Path $FwRelNsis $FwName
            if (-not (Test-Path -LiteralPath $FwSrc)) { throw "缺少安装包：$FwSrc" }
            $FwDst = Join-Path $FwRelDist $FwName
            Copy-Item -LiteralPath $FwSrc -Destination $FwDst -Force
            $FwHash = (Get-FileHash -LiteralPath $FwDst -Algorithm SHA256).Hash.ToLower()
            Write-Host ("{0}`n  {1} 字节`n  SHA256 {2}" -f $FwName, (Get-Item -LiteralPath $FwDst).Length, $FwHash)
        }
        Write-Host "版本 $FwRelVer 的两个安装包已输出到 $FwRelDist" -ForegroundColor Green
    }
    'dev' { & npm run dev --prefix $FwRepoRoot }
}

exit $LASTEXITCODE
