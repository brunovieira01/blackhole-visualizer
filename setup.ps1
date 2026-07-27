# One-time setup: install dependencies, build the icons, and create shortcuts.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files
# as CP1252, where a UTF-8 em-dash decodes into a curly quote -- which PS
# accepts as a string delimiter, so one stray dash breaks the whole parse.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Startup   # + run at login
#
param(
  [switch]$Startup,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

Write-Host "Black Hole Visualizer - setup" -ForegroundColor Yellow
Write-Host "  $root`n"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed or not on PATH. Get it from https://nodejs.org"
}

Write-Host "> installing dependencies (this pulls Electron, ~100 MB the first time)"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Write-Host "> generating icons"
node tools\make-icon.js

$exe = Join-Path $root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $exe)) { throw "Electron binary missing at $exe" }

function New-Shortcut([string]$LinkPath) {
  $dir = Split-Path -Parent $LinkPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($LinkPath)
  $lnk.TargetPath = $exe
  $lnk.Arguments = "`"$root`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$root\assets\icon.ico,0"
  $lnk.Description = "Black Hole audio visualizer"
  $lnk.Save()
  Write-Host "  created $LinkPath" -ForegroundColor Green
}

if (-not $NoShortcut) {
  Write-Host "> creating Desktop shortcut"
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Black Hole Visualizer.lnk')
}

if ($Startup) {
  Write-Host "> registering to start with Windows"
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Black Hole Visualizer.lnk')
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Launch it with the Desktop shortcut, or double-click 'Start Black Hole.vbs'."
Write-Host "Everything else lives in the tray icon (bottom-right, next to the clock)."
