param(
  [switch]$Prod,
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$runtimeDir = Join-Path $repoRoot ".runtime"
$logDir = Join-Path $runtimeDir "logs"
$pidFile = Join-Path $runtimeDir "bridge.pid"
$logFile = Join-Path $logDir "bridge.log"
$errFile = Join-Path $logDir "bridge.err.log"
$envPath = Join-Path $repoRoot $EnvFile

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $envPath)) {
  throw "Env file not found: $envPath"
}

if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
  if ($oldPid) {
    $existing = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($existing) {
      throw "Bridge seems to be running already (PID=$oldPid). Run scripts/windows/stop-bridge.ps1 first."
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Get-Content $envPath | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $name, $value = $_ -split '=', 2
  if (-not $name -or $null -eq $value) { return }
  [System.Environment]::SetEnvironmentVariable($name.Trim(), $value.Trim(), 'Process')
}

$required = @(
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'CODING_CLAW_WORKSPACE_ROOT',
  'CODING_CLAW_CLAUDE_PATH',
  'CLAUDE_CODE_GIT_BASH_PATH'
)

foreach ($name in $required) {
  if (-not [System.Environment]::GetEnvironmentVariable($name, 'Process')) {
    throw "Missing required environment variable: $name"
  }
}

$command = if ($Prod) {
  'pnpm build && pnpm --filter @coding-claw/bridge start'
} else {
  'pnpm dev'
}

$proc = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  '-NoProfile',
  '-Command',
  "Set-Location '$repoRoot'; $command"
) -WorkingDirectory $repoRoot -RedirectStandardOutput $logFile -RedirectStandardError $errFile -PassThru -WindowStyle Hidden

Set-Content -Path $pidFile -Value $proc.Id

Write-Host "Bridge started. PID=$($proc.Id)"
Write-Host "Stdout log: $logFile"
Write-Host "Stderr log: $errFile"
if ($Prod) {
  Write-Host "Mode: production"
} else {
  Write-Host "Mode: development"
}
