import fs from "node:fs/promises";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir) throw new Error("OPENCLAW_STATE_DIR is required");
const configPath = path.join(stateDir, "fake-openclaw.json");
const callsPath = path.join(stateDir, "fake-openclaw-calls.jsonl");
let args = process.argv.slice(2);
if (args[0]?.endsWith("openclaw.mjs")) args = args.slice(1);

async function readConfig() {
  try { return JSON.parse(await fs.readFile(configPath, "utf8")); }
  catch { return {}; }
}

async function writeConfig(config) {
  await fs.mkdir(stateDir, { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, configPath);
}

function deepMerge(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) result[key] = deepMerge(result[key], value);
  return result;
}

function setAtPath(root, dotted, value, merge) {
  const segments = dotted.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) current = current[segment] ??= {};
  const key = segments.at(-1);
  current[key] = merge ? deepMerge(current[key], value) : value;
}

function getAtPath(root, dotted) {
  return dotted.split(".").reduce((value, segment) => value?.[segment], root);
}

async function stdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

await fs.mkdir(stateDir, { recursive: true });
await fs.appendFile(callsPath, `${JSON.stringify(args)}\n`);
const config = await readConfig();

if (args[0] === "plugins" && args[1] === "install") {
  await fs.access(args[2]);
  config.fakeInstalledPackage = args[2];
  await writeConfig(config);
} else if (args[0] === "plugins" && args[1] === "inspect") {
  if (!config.fakeInstalledPackage) process.exitCode = 1;
  else process.stdout.write(JSON.stringify({ id: args[2], status: "loaded" }));
} else if (args[0] === "config" && args[1] === "get") {
  const value = getAtPath(config, args[2]);
  if (value === undefined) process.exitCode = 1;
  else process.stdout.write(JSON.stringify(value));
} else if (args[0] === "config" && args[1] === "set") {
  const value = JSON.parse(args[3]);
  setAtPath(config, args[2], value, args.includes("--merge"));
  await writeConfig(config);
} else if (args[0] === "config" && args[1] === "patch" && (args.includes("--stdin") || args.includes("--file"))) {
  const fileIndex = args.indexOf("--file");
  const source = fileIndex >= 0 ? await fs.readFile(args[fileIndex + 1], "utf8") : await stdin();
  const patch = JSON.parse(source);
  await writeConfig(deepMerge(config, patch));
} else {
  process.stderr.write(`unsupported fake OpenClaw command: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
