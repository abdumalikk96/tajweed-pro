@echo off
title Tajweed Pro Launcher
echo ===================================================
echo   TAJWEED PRO - AUTOMATIC LAUNCHER
echo ===================================================
echo.

set "PROJECT_DIR=C:\Users\User\Desktop\Tajvid"
set "BACKEND_DIR=C:\Users\User\Desktop\Tajvid\quran-ai-backend"

if not exist "%PROJECT_DIR%" goto :err_noproject
cd /d "%PROJECT_DIR%"
if errorlevel 1 goto :err_noproject

set "PYTHON_EXE="
if exist "%BACKEND_DIR%\venv\Scripts\python.exe" set "PYTHON_EXE=%BACKEND_DIR%\venv\Scripts\python.exe"
if "%PYTHON_EXE%"=="" if exist "%PROJECT_DIR%\.venv\Scripts\python.exe" set "PYTHON_EXE=%PROJECT_DIR%\.venv\Scripts\python.exe"
if "%PYTHON_EXE%"=="" set "PYTHON_EXE=python"

echo [1/3] Checking Tajweed Pro Backend (Port 8000)...
netstat -ano | findstr :8000 | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto :backend_ok

echo Starting Tajweed Pro Backend (Port 8000)...
if not exist "%BACKEND_DIR%\main.py" goto :err_nobackend
pushd "%BACKEND_DIR%"
start "Tajweed-Pro-Backend" /min cmd /k "%PYTHON_EXE% -m uvicorn main:app --host 0.0.0.0 --port 8000"
popd
echo [OK] Backend window started in minimized mode.
goto :check_frontend

:backend_ok
echo [OK] Backend is already running on Port 8000.

:check_frontend
echo.
echo [2/3] Checking Tajweed Pro Frontend (Port 3000)...
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto :frontend_ok

echo Starting Tajweed Pro Frontend (Port 3000)...
if exist "%PROJECT_DIR%\.next\dev\lock" del /f /q "%PROJECT_DIR%\.next\dev\lock" >nul 2>&1
start "Tajweed-Pro-Frontend" /min cmd /k "npm run dev"
echo [OK] Frontend window started in minimized mode.
goto :wait_ready

:frontend_ok
echo [OK] Frontend is already running on Port 3000.

:wait_ready
echo.
echo [3/3] Waiting for http://localhost:3000 to be ready...
set /a TRIES=0

:poll_loop
set /a TRIES+=1
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>&1
if not errorlevel 1 goto :open_browser
if %TRIES% geq 30 goto :err_timeout
timeout /t 1 /nobreak >nul
goto :poll_loop

:open_browser
echo [OK] Server is ready! Opening http://localhost:3000 ...
start "" "http://localhost:3000"
echo.
echo ===================================================
echo   ALL SERVICES ARE RUNNING:
echo   - Tajweed Pro Frontend: http://localhost:3000
echo   - Tajweed Pro Backend:  http://localhost:8000
echo ===================================================
if "%NO_PAUSE%"=="1" exit /b 0
timeout /t 3 >nul
exit /b 0

:err_noproject
echo.
echo [ERROR] Project folder not found: %PROJECT_DIR%
pause
exit /b 1

:err_nobackend
echo.
echo [ERROR] Backend file not found: %BACKEND_DIR%\main.py
pause
exit /b 1

:err_timeout
echo.
echo [WARNING] Port 3000 did not start within 30 seconds.
echo Please check the minimized "Tajweed-Pro-Frontend" window in the taskbar.
pause
exit /b 1
