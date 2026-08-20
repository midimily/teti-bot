[CmdletBinding()]
param(
  [ValidateSet("Bootstrap", "Hydrate", "Verify")]
  [string]$Action = "Verify",
  [switch]$SkipVisualStudio,
  [switch]$SkipRpcBuild,
  [string]$EvidencePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$policyPath = Join-Path $repoRoot "toolchains\windows-x64-build-machine.json"
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$buildRoot = [System.IO.Path]::GetFullPath([string]$policy.installRoot)
$downloadsRoot = Join-Path $buildRoot "downloads"
$nodeArchive = Join-Path $downloadsRoot ([string]$policy.node.archiveFileName)
$nodeRoot = Join-Path $buildRoot "tools\node\$($policy.node.version)"
$nodeDirectoryName = [System.IO.Path]::GetFileNameWithoutExtension([string]$policy.node.archiveFileName)
$node = Join-Path $nodeRoot "$nodeDirectoryName\node.exe"
$npm = Join-Path $nodeRoot "$nodeDirectoryName\npm.cmd"
$perlArchive = Join-Path $downloadsRoot ([string]$policy.perl.archiveFileName)
$perlRoot = Join-Path $buildRoot "tools\perl\$($policy.perl.distributionVersion)"
$perl = Join-Path $perlRoot "perl\bin\perl.exe"
$nasmArchive = Join-Path $downloadsRoot ([string]$policy.nasm.archiveFileName)
$nasmRoot = Join-Path $buildRoot "tools\nasm\$($policy.nasm.version)"
$nasmDirectoryName = [string]$policy.nasm.extractedDirectoryName
$nasm = Join-Path $nasmRoot "$nasmDirectoryName\nasm.exe"
$rustupInstaller = Join-Path $downloadsRoot ([string]$policy.rustup.fileName)
$cargoHome = Join-Path $buildRoot "cargo"
$rustupHome = Join-Path $buildRoot "rustup"
$rustup = Join-Path $cargoHome "bin\rustup.exe"
$cargoConfigSource = Join-Path $repoRoot ([string]$policy.cargo.configFile)
$cargoConfig = Join-Path $cargoHome "config.toml"
$visualStudioBootstrapper = Join-Path $downloadsRoot ([string]$policy.visualStudio.bootstrapperFileName)
$coreCheckout = Join-Path $buildRoot "sources\chatmail-core"
$builtRpc = Join-Path $coreCheckout "target\release\$($policy.deltaChat.fileName)"

function Assert-WindowsX64 {
  if ($env:OS -ne "Windows_NT" -or
      -not [Environment]::Is64BitOperatingSystem -or
      $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    throw "The reproducible Teti build machine requires Windows x64."
  }
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is missing."
  }
}

function Assert-ManagedPath([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $prefix = $buildRoot.TrimEnd("\") + "\"
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the dedicated Teti build root: $full"
  }
}

function Remove-ManagedDirectory([string]$Path) {
  Assert-ManagedPath $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "$Label SHA-256 mismatch. Expected $Expected, got $actual."
  }
}

function Get-NormalizedUtf8Sha256([string]$Path) {
  $source = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
  if ($source -match "`r(?!`n)") {
    throw "Text input contains unsupported lone CR line endings: $Path"
  }
  $normalized = $source.Replace("`r`n", "`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($normalized)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-PinnedDownload([string]$Uri, [string]$Destination, [string]$Sha256, [string]$Label) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    try {
      Assert-Sha256 $Destination $Sha256 $Label
      return
    } catch {
      Remove-Item -LiteralPath $Destination -Force
    }
  }
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($Destination)) -Force | Out-Null
  $temporary = "$Destination.download"
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $temporary
  try {
    Assert-Sha256 $temporary $Sha256 $Label
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Expand-PinnedArchive(
  [string]$Archive,
  [string]$Destination,
  [string]$ArchiveSha256,
  [string]$RequiredFile
) {
  $marker = Join-Path $Destination ".teti-source.json"
  if ((Test-Path -LiteralPath $marker -PathType Leaf) -and (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
    try {
      $source = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ([string]$source.sha256 -eq $ArchiveSha256) { return }
    } catch {
      # Re-extract below.
    }
  }
  Remove-ManagedDirectory $Destination
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
  [ordered]@{
    schemaVersion = 1
    archive = [System.IO.Path]::GetFileName($Archive)
    sha256 = $ArchiveSha256
  } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8
  if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
    throw "Pinned archive did not contain the expected file: $RequiredFile"
  }
}

function Install-PortableTools {
  Get-PinnedDownload $policy.node.archiveUrl $nodeArchive $policy.node.archiveSha256 "Node archive"
  Expand-PinnedArchive $nodeArchive $nodeRoot $policy.node.archiveSha256 $node
  Assert-Sha256 $node $policy.node.runtimeSha256 "Extracted Node runtime"

  Get-PinnedDownload $policy.perl.archiveUrl $perlArchive $policy.perl.archiveSha256 "Strawberry Perl archive"
  Expand-PinnedArchive $perlArchive $perlRoot $policy.perl.archiveSha256 $perl

  Get-PinnedDownload $policy.nasm.archiveUrl $nasmArchive $policy.nasm.archiveSha256 "NASM archive"
  Expand-PinnedArchive $nasmArchive $nasmRoot $policy.nasm.archiveSha256 $nasm
}

function Install-PinnedRust {
  Get-PinnedDownload $policy.rustup.url $rustupInstaller $policy.rustup.sha256 "rustup-init"
  $env:CARGO_HOME = $cargoHome
  $env:RUSTUP_HOME = $rustupHome
  if (Test-Path -LiteralPath $rustup -PathType Leaf) {
    $installed = (& $rustup --version 2>&1 | Select-Object -First 1) -join ""
    if ($installed -notmatch "rustup $([regex]::Escape([string]$policy.rustup.version))") {
      Remove-ManagedDirectory $cargoHome
      Remove-ManagedDirectory $rustupHome
    }
  }
  if (-not (Test-Path -LiteralPath $rustup -PathType Leaf)) {
    Invoke-Checked $rustupInstaller @(
      "-y",
      "--no-modify-path",
      "--profile", "minimal",
      "--default-host", [string]$policy.rust.host,
      "--default-toolchain", "none"
    )
  }
  Invoke-Checked $rustup @("set", "auto-self-update", "disable")
  $arguments = @("toolchain", "install", [string]$policy.rust.toolchain, "--profile", [string]$policy.rust.profile)
  foreach ($component in $policy.rust.components) {
    $arguments += @("--component", [string]$component)
  }
  Invoke-Checked $rustup $arguments

  $sourceHash = Get-NormalizedUtf8Sha256 $cargoConfigSource
  if ($sourceHash -ne [string]$policy.cargo.configSha256) {
    throw "Committed Cargo configuration does not match the pinned build-machine policy."
  }
  $cargoConfigText = [IO.File]::ReadAllText($cargoConfigSource, [Text.UTF8Encoding]::new($false)).Replace("`r`n", "`n")
  [IO.File]::WriteAllText($cargoConfig, $cargoConfigText, [Text.UTF8Encoding]::new($false))
}

function Get-VsWherePath {
  $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  return Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
}

function Get-PinnedVisualStudioInstance {
  $vswhere = Get-VsWherePath
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { return $null }
  $arguments = @("-products", [string]$policy.visualStudio.productId, "-requires")
  $arguments += @($policy.visualStudio.components | ForEach-Object { [string]$_ })
  $arguments += @("-format", "json", "-utf8")
  $json = (& $vswhere @arguments 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
  $instances = @($json | ConvertFrom-Json)
  return $instances | Where-Object {
    [string]$_.installationVersion -eq [string]$policy.visualStudio.installationVersion -and
    [System.IO.Path]::GetFullPath([string]$_.installationPath).TrimEnd("\") -eq
      [System.IO.Path]::GetFullPath([string]$policy.visualStudio.installPath).TrimEnd("\")
  } | Select-Object -First 1
}

function Install-PinnedVisualStudio {
  if (Get-PinnedVisualStudioInstance) { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Visual Studio Build Tools installation requires an elevated PowerShell session."
  }
  Get-PinnedDownload $policy.visualStudio.bootstrapperUrl $visualStudioBootstrapper `
    $policy.visualStudio.bootstrapperSha256 "Visual Studio Build Tools bootstrapper"
  $arguments = @(
    "--quiet", "--wait", "--norestart", "--nocache",
    "--installPath", [string]$policy.visualStudio.installPath,
    "--channelId", [string]$policy.visualStudio.channelId,
    "--productId", [string]$policy.visualStudio.productId,
    "--addProductLang", "en-US"
  )
  foreach ($component in $policy.visualStudio.components) {
    $arguments += @("--add", [string]$component)
  }
  $process = Start-Process -FilePath $visualStudioBootstrapper -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "Visual Studio Build Tools installer exited with code $($process.ExitCode)."
  }
  if (-not (Get-PinnedVisualStudioInstance)) {
    throw "Visual Studio Build Tools did not install the exact required instance and component set."
  }
  if ($process.ExitCode -eq 3010) {
    Write-Warning "Visual Studio Build Tools requested a reboot. Reboot before producing release evidence."
  }
}

function Invoke-Checked([string]$File, [object[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File exited with code $LASTEXITCODE."
  }
}

function Hydrate-RepositoryRuntime {
  Assert-Sha256 $node $policy.node.runtimeSha256 "Pinned build-machine Node runtime"
  if (-not (Test-Path -LiteralPath $builtRpc -PathType Leaf)) {
    throw "The pinned DeltaChat RPC has not been built at $builtRpc. Run Bootstrap without -SkipRpcBuild."
  }
  $runtimeNode = Join-Path $repoRoot ".tools\node\win-x64\$($policy.node.version)\node.exe"
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($runtimeNode)) -Force | Out-Null
  Copy-Item -LiteralPath $node -Destination $runtimeNode -Force
  $stageScript = Join-Path $repoRoot "apps\desktop\scripts\windows-runtime-cli.ts"
  Invoke-Checked $node @(
    "--experimental-strip-types", $stageScript, "stage-rpc",
    "--path", $builtRpc,
    "--revision", [string]$policy.deltaChat.revision
  )
}

function Invoke-Captured([string]$File, [object[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf) -and -not (Get-Command $File -ErrorAction SilentlyContinue)) {
    return [pscustomobject]@{ ok = $false; output = "missing"; exitCode = $null }
  }
  try {
    $output = (& $File @Arguments 2>&1 | Out-String).Trim()
    return [pscustomobject]@{ ok = ($LASTEXITCODE -eq 0); output = $output; exitCode = $LASTEXITCODE }
  } catch {
    return [pscustomobject]@{ ok = $false; output = $_.Exception.Message; exitCode = $null }
  }
}

function Verify-BuildMachine {
  $failures = [Collections.Generic.List[string]]::new()
  $checks = [ordered]@{}
  function Add-Check([string]$Name, [bool]$Ok, $Actual, $Expected) {
    $checks[$Name] = [ordered]@{ ok = $Ok; actual = $Actual; expected = $Expected }
    if (-not $Ok) { $failures.Add("$Name does not match the pinned build-machine policy.") }
  }

  $policySha = (Get-FileHash -LiteralPath $policyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $osInfo = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
  $osBuild = [int]$osInfo.CurrentBuildNumber
  Add-Check "windows" ([Environment]::Is64BitOperatingSystem -and $osBuild -ge [int]$policy.os.minimumBuild -and
    [string]$osInfo.InstallationType -eq "Client" -and $env:PROCESSOR_ARCHITECTURE -eq "AMD64") `
    ([ordered]@{ productName = $osInfo.ProductName; displayVersion = $osInfo.DisplayVersion; build = $osBuild; architecture = $env:PROCESSOR_ARCHITECTURE }) `
    ([ordered]@{ product = $policy.os.product; minimumBuild = $policy.os.minimumBuild; architecture = "AMD64" })

  $nodeHash = if (Test-Path -LiteralPath $node -PathType Leaf) {
    (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
  } else { "missing" }
  Add-Check "nodeSha256" ($nodeHash -eq [string]$policy.node.runtimeSha256) $nodeHash $policy.node.runtimeSha256
  $nodeVersion = Invoke-Captured $node @("--version")
  Add-Check "nodeVersion" ($nodeVersion.ok -and $nodeVersion.output -eq "v$($policy.node.version)") $nodeVersion.output "v$($policy.node.version)"
  $npmVersion = Invoke-Captured $npm @("--version")
  Add-Check "npmVersion" ($npmVersion.ok -and $npmVersion.output -eq [string]$policy.node.npmVersion) $npmVersion.output $policy.node.npmVersion
  foreach ($archiveCheck in @(
    @("nodeArchive", $nodeArchive, $policy.node.archiveSha256),
    @("perlArchive", $perlArchive, $policy.perl.archiveSha256),
    @("nasmArchive", $nasmArchive, $policy.nasm.archiveSha256),
    @("rustupInstaller", $rustupInstaller, $policy.rustup.sha256),
    @("visualStudioBootstrapper", $visualStudioBootstrapper, $policy.visualStudio.bootstrapperSha256)
  )) {
    $actual = if (Test-Path -LiteralPath $archiveCheck[1] -PathType Leaf) {
      (Get-FileHash -LiteralPath $archiveCheck[1] -Algorithm SHA256).Hash.ToLowerInvariant()
    } else { "missing" }
    Add-Check $archiveCheck[0] ($actual -eq [string]$archiveCheck[2]) $actual $archiveCheck[2]
  }

  $env:CARGO_HOME = $cargoHome
  $env:RUSTUP_HOME = $rustupHome
  $rustupVersion = Invoke-Captured $rustup @("--version")
  Add-Check "rustupVersion" ($rustupVersion.ok -and $rustupVersion.output -match "rustup $([regex]::Escape([string]$policy.rustup.version))") `
    ($rustupVersion.output -split "`n" | Select-Object -First 1) "rustup $($policy.rustup.version)"
  $rustcVersion = Invoke-Captured $rustup @("run", [string]$policy.rust.toolchain, "rustc", "--version")
  Add-Check "rustcVersion" ($rustcVersion.ok -and $rustcVersion.output -match "^rustc $([regex]::Escape([string]$policy.rust.version)) ") `
    $rustcVersion.output "rustc $($policy.rust.version) ($($policy.rust.host))"
  $cargoVersion = Invoke-Captured $rustup @("run", [string]$policy.rust.toolchain, "cargo", "--version")
  Add-Check "cargoVersion" ($cargoVersion.ok -and $cargoVersion.output -match "^cargo $([regex]::Escape([string]$policy.rust.version)) ") `
    $cargoVersion.output "cargo $($policy.rust.version)"
  $cargoConfigHash = if (Test-Path -LiteralPath $cargoConfig -PathType Leaf) {
    Get-NormalizedUtf8Sha256 $cargoConfig
  } else { "missing" }
  Add-Check "cargoRegistryConfig" ($cargoConfigHash -eq [string]$policy.cargo.configSha256) `
    $cargoConfigHash $policy.cargo.configSha256

  $instance = Get-PinnedVisualStudioInstance
  Add-Check "visualStudio" ($null -ne $instance) `
    $(if ($instance) { [ordered]@{ installationPath = $instance.installationPath; installationVersion = $instance.installationVersion } } else { "missing" }) `
    ([ordered]@{ installationPath = $policy.visualStudio.installPath; installationVersion = $policy.visualStudio.installationVersion })
  $toolset = Get-ChildItem -LiteralPath (Join-Path ([string]$policy.visualStudio.installPath) "VC\Tools\MSVC") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith([string]$policy.visualStudio.msvcToolsetPrefix) } |
    Sort-Object Name -Descending | Select-Object -First 1
  $cl = if ($toolset) { Join-Path $toolset.FullName "bin\Hostx64\x64\cl.exe" } else { "missing" }
  $clVersion = Invoke-Captured $cl @()
  Add-Check "msvc" ($clVersion.ok -and $clVersion.output -match "Version $([regex]::Escape([string]$policy.visualStudio.compilerVersionPrefix))") `
    ([ordered]@{ toolset = $(if ($toolset) { $toolset.Name } else { "missing" }); compiler = $clVersion.output }) `
    ([ordered]@{ toolsetPrefix = $policy.visualStudio.msvcToolsetPrefix; compilerVersionPrefix = $policy.visualStudio.compilerVersionPrefix })
  $sdkPath = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)) "Windows Kits\10\Lib\$($policy.windowsSdk.version)"
  Add-Check "windowsSdk" (Test-Path -LiteralPath $sdkPath -PathType Container) $sdkPath $policy.windowsSdk.version
  $cmake = Join-Path ([string]$policy.visualStudio.installPath) "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  $cmakeVersion = Invoke-Captured $cmake @("--version")
  $cmakeFirstLine = $cmakeVersion.output -split "`n" | Select-Object -First 1
  $expectedCmakePrefix = "cmake version $($policy.cmake.version)"
  Add-Check "cmakeVersion" ($cmakeVersion.ok -and
    $cmakeFirstLine.TrimEnd("`r").StartsWith($expectedCmakePrefix, [StringComparison]::Ordinal)) `
    $cmakeFirstLine $expectedCmakePrefix

  $perlVersion = Invoke-Captured $perl @("-e", "print `$^V")
  $perlVersionLine = $perlVersion.output -split "`n" | Select-Object -Last 1
  $perlVersionLine = $perlVersionLine.Trim()
  Add-Check "perlVersion" ($perlVersion.ok -and $perlVersionLine -eq "v$($policy.perl.runtimeVersion)") `
    $perlVersionLine "v$($policy.perl.runtimeVersion)"
  $nasmVersion = Invoke-Captured $nasm @("-v")
  Add-Check "nasmVersion" ($nasmVersion.ok -and $nasmVersion.output -match "NASM version $([regex]::Escape([string]$policy.nasm.version))") `
    $nasmVersion.output "NASM version $($policy.nasm.version)"
  $git = Get-Command git -ErrorAction SilentlyContinue
  $gitVersion = if ($git) { Invoke-Captured $git.Source @("--version") } else { [pscustomobject]@{ ok = $false; output = "missing" } }
  Add-Check "git" $gitVersion.ok $gitVersion.output "git available; checkout content is hash-verified"

  $sourceRevision = if ($git -and (Test-Path -LiteralPath $coreCheckout -PathType Container)) {
    (Invoke-Captured $git.Source @("-C", $coreCheckout, "rev-parse", "HEAD")).output
  } else { "missing" }
  Add-Check "deltaChatRevision" ($sourceRevision -eq [string]$policy.deltaChat.revision) $sourceRevision $policy.deltaChat.revision
  $sourceLock = Join-Path $coreCheckout "Cargo.lock"
  $sourceLockHash = if (Test-Path -LiteralPath $sourceLock -PathType Leaf) {
    Get-NormalizedUtf8Sha256 $sourceLock
  } else { "missing" }
  Add-Check "deltaChatCargoLock" ($sourceLockHash -eq [string]$policy.deltaChat.cargoLockSha256) $sourceLockHash $policy.deltaChat.cargoLockSha256
  $rpcVersion = Invoke-Captured $builtRpc @("--version")
  Add-Check "deltaChatRpcVersion" ($rpcVersion.ok -and $rpcVersion.output -eq [string]$policy.deltaChat.version) $rpcVersion.output $policy.deltaChat.version

  $runtimeVerifier = Join-Path $repoRoot "apps\desktop\scripts\windows-runtime-cli.ts"
  $runtimeResult = Invoke-Captured $node @("--experimental-strip-types", $runtimeVerifier, "verify")
  Add-Check "repositoryRuntime" $runtimeResult.ok $runtimeResult.output "verified Node and DeltaChat repository Runtime"
  $rpcVerifier = Join-Path $repoRoot "apps\desktop\scripts\rpc.ts"
  $rpcResult = Invoke-Captured $node @("--experimental-strip-types", $rpcVerifier, "verify")
  Add-Check "deltaChatJsonRpcHealth" $rpcResult.ok $rpcResult.output "version, JSON-RPC health, and clean shutdown"

  $report = [ordered]@{
    schemaVersion = 1
    policyId = $policy.policyId
    policySha256 = $policySha
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    ok = ($failures.Count -eq 0)
    checks = $checks
    errors = @($failures)
  }
  $json = $report | ConvertTo-Json -Depth 12
  $resolvedEvidencePath = if ($EvidencePath) {
    [System.IO.Path]::GetFullPath($EvidencePath)
  } else {
    Join-Path $buildRoot "evidence\windows-x64-build-machine.json"
  }
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolvedEvidencePath)) -Force | Out-Null
  Set-Content -LiteralPath $resolvedEvidencePath -Value $json -Encoding utf8
  Write-Output $json
  if ($failures.Count -gt 0) { exit 1 }
}

Assert-WindowsX64

switch ($Action) {
  "Bootstrap" {
    New-Item -ItemType Directory -Path $downloadsRoot -Force | Out-Null
    Install-PortableTools
    Install-PinnedRust
    if (-not $SkipVisualStudio) { Install-PinnedVisualStudio }
    if ($SkipRpcBuild) {
      Write-Warning "Portable tools were installed, but the DeltaChat RPC build and final verification were skipped."
      break
    }
    . (Join-Path $PSScriptRoot "enter-windows-build-machine.ps1")
    Assert-Command "git"
    Invoke-Checked $npm @("ci", "--prefix", (Join-Path $repoRoot "apps\desktop"))
    Invoke-Checked $npm @("--prefix", $repoRoot, "run", "desktop:rpc:install")
    Hydrate-RepositoryRuntime
    Verify-BuildMachine
    break
  }
  "Hydrate" {
    . (Join-Path $PSScriptRoot "enter-windows-build-machine.ps1")
    Hydrate-RepositoryRuntime
    Verify-BuildMachine
    break
  }
  "Verify" {
    Verify-BuildMachine
    break
  }
}
