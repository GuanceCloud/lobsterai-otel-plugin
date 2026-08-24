[CmdletBinding()]
param(
  [string]$StateDir,
  [string]$LobsterAiBin,
  [string]$OpenClawEntry,
  [switch]$AllowRunning
)

$ErrorActionPreference = "Stop"
$repository = "GuanceCloud/lobsterai-otel-plugin"
$baseUrl = "https://github.com/$repository/releases/latest/download"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("lobsterai-otel-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  $archive = Join-Path $tempDir "lobsterai-otel-plugin.tgz"
  $checksum = Join-Path $tempDir "lobsterai-otel-plugin.tgz.sha256"
  Invoke-WebRequest "$baseUrl/lobsterai-otel-plugin.tgz" -OutFile $archive
  Invoke-WebRequest "$baseUrl/lobsterai-otel-plugin.tgz.sha256" -OutFile $checksum
  $expected = ((Get-Content $checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
  if (-not $expected -or $expected -ne $actual) { throw "Checksum verification failed." }

  if (-not $AllowRunning -and (Get-Process LobsterAI -ErrorAction SilentlyContinue)) {
    throw "LobsterAI is running. Quit it first, or explicitly pass -AllowRunning."
  }
  if (-not $LobsterAiBin) {
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\LobsterAI\LobsterAI.exe"),
      (Join-Path $env:LOCALAPPDATA "LobsterAI\LobsterAI.exe")
    )
    $LobsterAiBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $LobsterAiBin -or -not (Test-Path $LobsterAiBin)) { throw "LobsterAI.exe not found; pass -LobsterAiBin." }
  if (-not $OpenClawEntry) {
    $OpenClawEntry = Join-Path (Split-Path $LobsterAiBin) "resources\cfmind\openclaw.mjs"
  }
  if (-not (Test-Path $OpenClawEntry)) { throw "openclaw.mjs not found; pass -OpenClawEntry." }
  if (-not $StateDir) { $StateDir = Join-Path $env:APPDATA "LobsterAI\openclaw\state" }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

  $oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $oldStateDir = $env:OPENCLAW_STATE_DIR
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $env:OPENCLAW_STATE_DIR = $StateDir
    & $LobsterAiBin $OpenClawEntry plugins install $archive --force
    if ($LASTEXITCODE -ne 0) { throw "OpenClaw plugin installation failed with exit code $LASTEXITCODE." }
    & $LobsterAiBin $OpenClawEntry config set plugins.entries.lobsterai-otel-plugin.hooks '{"allowConversationAccess":true,"allowPromptInjection":false}' --strict-json
    if ($LASTEXITCODE -ne 0) { throw "Failed to grant the required per-plugin conversation hook permission." }
    $allowOutput = (& $LobsterAiBin $OpenClawEntry config get plugins.allow --json 2>$null | Out-String).Trim()
    $allowValues = @()
    if ($LASTEXITCODE -eq 0 -and $allowOutput) { $allowValues = @($allowOutput | ConvertFrom-Json) }
    if ($allowValues -notcontains "lobsterai-otel-plugin") {
      $allowValues += "lobsterai-otel-plugin"
      $allowJson = ConvertTo-Json -Compress -InputObject @($allowValues)
      & $LobsterAiBin $OpenClawEntry config set plugins.allow $allowJson --strict-json
      if ($LASTEXITCODE -ne 0) { throw "Failed to add the plugin to plugins.allow." }
    }
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode
    $env:OPENCLAW_STATE_DIR = $oldStateDir
  }
  Write-Host "Installed. Configure and enable LobsterAI OpenTelemetry in Settings > Plugins, then restart the gateway."
} finally {
  Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
