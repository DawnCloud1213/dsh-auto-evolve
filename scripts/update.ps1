<#
.SYNOPSIS
    @dawn/dsh-auto-evolve 一键更新脚本

.DESCRIPTION
    DSH 插件管理器的「更新」按钮只对「从 npm registry 安装、包名即 registry 名」的插件显示
    （见宿主 dsh-plugin-manager 的 updateRefusal 判定）。本地 file: 依赖与自建 git 仓库装的
    第三方插件永远拿不到 installTarget，因此永远不会出现「更新」按钮。

    所以更新只能靠脚本走完这套固定动作：
        1. 定位 DSH profile 目录
        2. 备份当前已安装版本（出问题可回退）
        3. 删除 node_modules 里的插件拷贝（pnpm 对 file: 依赖是拷贝，不删则 install 认为是最新）
        4. 若是本地 file: 源目录，先 git pull 拉取最新代码
        5. pnpm install 重新安装
        6. 校验新装文件的哈希与源目录一致
        7. 提示重启 DSH

    注意：改完插件代码必须重启 DSH 桌面应用，热重载会留下「僵尸实例」（心跳在但事件不接管）。

.PARAMETER ProfileDir
    DSH profile 目录，默认自动探测 ~/.dsh/profiles/desktop。

.PARAMETER SourceDir
    插件源码目录。默认从 profile 的 package.json 依赖里解析，解析不到则用脚本所在仓库。

.PARAMETER DryRun
    只显示将要做什么，不做任何改动。

.PARAMETER SkipGitPull
    跳过源目录的 git pull（源码目录不是 git 仓库或不想拉取时用）。

.PARAMETER PnpmPath
    手动指定 pnpm 路径（默认自动查找全局 pnpm → DSH 自带 pnpm）。

.EXAMPLE
    .\update.ps1
    常规更新。

.EXAMPLE
    .\update.ps1 -DryRun
    预览将要执行的动作。

.EXAMPLE
    .\update.ps1 -ProfileDir "D:\other\.dsh\profiles\work"
    更新另一个 profile 里的同名插件。
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = '',
    [string]$SourceDir = '',
    [switch]$DryRun,
    [switch]$SkipGitPull,
    [string]$PnpmPath = ''
)

$ErrorActionPreference = 'Stop'
$PackageName = '@dawn/dsh-auto-evolve'
$PluginDirName = 'dsh-auto-evolve'
$ScopeName = '@dawn'
$Script:StepNo = 0

# ---------- 输出小工具 ----------
function Write-Step($msg) {
    $Script:StepNo++
    Write-Host ''
    Write-Host ("[{0}] {1}" -f $Script:StepNo, $msg) -ForegroundColor Cyan
}
function Write-Ok($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Fail($msg) {
    Write-Host ''
    Write-Host "[失败] $msg" -ForegroundColor Red
    Write-Host '更新未完成。可直接重跑本脚本，或用备份目录回退（见上方备份路径）。' -ForegroundColor Red
    exit 1
}

# 调用外部命令（git / pnpm）。关键：脚本全局是 $ErrorActionPreference='Stop'，
# 而外部命令的 stderr 在 PS 5.1 里会被包成 ErrorRecord 触发终止性错误——
# 结果是 pnpm 失败时脚本直接崩掉、回滚逻辑根本不执行（这是实测踩到的真坑）。
# 所以这里临时降级为 Continue，并把 stdout/stderr 统一当文本打印，只靠退出码判断成败。
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$WorkDir)
    $oldLocation = Get-Location
    $oldEAP = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($WorkDir) { Set-Location -LiteralPath $WorkDir }
        $lines = & $Exe @Arguments 2>&1
        $code = $LASTEXITCODE
        foreach ($line in $lines) {
            $text = if ($line -is [System.Management.Automation.ErrorRecord]) { $line.ToString() } else { [string]$line }
            Write-Host "    $text" -ForegroundColor DarkGray
        }
        return $code
    }
    finally {
        $ErrorActionPreference = $oldEAP
        Set-Location -LiteralPath $oldLocation
    }
}

function Get-Sha16($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.Substring(0, 16)
}

# ---------- 前置检查 ----------
Write-Host '===========================================' -ForegroundColor Magenta
Write-Host '  DSH 自进化插件 · 一键更新' -ForegroundColor Magenta
Write-Host '===========================================' -ForegroundColor Magenta
if ($DryRun) { Write-Host '  *** 预览模式（DryRun）：不会改动任何文件 ***' -ForegroundColor Yellow }

Write-Step '定位 DSH profile 目录'
if (-not $ProfileDir) {
    $candidate = Join-Path $HOME '.dsh\profiles\desktop'
    if (Test-Path -LiteralPath $candidate) {
        $ProfileDir = $candidate
    } else {
        $ProfilesRoot = Join-Path $HOME '.dsh\profiles'
        if (Test-Path -LiteralPath $ProfilesRoot) {
            $found = Get-ChildItem -LiteralPath $ProfilesRoot -Directory |
                Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') }
            if ($found.Count -eq 1) { $ProfileDir = $found[0].FullName }
            elseif ($found.Count -gt 1) {
                Fail ("找到多个 profile，请用 -ProfileDir 指定一个：`n  " + (($found | ForEach-Object { $_.FullName }) -join "`n  "))
            }
        }
    }
}
if (-not $ProfileDir -or -not (Test-Path -LiteralPath $ProfileDir)) {
    Fail "找不到 DSH profile 目录。请用 -ProfileDir 指定（通常是 <你的用户目录>\.dsh\profiles\desktop）。"
}
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$ProfileManifest = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $ProfileManifest)) {
    Fail "该目录下没有 package.json，不像 DSH profile 目录：$ProfileDir"
}
Write-Ok "profile：$ProfileDir"

$NodeModules = Join-Path $ProfileDir 'node_modules'
$InstalledDir = Join-Path $NodeModules ($ScopeName + '\' + $PluginDirName)

Write-Step '检查插件是否已安装'
if (-not (Test-Path -LiteralPath $InstalledDir)) {
    Fail ("$InstalledDir 不存在。插件似乎还没安装，请先按 README 的「安装」章节安装，而不是更新。")
}
$manifestText = Get-Content -LiteralPath $ProfileManifest -Raw
if ($manifestText -notmatch [regex]::Escape($PackageName)) {
    Fail ("profile 的 package.json 里没有 $PackageName 依赖。请按 README 重新安装。")
}
$InstalledPkg = Join-Path $InstalledDir 'package.json'
# 注意：不要用 ConvertFrom-Json 读插件自己的 package.json——历史文件中 description 可能含
# GBK/UTF-8 混编产生的替换字符，Windows PowerShell 5.1 会解析失败。只取 version 用正则即可。
function Get-PkgVersion($jsonPath) {
    if (-not (Test-Path -LiteralPath $jsonPath)) { return '(未知)' }
    try {
        $raw = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8
        if ($raw -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
        return '(未知)'
    } catch { return '(未知)' }
}
$OldVersion = Get-PkgVersion $InstalledPkg
Write-Ok "已安装版本：$OldVersion"

# 记录依赖声明形式，决定后续怎么更新
$depSpec = $null
if ($manifestText -match ('"' + [regex]::Escape($PackageName) + '"\s*:\s*"([^"]+)"')) {
    $depSpec = $Matches[1]
}
Write-Info "依赖声明：$depSpec"

Write-Step '查找 node 与 pnpm'
$NodeExe = ''
foreach ($cand in @($env:DSH_NODE_PATH, 'C:\Program Files\nodejs\node.exe', (Join-Path $HOME 'AppData\Local\Programs\nodejs\node.exe'))) {
    if ($cand -and (Test-Path -LiteralPath $cand)) { $NodeExe = $cand; break }
}
if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe) { Fail '找不到 node。请安装 Node.js 20+，或设置环境变量 DSH_NODE_PATH。' }
Write-Ok "node：$NodeExe"

# pnpm：手动指定 → PATH 里的 pnpm → DSH 自带 pnpm（通过 node 调用 pnpm.cjs）
$PnpmExe = ''
$PnpmPrefixArgs = @()
if ($PnpmPath) {
    if (-not (Test-Path -LiteralPath $PnpmPath)) { Fail "指定的 -PnpmPath 不存在：$PnpmPath" }
    $PnpmExe = $PnpmPath
} else {
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCmd) {
        $PnpmExe = $pnpmCmd.Source
    } else {
        $dshPnpmCandidates = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'),
            (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs')
        )
        foreach ($c in $dshPnpmCandidates) {
            if ($c -and (Test-Path -LiteralPath $c)) {
                $PnpmExe = $NodeExe
                $PnpmPrefixArgs = @($c)
                Write-Info "未找到独立 pnpm，改用 DSH 自带 pnpm：$c"
                break
            }
        }
    }
}
if (-not $PnpmExe) {
    Fail '找不到 pnpm。请安装 pnpm（npm i -g pnpm），或用 -PnpmPath 指定 pnpm 路径。'
}
if (-not $PnpmPrefixArgs) { Write-Ok "pnpm：$PnpmExe" } else { Write-Ok "pnpm：$PnpmExe $($PnpmPrefixArgs -join ' ')" }

Write-Step '解析插件源码目录'
if (-not $SourceDir) {
    if ($depSpec -and $depSpec -match '^(?:file|link):(.+)$') {
        $raw = $Matches[1]
        $srcCandidate = $raw
        if (-not [System.IO.Path]::IsPathRooted($srcCandidate)) {
            $srcCandidate = Join-Path $ProfileDir $srcCandidate
        }
        if (Test-Path -LiteralPath $srcCandidate) {
            $SourceDir = (Resolve-Path -LiteralPath $srcCandidate).Path
        }
    }
    # 兜底：脚本所在仓库根目录（scripts 的上一级）
    if (-not $SourceDir) {
        $repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
        if (Test-Path -LiteralPath (Join-Path $repoRoot 'package.json')) {
            $SourceDir = $repoRoot
            Write-Info "依赖不是本地路径，改用脚本所在仓库作为源码目录。"
        }
    }
}
if ($SourceDir -and (Test-Path -LiteralPath $SourceDir)) {
    Write-Ok "源码目录：$SourceDir"
} else {
    Write-Warn2 '没有可用的源码目录。将只做「删除已装拷贝 + 重新 pnpm install」（适合 git 地址安装）。'
    $SourceDir = ''
}

# ---------- 备份 ----------
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $env:TEMP ("dsh-auto-evolve-backup-" + $Stamp)

Write-Step "备份当前已安装版本到临时目录"
Write-Info "备份路径：$BackupDir"
if ($DryRun) {
    Write-Info '(预览模式，跳过实际备份)'
} else {
    try {
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        Copy-Item -LiteralPath $InstalledDir -Destination $BackupDir -Recurse -Force
        Copy-Item -LiteralPath $ProfileManifest -Destination (Join-Path $BackupDir 'profile-package.json') -Force
        $lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
        if (Test-Path -LiteralPath $lockPath) {
            Copy-Item -LiteralPath $lockPath -Destination (Join-Path $BackupDir 'pnpm-lock.yaml') -Force
        }
        Write-Ok '备份完成'
    } catch {
        Fail "备份失败：$($_.Exception.Message)"
    }
}

# ---------- 拉取源码 ----------
if ($SourceDir) {
    $isGit = Test-Path -LiteralPath (Join-Path $SourceDir '.git')
    Write-Step '同步源码'
    if ($isGit) {
        if ($SkipGitPull) {
            Write-Info '按参数要求跳过 git pull。'
        } elseif ($DryRun) {
            Write-Info '（预览模式）将执行：git pull --ff-only'
        } else {
            $before = (Get-ChildItem -LiteralPath (Join-Path $SourceDir '.git') -Force | Measure-Object).Count
            $code = Invoke-Native -Exe 'git' -Arguments @('-C', $SourceDir, 'pull', '--ff-only') -WorkDir $SourceDir
            if ($code -ne 0) {
                Write-Warn2 'git pull 失败（可能有本地改动或没有远端）。继续使用当前目录的代码。'
            } else {
                Write-Ok '源码已更新到最新'
            }
        }
    } else {
        Write-Info '源码目录不是 git 仓库，跳过拉取（请自行保证目录内容是最新的）。'
    }
}

# ---------- 删除已装拷贝 ----------
Write-Step '删除 node_modules 里的旧拷贝'
Write-Info "pnpm 对 file: 依赖是「拷贝」而非软链，不删除则 install 会认为已是最新（这就是更新不生效的经典坑）。"
if ($DryRun) {
    Write-Info "（预览模式）将删除：$InstalledDir"
} else {
    try {
        Remove-Item -LiteralPath $InstalledDir -Recurse -Force
        Write-Ok '旧拷贝已删除'
    } catch {
        Fail ("删除失败：$($_.Exception.Message)`n很可能是 DSH 还开着占用文件。请完全退出 DSH 桌面应用后重跑本脚本。")
    }
}

# ---------- 重新安装 ----------
Write-Step '重新安装依赖（pnpm install）'
$pnpmArgs = @()
$pnpmArgs += $PnpmPrefixArgs
$pnpmArgs += @('install', '--prefer-offline')
Write-Info ("执行：& `"" + $PnpmExe + "`" " + ($pnpmArgs -join ' '))
if ($DryRun) {
    Write-Info '（预览模式，跳过实际安装）'
} else {
    $code = Invoke-Native -Exe $PnpmExe -Arguments $pnpmArgs -WorkDir $ProfileDir
    if ($code -ne 0) {
        Write-Warn2 "pnpm install 失败（退出码 $code）。尝试从备份恢复……"
        try {
            if (Test-Path -LiteralPath $InstalledDir) { Remove-Item -LiteralPath $InstalledDir -Recurse -Force }
            New-Item -ItemType Directory -Path (Join-Path $NodeModules $ScopeName) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $BackupDir $PluginDirName) -Destination $InstalledDir -Recurse -Force
            Copy-Item -LiteralPath (Join-Path $BackupDir 'profile-package.json') -Destination $ProfileManifest -Force
            Write-Warn2 '已从备份恢复旧版本（DSH 行为与更新前一致）'
        } catch {
            Write-Warn2 "自动恢复也失败了：$($_.Exception.Message)。备份在 $BackupDir，可手动还原。"
        }
        Fail '安装失败。请检查网络（是否连得上 npm 源）后重试。'
    }
    Write-Ok '安装完成'
}

# ---------- 校验 ----------
Write-Step '校验更新结果'
if ($DryRun) {
    Write-Info '（预览模式，跳过校验）'
} else {
    if (-not (Test-Path -LiteralPath $InstalledDir)) {
        Fail "安装后 $InstalledDir 仍不存在，更新异常。"
    }
    $NewVersion = Get-PkgVersion $InstalledPkg
    Write-Ok "新安装版本：$NewVersion（原 $OldVersion）"

    if ($SourceDir) {
        $files = @('lib/index.js', 'lib/client.js', 'lib/dashboard.js', 'evolution/bg-review.mjs')
        $mismatch = @()
        foreach ($rel in $files) {
            $srcHash = Get-Sha16 (Join-Path $SourceDir $rel)
            $dstHash = Get-Sha16 (Join-Path $InstalledDir $rel)
            if ($null -eq $srcHash) { continue }
            if ($srcHash -ne $dstHash) { $mismatch += $rel }
        }
        if ($mismatch.Count -eq 0) {
            Write-Ok '关键文件哈希与源码目录一致'
        } else {
            Write-Warn2 ("以下文件与源码目录不一致：" + ($mismatch -join ', '))
            Write-Warn2 "若源码目录有未提交改动，这是正常的；否则请检查 pnpm install 是否真的重新拷贝了。"
        }
    }
}

# ---------- 结束 ----------
Write-Host ''
Write-Host '===========================================' -ForegroundColor Green
if ($DryRun) {
    Write-Host '  预览结束（未改动任何文件）' -ForegroundColor Green
} else {
    Write-Host '  更新完成！' -ForegroundColor Green
}
Write-Host '===========================================' -ForegroundColor Green
Write-Host ''
Write-Host '接下来必须做的一步：' -ForegroundColor Yellow
Write-Host '  >> 完全退出并重启 DSH 桌面应用 <<' -ForegroundColor Yellow
Write-Host ''
Write-Host '为什么必须重启：cordis 宿主插件在主进程加载；改完插件代码后热重载会留下' -ForegroundColor Gray
Write-Host '「僵尸实例」——心跳还在写，但事件订阅没接管，表现为插件「活着但没干活」。' -ForegroundColor Gray
Write-Host ''
Write-Host '重启后验证（1 分钟）：' -ForegroundColor Yellow
Write-Host '  1. 打开 <%USERPROFILE%>\.dsh\evolution\review\plugin-heartbeat.json' -ForegroundColor Gray
Write-Host '  2. 确认 version 是新版本、startedAt 是刚才重启的时间' -ForegroundColor Gray
Write-Host '  3. 聊一轮，确认 turnsSeen 在增长（这才是「插件真的接管了」的证据）' -ForegroundColor Gray
Write-Host ''
if (-not $DryRun) {
    Write-Host "备份保留在：$BackupDir" -ForegroundColor Gray
    Write-Host '确认新版本一切正常后可删除该备份。' -ForegroundColor Gray
}
