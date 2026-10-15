import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { BinanceFuturesClient } from "../src/exchanges/binance-futures.js";
import { HistoricalDataCatalog } from "../src/research/historical-data-catalog.js";
import {
  buildUniverseBackfillPlan,
  syncContractMetadata,
  syncHistoricalSymbol,
  syncMarketUniverseSnapshot,
} from "../src/research/historical-data-sync.js";

function researchBaseUrl() {
  const value = (process.env.BINANCE_RESEARCH_BASE_URL ?? "https://fapi.binance.com").replace(/\/$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "fapi.binance.com") {
    throw new Error("BINANCE_RESEARCH_BASE_URL 当前只允许 https://fapi.binance.com 公共只读行情域名");
  }
  return value;
}

function catalogRoot() {
  return path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data");
}

function closedMinuteRange(days, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("历史同步天数必须是 1 到 180 的整数");
  const endTime = Math.floor(now / 60_000) * 60_000 - 1;
  return { startTime: endTime - days * 86_400_000 + 1, endTime };
}

function parseSymbols(raw) {
  const symbols = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length || symbols.length > 50) throw new Error("请提供 1 到 50 个逗号分隔的 USDT 永续交易对");
  for (const symbol of symbols) {
    if (!/^[A-Z0-9]{1,20}USDT$/.test(symbol)) throw new Error(`无效历史交易对: ${symbol}`);
  }
  return [...new Set(symbols)];
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const command = String(process.argv[2] ?? "audit").toLowerCase();
  const catalog = new HistoricalDataCatalog({ root: catalogRoot() });
  if (command === "audit") {
    console.log(JSON.stringify(await catalog.auditAll(), null, 2));
    return;
  }
  if (!["sync", "sync-top", "snapshot"].includes(command)) throw new Error("命令只能是 sync、sync-top、snapshot 或 audit");

  const syncTopArgs = command === "sync-top" ? {
    count: Number(process.argv[3] ?? 50),
    days: Number(process.argv[4] ?? 7),
    offset: Number(process.argv[5] ?? 0),
    snapshotCapturedAt: process.argv[6] === undefined ? null : Number(process.argv[6]),
  } : null;
  if (syncTopArgs && syncTopArgs.offset > 0 && !Number.isFinite(syncTopArgs.snapshotCapturedAt)) {
    throw new Error("sync-top 的后续批次必须在第6个参数传入首批 snapshotCapturedAt");
  }

  const baseUrl = researchBaseUrl();
  const client = new BinanceFuturesClient({
    baseUrl,
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000),
  });
  const contractDataset = await syncContractMetadata({ client, catalog, sourceBaseUrl: baseUrl });
  const universeDataset = await syncMarketUniverseSnapshot({
    client,
    catalog,
    minListingDays: config.universe.minListingDays,
    maxSpreadBps: config.universe.maxSpreadBps,
    discoverySize: config.marketRadar.discoverySize,
    sourceBaseUrl: baseUrl,
  });
  if (command === "snapshot") {
    console.log(JSON.stringify({
      mode: "READ_ONLY_PUBLIC_MARKET_SNAPSHOT",
      catalogRoot: catalog.root,
      contractDataset: contractDataset.id,
      universeDataset: universeDataset.id,
      audit: await catalog.auditAll(),
    }, null, 2));
    return;
  }

  let selectionSnapshot = null;
  let rankedSelection = null;
  let symbols;
  let days;
  let range = null;
  if (command === "sync-top") {
    days = syncTopArgs.days;
    const snapshots = await catalog.queryRecords({
      dataType: "UNIVERSE",
      symbol: "ALL",
      interval: null,
    });
    const plan = buildUniverseBackfillPlan(snapshots, syncTopArgs);
    selectionSnapshot = plan.snapshot;
    rankedSelection = plan.rankedSelection;
    range = plan.range;
    symbols = rankedSelection.map((item) => item.symbol);
  } else {
    symbols = parseSymbols(process.argv[3]);
    days = Number(process.argv[4] ?? 7);
    range = closedMinuteRange(days);
  }
  const results = [];
  for (const symbol of symbols) {
    results.push(await syncHistoricalSymbol({
      client,
      catalog,
      symbol,
      ...range,
      interval: "1m",
      includeFunding: true,
      sourceBaseUrl: baseUrl,
    }));
  }
  console.log(JSON.stringify({
    mode: "READ_ONLY_PUBLIC_MARKET_DATA",
    catalogRoot: catalog.root,
    days,
    range,
    selectionSnapshot: selectionSnapshot ? {
      capturedAt: selectionSnapshot.capturedAt,
      eligibleCount: selectionSnapshot.eligibleCount,
      rankedSelection,
    } : null,
    contractDataset: contractDataset.id,
    universeDataset: universeDataset.id,
    results,
    audit: await catalog.auditAll(),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
