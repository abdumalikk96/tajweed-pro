$ErrorActionPreference = "Stop"

$desktopPath = [Environment]::GetFolderPath("Desktop")
$projectRoot = "C:\Users\User\Desktop\Tajvid"
$vbsPath = Join-Path $projectRoot "launch_silent.vbs"
$shortcutPath = Join-Path $desktopPath "Tajweed Pro.lnk"

# Remove obsolete legacy shortcut if it exists
$oldShortcutPath = Join-Path $desktopPath "Qur'on Tajvid AI.lnk"
if (Test-Path -LiteralPath $oldShortcutPath) {
    Remove-Item -LiteralPath $oldShortcutPath -Force -ErrorAction SilentlyContinue
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$Shortcut.Arguments = "`"$vbsPath`""
$Shortcut.WorkingDirectory = $projectRoot
$Shortcut.WindowStyle = 1
$Shortcut.Description = "Tajweed Pro - Professional Quran Recitation & Tajweed AI Trainer"
$Shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$Shortcut.Save()

if (Test-Path -LiteralPath $shortcutPath) {
    Write-Host "[OK] Desktop shortcut created successfully: $shortcutPath" -ForegroundColor Green
} else {
    Write-Error "Failed to create desktop shortcut!"
}
