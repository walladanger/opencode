# setup-look-dev.ps1 - run OpenCode 2.2.5 (from source) beside your installed 1.19.5
# Safe to paste into any PowerShell window or run as a file: it always works in D:\GitHub\opencode-dev.
$ErrorActionPreference = "Stop"
$repo = "D:\GitHub\opencode-dev"

# Guard: refuse to do anything unless this really is the OpenCode source folder
if (-not (Test-Path "$repo\packages\desktop\package.json") -or -not (Test-Path "$repo\packages\gui-plugins")) {
  Write-Host "ABORT: $repo is not the OpenCode source folder. Nothing was changed." -ForegroundColor Red
  return
}
Set-Location $repo
Write-Host "Working in $repo" -ForegroundColor Cyan

# 1. Back up your OpenCode data/config first (V2 reads the same folders as V1)
$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $env:USERPROFILE "opencode-backup-$stamp"
New-Item -ItemType Directory -Force $backup | Out-Null
$sources = @{
  "local-share-opencode"  = "$env:USERPROFILE\.local\share\opencode"
  "config-opencode"       = "$env:USERPROFILE\.config\opencode"
  "appdata-desktop"       = "$env:APPDATA\ai.opencode.desktop"
}
foreach ($name in $sources.Keys) {
  $p = $sources[$name]
  if (Test-Path $p) {
    Write-Host "Backing up $p"
    Copy-Item $p (Join-Path $backup $name) -Recurse -Force
  }
}
Write-Host "Backup: $backup" -ForegroundColor Green

# 2. Bun (the build tool OpenCode uses)
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Installing Bun..."
  winget install --id Oven-sh.Bun -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
}
bun --version

# 3. Git baseline (only inside the OpenCode folder) so every change can be diffed or reverted
if (-not (Test-Path "$repo\.git")) {
  git -C $repo init -b main | Out-Null
  git -C $repo config core.autocrlf false
  git -C $repo add -A
  git -C $repo -c user.name="Warwick" -c user.email="local@localhost" commit -q -m "baseline: opencode 2.2.5 source"
  Write-Host "Git baseline committed in $repo" -ForegroundColor Green
}

# 4. Install dependencies and launch the dev build (separate app identity: OpenCode Dev)
bun install
Set-Location "$repo\packages\desktop"
bun dev
