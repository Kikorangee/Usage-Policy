$nodeServicePath = "C:\Users\franc\Documents\Playground\geofence-notification-service\server.js"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$cloudflaredConfig = "C:\Users\franc\.cloudflared\config.yml"

$notificationListening = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $notificationListening) {
  Start-Process -FilePath "node.exe" -ArgumentList "`"$nodeServicePath`"" -WindowStyle Hidden
}

$tunnelRunning = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$cloudflaredConfig*" }
if (-not $tunnelRunning) {
  Start-Process -FilePath $cloudflaredPath -ArgumentList "tunnel --config `"$cloudflaredConfig`" run" -WindowStyle Hidden
}
