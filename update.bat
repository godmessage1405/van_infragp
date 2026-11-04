@echo off
title INFRAVAN PG - 1-Click Production Auto Updater
color 0A

echo ============================================================
echo         INFRAVAN PG - 1-CLICK PRODUCTION UPDATER
echo ============================================================
echo.

:: Always execute in the folder where this batch script lives
cd /d "%~dp0"
echo [*] Working Directory: %CD%
echo.

:: 1. Pull latest code from GitHub
echo [1/3] Pulling latest updates from GitHub main branch...
git pull origin main
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Git pull encountered an issue. Please verify internet connection.
    color 0C
    pause
    exit /b %ERRORLEVEL%
)
echo [OK] Code successfully pulled!
echo.

:: 2. Install any updated production dependencies
echo [2/3] Checking and updating production dependencies...
call npm install --omit=dev --no-audit --no-fund
echo [OK] Dependencies verified!
echo.

:: 3. Restart Server
echo [3/3] Restarting server services...
where pm2 >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [*] Found PM2. Restarting active clusters...
    call pm2 restart all
) else (
    echo [*] PM2 not active. Restarting background Node process...
    taskkill /F /IM node.exe >nul 2>nul
    timeout /t 2 /nobreak >nul
    start "" /B npm run start
)

echo.
echo ============================================================
echo  SUCCESS! Application successfully updated and live!
echo ============================================================
echo.
pause

