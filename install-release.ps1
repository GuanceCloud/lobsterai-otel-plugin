param(
  [string]$Version,
  [ValidateSet("gtrace", "otlp")][string]$Type,
  [string]$Endpoint,
  [string]$XToken,
  [string]$TracePath,
  [string]$MetricsPath,
  [string]$TracesUrl,
  [string]$MetricsUrl,
  [string[]]$Header = @(),
  [Alias("ResourceAttribute")][string[]]$Tag = @(),
  [ValidateSet("none", "preview", "full")][string]$CaptureContent,
  [ValidateRange(128, 100000)][int]$MaxChars,
  [ValidateRange(1000, 60000)][int]$TimeoutMs,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Debug,
  [switch]$NoDebug,
  [switch]$NoConfig,
  [string]$StateDir,
  [string]$LobsterAiBin,
  [string]$OpenClawEntry,
  [switch]$AllowRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Enable -and $Disable) { throw "-Enable and -Disable are mutually exclusive." }
if ($Debug -and $NoDebug) { throw "-Debug and -NoDebug are mutually exclusive." }
foreach ($Pair in @($Header) + @($Tag)) {
  if (-not $Pair.Contains("=") -or $Pair.IndexOf("=") -eq 0) { throw "Expected non-empty KEY=VALUE: $Pair" }
}

$PluginId = "lobsterai-otel-plugin"
$Repository = if ($env:LOBSTERAI_OTEL_REPOSITORY) { $env:LOBSTERAI_OTEL_REPOSITORY } else { "GuanceCloud/lobsterai-otel-plugin" }
if (-not $PSBoundParameters.ContainsKey("Version")) {
  $Version = if ($env:LOBSTERAI_OTEL_VERSION) { $env:LOBSTERAI_OTEL_VERSION } else { "latest" }
}
if ($Version -ne "latest" -and -not $Version.StartsWith("v")) { $Version = "v$Version" }
if ($Version -ne "latest" -and $Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') {
  throw "Version must be latest or vX.Y.Z."
}

if ($Version -eq "latest") {
  $AssetName = "lobsterai-otel-plugin.tar.gz"
  $BaseUrl = "https://github.com/$Repository/releases/latest/download"
  $ExpectedVersion = $null
} else {
  $AssetName = "lobsterai-otel-plugin-$Version.tar.gz"
  $BaseUrl = "https://github.com/$Repository/releases/download/$Version"
  $ExpectedVersion = $Version.Substring(1)
}
$ArchiveUrl = if ($env:LOBSTERAI_OTEL_ARCHIVE_URL) { $env:LOBSTERAI_OTEL_ARCHIVE_URL } else { "$BaseUrl/$AssetName" }
$ChecksumUrl = if ($env:LOBSTERAI_OTEL_CHECKSUM_URL) { $env:LOBSTERAI_OTEL_CHECKSUM_URL } else { "$BaseUrl/$AssetName.sha256" }

if (-not $AllowRunning -and (Get-Process -Name LobsterAI -ErrorAction SilentlyContinue)) {
  throw "LobsterAI is running. Quit it first, or explicitly pass -AllowRunning."
}
if (-not $LobsterAiBin) {
  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\LobsterAI\LobsterAI.exe"),
    (Join-Path $env:LOCALAPPDATA "LobsterAI\LobsterAI.exe"),
    (Join-Path $env:ProgramFiles "LobsterAI\LobsterAI.exe")
  )
  $LobsterAiBin = $Candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $LobsterAiBin -or -not (Test-Path -LiteralPath $LobsterAiBin -PathType Leaf)) {
  throw "LobsterAI.exe not found; pass -LobsterAiBin."
}
if (-not $OpenClawEntry) { $OpenClawEntry = Join-Path (Split-Path $LobsterAiBin) "resources\cfmind\openclaw.mjs" }
if (-not (Test-Path -LiteralPath $OpenClawEntry -PathType Leaf)) { throw "openclaw.mjs not found; pass -OpenClawEntry." }
if (-not $StateDir) { $StateDir = Join-Path $env:APPDATA "LobsterAI\openclaw\state" }
[IO.Directory]::CreateDirectory($StateDir) | Out-Null

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("lobsterai-otel-plugin-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot $AssetName
$ChecksumPath = "$ArchivePath.sha256"
[IO.Directory]::CreateDirectory($TempRoot) | Out-Null

$OldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$OldStateDir = $env:OPENCLAW_STATE_DIR
try {
  if ($env:LOBSTERAI_OTEL_ARCHIVE_PATH) {
    Copy-Item -LiteralPath $env:LOBSTERAI_OTEL_ARCHIVE_PATH -Destination $ArchivePath
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $ArchivePath
  }
  if ($env:LOBSTERAI_OTEL_CHECKSUM_PATH) {
    Copy-Item -LiteralPath $env:LOBSTERAI_OTEL_CHECKSUM_PATH -Destination $ChecksumPath
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $ChecksumUrl -OutFile $ChecksumPath
  }
  $ExpectedHash = ((Get-Content -LiteralPath $ChecksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
  if (-not $ExpectedHash -or $ExpectedHash -ne $ActualHash) { throw "Checksum verification failed for $AssetName." }

  $TarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $TarCommand) { $TarCommand = Get-Command tar -ErrorAction SilentlyContinue }
  if (-not $TarCommand) { throw "tar is required to validate the plugin package." }
  $PackageJsonText = (& $TarCommand.Source -xOf $ArchivePath package/package.json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Archive does not contain package/package.json." }
  $ManifestJsonText = (& $TarCommand.Source -xOf $ArchivePath package/openclaw.plugin.json | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Archive does not contain package/openclaw.plugin.json." }
  $PackageMetadata = $PackageJsonText | ConvertFrom-Json
  $ManifestMetadata = $ManifestJsonText | ConvertFrom-Json
  if ($PackageMetadata.name -ne $PluginId -or $ManifestMetadata.id -ne $PluginId) { throw "Plugin package identity is invalid." }
  if (-not $ManifestMetadata.version -or $ManifestMetadata.version -ne $PackageMetadata.version) { throw "Package and manifest versions do not match." }
  if ($ExpectedVersion -and $PackageMetadata.version -ne $ExpectedVersion) {
    throw "Package version $($PackageMetadata.version) does not match requested version $ExpectedVersion."
  }

  $env:ELECTRON_RUN_AS_NODE = "1"
  $env:OPENCLAW_STATE_DIR = $StateDir
  function Invoke-OpenClaw {
    param([string[]]$Arguments)
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ExitCode = 0
    try {
      $ErrorActionPreference = "Continue"
      & $LobsterAiBin $OpenClawEntry @Arguments
      $ExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($ExitCode -ne 0) { throw "OpenClaw command failed with exit code $ExitCode." }
  }
  function Invoke-OpenClawPatch {
    param([string]$Json)
    $PatchPath = Join-Path $TempRoot ("openclaw-patch-" + [guid]::NewGuid().ToString("N") + ".json")
    try {
      [IO.File]::WriteAllText($PatchPath, $Json, [System.Text.UTF8Encoding]::new($false))
      Invoke-OpenClaw -Arguments @("config", "patch", "--file", $PatchPath)
    } finally {
      Remove-Item -LiteralPath $PatchPath -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Host "Installing lobsterai-otel-plugin v$($PackageMetadata.version) into the selected LobsterAI OpenClaw state directory."
  Invoke-OpenClaw -Arguments @("plugins", "install", $ArchivePath, "--force")

  $AllowOutput = (& $LobsterAiBin $OpenClawEntry config get plugins.allow --json 2>$null | Out-String).Trim()
  $AllowValues = @()
  if ($LASTEXITCODE -eq 0 -and $AllowOutput) {
    $ParsedAllowValues = $AllowOutput | ConvertFrom-Json
    foreach ($AllowedPlugin in $ParsedAllowValues) { $AllowValues += [string]$AllowedPlugin }
  }
  if ($AllowValues -notcontains $PluginId) { $AllowValues += $PluginId }
  $HostPatch = @{
    plugins = @{
      allow = @($AllowValues)
      entries = @{
        $PluginId = @{
          enabled = $true
          hooks = @{ allowConversationAccess = $true; allowPromptInjection = $false }
        }
      }
    }
  }
  $HostPatchJson = ConvertTo-Json -Compress -Depth 20 -InputObject $HostPatch
  Invoke-OpenClawPatch -Json $HostPatchJson | Out-Null
  Invoke-OpenClaw -Arguments @("plugins", "inspect", $PluginId, "--json") | Out-Null

  if (-not $NoConfig) {
    $Config = [ordered]@{}
    if ($PSBoundParameters.ContainsKey("Type")) { $Config.profile = $Type }
    if ($PSBoundParameters.ContainsKey("Endpoint")) { $Config.endpoint = $Endpoint }
    if ($PSBoundParameters.ContainsKey("XToken")) { $Config.xToken = $XToken }
    if ($PSBoundParameters.ContainsKey("TracePath")) { $Config.tracePath = $TracePath }
    if ($PSBoundParameters.ContainsKey("MetricsPath")) { $Config.metricsPath = $MetricsPath }
    if ($PSBoundParameters.ContainsKey("TracesUrl")) { $Config.tracesUrl = $TracesUrl }
    if ($PSBoundParameters.ContainsKey("MetricsUrl")) { $Config.metricsUrl = $MetricsUrl }
    if ($PSBoundParameters.ContainsKey("CaptureContent")) { $Config.captureContent = $CaptureContent }
    if ($PSBoundParameters.ContainsKey("MaxChars")) { $Config.maxChars = $MaxChars }
    if ($PSBoundParameters.ContainsKey("TimeoutMs")) { $Config.timeoutMs = $TimeoutMs }
    if ($Enable) { $Config.enabled = $true }
    if ($Disable) { $Config.enabled = $false }
    if ($Debug) { $Config.debug = $true }
    if ($NoDebug) { $Config.debug = $false }
    if ($Header.Count -gt 0) {
      $HeaderValues = [ordered]@{}
      foreach ($Pair in $Header) { $Index = $Pair.IndexOf("="); $HeaderValues[$Pair.Substring(0, $Index)] = $Pair.Substring($Index + 1) }
      $Config.headers = $HeaderValues
    }
    if ($Tag.Count -gt 0) {
      $TagValues = [ordered]@{}
      foreach ($Pair in $Tag) { $Index = $Pair.IndexOf("="); $TagValues[$Pair.Substring(0, $Index)] = $Pair.Substring($Index + 1) }
      $Config.resourceAttributes = $TagValues
    }
    if ($Config.Count -gt 0) {
      $Patch = @{ plugins = @{ entries = @{ $PluginId = @{ config = $Config } } } }
      $PatchJson = ConvertTo-Json -Compress -Depth 20 -InputObject $Patch
      Invoke-OpenClawPatch -Json $PatchJson | Out-Null
    }
  }

  Write-Host "Installed lobsterai-otel-plugin v$($PackageMetadata.version). Restart LobsterAI before validation."
  Write-Host "Verify the gateway log contains: [lobsterai-otel] lifecycle hooks enabled"
} finally {
  $env:ELECTRON_RUN_AS_NODE = $OldRunAsNode
  $env:OPENCLAW_STATE_DIR = $OldStateDir
  if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
