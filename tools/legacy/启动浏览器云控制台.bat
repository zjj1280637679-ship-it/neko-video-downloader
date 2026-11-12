@echo off
chcp 65001 >nul
title 🌸 喵喵浏览器云控制台 (Remote Browser Control)
cd /d "%~dp0"

echo.
echo ======================================================================
echo    🌸 喵喵浏览器可视化云控制台启动中...
echo    💡 脚本将拉起 Chrome 并生成实时网页控制链接
echo ======================================================================
echo.

start "" "http://localhost:8899"
python browser_controller.py

pause
