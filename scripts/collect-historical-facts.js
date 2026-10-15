import { open, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { BinanceFuturesClient } from "../src/exchanges/binance-futures.js";
import {
  HISTORICAL_DATA_TYPES,
  HistoricalDataCatalog,
} from "../src/research/historical-data-catalog.js";
import {
  collectHistoricalFacts,
  isHistoricalCatalogBusy,
  latestContractCaptureTime,
  nextHistoricalFactRunAt,
} from "../src/research/historical-fact-collector.js";

const PUBLIC_ENVIRONMENT_KEYS = Object.freeze([
  "BINANCE_RESEARCH_BASE_URL",
  "HISTORICAL_DATA_ROOT",
  "REQUEST_TIMEOUT_MS",
  "UNIVERSE_MIN_LISTING_DAYS",
  "UNIVERSE_MAX_SPREAD_BPS",
  "MARKET_RADAR_DISCOVERY_SIZE",
  "MARKET_RADAR_REFRESH_MINUTES",
  "HISTORICAL_FACT_INTERVAL_MINUTES",
  "HISTORICAL_FACT_SETTLE_SECONDS",
  "HISTORICAL_FACT_CONTRACT_REFRESH_HOURS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
]);

function numberEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是${minimum}到${maximum}的数字`);
  }
  return value;
}

function publicCollectorConfig() {
  return {
    universe: {
      minListingDays: numberEnvironment("UNIVERSE_MIN_LISTING_DAYS", 90, 0, 3650),
      maxSpreadBps: numberEnvironment("UNIVERSE_MAX_SPREAD_BPS", 20, 1, 500),
    },
    marketRadar: {
      discoverySize: Math.trunc(numberEnvironment("MARKET_RADAR_DISCOVERY_SIZE", 100, 20, 300)),
      refreshMinutes: Math.trunc(numberEnvironment("MARKET_RADAR_REFRESH_MINUTES", 5, 1, 60)),
    },
  };
}

function integerOption(name, fallback, minimum, maximum) {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1]
    ?? process.env[`HISTORICAL_FACT_${name.replaceAll("-", "_").toUpperCase()}`];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} 必须是${minimum}到${maximum}的整数`);
  }
  return value;
}

function researchBaseUrl() {
  const value = (process.env.BINANCE_RESEARCH_BASE_URL ?? "https://fapi.binance.com").replace(/\/$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "fapi.binance.com") {
    throw new Error("历史事实采集只允许 https://fapi.binance.com 公共只读行情域名");
  }
  return value;
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  await rename(temporary, target);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireCollectorLock(root) {
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, ".fact-collector.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(lockPath, "utf8").catch(() => "{}"));
      if (processAlive(Number(existing.pid))) throw new Error(`HISTORICAL_FACT_COLLECTOR_ALREADY_RUNNING:${existing.pid}`);
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("HISTORICAL_FACT_COLLECTOR_LOCK_FAILED");
}

function waitUntil(timestamp, isStopping) {
  return new Promise((resolve) => {
    const check = () => {
      if (isStopping() || Date.now() >= timestamp) return resolve();
      setTimeout(check, Math.min(1000, timestamp - Date.now()));
    };
    check();
  });
}

export async function runCollector() {
  loadDotEnv(undefined, { allowedKeys: PUBLIC_ENVIRONMENT_KEYS });
  const config = publicCollectorConfig();
  const root = path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data");
  const intervalMinutes = integerOption("interval-minutes", config.marketRadar.refreshMinutes, 1, 60);
  const settleSeconds = integerOption("settle-seconds", 10, 0, 59);
  const contractRefreshHours = integerOption("contract-refresh-hours", 24, 1, 168);
  const once = process.argv.includes("--once");
  const baseUrl = researchBaseUrl();
  // Point-in-time snapshots are irreplaceable. A bulk K-line catch-up may briefly
  // hold the catalog writer lock, so the live collector must wait for that short
  // critical section instead of dropping the entire five-minute observation.
  const catalog = new HistoricalDataCatalog({ root, writeLockWaitMs: 60_000, writeLockPollMs: 100 });
  const client = new BinanceFuturesClient({
    baseUrl,
    timeoutMs: numberEnvironment("REQUEST_TIMEOUT_MS", 10_000, 1_000, 60_000),
  });
  const statusPath = path.join(root, "fact-collector-status.json");
  const releaseLock = await acquireCollectorLock(root);
  let stopping = false;
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastContractCapturedAt = latestContractCaptureTime(await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.CONTRACTS,
    symbol: "ALL",
    interval: null,
  }));
  const startedAt = Date.now();
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopping) {
      const lastAttemptAt = Date.now();
      let result = null;
      let errorMessage = null;
      let cycleError = null;
      try {
        result = await collectHistoricalFacts({
          client,
          catalog,
          config,
          sourceBaseUrl: baseUrl,
          lastContractCapturedAt,
          contractRefreshHours,
        });
        lastContractCapturedAt = result.lastContractCapturedAt;
        lastSuccessAt = result.completedAt;
        consecutiveFailures = 0;
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        cycleError = error;
        errorMessage = error instanceof Error ? error.message : String(error);
        consecutiveFailures += 1;
        process.stderr.write(`${JSON.stringify({ status: isHistoricalCatalogBusy(error) ? "SKIPPED_BUSY" : "FAILED", at: Date.now(), error: errorMessage })}\n`);
      }
      const nextRunAt = once || stopping ? null : nextHistoricalFactRunAt(Date.now(), { intervalMinutes, settleSeconds });
      await atomicJson(statusPath, {
        schemaVersion: 1,
        pid: process.pid,
        status: stopping ? "STOPPING" : errorMessage ? "DEGRADED" : once ? "COMPLETED" : "WATCHING",
        publicReadOnly: true,
        baseUrl,
        startedAt,
        lastAttemptAt,
        lastSuccessAt,
        nextRunAt,
        intervalMinutes,
        settleSeconds,
        contractRefreshHours,
        consecutiveFailures,
        lastError: errorMessage,
        lastResult: result,
      });
      if (once && cycleError) throw cycleError;
      if (once || stopping) break;
      await waitUntil(nextRunAt, () => stopping);
    }
  } finally {
    await atomicJson(statusPath, {
      schemaVersion: 1,
      pid: process.pid,
      status: "STOPPED",
      publicReadOnly: true,
      baseUrl,
      startedAt,
      stoppedAt: Date.now(),
      lastSuccessAt,
      consecutiveFailures,
    });
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCollector().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
