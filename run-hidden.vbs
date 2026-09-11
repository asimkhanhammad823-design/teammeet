' Starts the TeamMeet server with no visible window (used by the "TeamMeet" scheduled task).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\New folder"
sh.Run "cmd /c node server.js >> server.log 2>&1", 0, False
