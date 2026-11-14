[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'YangmoNative'),
    [string]$PythonPath,
    [string]$FFmpegPath,
    [string]$FFprobePath,
    [string]$NodePath,
    [string]$ExistingVenv,
    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
$hostName = 'org.yangmo.downloader'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $hostName
$requiredYtDlpVersion = '2026.10.26'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$sourceRoot = Split-Path -Parent $PSScriptRoot
$sourceNative = Join-Path $sourceRoot 'native'

function Resolve-Executable([string]$Value, [string]$CommandName) {
    if (!$Value) {
        $command = Get-Command $CommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (!$command) { throw "Missing $CommandName. Supply its explicit path; this installer does not download executables." }
        $Value = $command.Source
    }
    $resolved = (Resolve-Path -LiteralPath $Value).ProviderPath
    if (!(Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Expected an executable file: $Value" }
    # These paths become literals in a cmd wrapper. Reject expansion/control characters.
    if ($resolved -match '[%!*?&|<>^"\r\n]') { throw "Executable path contains unsupported command characters: $resolved" }
    return $resolved
}

function Write-Utf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $absolute = [System.IO.Path]::GetFullPath($Path)
    $prefix = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (!$absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path leaves the installation directory: $absolute"
    }
    return $absolute
}

if (!(Test-Path -LiteralPath (Join-Path $sourceNative 'host.py') -PathType Leaf)) {
    throw 'Missing native/host.py. Use the source package containing the native engine.'
}
$installation = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($installation -eq [System.IO.Path]::GetPathRoot($installation).TrimEnd('\') -or $installation -match '[%!*?&|<>^"\r\n]') {
    throw 'Choose a dedicated installation directory without command expansion characters.'
}
$ffmpeg = Resolve-Executable $FFmpegPath 'ffmpeg.exe'
if (!$FFprobePath) { $FFprobePath = Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe' }
$ffprobe = Resolve-Executable $FFprobePath 'ffprobe.exe'
$node = Resolve-Executable $NodePath 'node.exe'
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'A working Node.js 22 or newer is required.'
}

New-Item -ItemType Directory -Path $installation -Force | Out-Null
if ($ExistingVenv) {
    $venvRoot = (Resolve-Path -LiteralPath $ExistingVenv).ProviderPath
    $python = Resolve-Executable (Join-Path $venvRoot 'Scripts\python.exe') 'python.exe'
    if (!(Test-Path -LiteralPath (Join-Path $venvRoot 'pyvenv.cfg') -PathType Leaf)) { throw 'ExistingVenv must be an isolated Python virtual environment.' }
} else {
    $venvRoot = Assert-ChildPath (Join-Path $installation '.venv') $installation
    $candidate = Join-Path $venvRoot 'Scripts\python.exe'
    if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {
        if ($SkipDependencyInstall) { throw 'SkipDependencyInstall requires an existing isolated virtual environment.' }
        $basePython = Resolve-Executable $PythonPath 'python.exe'
        & $basePython -c "import sys; assert sys.version_info >= (3, 11), 'Python 3.11 or newer is required'"
        if ($LASTEXITCODE -ne 0) { throw 'Python version check failed.' }
        & $basePython -m venv $venvRoot
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python environment.' }
    }
    $python = Resolve-Executable $candidate 'python.exe'
    if (!(Test-Path -LiteralPath (Join-Path $venvRoot 'pyvenv.cfg') -PathType Leaf)) { throw 'The selected environment is not an isolated virtual environment.' }
}
if (!$SkipDependencyInstall) {
    & $python -m pip install --disable-pip-version-check ('yt-dlp[default]==' + $requiredYtDlpVersion)
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; the Chrome host was not registered.' }
}
& $python -c "import sys,yt_dlp.version; assert sys.prefix != sys.base_prefix; assert sys.version_info >= (3,11); assert yt_dlp.version.__version__ == '$requiredYtDlpVersion', yt_dlp.version.__version__"
if ($LASTEXITCODE -ne 0) { throw 'The isolated Python environment does not contain the pinned yt-dlp version.' }
& $ffmpeg -version *> $null
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg could not run.' }
& $ffprobe -version *> $null
if ($LASTEXITCODE -ne 0) { throw 'FFprobe could not run.' }

# Every deployment gets its own code directory. Rolling back the wrapper never
# mixes old and new Python modules; runtime, .venv and task data are untouched.
$deployment = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$appRoot = Assert-ChildPath (Join-Path $installation ('app\' + $deployment)) $installation
$dataRoot = Assert-ChildPath (Join-Path $installation 'data') $installation
$backupRoot = Assert-ChildPath (Join-Path $installation ('backups\' + $deployment)) $installation
$manifestPath = Assert-ChildPath (Join-Path $installation ($hostName + '.json')) $installation
$wrapperPath = Assert-ChildPath (Join-Path $installation 'host.cmd') $installation
New-Item -ItemType Directory -Path $appRoot, $dataRoot, $backupRoot -Force | Out-Null
$sourcePrefix = [System.IO.Path]::GetFullPath($sourceNative).TrimEnd('\') + '\'
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceNative -File -Recurse | Where-Object {
    $_.Extension -eq '.py' -and $_.Name -notlike 'test_*.py' -and $_.FullName -notmatch '[\\/](tests|__pycache__)[\\/]'
})
foreach ($file in $sourceFiles) {
    if ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Native source files may not be reparse points.' }
    $relative = $file.FullName.Substring($sourcePrefix.Length)
    $destination = Assert-ChildPath (Join-Path $appRoot $relative) $appRoot
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination
}
$configPath = Join-Path $appRoot 'runtime-config.json'
$config = [ordered]@{
    python = $python
    ffmpeg = $ffmpeg
    ffprobe = $ffprobe
    node = $node
    data_dir = $dataRoot
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
    yt_dlp_version = $requiredYtDlpVersion
}
Write-Utf8 $configPath ($config | ConvertTo-Json -Depth 5)
$entry = Join-Path $appRoot 'host.py'
$wrapper = "@echo off`r`nsetlocal DisableDelayedExpansion`r`nchcp 65001 >nul`r`n`"$python`" -u `"$entry`" %*`r`nexit /b %errorlevel%`r`n"
$manifest = [ordered]@{ name = $hostName; description = 'Yangmo local video download engine'; path = $wrapperPath; type = 'stdio'; allowed_origins = @('chrome-extension://' + $ExtensionId + '/') }
$hadRegistry = Test-Path -LiteralPath $registryPath
$previousValue = if ($hadRegistry) { (Get-Item -LiteralPath $registryPath).GetValue('') } else { $null }
$hadWrapper = Test-Path -LiteralPath $wrapperPath -PathType Leaf
$hadManifest = Test-Path -LiteralPath $manifestPath -PathType Leaf
if ($hadWrapper) { Copy-Item -LiteralPath $wrapperPath -Destination (Join-Path $backupRoot 'host.cmd') }
if ($hadManifest) { Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $backupRoot ($hostName + '.json')) }
Write-Utf8 (Join-Path $backupRoot 'registration.json') ([ordered]@{ existed = $hadRegistry; value = $previousValue; installed_manifest = $manifestPath; extension_id = $ExtensionId } | ConvertTo-Json)

try {
    Write-Utf8 $wrapperPath $wrapper
    Write-Utf8 $manifestPath ($manifest | ConvertTo-Json -Depth 4)
    New-Item -Path $registryPath -Force | Out-Null
    Set-Item -LiteralPath $registryPath -Value $manifestPath
    if ((Get-Item -LiteralPath $registryPath).GetValue('') -ne $manifestPath) { throw 'Registry verification failed.' }
} catch {
    # Restore only paths owned by this installation, and only our registration.
    $current = if (Test-Path -LiteralPath $registryPath) { (Get-Item -LiteralPath $registryPath).GetValue('') } else { $null }
    if ($current -eq $manifestPath) {
        if ($hadRegistry) { Set-Item -LiteralPath $registryPath -Value $previousValue }
        else { Remove-Item -LiteralPath $registryPath }
    }
    if ($hadWrapper) { Copy-Item -LiteralPath (Join-Path $backupRoot 'host.cmd') -Destination $wrapperPath -Force }
    if ($hadManifest) { Copy-Item -LiteralPath (Join-Path $backupRoot ($hostName + '.json')) -Destination $manifestPath -Force }
    throw
}

[pscustomobject]@{
    HostName = $hostName
    ExtensionId = $ExtensionId
    InstallRoot = $installation
    HostManifest = $manifestPath
    RuntimeConfig = $configPath
    Python = $python
    Backup = $backupRoot
    Note = 'Installed for the current Windows user. Chrome starts the host on demand; no startup service was added.'
}
