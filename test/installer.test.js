import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let suiteRoot;
let archive;
let archiveChecksum;
let installerChecksum;
let fakeBin;
let fakeEntry;

before(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lobsterai-otel-installer-test-"));
  const pack = spawnSync("npm", ["pack", root, "--pack-destination", suiteRoot, "--json"], { encoding: "utf8" });
  assert.equal(pack.status, 0, pack.stderr);
  archive = path.join(suiteRoot, JSON.parse(pack.stdout)[0].filename);
  const archiveDigest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  archiveChecksum = path.join(suiteRoot, "archive.sha256");
  await fs.writeFile(archiveChecksum, `${archiveDigest}  lobsterai-otel-plugin.tar.gz\n`);
  const installer = path.join(root, "install.sh");
  const installerDigest = createHash("sha256").update(await fs.readFile(installer)).digest("hex");
  installerChecksum = path.join(suiteRoot, "install.sh.sha256");
  await fs.writeFile(installerChecksum, `${installerDigest}  install.sh\n`);
  fakeEntry = path.join(suiteRoot, "openclaw.mjs");
  await fs.writeFile(fakeEntry, "// synthetic OpenClaw entry\n");
  fakeBin = path.join(suiteRoot, "fake-lobsterai");
  const helper = path.join(root, "test/helpers/fake-openclaw-runtime.mjs");
  await fs.writeFile(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`, { mode: 0o700 });
});

after(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true });
});

async function setupState(name, config = {}) {
  const home = path.join(suiteRoot, name, "home");
  const state = path.join(suiteRoot, name, "state");
  await fs.mkdir(state, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(state, "fake-openclaw.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { home, state };
}

function runInstaller({ home, state }, args = [], env = {}) {
  return spawnSync("bash", [path.join(root, "install.sh"),
    "--package", archive,
    "--lobsterai-bin", fakeBin,
    "--openclaw-entry", fakeEntry,
    "--state-dir", state,
    "--allow-running",
    ...args
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), ...env }
  });
}

function runReleaseInstaller({ home, state }, version, args = [], env = {}) {
  return spawnSync("bash", [path.join(root, "install-release.sh"), version,
    "--lobsterai-bin", fakeBin,
    "--openclaw-entry", fakeEntry,
    "--state-dir", state,
    "--allow-running",
    ...args
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      LOBSTERAI_OTEL_ARCHIVE_URL: pathToFileURL(archive).href,
      LOBSTERAI_OTEL_CHECKSUM_URL: pathToFileURL(archiveChecksum).href,
      LOBSTERAI_OTEL_INSTALL_URL: pathToFileURL(path.join(root, "install.sh")).href,
      LOBSTERAI_OTEL_INSTALL_CHECKSUM_URL: pathToFileURL(installerChecksum).href,
      ...env
    }
  });
}

async function config(state) {
  return JSON.parse(await fs.readFile(path.join(state, "fake-openclaw.json"), "utf8"));
}

test("fresh install registers hooks and applies explicit GTrace configuration", async () => {
  const sandbox = await setupState("fresh", { plugins: { allow: ["unrelated"], entries: { unrelated: { enabled: true } } } });
  const secret = "synthetic-test-token";
  const result = runInstaller(sandbox, [
    "--expected-version", "0.1.1", "--type", "gtrace", "--endpoint", "https://example.invalid",
    "--x-token", secret, "--tag", "deployment.environment.name=test", "--header", "X-Test=value",
    "--capture-content", "preview", "--max-chars", "2048", "--timeout-ms", "5000", "--enable", "--debug"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
  const value = await config(sandbox.state);
  assert.deepEqual(value.plugins.allow, ["unrelated", "lobsterai-otel-plugin"]);
  assert.equal(value.plugins.entries.unrelated.enabled, true);
  const entry = value.plugins.entries["lobsterai-otel-plugin"];
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.hooks, { allowConversationAccess: true, allowPromptInjection: false });
  assert.deepEqual(entry.config, {
    profile: "gtrace", endpoint: "https://example.invalid", xToken: secret,
    captureContent: "preview", maxChars: 2048, timeoutMs: 5000, enabled: true, debug: true,
    headers: { "X-Test": "value" }, resourceAttributes: { "deployment.environment.name": "test" }
  });
});

test("upgrade preserves unspecified private and unrelated configuration", async () => {
  const existing = {
    plugins: {
      allow: ["lobsterai-otel-plugin", "unrelated"],
      entries: {
        unrelated: { config: { keep: true } },
        "lobsterai-otel-plugin": {
          enabled: true,
          hooks: { customHostFlag: true },
          config: {
            endpoint: "https://old.invalid", xToken: "preserve-me", enabled: false,
            captureContent: "full", debug: true, customFutureField: "keep",
            headers: { Authorization: "Bearer synthetic" },
            resourceAttributes: { "deployment.environment.name": "old" }
          }
        }
      }
    }
  };
  const sandbox = await setupState("upgrade", existing);
  const result = runInstaller(sandbox, ["--endpoint", "https://new.invalid", "--tag", "region=us", "--header", "X-New=yes", "--enable"]);
  assert.equal(result.status, 0, result.stderr);
  const value = await config(sandbox.state);
  const entry = value.plugins.entries["lobsterai-otel-plugin"];
  assert.equal(entry.config.endpoint, "https://new.invalid");
  assert.equal(entry.config.xToken, "preserve-me");
  assert.equal(entry.config.enabled, true);
  assert.equal(entry.config.captureContent, "full");
  assert.equal(entry.config.debug, true);
  assert.equal(entry.config.customFutureField, "keep");
  assert.deepEqual(entry.config.headers, { Authorization: "Bearer synthetic", "X-New": "yes" });
  assert.deepEqual(entry.config.resourceAttributes, { "deployment.environment.name": "old", region: "us" });
  assert.equal(entry.hooks.customHostFlag, true);
  assert.equal(value.plugins.entries.unrelated.config.keep, true);

  const disabled = runInstaller(sandbox, ["--disable", "--no-debug"]);
  assert.equal(disabled.status, 0, disabled.stderr);
  const disabledEntry = (await config(sandbox.state)).plugins.entries["lobsterai-otel-plugin"];
  assert.equal(disabledEntry.config.enabled, false);
  assert.equal(disabledEntry.config.debug, false);
  assert.equal(disabledEntry.config.xToken, "preserve-me");
  assert.equal(disabledEntry.config.customFutureField, "keep");
});

test("--no-config leaves telemetry configuration byte-for-byte equivalent", async () => {
  const telemetry = { endpoint: "https://keep.invalid", xToken: "keep-secret", enabled: false, captureContent: "none", debug: true };
  const sandbox = await setupState("no-config", { plugins: { allow: [], entries: { "lobsterai-otel-plugin": { config: telemetry } } } });
  const result = runInstaller(sandbox, ["--no-config", "--endpoint", "https://ignored.invalid", "--x-token", "ignored", "--enable"]);
  assert.equal(result.status, 0, result.stderr);
  const value = await config(sandbox.state);
  assert.deepEqual(value.plugins.entries["lobsterai-otel-plugin"].config, telemetry);
});

test("running-app protection stops before installation", async () => {
  const sandbox = await setupState("running");
  const result = spawnSync("bash", [path.join(root, "install.sh"),
    "--package", archive, "--lobsterai-bin", fakeBin, "--openclaw-entry", fakeEntry, "--state-dir", sandbox.state
  ], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, HOME: sandbox.home, LOBSTERAI_OTEL_FORCE_RUNNING: "1" }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LobsterAI is running/);
  const value = await config(sandbox.state);
  assert.equal(value.fakeInstalledPackage, undefined);
});

test("fixed version mismatch fails before invoking the host CLI", async () => {
  const sandbox = await setupState("version-mismatch");
  const result = runInstaller(sandbox, ["--expected-version", "9.9.9"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match requested version/);
  const value = await config(sandbox.state);
  assert.equal(value.fakeInstalledPackage, undefined);
});

test("release wrapper verifies downloads and supports fixed and latest versions", async () => {
  for (const version of ["v0.1.1", "latest"]) {
    const sandbox = await setupState(`release-${version.replaceAll(".", "-")}`);
    const result = runReleaseInstaller(sandbox, version, ["--no-config"]);
    assert.equal(result.status, 0, result.stderr);
    const value = await config(sandbox.state);
    const calls = await fs.readFile(path.join(sandbox.state, "fake-openclaw-calls.jsonl"), "utf8").catch(() => "no calls");
    assert.equal(typeof value.fakeInstalledPackage, "string", `${JSON.stringify(value)}\n${calls}\n${result.stdout}\n${result.stderr}`);
    assert.equal(value.plugins.entries["lobsterai-otel-plugin"].enabled, true);
  }
});

test("release wrapper rejects a bad checksum before invoking the host CLI", async () => {
  const sandbox = await setupState("release-bad-checksum");
  const badChecksum = path.join(suiteRoot, "bad.sha256");
  await fs.writeFile(badChecksum, `${"0".repeat(64)}  lobsterai-otel-plugin.tar.gz\n`);
  const result = runReleaseInstaller(sandbox, "latest", [], {
    LOBSTERAI_OTEL_CHECKSUM_URL: pathToFileURL(badChecksum).href
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checksum verification failed/);
  const value = await config(sandbox.state);
  assert.equal(value.fakeInstalledPackage, undefined);
});
