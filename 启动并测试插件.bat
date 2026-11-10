@echo off
chcp 65001 >nul
title 🌸 喵喵视频下载姬 - 快捷启动测试
echo.
echo ========================================================
echo    🌸 正在启动加载了【喵喵视频下载姬】的 Google Chrome...
echo    🎯 目标实验网页: https://www1.ikanbot.com/play/1027358
echo ========================================================
echo.

set EXT_PATH=%~dp0
:: 去掉末尾反斜杠
set EXT_PATH=%EXT_PATH:~0,-1%

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --load-extension="%EXT_PATH%" --new-window "https://www1.ikanbot.com/play/1027358"

echo Chrome 已启动！请在打开的页面中：
echo 1. 点击网页中的播放按钮播放视频
echo 2. 点击浏览器右上角拼图图标或插件图标【🌸 喵喵视频下载姬】
echo 3. 即可看到捕获的 m3u8 流媒体，支持一键合并下载或复制直链！
echo.
pause
