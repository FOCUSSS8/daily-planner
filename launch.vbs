Option Explicit

' Daily Planner launcher: ensure the server is running, then open the UI
' in Edge app mode (no address bar, looks like a desktop app).
Dim fso, sh, appDir, serverJs, nodeExe, edgeExe, appUrl, healthUrl, i, alive

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverJs = fso.BuildPath(appDir, "server.js")
appUrl = "http://127.0.0.1:3210/?owner=1"
healthUrl = "http://127.0.0.1:3210/api/health"

nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

If Not ServerAlive(healthUrl) Then
    sh.CurrentDirectory = appDir
    sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False
    alive = False
    For i = 1 To 40
        WScript.Sleep 500
        If ServerAlive(healthUrl) Then
            alive = True
            Exit For
        End If
    Next
End If

edgeExe = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edgeExe) Then
    edgeExe = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
End If

If fso.FileExists(edgeExe) Then
    sh.Run """" & edgeExe & """ --app=" & appUrl, 1, False
Else
    sh.Run appUrl, 1, False
End If

Function ServerAlive(url)
    Dim http
    ServerAlive = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", url, False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then
            If InStr(http.responseText, "daily-planner") > 0 Then
                ServerAlive = True
            End If
        End If
    End If
    Err.Clear
    On Error GoTo 0
End Function
