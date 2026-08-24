$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ("lobsterai-otel-windows-test-" + [guid]::NewGuid().ToString("N"))
$OldAppData = $env:APPDATA
$OldLocalAppData = $env:LOCALAPPDATA
$OldArchivePath = $env:LOBSTERAI_OTEL_ARCHIVE_PATH
$OldChecksumPath = $env:LOBSTERAI_OTEL_CHECKSUM_PATH
$OldVersion = $env:LOBSTERAI_OTEL_VERSION
try {
  [IO.Directory]::CreateDirectory($Sandbox) | Out-Null
  $HomeDir = Join-Path $Sandbox "home"
  $StateDir = Join-Path $Sandbox "state"
  $RuntimeDir = Join-Path $Sandbox "runtime"
  [IO.Directory]::CreateDirectory($HomeDir) | Out-Null
  [IO.Directory]::CreateDirectory($StateDir) | Out-Null
  [IO.Directory]::CreateDirectory($RuntimeDir) | Out-Null
  $env:APPDATA = Join-Path $HomeDir "AppData\Roaming"
  $env:LOCALAPPDATA = Join-Path $HomeDir "AppData\Local"

  $PackJson = & npm.cmd pack $Root --pack-destination $Sandbox --json | Out-String
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
  $PackedName = (($PackJson | ConvertFrom-Json)[0]).filename
  $Archive = Join-Path $Sandbox "lobsterai-otel-plugin-v0.1.0.tar.gz"
  Copy-Item -LiteralPath (Join-Path $Sandbox $PackedName) -Destination $Archive
  $Checksum = "$Archive.sha256"
  $Digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($Checksum, "$Digest  lobsterai-otel-plugin-v0.1.0.tar.gz`n")
  $env:LOBSTERAI_OTEL_ARCHIVE_PATH = $Archive
  $env:LOBSTERAI_OTEL_CHECKSUM_PATH = $Checksum
  $env:LOBSTERAI_OTEL_VERSION = "latest"

  $Entry = Join-Path $RuntimeDir "openclaw.mjs"
  [IO.File]::WriteAllText($Entry, "// synthetic OpenClaw entry`n")
  $FakeBin = Join-Path $RuntimeDir "LobsterAI-test.cmd"
  $Helper = Join-Path $Root "test\helpers\fake-openclaw-runtime.mjs"
  [IO.File]::WriteAllText($FakeBin, "@echo off`r`nnode `"$Helper`" %*`r`n")

  $Initial = @{
    plugins = @{
      allow = @("unrelated")
      entries = @{
        unrelated = @{ enabled = $true }
        "lobsterai-otel-plugin" = @{
          config = @{
            endpoint = "https://old.invalid"
            xToken = "preserve-token"
            enabled = $false
            captureContent = "full"
            debug = $true
            customFutureField = "keep"
            headers = @{ Authorization = "Bearer synthetic" }
            resourceAttributes = @{ existing = "yes" }
          }
        }
      }
    }
  }
  $ConfigPath = Join-Path $StateDir "fake-openclaw.json"
  $Initial | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

  $Output = & (Join-Path $Root "install-release.ps1") -Version v0.1.0 -Type gtrace `
    -Endpoint "https://new.invalid" -XToken "synthetic-windows-token" `
    -Tag "region=windows" -Header "X-Test=yes" -CaptureContent preview `
    -Enable -StateDir $StateDir -LobsterAiBin $FakeBin -OpenClawEntry $Entry -AllowRunning 2>&1 | Out-String
  if (-not $?) { throw "Windows installer failed: $Output" }
  if ($Output.Contains("synthetic-windows-token")) { throw "Installer output leaked the token." }
  $Value = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $Value.fakeInstalledPackage.EndsWith("lobsterai-otel-plugin-v0.1.0.tar.gz")) { throw "Explicit Version did not override the environment default." }
  $EntryConfig = $Value.plugins.entries."lobsterai-otel-plugin"
  if ($EntryConfig.config.endpoint -ne "https://new.invalid") { throw "Endpoint override was not applied." }
  if ($EntryConfig.config.xToken -ne "synthetic-windows-token") { throw "Token override was not applied." }
  if (-not $EntryConfig.config.enabled) { throw "Enable override was not applied." }
  if ($EntryConfig.config.captureContent -ne "preview") { throw "Capture override was not applied." }
  if (-not $EntryConfig.config.debug) { throw "Unspecified debug value was not preserved." }
  if ($EntryConfig.config.customFutureField -ne "keep") { throw "Unknown plugin configuration was not preserved." }
  if ($EntryConfig.config.headers.Authorization -ne "Bearer synthetic" -or $EntryConfig.config.headers."X-Test" -ne "yes") { throw "Headers were not merged." }
  if ($EntryConfig.config.resourceAttributes.existing -ne "yes" -or $EntryConfig.config.resourceAttributes.region -ne "windows") { throw "Tags were not merged." }
  if ($Value.plugins.allow -notcontains "unrelated" -or $Value.plugins.allow -notcontains "lobsterai-otel-plugin") { throw "Allowlist merge failed." }
  if (-not $EntryConfig.hooks.allowConversationAccess -or $EntryConfig.hooks.allowPromptInjection) { throw "Hook policy is invalid." }

  $BeforeNoConfig = ($EntryConfig.config | ConvertTo-Json -Compress -Depth 20)
  $NoConfigOutput = & (Join-Path $Root "install-release.ps1") -Version v0.1.0 `
    -Endpoint "https://ignored.invalid" -XToken "ignored-token" -Enable -NoConfig `
    -StateDir $StateDir -LobsterAiBin $FakeBin -OpenClawEntry $Entry -AllowRunning 2>&1 | Out-String
  if (-not $?) { throw "Windows --no-config install failed: $NoConfigOutput" }
  if ($NoConfigOutput.Contains("ignored-token")) { throw "--no-config output leaked an ignored token." }
  $After = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $AfterNoConfig = ($After.plugins.entries."lobsterai-otel-plugin".config | ConvertTo-Json -Compress -Depth 20)
  if ($BeforeNoConfig -ne $AfterNoConfig) { throw "--no-config changed telemetry configuration." }

  $DisableOutput = & (Join-Path $Root "install-release.ps1") -Version v0.1.0 -Disable -NoDebug `
    -StateDir $StateDir -LobsterAiBin $FakeBin -OpenClawEntry $Entry -AllowRunning 2>&1 | Out-String
  if (-not $?) { throw "Windows disable install failed: $DisableOutput" }
  $Disabled = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $DisabledConfig = $Disabled.plugins.entries."lobsterai-otel-plugin".config
  if ($DisabledConfig.enabled) { throw "Disable override was not applied." }
  if ($DisabledConfig.debug) { throw "NoDebug override was not applied." }
  if ($DisabledConfig.xToken -ne "synthetic-windows-token") { throw "Disable upgrade did not preserve the token." }

  Write-Host "Windows installer regression checks passed."
} finally {
  $env:APPDATA = $OldAppData
  $env:LOCALAPPDATA = $OldLocalAppData
  $env:LOBSTERAI_OTEL_ARCHIVE_PATH = $OldArchivePath
  $env:LOBSTERAI_OTEL_CHECKSUM_PATH = $OldChecksumPath
  $env:LOBSTERAI_OTEL_VERSION = $OldVersion
  Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
