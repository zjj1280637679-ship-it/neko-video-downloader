[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'YangmoNative')
)

$ErrorActionPreference = 'Stop'
$hostName = 'org.yangmo.downloader'
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $hostName
$installation = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$expectedManifest = [System.IO.Path]::GetFullPath((Join-Path $installation ($hostName + '.json')))
if (!(Test-Path -LiteralPath $registryPath)) {
    Write-Output 'The current user has no Yangmo native host registration.'
    return
}
$registered = (Get-Item -LiteralPath $registryPath).GetValue('')
if (!$registered -or ![System.IO.Path]::GetFullPath($registered).Equals($expectedManifest, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'This native host registration belongs to a different installation. Nothing was removed.'
}
Remove-Item -LiteralPath $registryPath
Write-Output 'Removed this installation from Chrome Native Messaging for the current user.'
Write-Output "Application files, dependencies, backups and task data remain in: $installation"
Write-Output 'Saved Chrome downloads were not changed. Active tasks should be cancelled in Yangmo before removing application files.'
