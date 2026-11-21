:<<"::WINDOWS_END"
@echo off
rem Starts the Adhyaapak AI Dashboard: backend (8100) and frontend (5173).
rem This one file runs on Windows AND macOS/Linux:
rem   Windows: double-click start.bat (or run: start.bat)
rem   macOS:   ./start.bat           (or: sh start.bat)
rem cmd.exe sees the first line as a label and runs only this block; sh sees it
rem as a heredoc that skips this block and runs the part after WINDOWS_END.

rem ---------------- Windows ----------------
rem Each server opens in its own window. Stop: close the windows (or Ctrl+C in each).
set "ROOT=%~dp0"

start "Backend 8100" cmd /k "cd /d "%ROOT%backend" && venv\Scripts\python -m alembic upgrade head && venv\Scripts\python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8100 --workers 1"

start "Frontend 5173" cmd /k "cd /d "%ROOT%frontend" && npm run dev"

rem Give the servers a few seconds to start, then open the dashboard.
timeout /t 8 /nobreak >nul
start "" "http://localhost:5173/"
exit /b
::WINDOWS_END

# ---------------- macOS / Linux ----------------
# Both servers run in this terminal. Stop: press Ctrl+C (stops both).
cd "$(dirname "$0")" || exit 1

BACK_PID=""
FRONT_PID=""
stop_all() {
  trap - INT TERM HUP
  echo ""
  echo "Stopping backend and frontend..."
  [ -n "$BACK_PID" ] && kill "$BACK_PID" 2>/dev/null
  [ -n "$FRONT_PID" ] && kill "$FRONT_PID" 2>/dev/null
  wait 2>/dev/null
  echo "Stopped."
  exit 0
}
trap stop_all INT TERM HUP

(cd backend && venv/bin/python -m alembic upgrade head \
  && exec venv/bin/python -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8100 --workers 1) &
BACK_PID=$!

(cd frontend && exec npm run dev) &
FRONT_PID=$!

# Give the servers a few seconds to start, then open the dashboard.
sleep 8
if command -v open >/dev/null 2>&1; then
  open "http://localhost:5173/"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:5173/" >/dev/null 2>&1
fi
echo ""
echo "Dashboard: http://localhost:5173/  (Ctrl+C to stop)"
wait
