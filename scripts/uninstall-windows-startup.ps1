param(
  [string]$TaskName = "MobileCodexBridge"
)

$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已移除登录自启任务：$TaskName"
} else {
  Write-Host "未找到登录自启任务：$TaskName"
}

$startupConfig = Join-Path $PluginRoot "data\startup-config.ps1"
Remove-Item -LiteralPath $startupConfig -Force -ErrorAction SilentlyContinue
