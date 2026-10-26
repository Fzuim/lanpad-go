@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\client\index.html" (
  echo [LAN Pad] Building web client...
  if not exist "node_modules" (
    call npm.cmd install
    if errorlevel 1 goto error
  )
  call npm.cmd run build
  if errorlevel 1 goto error
)

echo.
echo [LAN Pad] Starting Go server. The browser will open in 2 seconds...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8787'"
go run ./cmd/lanpad
goto end

:error
echo.
echo [LAN Pad] Failed. Check the error output above.
pause

:end
endlocal
