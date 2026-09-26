@echo off
cd /d "%~dp0"
start "AquaGuard server" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
powershell.exe -NoProfile -Command "$u='http://127.0.0.1:8000/'; for($i=0;$i -lt 180;$i++){ try { $s=Invoke-RestMethod ($u+'api/state') -TimeoutSec 2; if($s.video){Start-Process $u; exit 0} } catch {} ; Start-Sleep -Seconds 1 }; exit 1"
if errorlevel 1 (
  echo AquaGuard server did not start. Check the server window for the error.
  pause
)
