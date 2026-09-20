@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi.
  echo https://nodejs.org adresinden LTS surumunu kurup bu dosyayi yeniden acin.
  pause
  exit /b 1
)
echo Puzzle sunucusu baslatiliyor...
echo Tarayicida http://localhost:3000 adresini acin.
echo Sunucuyu durdurmak icin bu pencerede Ctrl+C tuslarina basin.
start "" http://localhost:3000
node server.js
pause
