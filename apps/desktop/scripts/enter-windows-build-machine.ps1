[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
$policyPath = Join-Path $repoRoot "toolchains\windows-x64-build-machine.json"
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$buildRoot = [System.IO.Path]::GetFullPath([string]$policy.installRoot)

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch "AMD64") {
  throw "The Teti Windows build environment requires Windows x64."
}

$nodeRoot = Join-Path $buildRoot "tools\node\$($policy.node.version)"
$node = Get-ChildItem -LiteralPath $nodeRoot -Filter "node.exe" -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1
$perlRoot = Join-Path $buildRoot "tools\perl\$($policy.perl.distributionVersion)"
$perl = Get-ChildItem -LiteralPath $perlRoot -Filter "perl.exe" -File -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "[\\/]perl[\\/]bin[\\/]perl\.exe$" } |
  Select-Object -First 1
$nasmRoot = Join-Path $buildRoot "tools\nasm\$($policy.nasm.version)"
$nasm = Get-ChildItem -LiteralPath $nasmRoot -Filter "nasm.exe" -File -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1
$cargoHome = Join-Path $buildRoot "cargo"
$rustupHome = Join-Path $buildRoot "rustup"
$vsDevCmd = Join-Path ([string]$policy.visualStudio.installPath) "Common7\Tools\VsDevCmd.bat"
$cmakeRoot = Join-Path ([string]$policy.visualStudio.installPath) "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin"

foreach ($required in @($node, $perl, $nasm)) {
  if (-not $required) {
    throw "The pinned Teti Windows build tools are incomplete. Run windows-build-machine.ps1 -Action Bootstrap."
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $cargoHome "bin\rustup.exe") -PathType Leaf)) {
  throw "The pinned Teti Rust toolchain is missing. Run windows-build-machine.ps1 -Action Bootstrap."
}
if (-not (Test-Path -LiteralPath (Join-Path $cargoHome "config.toml") -PathType Leaf)) {
  throw "The pinned Teti Cargo registry configuration is missing. Run windows-build-machine.ps1 -Action Bootstrap."
}
if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
  throw "The pinned Visual Studio Build Tools installation is missing."
}

$command = "call `"$vsDevCmd`" -no_logo -arch=amd64 -host_arch=amd64 >nul && set"
$environmentLines = & $env:ComSpec /d /s /c $command
if ($LASTEXITCODE -ne 0) {
  throw "VsDevCmd failed with exit code $LASTEXITCODE."
}
foreach ($line in $environmentLines) {
  if ($line.StartsWith("=")) { continue }
  $separator = $line.IndexOf("=")
  if ($separator -le 0) { continue }
  $name = $line.Substring(0, $separator)
  $value = $line.Substring($separator + 1)
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

$toolPaths = @(
  $node.DirectoryName,
  (Join-Path $cargoHome "bin"),
  $perl.DirectoryName,
  (Join-Path $perlRoot "c\bin"),
  $nasm.DirectoryName,
  $cmakeRoot
)
$existingPaths = $env:Path -split ";" | Where-Object { $_ }
$env:Path = (@($toolPaths | Where-Object { Test-Path -LiteralPath $_ }) + $existingPaths |
  Select-Object -Unique) -join ";"
$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
$env:RUSTUP_TOOLCHAIN = [string]$policy.rust.toolchain
$env:CARGO_INCREMENTAL = "0"
$env:CARGO_HTTP_MULTIPLEXING = "false"
$env:CARGO_HTTP_TIMEOUT = "600"
$env:CARGO_NET_RETRY = "10"
$env:SOURCE_DATE_EPOCH = [string]$policy.deltaChat.sourceDateEpoch
$env:TETI_CHATMAIL_CORE_CHECKOUT = Join-Path $buildRoot "sources\chatmail-core"
$env:TETI_WINDOWS_BUILD_POLICY_ID = [string]$policy.policyId

# Strawberry Perl on Windows uses the native Windows locale. POSIX locale
# variables injected by Unix-oriented parent processes cause noisy fallback
# warnings and can make tool output host-dependent.
foreach ($localeVariable in @("LANG", "LC_ALL", "LC_CTYPE", "LC_NUMERIC", "LC_COLLATE", "LC_TIME", "LC_MONETARY")) {
  Remove-Item -LiteralPath "Env:$localeVariable" -ErrorAction SilentlyContinue
}

Write-Host "Entered $($policy.policyId): Node $($policy.node.version), Rust $($policy.rust.version) MSVC, DeltaChat $($policy.deltaChat.version)."
