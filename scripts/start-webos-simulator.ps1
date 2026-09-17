# Launch webOS TV 26 Simulator with Chromium remote debugging so agents can CDP-drive the remote.
$ErrorActionPreference = 'Stop'
$exe = 'C:\Users\samir\Downloads\webOS_TV_26_Simulator_1.5.0\webOS_TV_26_Simulator_1.5.0.exe'
$app = 'C:\Users\samir\SwiftTV'
$port = 9333

Get-Process webOS_TV_26_Simulator_1.5.0 -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Start-Process -FilePath $exe -ArgumentList @($app, '{}', "--remote-debugging-port=$port")
Write-Host "Simulator launching with CDP on http://127.0.0.1:$port"
Write-Host "App wrapper should redirect to http://127.0.0.1:5173 (npm run dev)"
