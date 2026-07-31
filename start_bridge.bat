@echo off
chcp 65001 >nul
setlocal
title 夜星 QQFriend 全栈启动器
cd /d "%~dp0"

echo.
echo ================================
echo   夜星 QQFriend v1.3.1-group-sticker-capture
echo ================================
echo.

echo [1/3] 启动 NapCat...
node scripts\start-napcat.mjs
if errorlevel 1 (
  echo       NapCat 尚未就绪，请确认 QQ 已登录。
  pause
  exit /b 1
)
echo       NapCat OneBot 已就绪。
echo.

echo [2/3] 检查 QQFriend 依赖...
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
echo       依赖正常。
echo.

echo [3/3] 启动 QQFriend Bridge...
node napcat_bridge.mjs
pause
