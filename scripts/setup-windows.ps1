param(
  [string]$ProjectPath,
  [string]$ProjectName,
  [string]$ProjectId,
  [string]$PublicBaseUrl,
  [switch]$InstallStartup,
  [switch]$AcceptFullAccess,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $PluginRoot "config.local.json"
$BridgeScript = Join-Path $PSScriptRoot "bridge.ps1"

function Confirm-Choice([string]$Message, [bool]$Default = $false) {
  if ($NonInteractive) { return $Default }
  $Suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
  $Answer = Read-Host "$Message $Suffix"
  if ([string]::IsNullOrWhiteSpace($Answer)) { return $Default }
  return $Answer -match "^(y|yes|是)$"
}

function Normalize-ProjectId([string]$Value) {
  $Normalized = $Value.ToLowerInvariant() -replace "[^a-z0-9-]", "-" -replace "-+", "-"
  $Normalized = $Normalized.Trim("-")
  if (-not $Normalized) { return "project" }
  return $Normalized.Substring(0, [Math]::Min(64, $Normalized.Length))
}

if ($env:OS -ne "Windows_NT") {
  throw "setup-windows.ps1 仅支持 Windows。其他平台请阅读 docs/AI_SETUP.md。"
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw "未找到 Node.js。请先安装 Node.js 20 或更高版本。" }
$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 20) { throw "当前 Node.js 主版本为 $NodeMajor，需要 20 或更高版本。" }

Write-Host ""
Write-Host "Mobile Codex Bridge 安装向导" -ForegroundColor Cyan
Write-Host "手机任务默认使用完全访问和免审批策略，可执行命令并修改电脑端项目文件。" -ForegroundColor Yellow
if (-not $AcceptFullAccess) {
  if ($NonInteractive) { throw "非交互安装必须显式传入 -AcceptFullAccess。" }
  if (-not (Confirm-Choice "我理解上述权限并继续安装" $false)) {
    throw "用户取消安装。"
  }
}

$ReuseConfig = $false
if (Test-Path -LiteralPath $ConfigPath) {
  $ReuseConfig = if ($NonInteractive) { $true } else { Confirm-Choice "检测到现有 config.local.json，是否保留" $true }
}

if (-not $ReuseConfig) {
  if (-not $ProjectPath) {
    if ($NonInteractive) { throw "非交互安装需要传入 -ProjectPath。" }
    $ProjectPath = Read-Host "请输入允许手机操作的项目目录"
  }
  $ResolvedProject = (Resolve-Path -LiteralPath $ProjectPath -ErrorAction Stop).Path
  if (-not (Test-Path -LiteralPath $ResolvedProject -PathType Container)) {
    throw "项目目录不存在：$ResolvedProject"
  }
  if (-not $ProjectName) { $ProjectName = Split-Path -Leaf $ResolvedProject }
  if (-not $ProjectId) { $ProjectId = Normalize-ProjectId $ProjectName }

  if (-not $PublicBaseUrl -and -not $NonInteractive) {
    $Tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($Tailscale -and (Confirm-Choice "检测到 Tailscale，是否为手机配置私有 HTTPS 访问" $false)) {
      & $Tailscale.Source serve --bg 3847
      if ($LASTEXITCODE -eq 0) {
        try {
          $TailscaleStatus = (& $Tailscale.Source status --json | ConvertFrom-Json)
          $DnsName = [string]$TailscaleStatus.Self.DNSName
          if ($DnsName) {
            $PublicBaseUrl = "https://$($DnsName.TrimEnd('.'))"
            Write-Host "已配置 Tailscale 地址：$PublicBaseUrl"
          }
        } catch {
          Write-Warning "Tailscale Serve 已执行，但未能自动读取 HTTPS 地址；可稍后手工填写 server.publicBaseUrl。"
        }
      } else {
        Write-Warning "Tailscale Serve 配置失败；安装会继续使用本机访问模式。"
      }
    }
    if (-not $PublicBaseUrl) {
      Write-Host "手机跨设备访问推荐使用 Tailscale Serve；也可以稍后配置。"
      $PublicBaseUrl = Read-Host "手机 HTTPS 地址（暂时没有可直接回车）"
    }
  }

  $Config = [ordered]@{
    server = [ordered]@{
      host = "127.0.0.1"
      port = 3847
      publicBaseUrl = $(if ($PublicBaseUrl) { $PublicBaseUrl.TrimEnd("/") } else { "" })
    }
    projects = @([ordered]@{
      id = $ProjectId
      name = $ProjectName
      path = $ResolvedProject.Replace("\", "/")
    })
    codex = [ordered]@{
      binary = "codex"
      model = $null
    }
    desktop = [ordered]@{
      autoOpen = "on-complete"
    }
    security = [ordered]@{
      pairingTtlMinutes = 10080
      sessionTtlDays = 30
      maxPromptChars = 12000
      rateLimitPerMinute = 30
    }
    storage = [ordered]@{
      persistTaskHistory = $true
      persistOutputs = $false
      maxTasks = 100
    }
    wechat = [ordered]@{
      enabled = $false
      tokenEnv = "WECHAT_BRIDGE_TOKEN"
      defaultProjectId = $ProjectId
      routePrefix = "#"
    }
  }
  $ConfigJson = $Config | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($ConfigPath, $ConfigJson, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已创建配置：$ConfigPath"
}

Write-Host ""
& $BridgeScript doctor
if ($LASTEXITCODE -ne 0) { throw "环境诊断未通过，请按上方建议修复后重新运行安装向导。" }

$UseStartup = $InstallStartup
if (-not $NonInteractive -and -not $InstallStartup) {
  $UseStartup = Confirm-Choice "是否随当前 Windows 用户登录自动启动" $false
}

if ($UseStartup) {
  & $BridgeScript stop
  & (Join-Path $PSScriptRoot "install-windows-startup.ps1") -Config $ConfigPath
} else {
  & $BridgeScript start
}
if ($LASTEXITCODE -ne 0) { throw "Bridge 启动失败。" }

& $BridgeScript status
if ($LASTEXITCODE -ne 0) { throw "Bridge 健康检查失败。" }

Write-Host ""
Write-Host "安装完成。下面的配对码有效期为 7 天，成功使用后立即失效。" -ForegroundColor Green
& $BridgeScript pair
