# Barer Brawl launcher — starts a local server and opens the game.
# Right-click > "Run with PowerShell", or:  powershell -ExecutionPolicy Bypass -File run.ps1
$ErrorActionPreference = 'SilentlyContinue'
$port = 8000
$url = "http://localhost:$port"
Set-Location $PSScriptRoot

Write-Host "Starting Barer Brawl on $url ..." -ForegroundColor Yellow

# Prefer Node, fall back to Python.
$node = (Get-Command node -ErrorAction SilentlyContinue)
$py = (Get-Command python -ErrorAction SilentlyContinue)

Start-Process $url

if ($node) {
    node serve.mjs $port
} elseif ($py) {
    python -m http.server $port
} else {
    Write-Host "Neither Node nor Python found. Install one, or open index.html via any static server." -ForegroundColor Red
    Read-Host "Press Enter to exit"
}
