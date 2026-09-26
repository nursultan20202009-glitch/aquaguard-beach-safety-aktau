$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
    $running = Invoke-RestMethod 'http://127.0.0.1:8000/api/state' -TimeoutSec 2
    if ($running.video) {
        Write-Host 'AquaGuard server is already running: http://127.0.0.1:8000/'
        return
    }
} catch { }

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCommand) {
    $python = $pythonCommand.Source
} else {
    $pyCommand = Get-Command py -ErrorAction SilentlyContinue
    if ($pyCommand) {
        $python = $pyCommand.Source
    } else {
        $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
        if (-not (Test-Path -LiteralPath $bundled)) {
            throw 'Python 3.11+ was not found. Install Python and run again.'
        }
        $python = $bundled
    }
}

$deps = Join-Path $PSScriptRoot '.runtime'
$marker = Join-Path $deps '.ready'
if (-not (Test-Path -LiteralPath $marker) -or (Get-Item 'requirements.txt').LastWriteTime -gt (Get-Item $marker -ErrorAction SilentlyContinue).LastWriteTime) {
    New-Item -ItemType Directory -Force -Path $deps | Out-Null
    & $python -m pip install --target $deps -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Could not install Python dependencies.' }
    New-Item -ItemType File -Force -Path $marker | Out-Null
}
$env:PYTHONPATH = $deps
& $python server.py
