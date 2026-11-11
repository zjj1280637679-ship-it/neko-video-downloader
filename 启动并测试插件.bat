@echo off
chcp 65001 >nul
title 喵喵视频下载姬 - 打开测试页
echo.
echo 喵喵视频下载姬 v1.4.1
echo 扩展目录：%~dp0
echo.
echo 初次安装：在 Chrome 地址栏输入 chrome://extensions/
echo 开启开发者模式，点击“加载已解压的扩展程序”，选择以上目录。
echo 更新安装：在同一页面点击扩展卡片上的“重新加载”。
echo 然后刷新视频页，播放视频，再打开扩展。
echo.
echo Chrome 137 起不再支持 --load-extension 自动加载参数。
echo 本脚本只打开测试页，不会声称扩展已经安装。
echo.
set "NEKO_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%NEKO_CHROME%" set "NEKO_CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%NEKO_CHROME%" set "NEKO_CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%NEKO_CHROME%" (
  echo 未找到 Chrome，请手动打开 https://www1.ikanbot.com/play/1027358
  pause
  exit /b 1
)
start "" "%NEKO_CHROME%" "https://www1.ikanbot.com/play/1027358"
pause
