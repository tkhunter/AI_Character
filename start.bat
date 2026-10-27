@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title Shiori 啟動器

rem ===== 設定（可在 .env 覆寫 API_PORT、LLAMA_BASE_URL） =====
set "API_PORT=3001"
set "UI_PORT=4173"
set "LLAMA_BASE_URL=http://127.0.0.1:8080"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="API_PORT" set "API_PORT=%%b"
    if /i "%%a"=="LLAMA_BASE_URL" set "LLAMA_BASE_URL=%%b"
  )
)
set "UI_URL=http://127.0.0.1:%UI_PORT%/"

echo.
echo  栞 Shiori 一鍵啟動
echo  ==================
echo.

rem ===== 1. 檢查 Node.js 24+ =====
where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js，請先安裝 Node.js 24 或更新版本。
  goto :fail
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 24 (
  echo [錯誤] 需要 Node.js 24 以上，目前是：
  node -v
  goto :fail
)

rem ===== 2. 安裝套件（第一次執行時） =====
if not exist "node_modules\" (
  echo [1/4] 第一次執行，安裝套件中...
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo [1/4] 套件已安裝。
)

rem ===== 3. 編譯 =====
echo [2/4] 型別檢查與正式編譯...
call npm run build
if errorlevel 1 (
  echo [錯誤] 編譯失敗，請查看上方訊息。
  goto :fail
)

rem ===== 4. 啟動後端與前端（已在執行就沿用） =====
echo [3/4] 啟動服務...
if exist "tts\.venv\Scripts\python.exe" (
  curl -s -o nul -m 2 "http://127.0.0.1:8880/health"
  if errorlevel 1 (
    start "Shiori TTS (Kokoro)" /min cmd /c "tts\start-tts.bat"
    echo       語音：已在新視窗啟動 Kokoro TTS http://127.0.0.1:8880
  ) else (
    echo       語音：Kokoro TTS 已在執行
  )
)
curl -s -o nul -m 2 "http://127.0.0.1:%API_PORT%/api/status"
if errorlevel 1 (
  start "Shiori API (port %API_PORT%)" /min cmd /k "npm run start:api"
  echo       後端：已在新視窗啟動 http://127.0.0.1:%API_PORT%
) else (
  echo       後端：已在執行，沿用 http://127.0.0.1:%API_PORT%
)
curl -s -o nul -m 2 "%UI_URL%"
if errorlevel 1 (
  start "Shiori UI (port %UI_PORT%)" /min cmd /k "npm run preview -- --port %UI_PORT% --strictPort"
  echo       前端：已在新視窗啟動 %UI_URL%
) else (
  echo       前端：已在執行，沿用 %UI_URL%
)

rem 等待兩個服務就緒（最多約 30 秒）
set /a WAIT=0
:wait
curl -s -o nul -m 1 "%UI_URL%" && curl -s -o nul -m 1 "http://127.0.0.1:%API_PORT%/api/status" && goto :ready
set /a WAIT+=1
if %WAIT% GEQ 30 (
  echo [錯誤] 服務 30 秒內沒有就緒，請查看「Shiori API」與「Shiori UI」視窗中的錯誤訊息。
  goto :fail
)
ping -n 2 127.0.0.1 >nul
goto :wait

:ready
curl -s -o nul -m 2 "%LLAMA_BASE_URL%/health"
if errorlevel 1 (
  echo.
  echo [提醒] 連不到 llama.cpp（%LLAMA_BASE_URL%）。介面可以開啟，但要先啟動模型服務才能對話。
)

rem ===== 5. 開啟瀏覽器 =====
echo [4/4] 開啟瀏覽器 %UI_URL%
start "" "%UI_URL%"
echo.
echo 完成！要停止服務，關閉「Shiori API」「Shiori UI」（以及「Shiori TTS」）視窗即可。
ping -n 6 127.0.0.1 >nul
exit /b 0

:fail
echo.
pause
exit /b 1
