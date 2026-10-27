@ECHO OFF
:: ===============================================
:: WireGuardAPIService management menu (idempotent)
:: - Admin check (elevates itself if needed)
:: - Startup type: Automatic
:: - 1060 (no such service) => don't fail on uninstall, carry on
:: ===============================================

:: ---- Administrator check ----
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Administrator rights needed, restarting...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit
)

setlocal ENABLEDELAYEDEXPANSION
title WireGuardAPIService management menu

:: ---- Settings ----
set SERVICE_NAME=WireGuardAPIService
set SCRIPT_PATH=%~dp0wireguard_service.py

:: ---- Find Python ----
set PYTHON_EXE=
if exist "%~dp0venv\Scripts\python.exe" set PYTHON_EXE=%~dp0venv\Scripts\python.exe
if "%PYTHON_EXE%"=="" set PYTHON_EXE=python

:: ---- File check ----
if not exist "%SCRIPT_PATH%" (
  echo [ERROR] wireguard_service.py is not in this folder!
  pause
  exit /b 1
)

:: ---- pywin32 check ----
"%PYTHON_EXE%" -c "import win32serviceutil" >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo [ERROR] pywin32 is missing. To install it:
  echo         %PYTHON_EXE% -m pip install pywin32
  pause
  exit /b 1
)

:menu
cls
echo ==========================================
echo     WireGuardAPIService management menu
echo ==========================================
echo [1] INSTALL the service  (startup: Automatic)
echo [2] UNINSTALL the service
echo [3] REINSTALL the service
echo [4] START the service
echo [5] STOP the service
echo [6] SHOW the service status
echo [7] DOWNLOAD / UPDATE wireproxy.exe
echo [0] EXIT
echo ==========================================
set /p choice=Enter your choice (0-7): 

if "%choice%"=="1" call :install & goto :menu
if "%choice%"=="2" call :uninstall & goto :menu
if "%choice%"=="3" call :reinstall & goto :menu
if "%choice%"=="4" call :start & goto :menu
if "%choice%"=="5" call :stop & goto :menu
if "%choice%"=="6" call :status & goto :menu
if "%choice%"=="7" call :wireproxy & goto :menu
if "%choice%"=="0" exit /b 0
echo [ERROR] Invalid choice!
pause
goto :menu

:: ----------------- Actions -----------------

:install
echo [INFO] Installing the %SERVICE_NAME% service...
"%PYTHON_EXE%" "%SCRIPT_PATH%" install
if "%ERRORLEVEL%"=="0" (
  echo [OK] Service installed.
  echo [INFO] Setting the startup type to Automatic...
  sc config "%SERVICE_NAME%" start= auto >nul
  echo [INFO] Starting the service...
  "%PYTHON_EXE%" "%SCRIPT_PATH%" start
) else (
  echo [ERROR] The service could not be installed!
)
pause
exit /b

:uninstall
:: Check whether it exists; if not, count it as success
sc query "%SERVICE_NAME%" >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo [INFO] %SERVICE_NAME% is not installed, nothing to remove.
  exit /b 0
)

echo [INFO] Removing the %SERVICE_NAME% service...
:: stop it first (ignore errors)
"%PYTHON_EXE%" "%SCRIPT_PATH%" stop >nul 2>&1

:: try python remove; carry on even if it fails
"%PYTHON_EXE%" "%SCRIPT_PATH%" remove >nul 2>&1

:: make sure with sc delete (if it is still there)
sc query "%SERVICE_NAME%" >nul 2>&1
if "%ERRORLEVEL%"=="0" (
  sc delete "%SERVICE_NAME%" >nul 2>&1
)

:: wait up to 5 s for the service entry to be fully removed
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

echo [OK] Removal finished.
pause
exit /b

:reinstall
echo [INFO] Reinstalling the service...
call :uninstall
call :install
exit /b

:start
echo [INFO] Starting the %SERVICE_NAME% service...
"%PYTHON_EXE%" "%SCRIPT_PATH%" start
pause
exit /b

:stop
echo [INFO] Stopping the %SERVICE_NAME% service...
"%PYTHON_EXE%" "%SCRIPT_PATH%" stop
pause
exit /b

:status
echo [INFO] Service status:
sc query "%SERVICE_NAME%"
pause
exit /b

:wireproxy
echo [INFO] Downloading the latest wireproxy from GitHub (github.com/whyvl/wireproxy)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$r = Invoke-RestMethod 'https://api.github.com/repos/whyvl/wireproxy/releases/latest';" ^
  "$a = $r.assets | Where-Object { $_.name -like '*windows_amd64*' } | Select-Object -First 1;" ^
  "if (-not $a) { throw 'windows_amd64 package not found' };" ^
  "$tmp = Join-Path $env:TEMP $a.name;" ^
  "Invoke-WebRequest $a.browser_download_url -OutFile $tmp;" ^
  "tar -xzf $tmp -C '%~dp0.' wireproxy.exe;" ^
  "Remove-Item $tmp;" ^
  "Write-Host ('[OK] wireproxy ' + $r.tag_name + ' installed.')"
if not "%ERRORLEVEL%"=="0" echo [ERROR] Download failed. Download wireproxy.exe by hand and put it in this folder.
pause
exit /b
