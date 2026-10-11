param(
    [ValidateRange(1, 3600)][int]$Seconds = 25,
    [ValidateRange(0, 1000000)][int]$MinimumUs = 0,
    [ValidateSet('immediate','run-load','room-entry','level-entry','projectile','tear','effect','npc','damage','run-end','game-exit')][string]$StartOn = 'run-load',
    [ValidateSet('duration','manual','run-load','room-entry','level-entry','projectile','tear','effect','npc','damage','run-end','game-exit')][string]$StopOn = 'duration',
    [ValidateRange(0,3600000)][int]$StartDelayMs = 0,
    [ValidateRange(0,3600000)][int]$StopDelayMs = 0,
    [ValidateRange(0,3600000)][int]$MaxDurationMs = 0,
    [switch]$Immediately,
    [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$exitCode = 0
$logPath = Join-Path $PSScriptRoot 'record-game.log'
function Show-Message([string]$Text) {
    Write-Host $Text
    [System.IO.File]::AppendAllText($logPath, ('[{0}] {1}{2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text, [Environment]::NewLine))
}
function Invoke-Profiler([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        # Capture native stderr as text; report the complete error after exit.
        $ErrorActionPreference = 'Continue'
        $output = @(& $injector @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($code -ne 0) { throw $text }
    return $text
}
try {
    Show-Message "Isaac Doctor: minimum $MinimumUs us, screenshots every 500 ms."
    $injector = Join-Path $PSScriptRoot 'build\Release\isaacprof-injector.exe'
    if (-not (Test-Path -LiteralPath $injector -PathType Leaf)) { throw 'Profiler build not found. Run build.ps1 first.' }
    $games = @(Get-Process -Name 'isaac-ng' -ErrorAction SilentlyContinue)
    if ($games.Count -ne 1) { throw 'Isaac is not running (or multiple instances exist). Start it through REPENTOGONLauncher, then run this script again.' }
    $gameId = $games[0].Id
    Show-Message (Invoke-Profiler -Arguments @('attach', '--pid', "$gameId"))
    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $status = Invoke-Profiler -Arguments @('status', '--pid', "$gameId")
        if ($status -match '\| ready \|') { $ready = $true; break }
        if ($status -match '\| (recording|armed) \|') { throw 'A recording is already running or armed. Stop it before starting another.' }
        if ($attempt -eq 0) { Show-Message 'Waiting for the game API to finish loading...' }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Game API did not become ready within 30 seconds. See build\Release\isaacprof.log.' }
    $recordArguments = @('record', '--pid', "$gameId", '--seconds', "$Seconds", '--trace', '--screenshots', '--screenshot-ms', '500', '--min-us', "$MinimumUs")
    if ($Immediately) { $StartOn = 'immediate' }
    $recordArguments += @('--start-on', $StartOn, '--stop-on', $StopOn, '--start-delay-ms', "$StartDelayMs", '--stop-delay-ms', "$StopDelayMs")
    $recordArguments += @('--max-duration-ms', "$MaxDurationMs")
    $started = Invoke-Profiler -Arguments $recordArguments
    Show-Message $started
    $report = (($started -split '\r?\n' | Where-Object { $_.StartsWith('Report: ') }) | Select-Object -Last 1)
    if (-not $report) { throw 'Profiler did not return a capture path.' }
    $report = $report.Substring(8).Trim()
    if ($StopOn -eq 'manual') { $stopDescription = 'manual Stop; stop delay and Seconds are unused' }
    elseif ($StopOn -eq 'duration') { $stopDescription = "after $Seconds seconds + $StopDelayMs ms delay" }
    else { $stopDescription = "on $StopOn + $StopDelayMs ms delay; Seconds is unused" }
    Show-Message "Start: $StartOn + $StartDelayMs ms; stop: $stopDescription. Manual Stop remains immediate."
    if ($MaxDurationMs -gt 0) { Show-Message "Independent maximum: $MaxDurationMs ms after recording starts; whichever stop condition comes first." }
    elseif ($StopOn -ne 'duration') { Show-Message 'No time limit enabled. Stop manually if the event never occurs.' }
    $lastState = ''
    while ($true) {
        Start-Sleep -Milliseconds 500
        $status = Invoke-Profiler -Arguments @('status', '--pid', "$gameId")
        if ($status -match '\| recording \|') {
            if ($lastState -ne 'recording') { Show-Message "Recording now; stop: $stopDescription."; $lastState = 'recording' }
        } elseif ($status -match '\| armed \|') {
            $lastState = 'armed'
        } elseif ($status -match '\| ready \|') {
            if (-not (Test-Path -LiteralPath $report -PathType Leaf)) { throw 'Recording was cancelled before it started; no capture was saved.' }
            Show-Message ('Saved: ' + $report)
            break
        } else { throw ('Recording interrupted: ' + $status) }
    }
} catch {
    $exitCode = 1
    Write-Host ''
    Show-Message ('ERROR: ' + $_.Exception.Message)
    Write-Host ('Log: ' + $logPath)
} finally {
    if (-not $NoPause) {
        Write-Host ''
        [void](Read-Host 'Press Enter to close')
    }
}
exit $exitCode
