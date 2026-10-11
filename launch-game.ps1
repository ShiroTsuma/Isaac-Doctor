param([Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$GameDirectory)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $GameDirectory 'REPENTOGONLauncher\REPENTOGONLauncher.exe'
$baseExe = Join-Path $GameDirectory 'isaac-ng.exe'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Launcher not found: $launcher" }
if (-not (Test-Path -LiteralPath $baseExe -PathType Leaf)) { throw "Base game not found: $baseExe" }
if (Get-Process -Name 'isaac-ng' -ErrorAction SilentlyContinue) { throw 'Isaac is already running; attach to the existing process.' }
# This script deliberately starts ONLY the official launcher. The launcher creates
# the compatible process and its environment; never run Repentogon/isaac-ng.exe here.
$arguments = @('--isaac="' + $baseExe + '"', '--stealth-mode', '--launch-mode=repentogon')
Start-Process -FilePath $launcher -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $launcher) -WindowStyle Hidden
