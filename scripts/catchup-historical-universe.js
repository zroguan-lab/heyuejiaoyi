import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { HistoricalBinanceFuturesClient } from "../src/research/historical-binance-client.js";
import {
  buildHistoricalCatchupJob,
  runHistoricalCatchupJob,
  summarizeHistoricalCatchupResults,
} from "../src/research/historical-catchup-job.js";
import { HISTORICAL_DATA_TYPES, HistoricalDataCatalog } from "../src/research/historical-data-catalog.js";
import { acquireHistoricalJobLock, atomicJson } from "../src/research/historical-job-runtime.js";

const PUBLIC_ENVIRONMENT_KEYS = Object.freeze([
  "BINANCE_RESEARCH_BASE_URL", "HISTORICAL_DATA_ROOT", "REQUEST_TIMEOUT_MS",
  "HISTORICAL_BACKFILL_REQUEST_INTERVAL_MS", "HISTORICAL_BACKFILL_RATE_LIMIT_RETRIES",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
]);

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

function researchBaseUrl() {
  const value = (process.env.BINANCE_RESEARCH_BASE_URL ?? "https://fapi.binance.com").replace(/\/$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "fapi.binance.com") {
    throw new Error("历史追平只允许 https://fapi.binance.com 公共只读行情域名");
  }
  return value;
}

function freshCheckpoint(plan, previousRuns = []) {
  return {
    schemaVersion: 1,
    status: "PREPARED",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan,
    results: {},
    previousRuns,
  };
}

export async function runCatchup() {
  loadDotEnv(undefined, { allowedKeys: PUBLIC_ENVIRONMENT_KEYS });
  const root = path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data");
  const backfillCheckpointPath = path.resolve(process.cwd(), option("backfill-checkpoint", "research-data/backfill-top100-180d.json"));
  const checkpointPath = path.resolve(process.cwd(), option("checkpoint", "research-data/catchup-top100.json"));
  const catalog = new HistoricalDataCatalog({ root, writeLockWaitMs: 30_000, writeLockPollMs: 100 });
  const backfillCheckpoint = JSON.parse(await readFile(backfillCheckpointPath, "utf8").catch(() => "null"));
  if (!backfillCheckpoint) throw new Error("缺少Top100回填检查点，不能追平分钟数据");
  const snapshots = await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
    symbol: "ALL",
    interval: null,
  });
  const snapshotArgument = option("snapshot");
  const candidatePlan = buildHistoricalCatchupJob(backfillCheckpoint, snapshots, {
    snapshotCapturedAt: snapshotArgument === null ? null : Number(snapshotArgument),
  });
  let checkpoint = JSON.parse(await readFile(checkpointPath, "utf8").catch(() => "null"));
  if (!checkpoint) {
    checkpoint = freshCheckpoint(candidatePlan);
  } else if (checkpoint.status === "COMPLETED" && checkpoint.plan.id !== candidatePlan.id) {
    const previousRuns = [...(checkpoint.previousRuns ?? []), {
      jobId: checkpoint.plan.id,
      targetSnapshotCapturedAt: checkpoint.plan.targetSnapshotCapturedAt,
      completedAt: checkpoint.updatedAt,
      successfulSymbols: checkpoint.successfulSymbols,
    }].slice(-50);
    checkpoint = freshCheckpoint(candidatePlan, previousRuns);
  } else if (checkpoint.plan.id !== candidatePlan.id) {
    throw new Error("历史追平检查点尚未完成，拒绝在恢复过程中改变目标快照");
  }

  const baseUrl = researchBaseUrl();
  const client = new HistoricalBinanceFuturesClient({
    baseUrl,
    timeoutMs: integerOption("timeout-ms", Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000), 1_000, 60_000),
    minimumRequestIntervalMs: integerOption(
      "request-interval-ms",
      Number(process.env.HISTORICAL_BACKFILL_REQUEST_INTERVAL_MS ?? 500),
      100,
      60_000,
    ),
    rateLimitRetries: integerOption(
      "rate-limit-retries",
      Number(process.env.HISTORICAL_BACKFILL_RATE_LIMIT_RETRIES ?? 8),
      0,
      20,
    ),
  });
  const releaseLock = await acquireHistoricalJobLock(root, { jobType: "TOP100_KLINE_CATCHUP" });
  try {
    checkpoint = {
      ...checkpoint,
      ...summarizeHistoricalCatchupResults(checkpoint.results),
      status: "RUNNING",
      pid: process.pid,
      updatedAt: Date.now(),
      lastError: null,
    };
    await atomicJson(checkpointPath, checkpoint);
    const output = await runHistoricalCatchupJob({
      plan: checkpoint.plan,
      catalog,
      client,
      sourceBaseUrl: baseUrl,
      maxSymbols: integerOption("max-symbols", checkpoint.plan.selection.length, 1, checkpoint.plan.selection.length),
      onProgress: async (result) => {
        const prior = checkpoint.results[result.symbol] ?? {};
        checkpoint.results[result.symbol] = {
          ...result,
          attempts: Number(prior.attempts ?? 0) + (result.status === "ALREADY_COMPLETE" ? 0 : 1),
          checkedAt: Date.now(),
        };
        Object.assign(checkpoint, summarizeHistoricalCatchupResults(checkpoint.results));
        checkpoint.updatedAt = Date.now();
        await atomicJson(checkpointPath, checkpoint);
        process.stdout.write(`${JSON.stringify({ jobId: checkpoint.plan.id, ...checkpoint.results[result.symbol] })}\n`);
      },
    });
    const summary = summarizeHistoricalCatchupResults(checkpoint.results);
    checkpoint = {
      ...checkpoint,
      ...summary,
      status: summary.successfulSymbols >= checkpoint.plan.selection.length
        ? "COMPLETED"
        : summary.blockedSymbols ? "BLOCKED"
          : summary.failedSymbols ? "PAUSED_WITH_FAILURES" : "PAUSED",
      updatedAt: Date.now(),
      lastRun: output,
    };
    await atomicJson(checkpointPath, checkpoint);
    console.log(JSON.stringify({ status: checkpoint.status, checkpointPath, ...summary, output }, null, 2));
    if (summary.blockedSymbols || summary.failedSymbols) process.exitCode = 1;
  } catch (error) {
    const current = JSON.parse(await readFile(checkpointPath, "utf8").catch(() => "{}"));
    await atomicJson(checkpointPath, {
      ...current,
      status: "FAILED",
      updatedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCatchup().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
