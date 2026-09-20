Option Explicit

Dim shell, fso, powerShellPath, scriptPath, workingDirectory, command, index, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 2 Then WScript.Quit 2
powerShellPath = Unquote(WScript.Arguments(0))
scriptPath = Unquote(WScript.Arguments(1))
workingDirectory = ""
If WScript.Arguments.Count >= 3 Then workingDirectory = Unquote(WScript.Arguments(2))

If Not fso.FileExists(powerShellPath) Then WScript.Quit 3
If Not fso.FileExists(scriptPath) Then WScript.Quit 4
If workingDirectory <> "" Then
    If Not fso.FolderExists(workingDirectory) Then WScript.Quit 5
    shell.CurrentDirectory = workingDirectory
End If

command = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(scriptPath)
For index = 3 To WScript.Arguments.Count - 1
    command = command & " " & CommandArgument(Unquote(WScript.Arguments(index)))
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & Replace(CStr(value), Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function

Function Unquote(value)
    Dim text
    text = Trim(CStr(value))
    If Len(text) >= 2 Then
        If Left(text, 1) = Chr(34) And Right(text, 1) = Chr(34) Then
            text = Mid(text, 2, Len(text) - 2)
        End If
    End If
    Unquote = text
End Function

Function CommandArgument(value)
    Dim text
    text = CStr(value)
    If Left(text, 1) = "-" And InStr(text, " ") = 0 Then
        CommandArgument = text
    Else
        CommandArgument = Quote(text)
    End If
End Function
