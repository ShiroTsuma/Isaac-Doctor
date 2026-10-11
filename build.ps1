param([ValidateSet('Release','Debug')][string]$Configuration = 'Release', [string]$BuildDirectory = 'build')
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vsRoot = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'Visual Studio C++ x86/x64 tools were not found.' }
$cmake = Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake)) { $cmake = (Get-Command cmake -ErrorAction Stop).Source }
$buildPath = Join-Path $PSScriptRoot $BuildDirectory
& $cmake -S $PSScriptRoot -B $buildPath -G 'Visual Studio 17 2022' -A Win32 "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE:PATH=$buildPath/Release" "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG:PATH=$buildPath/Debug"
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }
& $cmake --build $buildPath --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
$collectorPath = Join-Path $buildPath 'collector-x64'
& $cmake -S (Join-Path $PSScriptRoot 'collector') -B $collectorPath -G 'Visual Studio 17 2022' -A x64 "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE:PATH=$buildPath/Release" "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_DEBUG:PATH=$buildPath/Debug"
if ($LASTEXITCODE -ne 0) { throw 'Collector configuration failed.' }
& $cmake --build $collectorPath --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw 'Collector build failed.' }
