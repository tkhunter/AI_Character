@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Shiori TTS (Kokoro)
if not exist ".venv\Scripts\python.exe" (
  echo [錯誤] 尚未安裝 Kokoro 環境。請參考 docs\KOKORO_TTS.md。
  pause
  exit /b 1
)
rem 模型放在 tts\models\Kokoro-82M-v1.1-zh 時離線載入；否則嘗試下載。下載可用 download-model.ps1。
rem 要改用 CPU：set KOKORO_DEVICE=cpu
set "HF_HOME=%~dp0hf-cache"
set "PYTHONIOENCODING=utf-8"
".venv\Scripts\python.exe" server.py
pause
