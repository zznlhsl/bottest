@echo off
chcp 65001 >nul
title Cursor Cloud Agent 控制台
cd /d "%~dp0"

echo [1/2] 正在启动后台服务...
start "CursorPodServer" /min node server.js

echo [2/2] 正在打开浏览器控制面板...
timeout /t 2 /nobreak >nul
start http://127.0.0.1:4567

echo.
echo ========================================================
echo  Cursor Cloud Agent 可视化控制台已启动！
echo  控制台网址: http://127.0.0.1:4567
echo ========================================================
echo.
pause
