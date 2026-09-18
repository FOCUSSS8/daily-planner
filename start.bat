@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   每日计划 - Daily Planner
echo   请保持本窗口开启，关闭即停止服务
echo ============================================
node server.js
pause
