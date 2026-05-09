$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $root "src-tauri"
$releaseExe = Join-Path $tauriDir "target\release\team-mgt.exe"
$portableDir = Join-Path $root "portable"
$portableExe = Join-Path $portableDir "team-mgt.exe"

Set-Location $root
npm.cmd run tauri -- build --no-bundle

Set-Location $root
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item -LiteralPath $releaseExe -Destination $portableExe -Force

$readme = @(
  "Team Progress Manager Portable",
  "",
  "How to start:",
  "  Run team-mgt.exe.",
  "",
  "Data:",
  "  By default, team-mgt.sqlite is created next to the executable.",
  "  For shared-folder usage, set the database path in the app to a .sqlite file on the shared folder.",
  "",
  "Locking:",
  "  While editing, the app creates a .lock file next to the database.",
  "  Other users can keep the app open in read-only mode."
)
$readme | Set-Content -LiteralPath (Join-Path $portableDir "README.txt") -Encoding UTF8

Write-Host "Portable app created: $portableExe"
