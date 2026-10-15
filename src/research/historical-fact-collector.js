import {
  syncContractMetadata,
  syncMarketUniverseSnapshot,
} from "./historical-data-sync.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function nextHistoricalFactRunAt(now, {
  intervalMinutes = 5,
  settleSeconds = 10,
} = {}) {
  const current = Number(now);
  if (!Number.isFinite(current)) throw new Error("历史事实采集时间无效");
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 60) {
    throw new Error("历史事实采集间隔必须是1到60分钟的整数");
  }
  if (!Number.isInteger(settleSeconds) || settleSeconds < 0 || settleSeconds > 59) {
    throw new Error("历史事实采集延迟必须是0到59秒的整数");
  }
  const intervalMs = intervalMinutes * MINUTE_MS;
  const settleMs = settleSeconds * 1000;
  const currentBoundary = Math.floor(current / intervalMs) * intervalMs + settleMs;
  return currentBoundary > current ? currentBoundary : currentBoundary + intervalMs;
}

export function latestContractCaptureTime(contractRecords = []) {
  const times = contractRecords.map((item) => Number(item?.capturedAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

export function contractSnapshotDue(now, lastContractCapturedAt, refreshHours = 24) {
  const current = Number(now);
  if (!Number.isFinite(current)) throw new Error("历史事实采集时间无效");
  if (!Number.isFinite(refreshHours) || refreshHours < 1 || refreshHours > 168) {
    throw new Error("合约快照刷新周期必须是1到168小时");
  }
  return !Number.isFinite(lastContractCapturedAt)
    || current - Number(lastContractCapturedAt) >= refreshHours * HOUR_MS;
}

export async function collectHistoricalFacts({
  client,
  catalog,
  config,
  sourceBaseUrl = null,
  lastContractCapturedAt = null,
  contractRefreshHours = 24,
  now = Date.now,
  syncUniverse = syncMarketUniverseSnapshot,
  syncContracts = syncContractMetadata,
} = {}) {
  if (!client || !catalog || !config?.universe || !config?.marketRadar) {
    throw new TypeError("历史事实采集缺少 client、catalog 或市场配置");
  }
  const startedAt = Number(now());
  const universeDataset = await syncUniverse({
    client,
    catalog,
    minListingDays: config.universe.minListingDays,
    maxSpreadBps: config.universe.maxSpreadBps,
    discoverySize: config.marketRadar.discoverySize,
    sourceBaseUrl,
  });
  let contractDataset = null;
  let nextContractCapturedAt = Number.isFinite(lastContractCapturedAt) ? Number(lastContractCapturedAt) : null;
  if (contractSnapshotDue(startedAt, nextContractCapturedAt, contractRefreshHours)) {
    contractDataset = await syncContracts({ client, catalog, sourceBaseUrl });
    nextContractCapturedAt = Number(contractDataset?.lastTime ?? contractDataset?.firstTime ?? startedAt);
  }
  return {
    status: "COLLECTED",
    startedAt,
    completedAt: Number(now()),
    universeDatasetId: universeDataset.id,
    universeSnapshotAt: Number(universeDataset.lastTime),
    universePartitionRows: Number(universeDataset.rowCount),
    contractDatasetId: contractDataset?.id ?? null,
    contractSnapshotAt: contractDataset ? nextContractCapturedAt : null,
    lastContractCapturedAt: nextContractCapturedAt,
  };
}

export function isHistoricalCatalogBusy(error) {
  return String(error?.message ?? error).startsWith("HISTORICAL_CATALOG_BUSY:");
}
