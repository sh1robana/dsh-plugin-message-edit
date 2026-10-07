param(
    [string]$AppPath = 'D:\DeepSeek Harness',
    [string]$PackagePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $AppPath 'resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "找不到桌面端 CLI：$cliPath"
}
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    $manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $archiveName = "$($manifest.name.Replace('@', '').Replace('/', '-'))-$($manifest.version).tgz"
    $PackagePath = Join-Path $projectRoot "artifacts\$archiveName"
}
$packageFile = Get-Item -LiteralPath $PackagePath
if ($packageFile.PSIsContainer -or $packageFile.Extension -ne '.tgz') {
    throw '请提供已构建的 .tgz 插件安装包。'
}

# 在调用官方 CLI 前保存配置，备份仅保留在本地且已被 Git 忽略。
$dshDataRoot = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME }
$profilePath = Join-Path $dshDataRoot 'profiles\desktop'
$backupPath = Join-Path $projectRoot ('.local-backups\desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
foreach ($fileName in @('package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
    $sourcePath = Join-Path $profilePath $fileName
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupPath $fileName)
    }
}
Write-Host "配置备份位置：$backupPath"
$packageUrl = 'file:' + $packageFile.FullName.Replace('\', '/')
& $cliPath plugin --profile desktop add -w $packageUrl
if ($LASTEXITCODE -ne 0) {
    throw "官方插件安装命令失败，退出码：$LASTEXITCODE。原配置备份位于 $backupPath"
}
Write-Host '插件安装完成。请保存工作，彻底退出 DSH 后重新启动，以加载适配版。'
