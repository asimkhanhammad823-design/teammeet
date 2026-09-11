@echo off
title TeamMeet
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo.
echo Starting TeamMeet at http://localhost:3000
echo The public invite link appears in the lobby (Invite link box) in ~10 seconds.
echo Keep this window open while the meeting runs.
echo.
start "" http://localhost:3000
node server.js
pause
