@echo off
chcp 65001 >nul
title 夜星 NapCat 全栈启动器

echo.
echo ================================
echo   夜星喵 QQ 机器人 v1.1.0
echo ================================
echo.

echo [1/3] 启动 NapCat (QQ框架)...
cd /d "C:\Users\asus\.openclaw\workspace\qqfriend\NapCat\NapCat.44498.Shell"
start "NapCat" /min .\NapCatWinBootMain.exe
cd /d "C:\Users\asus\.openclaw\workspace\qqfriend"
echo       请确认QQ已登录 (WebUI: http://127.0.0.1:6099)
echo       如未登录请扫码~
echo.
pause

echo.
echo [2/3] 等待 OneBot 就绪...
:wait_napcat
timeout /t 3 /nobreak >nul
node -e "fetch('http://127.0.0.1:6700/get_login_info',{method:'POST'}).then(r=>r.json()).then(d=>{if(d.data)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))" 2>nul
if errorlevel 1 goto wait_napcat
echo       NapCat OneBot 已就绪!
echo.

echo [3/3] 启动夜星桥接器...
echo.
node napcat_bridge.mjs
pause
