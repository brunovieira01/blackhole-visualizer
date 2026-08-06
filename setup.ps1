# One-time setup for running from source: install dependencies and build the
# icons. If you just want to *use* the app, build an installer with
# `npm run dist` and run that instead - this script is the developer path.
#
# Nothing is written outside this folder unless you ask for it: both shortcuts
# are opt-in, because a setup script has no business putting files on someone
# else's Desktop or into their Startup folder without being told to.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less files
# as CP1252, where a UTF-8 em-dash decodes into a curly quote -- which PS
# accepts as a string delimiter, so one stray dash breaks the whole parse.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Shortcut   # + Desktop icon
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Startup    # + run at login
#
param(
  [switch]$Startup,
  [switch]$Shortcut
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
if (-not (Test-Path $exe)) {
  # Electron 43+ ships no postinstall hook; the binary is fetched lazily on the
  # first require(). The shortcut below points straight at the .exe, so pull it
  # down now rather than on whatever the user's first launch happens to be.
  Write-Host "> downloading the Electron binary (~100 MB, first time only)"
  node "node_modules\electron\install.js"
  if ($LASTEXITCODE -ne 0) { throw "Electron binary download failed" }
}
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

if ($Shortcut) {
  Write-Host "> creating Desktop shortcut"
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Black Hole Visualizer.lnk')
}

if ($Startup) {
  Write-Host "> registering to start with Windows"
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Black Hole Visualizer.lnk')
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Launch it by double-clicking 'Start Black Hole.vbs' in this folder."
Write-Host "It opens in a window; the mode row in the HUD switches it to your wallpaper."
Write-Host "Everything else lives in the tray icon (bottom-right, next to the clock)."
if (-not $Shortcut) {
  Write-Host "Nothing was written outside this folder. Re-run with -Shortcut for a Desktop icon."
}
