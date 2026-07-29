Option Explicit

Dim shell, fso, scriptDir, rootDir, watchdogPath, heartbeatPath, command, temporaryPath, powerShellPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
watchdogPath = fso.BuildPath(scriptDir, "Ensure-UserScheduler.ps1")
heartbeatPath = fso.BuildPath(rootDir, "data\scheduler-supervisor-heartbeat.json")
If WScript.Arguments.Count > 0 Then
    powerShellPath = WScript.Arguments(0)
Else
    powerShellPath = "pwsh.exe"
End If
command = """" & powerShellPath & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & watchdogPath & """"

Function WatchdogIsRunning()
    Dim service, processes, process, line
    WatchdogIsRunning = False
    On Error Resume Next
    Set service = GetObject("winmgmts:\\.\root\cimv2")
    Set processes = service.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name='pwsh.exe' OR Name='powershell.exe'")
    For Each process In processes
        line = "" & process.CommandLine
        If InStr(1, line, watchdogPath, vbTextCompare) > 0 Then
            WatchdogIsRunning = True
            Exit For
        End If
    Next
    On Error GoTo 0
End Function

Sub WriteHeartbeat()
    Dim file, parent, json
    On Error Resume Next
    parent = fso.GetParentFolderName(heartbeatPath)
    If Not fso.FolderExists(parent) Then fso.CreateFolder(parent)
    temporaryPath = heartbeatPath & "." & CStr(Timer) & ".tmp"
    json = "{""updatedAt"":""" & Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "T" & Right("0" & Hour(Now), 2) & ":" & Right("0" & Minute(Now), 2) & ":" & Right("0" & Second(Now), 2) & """}"
    Set file = fso.CreateTextFile(temporaryPath, True, True)
    file.Write json
    file.Close
    If fso.FileExists(heartbeatPath) Then fso.DeleteFile heartbeatPath, True
    fso.MoveFile temporaryPath, heartbeatPath
    On Error GoTo 0
End Sub

Do
    WriteHeartbeat
    If Not WatchdogIsRunning() Then shell.Run command, 0, False
    WScript.Sleep 60000
Loop
