@ECHO OFF
:: ===============================================
:: WireGuardAPIService Yönetim Menüsü (idempotent)
:: - Admin kontrolü (gerekirse kendini yükseltir)
:: - Başlangıç türü: Automatic
:: - 1060 (servis yok) => kaldirmaya takilma, devam et
:: ===============================================

:: ---- Yönetici kontrolü ----
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Administrator yetkisi gerekiyor, yeniden baslatiliyor...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit
)

setlocal ENABLEDELAYEDEXPANSION
title WireGuardAPIService Yonetim Menusu

:: ---- Ayarlar ----
set SERVICE_NAME=WireGuardAPIService
set SCRIPT_PATH=%~dp0wireguard_service.py

:: ---- Python bul ----
set PYTHON_EXE=
if exist "%~dp0venv\Scripts\python.exe" set PYTHON_EXE=%~dp0venv\Scripts\python.exe
if "%PYTHON_EXE%"=="" set PYTHON_EXE=python

:: ---- Dosya kontrol ----
if not exist "%SCRIPT_PATH%" (
  echo [HATA] wireguard_service.py bu klasorde yok!
  pause
  exit /b 1
)

:: ---- pywin32 kontrol ----
"%PYTHON_EXE%" -c "import win32serviceutil" >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo [HATA] pywin32 yok. Yuklemek icin:
  echo         %PYTHON_EXE% -m pip install pywin32
  pause
  exit /b 1
)

:menu
cls
echo ==========================================
echo     WireGuardAPIService Yonetim Menusu
echo ==========================================
echo [1] Servisi KUR  (Automatic olarak)
echo [2] Servisi KALDIR
echo [3] Servisi YENIDEN KUR
echo [4] Servisi BASLAT
echo [5] Servisi DURDUR
echo [6] Servis DURUMUNU GOSTER
echo [7] wireproxy.exe INDIR / GUNCELLE
echo [0] CIKIS
echo ==========================================
set /p secim=Seciminizi girin (0-7): 

if "%secim%"=="1" call :install & goto :menu
if "%secim%"=="2" call :uninstall & goto :menu
if "%secim%"=="3" call :reinstall & goto :menu
if "%secim%"=="4" call :start & goto :menu
if "%secim%"=="5" call :stop & goto :menu
if "%secim%"=="6" call :status & goto :menu
if "%secim%"=="7" call :wireproxy & goto :menu
if "%secim%"=="0" exit /b 0
echo [HATA] Gecersiz secim!
pause
goto :menu

:: ----------------- İşlemler -----------------

:install
echo [BILGI] %SERVICE_NAME% servisi yukleniyor...
"%PYTHON_EXE%" "%SCRIPT_PATH%" install
if "%ERRORLEVEL%"=="0" (
  echo [OK] Servis yuklendi.
  echo [BILGI] Baslangic turu Automatic olarak ayarlaniyor...
  sc config "%SERVICE_NAME%" start= auto >nul
  echo [BILGI] Servis baslatiliyor...
  "%PYTHON_EXE%" "%SCRIPT_PATH%" start
) else (
  echo [HATA] Servis kurulurken hata olustu!
)
pause
exit /b

:uninstall
:: Var mi diye bak; yoksa basarili say
sc query "%SERVICE_NAME%" >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo [BILGI] %SERVICE_NAME% zaten yuklu degil, kaldirma atlandi.
  exit /b 0
)

echo [BILGI] %SERVICE_NAME% servisi kaldiriliyor...
:: once durdur (hata olursa onemseme)
"%PYTHON_EXE%" "%SCRIPT_PATH%" stop >nul 2>&1

:: python remove dene; hata verse bile devam
"%PYTHON_EXE%" "%SCRIPT_PATH%" remove >nul 2>&1

:: sc delete ile garanti temizle (varsa)
sc query "%SERVICE_NAME%" >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  sc delete "%SERVICE_NAME%" >nul 2>&1
)

:: maksimum 5 sn bekle: servis girdisi tamamen silinsin
set /a _tries=0
:waitgone
sc query "%SERVICE_NAME%" >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  if !_tries! LSS 5 (
    set /a _tries+=1
    timeout /t 1 >nul
    goto :waitgone
  )
)

echo [OK] Kaldirma islemi tamamlandi.
pause
exit /b

:reinstall
echo [BILGI] Servis yeniden kuruluyor...
call :uninstall
call :install
exit /b

:start
echo [BILGI] %SERVICE_NAME% servisi baslatiliyor...
"%PYTHON_EXE%" "%SCRIPT_PATH%" start
pause
exit /b

:stop
echo [BILGI] %SERVICE_NAME% servisi durduruluyor...
"%PYTHON_EXE%" "%SCRIPT_PATH%" stop
pause
exit /b

:status
echo [BILGI] Servis durumu:
sc query "%SERVICE_NAME%"
pause
exit /b

:wireproxy
echo [BILGI] wireproxy son surumu GitHub'dan indiriliyor (github.com/whyvl/wireproxy)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$r = Invoke-RestMethod 'https://api.github.com/repos/whyvl/wireproxy/releases/latest';" ^
  "$a = $r.assets | Where-Object { $_.name -like '*windows_amd64*' } | Select-Object -First 1;" ^
  "if (-not $a) { throw 'windows_amd64 paketi bulunamadi' };" ^
  "$tmp = Join-Path $env:TEMP $a.name;" ^
  "Invoke-WebRequest $a.browser_download_url -OutFile $tmp;" ^
  "tar -xzf $tmp -C '%~dp0.' wireproxy.exe;" ^
  "Remove-Item $tmp;" ^
  "Write-Host ('[OK] wireproxy ' + $r.tag_name + ' kuruldu.')"
if not "%ERRORLEVEL%"=="0" echo [HATA] Indirme basarisiz. Elle indirip wireproxy.exe dosyasini bu klasore koy.
pause
exit /b
