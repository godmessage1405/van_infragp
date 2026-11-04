@echo off
title INFRAVAN PG - Server Gateway Launcher
color 0A

:: Always execute in the folder where this batch script lives
cd /d "%~dp0"

:: Ensure common Node.js and Git installation paths are loaded
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Program Files\Git\bin;%LOCALAPPDATA%\Programs\node;%APPDATA%\npm"

echo ============================================================
echo           INFRAVAN PG - SERVER GATEWAY LAUNCHER
echo      Infravan Technologies - Sovereign Payment Hub
echo ============================================================
echo [*] Working Directory: %CD%
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo [ERROR] Node.js is not found in PATH!
    echo Please ensure Node.js is installed on this system.
    echo.
    pause
    exit /b 1
)

:: 2. Check dependencies
if not exist "node_modules\" (
    echo [*] First run detected. Installing dependencies...
    call npm install --omit=dev --no-audit --no-fund
    echo.
)

:: 3. Ensure data directory exists
if not exist "data\" (
    mkdir data 2>nul
)

:: 4. Stop any old conflicting node instances on these ports
echo [*] Clearing stale processes from ports...
taskkill /F /IM node.exe >nul 2>nul
ping 127.0.0.1 -n 2 >nul

:: 5. Setup & Launch Caddy Reverse Proxy for pg.infravan.tech
if not exist "Caddyfile" (
    if exist "reverse-proxy.template" (
        echo [*] Initializing Caddyfile configuration for pg.infravan.tech...
        copy /Y "reverse-proxy.template" "Caddyfile" >nul
    )
)

if not exist "caddy.exe" (
    echo [*] Downloading caddy.exe for automatic SSL and domain proxy...
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://caddyserver.com/api/download?os=windows&arch=amd64', 'caddy.exe')"
)

:: Check if Caddy is already running
tasklist /FI "IMAGENAME eq caddy.exe" 2>nul | find /I /N "caddy.exe" >nul
if errorlevel 1 (
    if exist "caddy.exe" (
        echo [*] Starting Caddy SSL Reverse Proxy in background...
        start "" caddy.exe run
    )
) else (
    echo [*] Caddy SSL Reverse Proxy is already active and routing domains.
)

:: 6. Launch Infravan PG Gateway Services
echo.
echo ============================================================
echo   Starting all Infravan PG Gateway Services...
echo   - Public Checkout:    https://pg.infravan.tech
echo   - Public Admin Hub:   https://pg-admin.infravan.tech
echo   - Public Payment API: https://pg-api.infravan.tech
echo   - Public Gmail Obs:   https://pg-gmail.infravan.tech
echo   ----------------------------------------------------------
echo   Internal Backend Ports:
echo   - Port 7000 (Checkout)  : routed from pg.infravan.tech
echo   - Port 6001 (Admin)     : routed from pg-admin.infravan.tech
echo   - Port 6100 (API)       : routed from pg-api.infravan.tech
echo   - Port 6003 (Gmail)     : routed from pg-gmail.infravan.tech
echo   - Port 6002 (SMS)
echo   - Port 8090 (Control)
echo ============================================================
echo.

:: Launch the server and keep console open with live logs
call node scripts/dev.js

echo.
echo ============================================================
echo [!] Infravan PG Server process has ended.
echo ============================================================
pause
