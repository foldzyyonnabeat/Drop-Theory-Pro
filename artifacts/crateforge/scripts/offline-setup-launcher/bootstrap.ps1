$ErrorActionPreference = 'Stop'

$bundlePath = [IO.Path]::GetFullPath([string]$args[0])
$extractRoot = Join-Path $env:TEMP ("DropTheoryPro-Offline-" + [guid]::NewGuid().ToString('N'))
$exitCode = 1

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    Write-Host 'Extracting the included offline installer and model files...'
    [System.IO.Compression.ZipFile]::ExtractToDirectory($bundlePath, $extractRoot)

    Write-Host 'Starting Drop Theory Pro offline setup...'
    & (Join-Path $extractRoot 'Install-Offline.ps1')
    $exitCode = 0
    Write-Host 'All model files are installed and verified.'
} catch {
    Write-Host "Offline setup failed: $($_.Exception.Message)" -ForegroundColor Red
}

if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($exitCode -eq 0) {
    Write-Host 'Press Enter to close this window.'
} else {
    Write-Host 'Fix the issue above and run this setup file again. Press Enter to close.'
}
[void][Console]::ReadLine()
exit $exitCode
