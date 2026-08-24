import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");

if (manifest.id !== packageJson.name) throw new Error("manifest id does not match package name");
if (manifest.version !== packageJson.version) throw new Error("manifest version does not match package version");
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error("package version must be X.Y.Z");
if (!changelog.includes(`## ${packageJson.version} -`)) {
  throw new Error(`CHANGELOG.md does not contain release ${packageJson.version}`);
}
const releaseTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${packageJson.version}`) {
  throw new Error(`release tag ${releaseTag} does not match package version v${packageJson.version}`);
}

await fs.rm(releaseDir, { recursive: true, force: true });
await fs.mkdir(releaseDir, { recursive: true });
const result = spawnSync("npm", ["pack", "--pack-destination", releaseDir, "--json"], {
  cwd: root,
  encoding: "utf8"
});
if (result.status !== 0) throw new Error(result.stderr || result.stdout || "npm pack failed");
const packed = JSON.parse(result.stdout)[0];
const original = path.join(releaseDir, packed.filename);
const versionedName = `lobsterai-otel-plugin-v${packageJson.version}.tar.gz`;
const versioned = path.join(releaseDir, versionedName);
const genericName = "lobsterai-otel-plugin.tar.gz";
const generic = path.join(releaseDir, genericName);
await fs.rename(original, versioned);
await fs.copyFile(versioned, generic);

const primaryAssets = [versionedName, genericName, "install.sh", "install-release.sh", "install-release.ps1"];
for (const installer of primaryAssets.slice(2)) {
  await fs.copyFile(path.join(root, installer), path.join(releaseDir, installer));
}
for (const name of primaryAssets) {
  const digest = createHash("sha256").update(await fs.readFile(path.join(releaseDir, name))).digest("hex");
  const line = `${digest}  ${name}\n`;
  await fs.writeFile(path.join(releaseDir, `${name}.sha256`), line);
}
const publishedAssets = [...primaryAssets, ...primaryAssets.map((name) => `${name}.sha256`)];
const sumLines = [];
for (const name of publishedAssets) {
  const digest = createHash("sha256").update(await fs.readFile(path.join(releaseDir, name))).digest("hex");
  sumLines.push(`${digest}  ${name}\n`);
}
await fs.writeFile(path.join(releaseDir, "SHA256SUMS"), sumLines.join(""));
process.stdout.write(`Built ${publishedAssets.length + 1} release assets in ${releaseDir}\n`);
