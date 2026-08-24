$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Sandbox = Join-Path ([IO.Path]::GetTempPath()) ("lobsterai-otel-windows-test-" + [guid]::NewGuid().ToString("N"))
$OldAppData = $env:APPDATA
$OldLocalAppData = $env:LOCALAPPDATA
$OldArchivePath = $env:LOBSTERAI_OTEL_ARCHIVE_PATH
$OldChecksumPath = $env:LOBSTERAI_OTEL_CHECKSUM_PATH
$OldVersion = $env:LOBSTERAI_OTEL_VERSION
$OldTestNode = $env:LOBSTERAI_OTEL_TEST_NODE
try {
  [IO.Directory]::CreateDirectory($Sandbox) | Out-Null
  $HomeDir = Join-Path $Sandbox "home"
  $StateDir = Join-Path $Sandbox "state"
  [IO.Directory]::CreateDirectory($HomeDir) | Out-Null
  [IO.Directory]::CreateDirectory($StateDir) | Out-Null
  $env:APPDATA = Join-Path $HomeDir "AppData\Roaming"
  $env:LOCALAPPDATA = Join-Path $HomeDir "AppData\Local"

  $PackJson = & npm.cmd pack $Root --pack-destination $Sandbox --json | Out-String
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
  $PackedName = (($PackJson | ConvertFrom-Json)[0]).filename
  $Archive = Join-Path $Sandbox "lobsterai-otel-plugin-v0.1.1.tar.gz"
  Copy-Item -LiteralPath (Join-Path $Sandbox $PackedName) -Destination $Archive
  $Checksum = "$Archive.sha256"
  $Digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($Checksum, "$Digest  lobsterai-otel-plugin-v0.1.1.tar.gz`n")
  $env:LOBSTERAI_OTEL_ARCHIVE_PATH = $Archive
  $env:LOBSTERAI_OTEL_CHECKSUM_PATH = $Checksum
  $env:LOBSTERAI_OTEL_VERSION = "latest"

  $Helper = Join-Path $Root "test\helpers\fake-openclaw-runtime.mjs"
  $env:LOBSTERAI_OTEL_TEST_NODE = (Get-Command node.exe -ErrorAction Stop).Source
  $FakeBin = Join-Path $Sandbox "LobsterAI.exe"
  $GuiShimSource = @'
using System;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class LobsterAiGuiShim
{
    private static string QuoteArgument(string value)
    {
        if (!String.IsNullOrEmpty(value) && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        var quoted = new StringBuilder();
        quoted.Append('"');
        var backslashes = 0;
        foreach (var character in value ?? String.Empty)
        {
            if (character == '\\')
            {
                backslashes += 1;
            }
            else if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
            }
            else
            {
                quoted.Append('\\', backslashes);
                quoted.Append(character);
                backslashes = 0;
            }
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string JoinArguments(string[] args)
    {
        var commandLine = new StringBuilder();
        for (var index = 0; index < args.Length; index += 1)
        {
            if (index > 0) commandLine.Append(' ');
            commandLine.Append(QuoteArgument(args[index]));
        }
        return commandLine.ToString();
    }

    public static int Main(string[] args)
    {
        if (args.Length >= 3 && args[1] == "plugins" && args[2] == "install")
        {
            Thread.Sleep(2500);
        }

        var node = Environment.GetEnvironmentVariable("LOBSTERAI_OTEL_TEST_NODE");
        if (String.IsNullOrEmpty(node)) return 127;

        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.Arguments = JoinArguments(args);

        using (var process = Process.Start(startInfo))
        {
            if (process == null) return 127;
            Task<string> stdout = process.StandardOutput.ReadToEndAsync();
            Task<string> stderr = process.StandardError.ReadToEndAsync();
            process.WaitForExit();
            Task.WaitAll(stdout, stderr);
            Console.Out.Write(stdout.Result);
            Console.Error.Write(stderr.Result);
            return process.ExitCode;
        }
    }
}
'@
  Add-Type -TypeDefinition $GuiShimSource -Language CSharp `
    -OutputAssembly $FakeBin -OutputType WindowsApplication
  $Entry = $Helper

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
  $InitialJson = $Initial | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($ConfigPath, $InitialJson, [System.Text.UTF8Encoding]::new($false))

  $Output = & (Join-Path $Root "install-release.ps1") -Version v0.1.1 -Type gtrace `
    -Endpoint "https://new.invalid" -XToken "synthetic-windows-token" `
    -Tag "region=windows" -Header "X-Test=yes" -CaptureContent preview `
    -Enable -StateDir $StateDir -LobsterAiBin $FakeBin -OpenClawEntry $Entry -AllowRunning 2>&1 | Out-String
  if (-not $?) { throw "Windows installer failed: $Output" }
  if ($Output.Contains("synthetic-windows-token")) { throw "Installer output leaked the token." }
  $Value = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not $Value.fakeInstalledPackage.EndsWith("lobsterai-otel-plugin-v0.1.1.tar.gz")) { throw "Explicit Version did not override the environment default." }
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
  $NoConfigOutput = & (Join-Path $Root "install-release.ps1") -Version v0.1.1 `
    -Endpoint "https://ignored.invalid" -XToken "ignored-token" -Enable -NoConfig `
    -StateDir $StateDir -LobsterAiBin $FakeBin -OpenClawEntry $Entry -AllowRunning 2>&1 | Out-String
  if (-not $?) { throw "Windows --no-config install failed: $NoConfigOutput" }
  if ($NoConfigOutput.Contains("ignored-token")) { throw "--no-config output leaked an ignored token." }
  $After = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $AfterNoConfig = ($After.plugins.entries."lobsterai-otel-plugin".config | ConvertTo-Json -Compress -Depth 20)
  if ($BeforeNoConfig -ne $AfterNoConfig) { throw "--no-config changed telemetry configuration." }

  $DisableOutput = & (Join-Path $Root "install-release.ps1") -Version v0.1.1 -Disable -NoDebug `
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
  $env:LOBSTERAI_OTEL_TEST_NODE = $OldTestNode
  Remove-Item -LiteralPath $Sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
