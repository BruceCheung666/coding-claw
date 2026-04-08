param(
  [switch]$ErrorLog,
  [int]$Tail = 100,
  [switch]$Wait
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$logDir = Join-Path (Join-Path $repoRoot ".runtime") "logs"
$logFile = if ($ErrorLog) {
  Join-Path $logDir "bridge.err.log"
} else {
  Join-Path $logDir "bridge.log"
}

if (-not (Test-Path $logFile)) {
  throw "Log file not found: $logFile"
}

if ($Wait) {
  Get-Content $logFile -Tail $Tail -Wait
} else {
  Get-Content $logFile -Tail $Tail
}
