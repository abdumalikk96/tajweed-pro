Option Explicit

Dim WshShell, fso, projectDir, backendDir, logsDir, pythonExe, npmCmd
Dim backendRunning, frontendRunning, http, isReady, attempts
Dim chromePath, edgePath

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = "C:\Users\User\Desktop\Tajvid"
backendDir = "C:\Users\User\Desktop\Tajvid\quran-ai-backend"
logsDir = "C:\Users\User\Desktop\Tajvid\logs"
pythonExe = "C:\Users\User\Desktop\Tajvid\quran-ai-backend\venv\Scripts\python.exe"
npmCmd = "C:\Program Files\nodejs\npm.cmd"

If Not fso.FolderExists(logsDir) Then
    On Error Resume Next
    fso.CreateFolder(logsDir)
    On Error GoTo 0
End If

If Not fso.FileExists(pythonExe) Then
    If fso.FileExists("C:\Users\User\Desktop\Tajvid\.venv\Scripts\python.exe") Then
        pythonExe = "C:\Users\User\Desktop\Tajvid\.venv\Scripts\python.exe"
    Else
        pythonExe = "python"
    End If
End If

If Not fso.FileExists(npmCmd) Then
    npmCmd = "npm.cmd"
End If

WshShell.CurrentDirectory = projectDir

' 1. Check if Backend (Port 8000) is already listening
backendRunning = (WshShell.Run("cmd /c netstat -ano | findstr "":8000.*LISTENING"" >nul 2>&1", 0, True) = 0)
If Not backendRunning Then
    WshShell.Run "cmd /c cd /d """ & backendDir & """ && """ & pythonExe & """ -m uvicorn main:app --host 0.0.0.0 --port 8000 > """ & logsDir & "\backend.log"" 2>&1", 0, False
End If

' 2. Check if Frontend (Port 3000) is already listening
frontendRunning = (WshShell.Run("cmd /c netstat -ano | findstr "":3000.*LISTENING"" >nul 2>&1", 0, True) = 0)
If Not frontendRunning Then
    ' Remove stale Next.js dev lock if present
    If fso.FileExists(projectDir & "\.next\dev\lock") Then
        On Error Resume Next
        fso.DeleteFile projectDir & "\.next\dev\lock", True
        On Error GoTo 0
    End If
    WshShell.Run "cmd /c cd /d """ & projectDir & """ && """ & npmCmd & """ run dev > """ & logsDir & "\frontend.log"" 2>&1", 0, False
End If

' 3. Poll http://localhost:3000 up to 25 seconds via MSXML2.ServerXMLHTTP until HTTP 200
isReady = False
attempts = 0

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.ServerXMLHTTP")
End If
If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.XMLHTTP")
End If

Do While (Not isReady) And (attempts < 25)
    Err.Clear
    http.Open "GET", "http://localhost:3000", False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then
            isReady = True
            Exit Do
        End If
    End If
    WScript.Sleep 1000
    attempts = attempts + 1
Loop
On Error GoTo 0

' 4. Open application window ONLY when server actually responded HTTP 200
If isReady Then
    chromePath = ""
    If fso.FileExists("C:\Program Files\Google\Chrome\Application\chrome.exe") Then
        chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    ElseIf fso.FileExists("C:\Program Files (x86)\Google\Chrome\Application\chrome.exe") Then
        chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    End If

    edgePath = ""
    If fso.FileExists("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe") Then
        edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    ElseIf fso.FileExists("C:\Program Files\Microsoft\Edge\Application\msedge.exe") Then
        edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    End If

    If chromePath <> "" Then
        WshShell.Run """" & chromePath & """ --app=http://localhost:3000", 1, False
    ElseIf edgePath <> "" Then
        WshShell.Run """" & edgePath & """ --app=http://localhost:3000", 1, False
    Else
        WshShell.Run "cmd /c start http://localhost:3000", 0, False
    End If
End If
