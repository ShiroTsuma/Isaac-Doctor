param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not $SkipBuild) {
        & ./build.ps1
        & pnpm.cmd --dir viewer install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw 'Viewer installation failed.' }
        & pnpm.cmd --dir viewer build
        if ($LASTEXITCODE -ne 0) { throw 'Viewer build failed.' }
    }
    $python = Join-Path $PSScriptRoot 'build/release-tools/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $python)) {
        & python -m venv build/release-tools
        if ($LASTEXITCODE -ne 0) { throw 'Release environment creation failed.' }
    }
    & $python -m pip install -r tools/release-requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Release tooling installation failed.' }
    & $python tools/package-release.py
    if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }
} finally { Pop-Location }
