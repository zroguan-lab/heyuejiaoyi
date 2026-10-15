import { createHash } from "node:crypto";
import { HISTORICAL_DATA_TYPES } from "./historical-data-catalog.js";
import { syncHistoricalSymbol } from "./historical-data-sync.js";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function buildHistoricalBackfillJob(snapshots, {
  snapshotCapturedAt = null,
  offset = 0,
  count = 100,
  days = 180,
} = {}) {
  if (!Array.isArray(snapshots) || !snapshots.length) throw new Error("历史回填任务需要已封存全市场快照");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("历史回填任务offset必须是非负整数");
  if (!Number.isInteger(count) || count < 1 || count > 300) throw new Error("历史回填任务count必须是1到300的整数");
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("历史回填任务days必须是1到180的整数");
  const ordered = snapshots.filter((item) => item?.complete === true && Array.isArray(item.items))
    .sort((left, right) => Number(left.capturedAt) - Number(right.capturedAt));
  const snapshot = Number.isFinite(snapshotCapturedAt)
    ? ordered.find((item) => Number(item.capturedAt) === Number(snapshotCapturedAt))
    : ordered.at(-1);
  if (!snapshot) throw new Error(`找不到完整全市场快照: ${snapshotCapturedAt}`);
  const capturedAt = Number(snapshot.capturedAt);
  const selection = snapshot.items.slice(offset, offset + count).map((item) => ({
    symbol: item.symbol,
    liquidityRank: Number(item.liquidityRank),
    onboardDate: Number(item.onboardDate),
  }));
  if (selection.length !== count) throw new Error(`全市场快照不足以选择${count}个标的`);
  const endTime = Math.floor(capturedAt / MINUTE_MS) * MINUTE_MS - 1;
  const startTime = endTime - days * DAY_MS + 1;
  const identity = { snapshotCapturedAt: capturedAt, offset, count, days, startTime, endTime, selection };
  return {
    schemaVersion: 1,
    id: `historical-backfill-${stableHash(identity)}`,
    ...identity,
  };
}

export function symbolBackfillRange(plan, item) {
  const onboardDate = Number(item?.onboardDate);
  const listingStart = Number.isFinite(onboardDate) ? Math.ceil(onboardDate / MINUTE_MS) * MINUTE_MS : plan.startTime;
  const startTime = Math.max(Number(plan.startTime), listingStart);
  return {
    startTime,
    endTime: Number(plan.endTime),
    listingLimited: startTime > Number(plan.startTime),
  };
}

export function summarizeHistoricalBackfillResults(results = {}) {
  const entries = Object.values(results ?? {});
  return {
    successfulSymbols: entries.filter((item) => ["ALREADY_COMPLETE", "SYNCED"].includes(item?.status)).length,
    failedSymbols: entries.filter((item) => item?.status === "FAILED").length,
  };
}

export async function runHistoricalBackfillJob({
  plan,
  catalog,
  client,
  maxSymbols = Infinity,
  sourceBaseUrl = null,
  syncSymbol = syncHistoricalSymbol,
  onProgress = async () => {},
} = {}) {
  if (!plan?.id || !Array.isArray(plan.selection) || !catalog || !client) {
    throw new TypeError("历史回填执行缺少plan、catalog或client");
  }
  if (!(maxSymbols === Infinity || (Number.isInteger(maxSymbols) && maxSymbols >= 1))) {
    throw new Error("maxSymbols必须是正整数或Infinity");
  }
  const results = [];
  let attempted = 0;
  for (const item of plan.selection) {
    if (attempted >= maxSymbols) break;
    const range = symbolBackfillRange(plan, item);
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
  return {
    jobId: plan.id,
    attempted,
    complete: results.filter((item) => ["ALREADY_COMPLETE", "SYNCED"].includes(item.status)).length,
    failed: results.filter((item) => item.status === "FAILED").length,
    listingLimited: results.filter((item) => item.listingLimited).map((item) => item.symbol),
    results,
  };
}
