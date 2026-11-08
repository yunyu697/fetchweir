#Requires -Version 7.0
<#
.SYNOPSIS
  1.0.5 新用户验收的环境隔离：备份/还原用户现有 1.0.4 的注册表、快捷方式、数据目录与 WebView2 profile。
.DESCRIPTION
  安装包按产品名写固定的 HKCU 卸载键、厂商键与快捷方式，测试安装会覆盖用户现有安装的登记信息。
  本脚本先把这些状态整体搬到工作目录，验收结束后原样搬回，并把用户数据目录与 WebView2 profile 换回去。
  用法：
    pwsh -NoProfile -File tools/Accept-Fw105-Env.ps1 -Mode Backup
    pwsh -NoProfile -File tools/Accept-Fw105-Env.ps1 -Mode Restore
    pwsh -NoProfile -File tools/Accept-Fw105-Env.ps1 -Mode Status
#>
[CmdletBinding()]
param(
    [ValidateSet('Backup', 'Restore', 'Status')]
    [string]$Mode = 'Status',
    [string]$WorkDir = 'D:\fw-accept'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DataDir = Join-Path $env:APPDATA 'Fetchweir'
$WebViewDir = Join-Path $env:LOCALAPPDATA 'dev.fetchweir.app'
$UninstallKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fetchweir'
$ManuKey = 'HKCU\Software\fetchweir'
$NmKeys = @(
    'HKCU\Software\Google\Chrome\NativeMessagingHosts\dev.fetchweir.nmh',
    'HKCU\Software\Chromium\NativeMessagingHosts\dev.fetchweir.nmh',
    'HKCU\Software\Microsoft\Edge\NativeMessagingHosts\dev.fetchweir.nmh',
    'HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\dev.fetchweir.nmh',
    'HKCU\Software\Vivaldi\NativeMessagingHosts\dev.fetchweir.nmh',
    'HKCU\Software\Mozilla\NativeMessagingHosts\dev.fetchweir.nmh'
)
$Shortcuts = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Fetchweir.lnk'),
    (Join-Path $env:USERPROFILE 'Desktop\Fetchweir.lnk')
)

$Backup = Join-Path $WorkDir 'backup'
$DataBak = Join-Path $Backup 'data'
$WebViewBak = Join-Path $Backup 'webview'
$RegBak = Join-Path $Backup 'registry'
$ShortcutBak = Join-Path $Backup 'shortcuts'

function Write-Step([string]$Text) { Write-Host "· $Text" }

function Export-Key([string]$Key, [string]$File) {
    if (-not (Test-Path "Registry::$Key")) {
        Write-Step "跳过（不存在）：$Key"
        return
    }
    & reg.exe export $Key $File /y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "reg export 失败：$Key" }
    Write-Step "已导出：$Key → $File"
}

function Import-Key([string]$Key, [string]$File) {
    if (-not (Test-Path -LiteralPath $File)) { Write-Step "跳过（无备份）：$Key"; return }
    & reg.exe import $File | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "reg import 失败：$File" }
    Write-Step "已恢复：$Key"
}

function Stop-TestApps {
    Get-Process -Name 'fetchweir' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $p = $_.Path
            if ($p -and $p -like '*Fetchweir-Accept*') {
                Write-Step "结束测试进程：$p（pid $($_.Id)）"
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { Write-Step "跳过进程 $($_.Id)：$($_.Exception.Message)" }
    }
    Start-Sleep -Milliseconds 500
}

switch ($Mode) {
    'Backup' {
        if (Test-Path -LiteralPath $Backup) { throw "备份目录已存在，拒绝覆盖：$Backup（先 Restore 或手动清理）" }
        New-Item -ItemType Directory -Path $RegBak, $ShortcutBak -Force | Out-Null

        Export-Key $UninstallKey (Join-Path $RegBak 'uninstall-fetchweir.reg')
        Export-Key $ManuKey (Join-Path $RegBak 'software-fetchweir.reg')
        foreach ($k in $NmKeys) {
            $name = ($k -replace '^HKCU\\', '' -replace '\\', '_') + '.reg'
            Export-Key $k (Join-Path $RegBak $name)
        }

        foreach ($s in $Shortcuts) {
            if (Test-Path -LiteralPath $s) {
                Copy-Item -LiteralPath $s -Destination $ShortcutBak -Force
                Write-Step "已备份快捷方式：$s"
            } else {
                Write-Step "跳过（不存在）：$s"
            }
        }

        # 数据目录整体搬走（体积很小），测试期间应用会新建一个干净目录。
        if (Test-Path -LiteralPath $DataDir) {
            Move-Item -LiteralPath $DataDir -Destination $DataBak -Force
            Write-Step "已搬走数据目录：$DataDir → $DataBak"
        }
        # WebView2 profile（约 60MB）复制备份；卸载测试会把它整目录删掉。
        if (Test-Path -LiteralPath $WebViewDir) {
            Copy-Item -LiteralPath $WebViewDir -Destination $WebViewBak -Recurse -Force
            Write-Step "已备份 WebView2 profile：$WebViewDir → $WebViewBak"
        }

        # 记录现有安装指纹，用于结束时证明未改动。
        $exe = Join-Path $env:LOCALAPPDATA 'Fetchweir\fetchweir.exe'
        if (Test-Path -LiteralPath $exe) {
            $h = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
            Set-Content -LiteralPath (Join-Path $Backup 'user-install.sha256') -Value $h
            Write-Step "用户 1.0.4 主程序 SHA256：$h"
        }
        Write-Host "备份完成：$Backup"
    }

    'Restore' {
        Stop-TestApps

        foreach ($f in Get-ChildItem -LiteralPath $RegBak -Filter '*.reg' -ErrorAction SilentlyContinue) {
            & reg.exe import $f.FullName | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "reg import 失败：$($f.FullName)" }
            Write-Step "已恢复注册表：$($f.Name)"
        }

        foreach ($s in $Shortcuts) {
            $b = Join-Path $ShortcutBak (Split-Path $s -Leaf)
            if (Test-Path -LiteralPath $b) {
                Copy-Item -LiteralPath $b -Destination $s -Force
                Write-Step "已恢复快捷方式：$s"
            }
        }

        # 还原数据目录：删掉测试期间新建的，再把备份搬回。
        if (Test-Path -LiteralPath $DataBak) {
            if (Test-Path -LiteralPath $DataDir) {
                Remove-Item -LiteralPath $DataDir -Recurse -Force
                Write-Step "已删除测试数据目录：$DataDir"
            }
            Move-Item -LiteralPath $DataBak -Destination $DataDir -Force
            Write-Step "已还原数据目录：$DataBak → $DataDir"
        }

        if (Test-Path -LiteralPath $WebViewBak) {
            if (Test-Path -LiteralPath $WebViewDir) {
                Remove-Item -LiteralPath $WebViewDir -Recurse -Force
            }
            Copy-Item -LiteralPath $WebViewBak -Destination $WebViewDir -Recurse -Force
            Write-Step "已还原 WebView2 profile：$WebViewDir"
        }

        # 测试安装落在 %LOCALAPPDATA% 下（与真实「仅当前用户」安装同范围），目录名带 Accept 后缀避免撞真实安装。
        foreach ($d in @('Fetchweir-AcceptA', 'Fetchweir-AcceptB')) {
            $p = Join-Path $env:LOCALAPPDATA $d
            if (Test-Path -LiteralPath $p) {
                Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
                Write-Step "已删除测试安装：$p"
            }
        }

        $hashFile = Join-Path $Backup 'user-install.sha256'
        if (Test-Path -LiteralPath $hashFile) {
            $want = (Get-Content -LiteralPath $hashFile -Raw).Trim()
            $got = (Get-FileHash -LiteralPath (Join-Path $env:LOCALAPPDATA 'Fetchweir\fetchweir.exe') -Algorithm SHA256).Hash
            if ($want -ne $got) { throw "用户 1.0.4 主程序被改动：$want → $got" }
            Write-Step "用户 1.0.4 主程序未改动：$got"
        }
        Write-Host "还原完成"
    }

    'Status' {
        Write-Host "== 工作目录 =="
        Get-ChildItem -LiteralPath $WorkDir -Force -ErrorAction SilentlyContinue |
            Select-Object Mode, LastWriteTime, Length, Name | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
        Write-Host "== 卸载登记 =="
        & reg.exe query $UninstallKey /s 2>$null | Write-Host
        Write-Host "== 数据目录存在：$(Test-Path -LiteralPath $DataDir) =="
        Get-ChildItem -LiteralPath $DataDir -Force -ErrorAction SilentlyContinue |
            Select-Object LastWriteTime, Length, Name | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
    }
}
