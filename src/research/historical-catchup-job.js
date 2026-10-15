import { createHash } from "node:crypto";
import { HISTORICAL_DATA_TYPES } from "./historical-data-catalog.js";
import { symbolBackfillRange } from "./historical-backfill-job.js";
import { syncHistoricalSymbol } from "./historical-data-sync.js";

const MINUTE_MS = 60_000;

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function successfulBackfillResults(results = {}) {
  return Object.values(results).filter((item) => ["ALREADY_COMPLETE", "SYNCED"].includes(item?.status)).length;
}

export function buildHistoricalCatchupJob(backfillCheckpoint, snapshots, { snapshotCapturedAt = null } = {}) {
  const backfillPlan = backfillCheckpoint?.plan;
  if (!backfillPlan?.id || !Array.isArray(backfillPlan.selection)) {
    throw new Error("历史追平需要有效的Top100回填检查点");
  }
  const successful = successfulBackfillResults(backfillCheckpoint.results);
  if (backfillCheckpoint.status !== "COMPLETED" || successful < backfillPlan.count) {
    throw new Error(`HISTORICAL_BACKFILL_NOT_COMPLETE:${successful}/${backfillPlan.count}`);
  }
  const completeSnapshots = [...(snapshots ?? [])]
    .filter((item) => item?.complete === true && Number.isFinite(Number(item.capturedAt)))
    .sort((left, right) => Number(left.capturedAt) - Number(right.capturedAt));
  const target = snapshotCapturedAt === null
    ? completeSnapshots.at(-1)
    : completeSnapshots.find((item) => Number(item.capturedAt) === Number(snapshotCapturedAt));
  if (!target) throw new Error(`找不到历史追平目标快照: ${snapshotCapturedAt}`);
  const targetEndTime = Math.floor(Number(target.capturedAt) / MINUTE_MS) * MINUTE_MS - 1;
  const catchupStartTime = Number(backfillPlan.endTime) + 1;
  if (targetEndTime < catchupStartTime) throw new Error("HISTORICAL_CATCHUP_NO_NEW_CLOSED_MINUTE");
  const identity = {
    backfillJobId: backfillPlan.id,
    targetSnapshotCapturedAt: Number(target.capturedAt),
    catchupStartTime,
    targetEndTime,
    selection: backfillPlan.selection,
  };
  return {
    schemaVersion: 1,
    id: `historical-catchup-${stableHash(identity)}`,
    ...identity,
    backfillPlan,
  };
}

export function summarizeHistoricalCatchupResults(results = {}) {
  const entries = Object.values(results ?? {});
  return {
    successfulSymbols: entries.filter((item) => ["ALREADY_COMPLETE", "SYNCED"].includes(item?.status)).length,
    blockedSymbols: entries.filter((item) => item?.status === "BASE_INCOMPLETE").length,
    failedSymbols: entries.filter((item) => item?.status === "FAILED").length,
  };
}

export async function runHistoricalCatchupJob({
  plan,
  catalog,
  client,
  maxSymbols = Infinity,
  sourceBaseUrl = null,
  syncSymbol = syncHistoricalSymbol,
  onProgress = async () => {},
} = {}) {
  if (!plan?.id || !Array.isArray(plan.selection) || !catalog || !client) {
    throw new TypeError("历史追平执行缺少plan、catalog或client");
  }
  if (!(maxSymbols === Infinity || (Number.isInteger(maxSymbols) && maxSymbols >= 1))) {
    throw new Error("maxSymbols必须是正整数或Infinity");
  }
  const results = [];
  let attempted = 0;
  for (const item of plan.selection) {
    if (attempted >= maxSymbols) break;
    const baseRange = symbolBackfillRange(plan.backfillPlan, item);
    const baseCoverage = await catalog.auditCoverage({
      dataType: HISTORICAL_DATA_TYPES.KLINES,
      symbol: item.symbol,
      interval: "1m",
      startTime: baseRange.startTime,
      endTime: baseRange.endTime,
    });
    if (baseCoverage.status !== "COMPLETE") {
      const result = { ...item, status: "BASE_INCOMPLETE", baseCoverage };
      results.push(result);
      await onProgress(result);
      continue;
    }
    const range = { startTime: plan.catchupStartTime, endTime: plan.targetEndTime };
    const coverage = await catalog.auditCoverage({
      dataType: HISTORICAL_DATA_TYPES.KLINES,
      symbol: item.symbol,
      interval: "1m",
      ...range,
    });
    if (coverage.status === "COMPLETE") {
      const result = { ...item, ...range, status: "ALREADY_COMPLETE", coverage };
      results.push(result);
      await onProgress(result);
      continue;
    }
    attempted += 1;
    try {
      const sync = await syncSymbol({
        client,
        catalog,
        symbol: item.symbol,
        ...range,
        interval: "1m",
        includeFunding: true,
        sourceBaseUrl,
      });
      const result = { ...item, ...range, status: "SYNCED", coverage: sync.coverage };
      results.push(result);
      await onProgress(result);
    } catch (error) {
      const result = {
        ...item,
        ...range,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      await onProgress(result);
    }
  }
  const summary = summarizeHistoricalCatchupResults(Object.fromEntries(results.map((item) => [item.symbol, item])));
  return {
    jobId: plan.id,
    attempted,
    complete: summary.successfulSymbols,
    blocked: summary.blockedSymbols,
    failed: summary.failedSymbols,
    results,
  };
}
