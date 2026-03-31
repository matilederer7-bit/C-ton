$lines = netstat -ano | findstr :3000
$procIds = @()
foreach ($line in $lines) {
  $parts = ($line -split '\s+') | Where-Object { $_ -ne '' }
  if ($parts.Length -ge 5) {
    $procId = $parts[-1]
    if ($procId -match '^\d+$' -and $procId -ne '0') {
      $procIds += $procId
    }
  }
}
$procIds = $procIds | Select-Object -Unique
foreach ($procId in $procIds) {
  try { Stop-Process -Id ([int]$procId) -Force } catch {}
}
Start-Process powershell -ArgumentList '-NoExit','-Command','Set-Location C:\Users\Lenovo\Documents\C-ton; node --import ./scripts/register-ts-node.mjs src/app.ts'
$healthOk = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health
    if ($response.Content -eq '{"ok":true}') {
      $healthOk = $true
      $response.Content
      break
    }
  } catch {}
}

if (-not $healthOk) {
  Write-Error "Server did not become healthy on port 3000 within the expected restart window."
  exit 1
}
