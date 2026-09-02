$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Host "Project: $projectRoot"

if (-not (Test-Path (Join-Path $projectRoot 'data'))) {
  New-Item -ItemType Directory -Path (Join-Path $projectRoot 'data') | Out-Null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH."
  Write-Host "Install Node.js LTS, then run serve.cmd again."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "npm is not installed or not on PATH."
  Write-Host "Install Node.js LTS (includes npm), then run serve.cmd again."
  exit 1
}

if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  Write-Host "Installing dependencies (first run)..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Dependency install failed. Fix the npm error above, then rerun serve.cmd."
    exit $LASTEXITCODE
  }
}

$port = 8787
if ($env:PORT) {
  $port = [int]$env:PORT
}

$url = "http://127.0.0.1:$port"
Write-Host "Starting local server at $url"
Write-Host "Press Ctrl+C in this terminal to stop the server."
Start-Process $url | Out-Null

$env:PORT = "$port"
node server.js
