import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
assert.equal(packageJson.name, manifest.id);
assert.equal(packageJson.openclaw.extensions[0], "./index.js");
assert.equal(manifest.configSchema.properties.enabled.default, false);
assert.equal(manifest.uiHints.xToken.sensitive, true);

async function collect(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "release"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(absolute));
    else files.push(absolute);
  }
  return files;
}

const files = await collect(root);
for (const file of files.filter((item) => /\.(?:js|mjs)$/.test(item))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
}
for (const file of ["install.sh", "install-release.sh"]) {
  const result = spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}
for (const required of [
  "README.md", "README_ZH.md", "LICENSE", "CHANGELOG.md", "docs/product-research.md",
  "docs/architecture.md", "docs/configuration.md", "docs/privacy.md", "docs/installation.md",
  "test/fixtures/lobsterai-openclaw-v2026.6.1.json"
]) {
  await fs.access(path.join(root, required));
}
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const entries = JSON.parse(packed.stdout)[0].files.map((item) => item.path);
for (const expected of ["index.js", "openclaw.plugin.json", "src/runtime.js", "README.md", "LICENSE"]) {
  assert.ok(entries.includes(expected), `package is missing ${expected}`);
}
process.stdout.write(`Checked ${files.length} files; package metadata and release inputs are valid.\n`);
