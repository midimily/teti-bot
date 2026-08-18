[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Clean", "Upgrade")]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [string]$CurrentInstaller,

  [string]$PreviousInstaller,
  [string]$EvidencePath,
  [switch]$RequireMissingWebView2
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  throw "The Teti installer exit gate requires a real Windows x64 machine."
}
if ($Scenario -eq "Upgrade" -and [string]::IsNullOrWhiteSpace($PreviousInstaller)) {
  throw "Upgrade validation requires -PreviousInstaller."
}

$ExpectedThumbprint = ($env:TETI_WINDOWS_CERTIFICATE_SHA1 -replace '[\s:]', '').ToUpperInvariant()
if ($ExpectedThumbprint -notmatch '^[0-9A-F]{40}$') {
  throw "TETI_WINDOWS_CERTIFICATE_SHA1 must contain the release certificate thumbprint."
}
$AppLocalRoot = Join-Path $env:LOCALAPPDATA "bot.teti.app"
$ProfileRoot = Join-Path $AppLocalRoot "profile"
$LocalePreference = Join-Path $ProfileRoot "preferences\locale.json"
$ProfileSentinel = Join-Path $ProfileRoot "m6-upgrade-preservation.json"
$Evidence = [ordered]@{
  schemaVersion = 1
  scenario = $Scenario
  startedAt = [DateTime]::UtcNow.ToString("o")
  windows = [Environment]::OSVersion.VersionString
  currentUserInstall = $false
  webView2WasMissing = $false
  repairPassed = $false
  runtimeSmokePassed = $false
  profilePreserved = $false
  languagePreferencePreserved = $false
  uninstallPreservedState = $false
  stages = @()
}

function Add-Stage([string]$Name, [string]$Result) {
  $script:Evidence.stages += [ordered]@{
    name = $Name
    result = $Result
    occurredAt = [DateTime]::UtcNow.ToString("o")
  }
}

function Assert-SignedPe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing PE artifact: $Path" }
  $Signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid Authenticode signature: $Path ($($Signature.Status))"
  }
  if (($Signature.SignerCertificate.Thumbprint -replace '[\s:]', '').ToUpperInvariant() -ne $ExpectedThumbprint) {
    throw "Unexpected Authenticode signer: $Path"
  }
  if ($null -eq $Signature.TimeStamperCertificate) { throw "Missing Authenticode timestamp: $Path" }
}

function Get-TetiUninstallEntry {
  $Entries = @(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "Teti" })
  if ($Entries.Count -gt 1) { throw "More than one per-user Teti uninstall entry exists." }
  if ($Entries.Count -eq 0) { return $null }
  return $Entries[0]
}

function Get-WebView2Version {
  $Client = "{F3017226-5E20-429F-9AFB-3064D3B52C7D}"
  foreach ($Path in @(
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$Client",
    "HKLM:\Software\Microsoft\EdgeUpdate\Clients\$Client",
    "HKLM:\Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\$Client"
  )) {
    $Value = (Get-ItemProperty -LiteralPath $Path -Name "pv" -ErrorAction SilentlyContinue).pv
    if (-not [string]::IsNullOrWhiteSpace($Value) -and $Value -ne "0.0.0.0") { return [string]$Value }
  }
  return $null
}

function Invoke-Installer([string]$Path) {
  Assert-SignedPe $Path
  $Process = Start-Process -FilePath (Resolve-Path -LiteralPath $Path) -ArgumentList "/S" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "NSIS installer failed with exit code $($Process.ExitCode)." }
}

function Resolve-InstallState {
  $Entry = Get-TetiUninstallEntry
  if ($null -eq $Entry) { throw "Teti did not create a per-user uninstall entry." }
  $InstallRoot = [string]$Entry.InstallLocation
  if ([string]::IsNullOrWhiteSpace($InstallRoot) -or -not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    throw "Teti per-user install location is missing."
  }
  $ExpectedPrefix = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
  if (-not [IO.Path]::GetFullPath($InstallRoot).StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Teti was not installed below the current user's LocalAppData."
  }
  $Application = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "teti-desktop.exe" | Select-Object -First 1
  $Uninstaller = Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Filter "uninstall.exe" | Select-Object -First 1
  if ($null -eq $Application -or $null -eq $Uninstaller) { throw "Installed application or uninstaller is missing." }
  return [ordered]@{ Entry = $Entry; Root = $InstallRoot; Application = $Application.FullName; Uninstaller = $Uninstaller.FullName }
}

function Assert-InstalledPeInventory([string]$InstallRoot) {
  $Artifacts = @(Get-ChildItem -LiteralPath $InstallRoot -Recurse -File |
    Where-Object { $_.Extension -in @(".exe", ".dll") })
  if ($Artifacts.Count -lt 4) { throw "Installed PE inventory is unexpectedly incomplete." }
  foreach ($Artifact in $Artifacts) { Assert-SignedPe $Artifact.FullName }
  Add-Stage "installed-pe-inventory" "$($Artifacts.Count) signed artifacts"
}

function Invoke-RuntimeSmoke($State) {
  $ApplicationProcess = Start-Process -FilePath $State.Application -PassThru
  $Deadline = [DateTime]::UtcNow.AddSeconds(60)
  $RuntimeFound = $false
  do {
    Start-Sleep -Milliseconds 500
    $RuntimeProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        ($_.Name -in @("node.exe", "deltachat-rpc-server.exe")) -and
        (($_.ExecutablePath -like "$($State.Root)*") -or ($_.CommandLine -like "*$($State.Root)*"))
      })
    $HasNode = @($RuntimeProcesses | Where-Object { $_.Name -eq "node.exe" }).Count -gt 0
    $HasRpc = @($RuntimeProcesses | Where-Object { $_.Name -eq "deltachat-rpc-server.exe" }).Count -gt 0
    $RuntimeFound = $HasNode -and $HasRpc
  } until ($RuntimeFound -or [DateTime]::UtcNow -ge $Deadline -or $ApplicationProcess.HasExited)
  if (-not $RuntimeFound) {
    if (-not $ApplicationProcess.HasExited) { Stop-Process -Id $ApplicationProcess.Id -Force }
    throw "Teti Runtime descendants did not reach Node + JSON-RPC health."
  }
  Stop-Process -Id $ApplicationProcess.Id -Force -ErrorAction SilentlyContinue
  $ApplicationProcess.WaitForExit(10000) | Out-Null
  Start-Sleep -Seconds 2
  $Survivors = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      ($_.Name -in @("node.exe", "deltachat-rpc-server.exe")) -and
      (($_.ExecutablePath -like "$($State.Root)*") -or ($_.CommandLine -like "*$($State.Root)*"))
    })
  if ($Survivors.Count -ne 0) { throw "A Teti Runtime descendant survived application exit." }
  $script:Evidence.runtimeSmokePassed = $true
  Add-Stage "runtime-smoke" "Node and JSON-RPC healthy; zero surviving descendants"
}

function Write-PreservationState {
  New-Item -ItemType Directory -Path (Split-Path -Parent $LocalePreference) -Force | Out-Null
  [IO.File]::WriteAllText($LocalePreference, '{"schemaVersion":1,"preference":"zh-Hans"}', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($ProfileSentinel, '{"schemaVersion":1,"owner":"m6-installer-smoke"}', [Text.UTF8Encoding]::new($false))
  return [ordered]@{
    Locale = (Get-FileHash -Algorithm SHA256 -LiteralPath $LocalePreference).Hash
    Sentinel = (Get-FileHash -Algorithm SHA256 -LiteralPath $ProfileSentinel).Hash
  }
}

function Assert-PreservationState($Hashes) {
  if (-not (Test-Path -LiteralPath $ProfileSentinel -PathType Leaf)) { throw "Profile sentinel was not preserved." }
  if (-not (Test-Path -LiteralPath $LocalePreference -PathType Leaf)) { throw "Language preference was not preserved." }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ProfileSentinel).Hash -ne $Hashes.Sentinel) {
    throw "Profile sentinel changed during installer lifecycle."
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $LocalePreference).Hash -ne $Hashes.Locale) {
    throw "Language preference changed during installer lifecycle."
  }
  $Preference = Get-Content -LiteralPath $LocalePreference -Raw | ConvertFrom-Json
  if ($Preference.schemaVersion -ne 1 -or $Preference.preference -ne "zh-Hans") {
    throw "Language preference schema or value changed."
  }
  $script:Evidence.profilePreserved = $true
  $script:Evidence.languagePreferencePreserved = $true
}

function Invoke-Uninstall($State, $Hashes) {
  Assert-SignedPe $State.Uninstaller
  $Process = Start-Process -FilePath $State.Uninstaller -ArgumentList "/S" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "NSIS uninstaller failed with exit code $($Process.ExitCode)." }
  if ($null -ne (Get-TetiUninstallEntry)) { throw "Per-user uninstall entry survived uninstall." }
  Assert-PreservationState $Hashes
  $script:Evidence.uninstallPreservedState = $true
  Add-Stage "uninstall" "application removed; Profile and language preference preserved"
}

if ($null -ne (Get-TetiUninstallEntry)) { throw "Use a clean VM/user: Teti is already installed." }
if (Test-Path -LiteralPath $AppLocalRoot) { throw "Use a clean VM/user: Teti AppLocalData already exists." }
Assert-SignedPe $CurrentInstaller
if ($Scenario -eq "Upgrade") { Assert-SignedPe $PreviousInstaller }

$WebViewBefore = Get-WebView2Version
$Evidence.webView2WasMissing = [string]::IsNullOrWhiteSpace($WebViewBefore)
if ($RequireMissingWebView2 -and -not $Evidence.webView2WasMissing) {
  throw "This clean-VM gate requires an image without WebView2."
}

if ($Scenario -eq "Clean") {
  Invoke-Installer $CurrentInstaller
  Add-Stage "clean-install" "current installer completed"
} else {
  Invoke-Installer $PreviousInstaller
  Add-Stage "clean-prerelease-install" "previous prerelease completed"
}

$State = Resolve-InstallState
$Evidence.currentUserInstall = $true
if ($Scenario -eq "Clean") { Assert-InstalledPeInventory $State.Root }
Invoke-RuntimeSmoke $State
$Hashes = Write-PreservationState

if ($Scenario -eq "Upgrade") {
  Invoke-Installer $CurrentInstaller
  $State = Resolve-InstallState
  Assert-InstalledPeInventory $State.Root
  Assert-PreservationState $Hashes
  Invoke-RuntimeSmoke $State
  Add-Stage "prerelease-upgrade" "Profile and forced zh-Hans preference preserved"
}

Invoke-Installer $CurrentInstaller
$State = Resolve-InstallState
Assert-PreservationState $Hashes
$Evidence.repairPassed = $true
Add-Stage "repair" "same-version repair preserved state"

if ($Evidence.webView2WasMissing) {
  $WebViewAfter = Get-WebView2Version
  if ([string]::IsNullOrWhiteSpace($WebViewAfter)) { throw "Embedded Evergreen bootstrapper did not install WebView2." }
  Add-Stage "webview2-bootstrap" "Evergreen Runtime installed from missing state"
}

Invoke-Uninstall $State $Hashes
$Evidence["completedAt"] = [DateTime]::UtcNow.ToString("o")
if ([string]::IsNullOrWhiteSpace($EvidencePath)) {
  $EvidencePath = Join-Path (Get-Location) "teti-m6-$($Scenario.ToLowerInvariant())-evidence.json"
}
$EvidenceDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($EvidencePath))
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$Evidence | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
Write-Host "Teti M6 $Scenario installer gate passed. Evidence: $EvidencePath"
