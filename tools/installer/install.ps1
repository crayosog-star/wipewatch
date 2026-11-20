# Wipewatch installer: per-user (no admin). Copies the app to %LOCALAPPDATA%\Programs\Wipewatch, adds Start Menu + Desktop shortcuts and an Apps & Features entry.
param([switch]$Silent, [string]$TestDir = '')
$ErrorActionPreference = 'Stop'
$ver = '__VERSION__'
$test = [bool]$TestDir
$dest = if ($test) { $TestDir } else { Join-Path $env:LOCALAPPDATA 'Programs\Wipewatch' }
function Say($t, $icon = 'Information') { if (-not $Silent -and -not $test) { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($t, 'Wipewatch setup', 'OK', $icon) } }
try {
  if (-not $test) { Get-Process Wipewatch -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 1 }
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Force $dest | Out-Null
  $zip = Join-Path $PSScriptRoot 'payload.zip'
  & "$env:SystemRoot\System32\tar.exe" -xf $zip -C $dest
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $dest 'Wipewatch.exe'))) { throw 'Could not unpack the app files.' }
  Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') (Join-Path $dest 'uninstall.ps1') -Force
  $exe = Join-Path $dest 'Wipewatch.exe'
  if (-not $test) {
    $sh = New-Object -ComObject WScript.Shell
    $links = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Wipewatch.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Wipewatch.lnk'))
    foreach ($l in $links) { $s = $sh.CreateShortcut($l); $s.TargetPath = $exe; $s.WorkingDirectory = $dest; $s.IconLocation = "$exe,0"; $s.Description = 'Wipewatch - your Rust companion'; $s.Save() }
    $k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Wipewatch'
    New-Item -Path $k -Force | Out-Null
    $sizeKb = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    $uninst = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $dest + '\uninstall.ps1"'
    $vals = @{ DisplayName = 'Wipewatch'; DisplayVersion = $ver; Publisher = 'Wipewatch'; InstallLocation = $dest; DisplayIcon = $exe; UninstallString = $uninst }
    foreach ($n in $vals.Keys) { Set-ItemProperty -Path $k -Name $n -Value $vals[$n] }
    New-ItemProperty -Path $k -Name EstimatedSize -Value $sizeKb -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $k -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    Start-Process $exe
    Say "Wipewatch $ver is installed. It is starting now and will keep running in the tray.`n`nYour settings and history were kept."
  }
} catch {
  Say ("Setup failed: " + $_.Exception.Message) 'Error'
  exit 1
}
