' Double-click launcher. Starts the visualiser with no console window at all —
' it just appears as your wallpaper, with a tray icon for the settings.
Option Explicit

Dim fso, sh, root, exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
exe  = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Dependencies aren't installed yet." & vbCrLf & vbCrLf & _
         "Right-click setup.ps1 in this folder and choose" & vbCrLf & _
         """Run with PowerShell"" (or run 'npm install' here)." & vbCrLf & vbCrLf & _
         root, 48, "Black Hole Visualizer"
  WScript.Quit 1
End If

sh.CurrentDirectory = root
sh.Run """" & exe & """ """ & root & """", 0, False
