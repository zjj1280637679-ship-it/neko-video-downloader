@echo off
chcp 65001 >nul
setlocal
title 喵喵视频下载姬 - 安装与测试

set "NEKO_CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "NEKO_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined NEKO_CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "NEKO_CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined NEKO_CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "NEKO_CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo 普通 Chrome 137+ 需要在扩展管理页手动加载，不再依赖 --load-extension。
echo 1. 打开 chrome://extensions/ 并开启开发者模式。
echo 2. 点击“加载已解压的扩展程序”，选择以下文件夹：
echo "%~dp0"
echo 3. 播放需要测试的视频网页，再点击插件图标。
echo 更新扩展后请刷新已经打开的视频网页。

if defined NEKO_CHROME (
    start "" "%NEKO_CHROME%" "chrome://extensions/"
) else (
    echo 未找到常见位置的 Google Chrome，请手动打开扩展管理页。
)
pause
