import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function stateKey(sessionId, runId) {
  return createHash("sha256").update(`${sessionId ?? "unknown"}\0${runId}`).digest("hex");
}

async function exists(file) {
  return Boolean(await fs.stat(file).catch(() => undefined));
}

async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temp, file);
}

async function atomicCreateJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  try {
    await fs.link(temp, file);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export function createStateStore({ configuredStateDir, claimTtlMs, retentionDays, logger }) {
  let root;

  function requireRoot() {
    if (!root) throw new Error("state store has not started");
    return root;
  }

  async function start(openClawStateDir) {
    root = configuredStateDir || path.join(openClawStateDir, "plugin-data", "lobsterai-otel-plugin");
    await fs.mkdir(path.join(root, "turns"), { recursive: true, mode: 0o700 });
    await cleanup();
  }

  function turnDir(sessionId, runId) {
    return path.join(requireRoot(), "turns", stateKey(sessionId, runId));
  }

  async function persist(payload) {
    const dir = turnDir(payload.sessionId, payload.runId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (await exists(path.join(dir, "completed.json"))) return { dir, completed: true };
    // The first terminal payload is the retry contract. A duplicate agent_end
    // must never replace a partially uploaded batch with newly reconstructed data.
    await atomicCreateJson(path.join(dir, "turn.json"), {
      schemaVersion: 1,
      runIdHash: stateKey(payload.sessionId, payload.runId),
      createdAt: Date.now(),
      traces: Buffer.from(payload.traces).toString("base64"),
      metrics: Buffer.from(payload.metrics).toString("base64")
    });
    if (await exists(path.join(dir, "completed.json"))) {
      await fs.rm(path.join(dir, "turn.json"), { force: true });
      return { dir, completed: true };
    }
    return { dir, completed: false };
  }

  async function claim(dir, retry = true) {
    if (await exists(path.join(dir, "completed.json"))) return { claimed: false, completed: true, dir };
    const lock = path.join(dir, "claim.lock");
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ startedAt: Date.now() }));
      await handle.close();
      return { claimed: true, completed: false, dir, lock };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (retry && stat && Date.now() - stat.mtimeMs > claimTtlMs) {
        await fs.rm(lock, { force: true });
        return claim(dir, false);
      }
      return { claimed: false, completed: false, dir, lock };
    }
  }

  async function uploaded(dir, signal) {
    return exists(path.join(dir, `${signal}.json`));
  }

  async function markUploaded(dir, signal, details) {
    await atomicJson(path.join(dir, `${signal}.json`), {
      uploadedAt: Date.now(),
      status: details?.status,
      bytes: details?.bytes
    });
  }

  async function complete(claimResult) {
    await atomicJson(path.join(claimResult.dir, "completed.json"), { completedAt: Date.now() });
    await fs.rm(path.join(claimResult.dir, "turn.json"), { force: true });
    await fs.rm(claimResult.lock, { force: true });
  }

  async function release(claimResult) {
    if (claimResult?.claimed) await fs.rm(claimResult.lock, { force: true });
  }

  async function processDir(dir, upload) {
    const claimResult = await claim(dir);
    if (!claimResult.claimed) return { skipped: true, completed: claimResult.completed };
    try {
      const payload = await readJson(path.join(dir, "turn.json"));
      if (!await uploaded(dir, "traces")) {
        const result = await upload("traces", Buffer.from(payload.traces, "base64"));
        await markUploaded(dir, "traces", result);
      }
      if (!await uploaded(dir, "metrics")) {
        const result = await upload("metrics", Buffer.from(payload.metrics, "base64"));
        await markUploaded(dir, "metrics", result);
      }
      await complete(claimResult);
      return { completed: true };
    } finally {
      await release(claimResult);
    }
  }

  async function process(payload, upload) {
    const persisted = await persist(payload);
    if (persisted.completed) return { skipped: true, completed: true };
    return processDir(persisted.dir, upload);
  }

  async function recover(upload) {
    const turns = path.join(requireRoot(), "turns");
    const entries = await fs.readdir(turns, { withFileTypes: true }).catch(() => []);
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(turns, entry.name);
      if (!await exists(path.join(dir, "turn.json"))) continue;
      try {
        results.push(await processDir(dir, upload));
      } catch (error) {
        logger?.warn?.(`[lobsterai-otel] pending export retry failed (${error?.code ?? error?.name ?? "error"})`);
      }
    }
    return results;
  }

  async function cleanup() {
    const turns = path.join(requireRoot(), "turns");
    const entries = await fs.readdir(turns, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(turns, entry.name);
      const completed = await fs.stat(path.join(dir, "completed.json")).catch(() => undefined);
      if (completed && completed.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  return { start, persist, process, recover, cleanup, get root() { return root; } };
}

export const __stateTest = { stateKey };
