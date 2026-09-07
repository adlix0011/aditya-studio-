@echo off
setlocal DisableDelayedExpansion
title Aditya Studio Server
color 0A
set "LOCAL_SETTINGS=.aditya-local-settings.cmd"
if exist "%LOCAL_SETTINGS%" call "%LOCAL_SETTINGS%"
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

if not defined ADMIN_PASSWORD (
    set /p "ADMIN_PASSWORD=Admin password set karein: "
)
if not defined ADMIN_PASSWORD (
    echo [ERROR] Admin password zaroori hai.
    pause
    exit /b 1
)

if not defined SMS_GATEWAY_URL (
    set /p "SMS_GATEWAY_URL=SMS Gateway URL (OTP ke liye, optional): "
)
if defined SMS_GATEWAY_URL (
    if not defined SMS_GATEWAY_API_KEY (
        set /p "SMS_GATEWAY_API_KEY=SMS Gateway API key: "
    )
)

if not exist "%LOCAL_SETTINGS%" (
    > "%LOCAL_SETTINGS%" (
        echo @echo off
        echo set "ADMIN_PASSWORD=%ADMIN_PASSWORD%"
        echo set "SMS_GATEWAY_URL=%SMS_GATEWAY_URL%"
        echo set "SMS_GATEWAY_API_KEY=%SMS_GATEWAY_API_KEY%"
    )
    attrib +h "%LOCAL_SETTINGS%" >nul 2>nul
    echo [OK] Admin aur SMS Gateway settings ek baar ke liye local save ho gayi.
)

echo [INFO] Starting server...
echo.
echo Agar 5 sec me READY na dikhe to Ctrl+C dabao.
echo Browser: http://localhost:8000
echo Admin:   http://localhost:8000/admin
echo Password: Aapne abhi jo admin password dala hai.
echo ========================================
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:8000"

node server.js

echo.
echo Server band ho gaya.
pause
