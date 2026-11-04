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
timeout /t 1 /nobreak >nul

:: 5. Setup & Launch Caddy Reverse Proxy for pg.infravan.tech
if not exist "Caddyfile" (
    if exist "reverse-proxy.template" (
        echo [*] Initializing Caddyfile configuration for pg.infravan.tech...
        copy /Y "reverse-proxy.template" "Caddyfile" >nul
    )
)

if not exist "caddy.exe" (
    where caddy >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        echo [*] Caddy reverse proxy not detected. Downloading caddy.exe for SSL...
        powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile 'caddy.exe'"
    )
)

if exist "caddy.exe" (
    echo [*] Starting Caddy SSL Reverse Proxy for pg.infravan.tech...
    start "" caddy.exe run
)

:: 6. Launch Infravan PG Gateway Services
echo.
echo ============================================================
echo   Starting all Infravan PG Gateway Services...
echo   - Public Domain:      https://pg.infravan.tech
echo   - Admin Portal:       https://pg.infravan.tech/login
echo   - Internal Admin:     http://localhost:6001
echo   - Internal Checkout:  http://localhost:7000
echo   - Internal Core API:  http://localhost:6100
echo   - Control Center:     http://localhost:8090
echo ============================================================
echo   - Control Center:     http://localhost:8090
echo   - Gmail Observer:     http://localhost:6003
echo   - SMS Observer:       http://localhost:6002
echo ============================================================
echo.

:: Launch the server and keep console open with live logs
call node scripts/dev.js

echo.
echo ============================================================
echo [!] Infravan PG Server process has ended.
echo ============================================================
pause
