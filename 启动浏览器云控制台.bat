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

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import aiohttp" >nul 2>nul
    if errorlevel 1 (
        echo 请先运行: py -3 -m pip install -r requirements.txt
        pause
        exit /b 1
    )
    py -3 browser_controller.py --open %*
) else (
    python -c "import aiohttp" >nul 2>nul
    if errorlevel 1 (
        echo 请安装 Python 3.10+ 并运行: python -m pip install -r requirements.txt
        pause
        exit /b 1
    )
    python browser_controller.py --open %*
)

pause
