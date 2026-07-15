param(
  [string]$TaskName = "MobileCodexBridge",
  [string]$Config
)

$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot
$CliPath = Join-Path $PluginRoot "bridge\cli.mjs"
$ConfigPath = if ($Config) { (Resolve-Path -LiteralPath $Config).Path } else { Join-Path $PluginRoot "config.local.json" }
$NodePath = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "找不到配置文件：$ConfigPath"
}

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

# Scheduled Task actions do not inherit this PowerShell process environment. Store only the non-secret config path as a task-scoped wrapper argument file.
$startupConfig = Join-Path $PluginRoot "data\startup-config.ps1"
New-Item -ItemType Directory -Force (Split-Path -Parent $startupConfig) | Out-Null
Set-Content -LiteralPath $startupConfig -Encoding UTF8 -Value "`$env:MOBILE_CODEX_CONFIG = '$($ConfigPath.Replace("'", "''"))'`n& '$($NodePath.Replace("'", "''"))' '$($CliPath.Replace("'", "''"))' serve"
$wrapperAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$startupConfig`"" -WorkingDirectory $PluginRoot
Register-ScheduledTask -TaskName $TaskName -Action $wrapperAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Start Mobile Codex Bridge for the current user." -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "已安装并启动登录自启任务：$TaskName"
Write-Host "配置文件：$ConfigPath"
