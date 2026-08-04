@echo off
REM Start the dashboard using the project's virtualenv.
cd /d "%~dp0"
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
