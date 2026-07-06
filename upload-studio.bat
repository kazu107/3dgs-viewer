@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 3DGS Upload Studio

if not exist .env (
  echo [エラー] .env ファイルが見つかりません。
  echo.
  echo   1. .env.example をコピーして .env を作成してください
  echo   2. R2の接続情報を記入してください
  echo      ※アップロードには「オブジェクト読み取りと書き込み」権限のAPIトークンが必要です
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [エラー] Node.js が見つかりません。https://nodejs.org からインストールしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 依存パッケージをインストールしています...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo インストールに失敗しました
    pause
    exit /b 1
  )
)

echo フロントエンドをビルドしています...
call npm run build
if errorlevel 1 (
  echo ビルドに失敗しました
  pause
  exit /b 1
)

echo.
echo ==============================================
echo   3DGS Upload Studio
echo   http://localhost:3000 をブラウザで開きます
echo   終了するにはこのウィンドウを閉じてください
echo ==============================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server\index.js --upload
pause
