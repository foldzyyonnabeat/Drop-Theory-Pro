$ErrorActionPreference = 'Stop'

function Get-RegistryInstallEntry {
    $registryGlobs = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($registryGlob in $registryGlobs) {
        Get-ItemProperty -Path $registryGlob -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -eq 'Drop Theory Pro' }
    }
}

function Get-SafeBundlePath([string] $root, [string] $relativePath) {
    $normalized = $relativePath.Replace('/', '\')
    if ([IO.Path]::IsPathRooted($normalized) -or ($normalized -split '\\') -contains '..') {
        throw "The model manifest contains an unsafe path: $relativePath"
    }
    $rootPath = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $fullPath = [IO.Path]::GetFullPath((Join-Path $rootPath $normalized))
    if (-not $fullPath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The model manifest path escapes its bundle folder: $relativePath"
    }
    return $fullPath
}

function Assert-ModelFile([string] $path, $entry) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "A required model file is missing: $path"
    }
    $file = Get-Item -LiteralPath $path
    if ($file.Length -ne [long]$entry.sizeBytes) {
        throw "A model file has the wrong size: $path"
    }
    $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant()) {
        throw "A model file failed its SHA-256 check: $path"
    }
}

$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$modelRoot = Join-Path $bundleRoot 'stem-models'
$manifestPath = Join-Path $modelRoot 'bundle-manifest.json'
$installer = Get-ChildItem -LiteralPath $bundleRoot -Filter 'Drop Theory Pro_*_x64-setup.exe' -File |
    Select-Object -First 1

if (-not $installer) {
    throw 'The bundled Drop Theory Pro installer was not found. Extract the complete offline ZIP first.'
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw 'The offline model manifest is missing. Extract the complete offline ZIP first.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.format -ne 'drop-theory-stem-model-bundle' -or $manifest.version -ne 1) {
    throw 'The offline model manifest has an unsupported format.'
}
$modelFiles = @($manifest.files)
if ($modelFiles.Count -ne 10) {
    throw "Expected ten pinned model files; found $($modelFiles.Count)."
}
$expectedProfiles = @('htdemucs-ft', 'htdemucs-ft-compact', 'htdemucs-speed', 'uvr-mdx-inst-hq-5')
$actualProfiles = @($manifest.profiles.PSObject.Properties.Name | Sort-Object)
$expectedProfiles = @($expectedProfiles | Sort-Object)
if (($actualProfiles -join ',') -ne ($expectedProfiles -join ',')) {
    throw 'The offline bundle does not contain all four supported model profiles.'
}

Write-Host 'Checking the bundled model files. This can take a few minutes.'
foreach ($entry in $modelFiles) {
    $source = Get-SafeBundlePath $modelRoot ([string]$entry.path)
    Assert-ModelFile $source $entry
}

$runningApp = Get-Process -Name 'crateforge' -ErrorAction SilentlyContinue
if ($runningApp) {
    throw 'Close Drop Theory Pro before running the offline setup script.'
}

Write-Host 'Starting the included app installer. Follow its prompts, then return here.'
$installProcess = Start-Process -FilePath $installer.FullName -Wait -PassThru
if ($installProcess.ExitCode -ne 0) {
    throw "The app installer exited with code $($installProcess.ExitCode)."
}

$registryEntry = Get-RegistryInstallEntry | Select-Object -First 1
$installRoot = if ($registryEntry.InstallLocation) {
    ([string]$registryEntry.InstallLocation).Trim().Trim('"')
} else {
    ''
}
if (-not $installRoot -or -not (Test-Path -LiteralPath (Join-Path $installRoot 'stem-runtime\python.exe'))) {
    $installRoot = Read-Host 'Enter the app installation folder containing stem-runtime\python.exe'
}
$installRoot = [IO.Path]::GetFullPath($installRoot.Trim().Trim('"'))
if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'stem-runtime\python.exe') -PathType Leaf)) {
    throw "The Drop Theory Pro runtime was not found under: $installRoot"
}
$runningApp = Get-Process -Name 'crateforge' -ErrorAction SilentlyContinue
if ($runningApp) {
    Write-Host 'Close Drop Theory Pro so the verified model files can be copied.'
    [void](Read-Host 'Press Enter after closing the app')
    if (Get-Process -Name 'crateforge' -ErrorAction SilentlyContinue) {
        throw 'Drop Theory Pro is still running. Close it and run Install-Offline.ps1 again.'
    }
}

$destinationRoot = Join-Path $installRoot 'stem-models'
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$licensesSource = Join-Path $modelRoot 'MODEL-LICENSES.txt'
if (-not (Test-Path -LiteralPath $licensesSource -PathType Leaf)) {
    throw 'The model license notice is missing from the offline bundle.'
}
Copy-Item -LiteralPath $licensesSource -Destination (Join-Path $destinationRoot 'MODEL-LICENSES.txt') -Force

Write-Host 'Installing and verifying all model files locally.'
foreach ($entry in $modelFiles) {
    $relativePath = [string]$entry.path
    $source = Get-SafeBundlePath $modelRoot $relativePath
    $destination = Get-SafeBundlePath $destinationRoot $relativePath
    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Assert-ModelFile $destination $entry
}

# Publish the manifest last so the app never detects a partial model installation.
Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $destinationRoot 'bundle-manifest.json') -Force
Write-Host 'Offline setup is complete. All four model profiles are installed and verified.'