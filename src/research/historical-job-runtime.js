import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  await rename(temporary, target);
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return Number(pid) > 0;
  } catch {
    return false;
  }
}

export async function acquireNamedJobLock(root, {
  jobType = "HISTORICAL_JOB",
  lockName = ".historical-backfill.lock",
} = {}) {
  if (path.basename(lockName) !== lockName || !lockName.startsWith(".")) {
    throw new Error("HISTORICAL_JOB_LOCK_NAME_INVALID");
  }
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, lockName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, jobType, startedAt: new Date().toISOString() })}\n`);
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
      if (processAlive(existing.pid)) throw new Error(`HISTORICAL_JOB_ALREADY_RUNNING:${existing.pid}`);
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("HISTORICAL_JOB_LOCK_FAILED");
}

export async function acquireHistoricalJobLock(root, { jobType = "HISTORICAL_JOB" } = {}) {
  return acquireNamedJobLock(root, { jobType, lockName: ".historical-backfill.lock" });
}
