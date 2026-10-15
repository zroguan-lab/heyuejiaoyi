import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { acquireNamedJobLock, atomicJson } from "../src/research/historical-job-runtime.js";

function option(name, fallback = null) {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

function integerOption(name, fallback, minimum, maximum) {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} 必须是${minimum}到${maximum}的整数`);
  }
  return value;
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return Number(pid) > 0;
  } catch {
    return false;
  }
}

export function classifyBackfillCheckpoint(checkpoint, { verifyProcess = true } = {}) {
  if (!checkpoint || typeof checkpoint !== "object") {
    return { state: "BLOCKED", reason: "BACKFILL_CHECKPOINT_MISSING" };
  }
  const total = Array.isArray(checkpoint.plan?.selection) ? checkpoint.plan.selection.length : 0;
  const successful = Number(checkpoint.successfulSymbols ?? 0);
  const failed = Number(checkpoint.failedSymbols ?? 0);
  if (!total) return { state: "BLOCKED", reason: "BACKFILL_SELECTION_EMPTY", successful, total, failed };
  if (checkpoint.status === "COMPLETED") {
    return successful >= total && failed === 0
      ? { state: "READY", reason: null, successful, total, failed }
      : { state: "BLOCKED", reason: "BACKFILL_COMPLETED_INCOMPLETE", successful, total, failed };
  }
  if (["FAILED", "BLOCKED", "PAUSED_WITH_FAILURES"].includes(checkpoint.status) || failed > 0) {
    return { state: "BLOCKED", reason: checkpoint.lastError ?? `BACKFILL_${checkpoint.status}`, successful, total, failed };
  }
  if (verifyProcess && checkpoint.status === "RUNNING" && !processAlive(checkpoint.pid)) {
    return { state: "BLOCKED", reason: "BACKFILL_PROCESS_NOT_RUNNING", successful, total, failed };
  }
  return { state: "WAITING", reason: null, successful, total, failed };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8").catch(() => "null"));
}

export function pipelineStageArguments(stage, { validationPoints = 20 } = {}) {
  const common = ["--disable-warning=ExperimentalWarning"];
  if (stage === "CATCHUP") {
    return ["--env-file-if-exists=.env.public", "--use-env-proxy", ...common, "scripts/catchup-historical-universe.js"];
  }
  if (stage === "STRICT_SINGLE_POINT_REPLAY") {
    return ["--env-file-if-exists=.env", ...common, "scripts/replay-v2-3-history.js", "--points=1"];
  }
  if (stage === "STRICT_VALIDATION") {
    return ["--env-file-if-exists=.env", ...common, "scripts/validate-v2-3-history.js", `--points=${validationPoints}`];
  }
  throw new Error(`PIPELINE_STAGE_UNKNOWN:${stage}`);
}

async function runNodeStage(cwd, stage, options = {}) {
  const args = pipelineStageArguments(stage, options);
  const captureJson = Boolean(options.captureJson);
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: captureJson ? ["ignore", "pipe", "inherit"] : "inherit",
    windowsHide: true,
  });
  let stdout = "";
  if (captureJson) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) throw new Error(`PIPELINE_STAGE_FAILED:${stage}:${exitCode}`);
  return captureJson ? JSON.parse(stdout) : null;
}

export function classifyValidationResult(result) {
  if (result?.status === "BLOCKED") {
    return {
      state: "WAITING",
      status: "WAITING_FOR_POINT_IN_TIME_COVERAGE",
      blocker: result.blocker ?? "VALIDATION_BLOCKED",
      pointInTimeCoverage: result.pointInTimeCoverage ?? null,
    };
  }
  if (!result || typeof result !== "object" || !result.promotionGate) {
    return { state: "FAILED", status: "VALIDATION_RESULT_INVALID", blocker: "VALIDATION_RESULT_INVALID" };
  }
  return {
    state: "READY",
    status: "VALIDATION_COMPLETED",
    blocker: null,
    pointInTimeCoverage: result.pointInTimeCoverage ?? null,
  };
}

export async function continueHistoricalPipeline({
  cwd = process.cwd(),
  pollMs = 30_000,
  validationPoints = 20,
  retryBlockedMs = 0,
} = {}) {
  const root = path.resolve(cwd, "research-data");
  const checkpointPath = path.resolve(cwd, option("backfill-checkpoint", "research-data/backfill-top100-180d.json"));
  const statusPath = path.resolve(cwd, option("status", "research-data/historical-pipeline-status.json"));
  const releaseLock = await acquireNamedJobLock(root, {
    jobType: "HISTORICAL_PIPELINE_CONTINUATION",
    lockName: ".historical-pipeline.lock",
  });
  let lastProgress = null;
  try {
    await atomicJson(statusPath, {
      schemaVersion: 1,
      pid: process.pid,
      status: "WAITING_FOR_BACKFILL",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    while (true) {
      const state = classifyBackfillCheckpoint(await readJson(checkpointPath));
      const progress = `${state.successful}/${state.total}`;
      if (progress !== lastProgress) {
        process.stdout.write(`${JSON.stringify({ stage: "WAITING_FOR_BACKFILL", ...state })}\n`);
        lastProgress = progress;
      }
      await atomicJson(statusPath, {
        schemaVersion: 1,
        pid: process.pid,
        status: state.state === "READY" ? "BACKFILL_READY" : "WAITING_FOR_BACKFILL",
        progress,
        updatedAt: Date.now(),
      });
      if (state.state === "READY") break;
      if (state.state === "BLOCKED") throw new Error(state.reason);
      await delay(pollMs);
    }

    while (true) {
      await atomicJson(statusPath, { schemaVersion: 1, pid: process.pid, status: "RUNNING_CATCHUP", updatedAt: Date.now() });
      await runNodeStage(cwd, "CATCHUP");

      await atomicJson(statusPath, { schemaVersion: 1, pid: process.pid, status: "RUNNING_STRICT_SINGLE_POINT_REPLAY", updatedAt: Date.now() });
      await runNodeStage(cwd, "STRICT_SINGLE_POINT_REPLAY");

      await atomicJson(statusPath, { schemaVersion: 1, pid: process.pid, status: "RUNNING_STRICT_VALIDATION", validationPoints, updatedAt: Date.now() });
      const validationResult = await runNodeStage(cwd, "STRICT_VALIDATION", { validationPoints, captureJson: true });
      const validationState = classifyValidationResult(validationResult);
      if (validationState.state === "FAILED") throw new Error(validationState.blocker);
      if (validationState.state === "READY") {
        await atomicJson(statusPath, {
          schemaVersion: 1,
          pid: process.pid,
          status: "COMPLETED",
          validationPoints,
          pointInTimeCoverage: validationState.pointInTimeCoverage,
          validation: validationResult.promotionGate,
          completedAt: Date.now(),
          updatedAt: Date.now(),
        });
        break;
      }
      await atomicJson(statusPath, {
        schemaVersion: 1,
        pid: process.pid,
        status: validationState.status,
        validationPoints,
        blocker: validationState.blocker,
        pointInTimeCoverage: validationState.pointInTimeCoverage,
        nextRetryAt: retryBlockedMs > 0 ? Date.now() + retryBlockedMs : null,
        updatedAt: Date.now(),
      });
      if (retryBlockedMs <= 0) break;
      await delay(retryBlockedMs);
    }
  } catch (error) {
    await atomicJson(statusPath, {
      schemaVersion: 1,
      pid: process.pid,
      status: "FAILED",
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    }).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  continueHistoricalPipeline({
    pollMs: integerOption("poll-seconds", 30, 5, 3_600) * 1_000,
    validationPoints: integerOption("validation-points", 20, 20, 2_016),
    retryBlockedMs: integerOption("retry-blocked-minutes", 0, 0, 1_440) * 60_000,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
