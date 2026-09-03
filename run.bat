@echo off
title Aditya Studio Server
color 0A
echo ========================================
echo    Aditya Studio - Local Server
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js nahi mila!
    echo Install: https://nodejs.org
    pause
    exit /b 1
)

echo [OK] Node.js:
node -v
echo.

if not exist "node_modules\mongodb" (
    echo [INFO] npm install... (1-2 min)
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install fail
        pause
        exit /b 1
    )
)

echo [INFO] Starting server...
echo.
echo Agar 5 sec me READY na dikhe to Ctrl+C dabao.
echo Browser: http://localhost:8000
echo Admin:   http://localhost:8000/admin
echo Password: ADlix08  (ya .env me ADMIN_PASSWORD)
echo ========================================
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:8000"

node server.js

echo.
echo Server band ho gaya.
pause
