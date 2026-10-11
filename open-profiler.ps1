param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$viewerPath = Join-Path $PSScriptRoot 'viewer'
if (-not (Test-Path (Join-Path $viewerPath 'node_modules'))) {
    & pnpm.cmd --dir $viewerPath install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Viewer dependency installation failed.' }
}
& pnpm.cmd --dir $viewerPath build
if ($LASTEXITCODE -ne 0) { throw 'Viewer type checking, lint or build failed.' }
$url = 'http://127.0.0.1:' + $Port
$health = $null
try { $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 2 } catch {}
if ($health -and ($health.app -ne 'isaacprof' -or $health.root -ne $PSScriptRoot)) { throw 'This port belongs to another server. Select a different -Port.' }
if (-not $health) {
    $python = (Get-Command python -ErrorAction Stop).Source
    $scriptPath = Join-Path $PSScriptRoot 'tools\viewer-server.py'
    $server = Start-Process -FilePath $python -ArgumentList @('"' + $scriptPath + '"', '--port', $Port) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $health -or $health.root -ne $PSScriptRoot) { throw 'The profiler server did not start. Try another -Port.' }
    Write-Host ('Viewer server PID: ' + $server.Id + ' (Stop-Process -Id ' + $server.Id + ' to close it)')
}
Start-Process $url
