@echo off
title INFRAVAN PG - Server Stopper
color 0E

:: Always execute in the folder where this batch script lives
cd /d "%~dp0"

echo ============================================================
echo           INFRAVAN PG - SERVER STOPPER
echo ============================================================
echo.
echo [*] Stopping all Node.js and Gateway processes...
taskkill /F /IM node.exe >nul 2>nul
taskkill /F /IM caddy.exe >nul 2>nul

echo [✓] Infravan PG Server and Reverse Proxy stopped cleanly.
echo.
timeout /t 3
