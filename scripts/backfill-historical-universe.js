import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { HistoricalBinanceFuturesClient } from "../src/research/historical-binance-client.js";
import { acquireHistoricalJobLock, atomicJson } from "../src/research/historical-job-runtime.js";
import {
  HISTORICAL_DATA_TYPES,
  HistoricalDataCatalog,
} from "../src/research/historical-data-catalog.js";
import {
  buildHistoricalBackfillJob,
  runHistoricalBackfillJob,
  summarizeHistoricalBackfillResults,
} from "../src/research/historical-backfill-job.js";

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
    throw new Error("历史回填只允许 https://fapi.binance.com 公共只读行情域名");
  }
  return value;
}

export async function runBackfill() {
  loadDotEnv(undefined, { allowedKeys: PUBLIC_ENVIRONMENT_KEYS });
  const root = path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data");
  const checkpointPath = path.resolve(process.cwd(), option("checkpoint", "research-data/backfill-top100-180d.json"));
  const catalog = new HistoricalDataCatalog({ root, writeLockWaitMs: 30_000, writeLockPollMs: 100 });
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
  const releaseLock = await acquireHistoricalJobLock(root, { jobType: "TOP100_180D_BACKFILL" });
  try {
    let checkpoint = JSON.parse(await readFile(checkpointPath, "utf8").catch(() => "null"));
    if (!checkpoint) {
      const snapshots = await catalog.queryRecords({
        dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
        symbol: "ALL",
        interval: null,
      });
      const snapshotArgument = option("snapshot");
      checkpoint = {
        schemaVersion: 1,
        status: "PREPARED",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        plan: buildHistoricalBackfillJob(snapshots, {
          snapshotCapturedAt: snapshotArgument === null ? null : Number(snapshotArgument),
          offset: integerOption("offset", 0, 0, 500),
          count: integerOption("count", 100, 1, 300),
          days: integerOption("days", 180, 1, 180),
        }),
        results: {},
      };
    }
    const snapshotArgument = option("snapshot");
    if (snapshotArgument !== null && Number(snapshotArgument) !== Number(checkpoint.plan.snapshotCapturedAt)) {
      throw new Error("回填检查点与--snapshot不一致，拒绝改变既有任务事实");
    }
    checkpoint = {
      ...checkpoint,
      ...summarizeHistoricalBackfillResults(checkpoint.results),
      status: "RUNNING",
      pid: process.pid,
      updatedAt: Date.now(),
      lastError: null,
    };
    await atomicJson(checkpointPath, checkpoint);
    const output = await runHistoricalBackfillJob({
      plan: checkpoint.plan,
      catalog,
      client,
      sourceBaseUrl: baseUrl,
      maxSymbols: integerOption("max-symbols", checkpoint.plan.count, 1, checkpoint.plan.count),
      onProgress: async (result) => {
        const prior = checkpoint.results[result.symbol] ?? {};
        checkpoint.results[result.symbol] = {
          ...result,
          attempts: Number(prior.attempts ?? 0) + (result.status === "ALREADY_COMPLETE" ? 0 : 1),
          checkedAt: Date.now(),
        };
        Object.assign(checkpoint, summarizeHistoricalBackfillResults(checkpoint.results));
        checkpoint.updatedAt = Date.now();
        await atomicJson(checkpointPath, checkpoint);
        process.stdout.write(`${JSON.stringify({ jobId: checkpoint.plan.id, ...checkpoint.results[result.symbol] })}\n`);
      },
    });
    const { successfulSymbols, failedSymbols } = summarizeHistoricalBackfillResults(checkpoint.results);
    checkpoint = {
      ...checkpoint,
      status: successfulSymbols >= checkpoint.plan.count ? "COMPLETED" : failedSymbols ? "PAUSED_WITH_FAILURES" : "PAUSED",
      updatedAt: Date.now(),
      successfulSymbols,
      failedSymbols,
      lastRun: output,
    };
    await atomicJson(checkpointPath, checkpoint);
    console.log(JSON.stringify({ status: checkpoint.status, checkpointPath, successfulSymbols, failedSymbols, output }, null, 2));
    if (failedSymbols) process.exitCode = 1;
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
  runBackfill().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
