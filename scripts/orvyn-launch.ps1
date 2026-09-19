# Launches ORVYN Desktop: starts the local backend if it isn't already
# running, waits for it to answer, then opens the Electron app.
# The desktop shortcut ("ORVYN") points at this script.
$ErrorActionPreference = "SilentlyContinue"
$repo = "C:\Users\rmckn\viride"

$listening = Get-NetTCPConnection -LocalPort 4570 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process node -ArgumentList "dist/index.js" -WorkingDirectory "$repo\apps\backend" -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:4570/api/v1/health" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { break }
    } catch {}
  }
}

Start-Process "$repo\node_modules\electron\dist\electron.exe" -ArgumentList "`"$repo\apps\desktop`"" -WorkingDirectory "$repo\apps\desktop"
