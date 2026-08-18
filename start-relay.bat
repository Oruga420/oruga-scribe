@echo off
title oruga-scribe relay
cd /d "%~dp0"

REM Leave this window OPEN while you record. Closing it kills narration and the SOP writer.
REM
REM By default the relay uses relay\.claude-home, an isolated config dir holding a PERSONAL
REM login, so a personal tool never spends Promise quota. If you have not logged in there yet,
REM narration and the SOP will fail with "no text".
REM
REM To log in once:
REM   set CLAUDE_CONFIG_DIR=%~dp0relay\.claude-home
REM   claude auth login
REM
REM To run against the machine's DEFAULT login instead (a work account on a team plan), start
REM this script with the word work as an argument:  start-relay.bat work

if /I "%~1"=="work" (
  set "SCRIBE_CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude"
  echo.
  echo   WARNING: using the machine default login, which is a work seat.
  echo   This spends company quota. Intended only for a one off proof run.
  echo.
)

node relay\server.js
echo.
echo   The relay stopped. Press a key to close.
pause > nul
