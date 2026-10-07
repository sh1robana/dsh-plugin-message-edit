param(
    [string]$AppPath = 'D:\DeepSeek Harness',
    [string]$ProfilePath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expected = Get-Content -LiteralPath (Join-Path $projectRoot 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$installedRoot = Join-Path (Join-Path $ProfilePath 'node_modules') $manifest.name
$installed = Get-Content -LiteralPath (Join-Path $installedRoot 'build-info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installed.version -ne $expected.version -or $installed.buildId -ne $expected.buildId) {
    throw '安装目录中的插件与本地构建不一致，请重新安装。'
}
foreach ($file in $expected.files.PSObject.Properties) {
    $digest = (Get-FileHash -LiteralPath (Join-Path $installedRoot $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne $file.Value) { throw "已安装文件与本地构建不一致：$($file.Name)" }
}
$cliPath = Join-Path $AppPath 'resources\runtime\cli\bin\dsh.cmd'
$runtimeVersion = ((& $cliPath --version) -join "`n").Trim()
if ($LASTEXITCODE -ne 0) { throw '读取桌面宿主版本失败。' }
if ($runtimeVersion -ne $expected.targetDshVersion) {
    throw "桌面宿主版本 $runtimeVersion 与当前适配目标 $($expected.targetDshVersion) 不一致。"
}
Write-Host "桌面宿主版本：$runtimeVersion"
Write-Host "已安装插件：$($installed.version)，构建：$($installed.buildId)"
Write-Host '宿主及客户端文件 SHA256 一致。此检查仅验证安装目录；实际加载版本请在 DSH 页面运行 __DSH_MESSAGE_EDIT__.diagnostics()。'
