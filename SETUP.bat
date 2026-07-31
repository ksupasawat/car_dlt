@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

echo ============================================================
echo  One-time / occasional project setup
echo ============================================================
echo.

echo ==== Backend: installing Python dependencies ====
cd backend
set "PY312=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
set "PYTHON_CMD="
py -3.12 --version >nul 2>&1
if %ERRORLEVEL%==0 set "PYTHON_CMD=py -3.12"
if not defined PYTHON_CMD if exist "%PY312%" set "PYTHON_CMD="%PY312%""
if not defined PYTHON_CMD (
    echo.
    echo ERROR: Python 3.12 was not found.
    echo Run INSTALL_FROM_ZERO.bat, or install Python 3.12 and run SETUP.bat again.
    if /I not "%~1"=="nopause" pause
    exit /b 1
)
%PYTHON_CMD% -m pip install -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Backend dependency install failed.
    if /I not "%~1"=="nopause" pause
    exit /b 1
)
cd ..
echo.

echo ==== Frontend: installing npm dependencies ====
cd frontend
call npm ci
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Frontend dependency install failed.
    if /I not "%~1"=="nopause" pause
    exit /b 1
)
cd ..
echo.

echo ============================================================
echo  Setup complete. Next: MONTHLY_UPDATE.bat
echo ============================================================
if /I not "%~1"=="nopause" pause
