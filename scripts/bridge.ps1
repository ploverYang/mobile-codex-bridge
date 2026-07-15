param(
  [Parameter(Position = 0)]
  [ValidateSet("serve", "start", "stop", "status", "pair", "doctor", "self-test")]
  [string]$Command = "status",

  [string]$Config,

  [switch]$Json
)

$ErrorActionPreference = "Stop"
$PluginRoot = Split-Path -Parent $PSScriptRoot

if ($Config) {
  $env:MOBILE_CODEX_CONFIG = (Resolve-Path -LiteralPath $Config).Path
}

$Arguments = @((Join-Path $PluginRoot "bridge\cli.mjs"), $Command)
if ($Json) { $Arguments += "--json" }
& node @Arguments
exit $LASTEXITCODE
