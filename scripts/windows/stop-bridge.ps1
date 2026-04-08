$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$pidFile = Join-Path (Join-Path $repoRoot ".runtime") "bridge.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "Bridge is not running (no PID file found)."
  exit 0
}

$processId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
if (-not $processId) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Bridge PID file was empty and has been removed."
  exit 0
}

$proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
if (-not $proc) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Bridge process PID=$processId was not running. PID file removed."
  exit 0
}

Stop-Process -Id $processId -Force
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Bridge stopped. PID=$processId"
