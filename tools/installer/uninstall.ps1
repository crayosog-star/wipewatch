# Wipewatch uninstaller. Removes the app, shortcuts and startup entry. Your data folder (%APPDATA%\Rust Drops Tracker) is kept.
param([switch]$Silent, [switch]$FromTemp, [string]$Dir = '')
$ErrorActionPreference = 'Continue'
$dest = if ($Dir) { $Dir } else { Join-Path $env:LOCALAPPDATA 'Programs\Wipewatch' }
if (-not $FromTemp) {
  # run a copy from %TEMP% so the install folder (including this script) can be deleted
  $tmp = Join-Path $env:TEMP 'wipewatch-uninstall.ps1'; Copy-Item $PSCommandPath $tmp -Force
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $tmp, '-FromTemp', '-Dir', $dest)
  if ($Silent) { $argList += '-Silent' }
  Start-Process powershell.exe -ArgumentList $argList
  exit 0
}
Get-Process Wipewatch -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Wipewatch' -ErrorAction SilentlyContinue
foreach ($l in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Wipewatch.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Wipewatch.lnk'))) { Remove-Item $l -Force -ErrorAction SilentlyContinue }
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Wipewatch' -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $Silent) { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show("Wipewatch was removed.`n`nYour settings and history are still in %APPDATA%\Rust Drops Tracker if you reinstall later.", 'Wipewatch', 'OK', 'Information') }
