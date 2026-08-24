import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

await fs.rm(releaseDir, { recursive: true, force: true });
await fs.mkdir(releaseDir, { recursive: true });
const result = spawnSync("npm", ["pack", "--pack-destination", releaseDir, "--json"], {
  cwd: root,
  encoding: "utf8"
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout || "npm pack failed");
const packed = JSON.parse(result.stdout)[0];
const original = path.join(releaseDir, packed.filename);
const versionedName = `lobsterai-otel-plugin-v${packageJson.version}.tgz`;
const versioned = path.join(releaseDir, versionedName);
const generic = path.join(releaseDir, "lobsterai-otel-plugin.tgz");
await fs.rename(original, versioned);
await fs.copyFile(versioned, generic);

const assets = [versionedName, "lobsterai-otel-plugin.tgz", "install.sh", "install-release.sh", "install-release.ps1"];
for (const installer of assets.slice(2)) {
  await fs.copyFile(path.join(root, installer), path.join(releaseDir, installer));
}
const sumLines = [];
for (const name of assets) {
  const digest = createHash("sha256").update(await fs.readFile(path.join(releaseDir, name))).digest("hex");
  const line = `${digest}  ${name}\n`;
  await fs.writeFile(path.join(releaseDir, `${name}.sha256`), line);
  sumLines.push(line);
}
await fs.writeFile(path.join(releaseDir, "SHA256SUMS"), sumLines.join(""));
process.stdout.write(`Built ${assets.length} release assets in ${releaseDir}\n`);
