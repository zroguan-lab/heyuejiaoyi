import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HISTORICAL_DATA_TYPES,
  HistoricalDataCatalog,
  auditHistoricalRecords,
  historicalDatasetId,
  partitionRecordsByCatalogPeriod,
} from "../src/research/historical-data-catalog.js";
import {
  buildUniverseBackfillPlan,
  selectUniverseBackfillBatch,
  syncContractMetadata,
  syncHistoricalSymbol,
  syncMarketUniverseSnapshot,
} from "../src/research/historical-data-sync.js";
import {
  collectHistoricalFacts,
  contractSnapshotDue,
  latestContractCaptureTime,
  nextHistoricalFactRunAt,
} from "../src/research/historical-fact-collector.js";
import {
  buildHistoricalBackfillJob,
  runHistoricalBackfillJob,
  summarizeHistoricalBackfillResults,
  symbolBackfillRange,
} from "../src/research/historical-backfill-job.js";
import {
  buildHistoricalCatchupJob,
  runHistoricalCatchupJob,
  summarizeHistoricalCatchupResults,
} from "../src/research/historical-catchup-job.js";

function candle(openTime, close = 100) {
  return {
    openTime,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 10,
    closeTime: openTime + 59_999,
    quoteVolume: 1_000,
    trades: 20,
  };
}

function descriptor(partition = "2026-10") {
  return {
    exchange: "BINANCE",
    market: "USD_M_PERPETUAL",
    dataType: HISTORICAL_DATA_TYPES.KLINES,
    symbol: "BTCUSDT",
    interval: "1m",
    partition,
  };
}

test("历史目录以内容寻址对象保存不可变修订并原子更新manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-catalog-"));
  let now = Date.UTC(2026, 9, 4, 0, 0, 0);
  const catalog = new HistoricalDataCatalog({ root, now: () => now });
  const start = Date.UTC(2026, 9, 1, 0, 0, 0);
  const first = await catalog.writePartition({
    descriptor: descriptor(),
    records: [candle(start), candle(start + 60_000)],
    source: { endpoint: "/fapi/v1/klines" },
    requestedRange: { startTime: start, endTime: start + 119_999 },
  });
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.revisions.length, 1);
  const originalObject = path.join(root, first.revisions[0].object.path);
  assert.ok((await readFile(originalObject)).length > 0);

  now += 60_000;
  const second = await catalog.writePartition({
    descriptor: descriptor(),
    records: [candle(start + 120_000)],
    source: { endpoint: "/fapi/v1/klines" },
    requestedRange: { startTime: start, endTime: start + 179_999 },
  });
  assert.equal(second.revisions.length, 2);
  assert.equal(second.rowCount, 3);
  assert.ok((await readFile(originalObject)).length > 0, "旧修订对象必须保留");
  assert.equal((await catalog.readPartition(second.id)).length, 3);
  assert.equal((await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.KLINES,
    symbol: "BTCUSDT",
    interval: "1m",
    startTime: start + 60_000,
    endTime: start + 120_000,
  })).length, 2);
  assert.deepEqual(await catalog.availableSymbols(), ["BTCUSDT"]);
  assert.deepEqual(await catalog.availableCoverageRanges(), [{
    symbol: "BTCUSDT",
    firstTime: start,
    lastTime: start + 120_000,
    rowCount: 3,
    partitionCount: 1,
  }]);
  assert.equal((await catalog.auditAll()).healthy, true);
});

test("长回填可等待短暂目录写锁而不重新下载数据", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-lock-wait-"));
  const lockPath = path.join(root, ".writer.lock");
  await writeFile(lockPath, "busy\n");
  const release = setTimeout(() => unlink(lockPath), 25);
  const catalog = new HistoricalDataCatalog({ root, writeLockWaitMs: 1_000, writeLockPollMs: 10 });
  try {
    const result = await catalog.writePartition({ descriptor: descriptor(), records: [candle(Date.UTC(2026, 9, 1))] });
    assert.equal(result.status, "COMPLETE");
  } finally {
    clearTimeout(release);
    await unlink(lockPath).catch(() => {});
  }
});

test("空目录不会被误报为健康数据集", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-empty-"));
  const catalog = new HistoricalDataCatalog({ root });
  const audit = await catalog.auditAll();
  assert.equal(audit.datasetCount, 0);
  assert.equal(audit.healthy, false);
});

test("K线缺口会被识别，冲突的同时间记录不会覆盖原始事实", async () => {
  const start = Date.UTC(2026, 9, 1, 0, 0, 0);
  const audit = auditHistoricalRecords([candle(start), candle(start + 120_000)], {
    dataType: HISTORICAL_DATA_TYPES.KLINES,
    interval: "1m",
    expectedStartTime: start,
    expectedEndTime: start + 179_999,
  });
  assert.equal(audit.status, "GAPS_OR_INVALID");
  assert.equal(audit.gapCount, 1);
  assert.equal(audit.gaps[0].missingBars, 1);

  const root = await mkdtemp(path.join(os.tmpdir(), "history-conflict-"));
  const catalog = new HistoricalDataCatalog({ root });
  await catalog.writePartition({ descriptor: descriptor(), records: [candle(start)] });
  await assert.rejects(
    catalog.writePartition({ descriptor: descriptor(), records: [candle(start, 101)] }),
    /HISTORICAL_CONFLICTING_RECORD/,
  );
});

test("目录审计能发现内容对象被篡改", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-corrupt-"));
  const catalog = new HistoricalDataCatalog({ root });
  const start = Date.UTC(2026, 9, 1, 0, 0, 0);
  const dataset = await catalog.writePartition({ descriptor: descriptor(), records: [candle(start)] });
  const objectPath = path.join(root, dataset.revisions[0].object.path);
  await writeFile(objectPath, Buffer.from("corrupt"));
  const audit = await catalog.auditAll();
  assert.equal(audit.healthy, false);
  assert.equal(audit.datasets[0].status, "CORRUPT");
});

test("M2同步把1分钟K线、资金费和合约元数据写入独立历史目录", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-sync-"));
  const catalog = new HistoricalDataCatalog({ root });
  const start = Date.UTC(2026, 9, 4, 0, 0, 0);
  const end = start + 179_999;
  const client = {
    baseUrl: "https://fapi.binance.com",
    async fetchHistoricalKlines() {
      return [candle(start), candle(start + 60_000), candle(start + 120_000)];
    },
    async fetchFundingRates(symbol) {
      return [{ symbol, fundingTime: start + 60_000, rate: 0.0001, markPrice: 100 }];
    },
    async fetchUniverseSnapshot({ discoverySize }) {
      return {
        schemaVersion: 2,
        capturedAt: start,
        complete: true,
        discoverySize,
        eligibleCount: 1,
        filters: { minListingDays: 0, maxSpreadBps: 20 },
        items: [{
          symbol: "BTCUSDT",
          baseAsset: "BTC",
          onboardDate: 1,
          quoteVolume24h: 1_000_000,
          lastPrice: 100,
          priceChangePercent24h: 1,
          highPrice24h: 101,
          lowPrice24h: 99,
          tradeCount24h: 1_000,
          bidPrice: 99.99,
          askPrice: 100,
          spreadBps: ((100 - 99.99) / ((100 + 99.99) / 2)) * 10_000,
          liquidityRank: 1,
        }],
      };
    },
    async request(pathname) {
      assert.equal(pathname, "/fapi/v1/exchangeInfo");
      return {
        symbols: [{
          symbol: "BTCUSDT",
          pair: "BTCUSDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          marginAsset: "USDT",
          onboardDate: 1,
          deliveryDate: 4_133_404_800_000,
          pricePrecision: 1,
          quantityPrecision: 3,
          filters: [],
        }, {
          symbol: "币安人生USDT",
          pair: "币安人生USDT",
          contractType: "PERPETUAL",
          status: "TRADING",
          baseAsset: "币安人生",
          quoteAsset: "USDT",
          marginAsset: "USDT",
          onboardDate: 2,
          deliveryDate: 4_133_404_800_000,
          pricePrecision: 6,
          quantityPrecision: 0,
          filters: [],
        }],
      };
    },
  };
  const sync = await syncHistoricalSymbol({ client, catalog, symbol: "BTCUSDT", startTime: start, endTime: end });
  assert.equal(sync.coverage.status, "COMPLETE");
  assert.equal(sync.klineRows, 3);
  assert.equal(sync.fundingRows, 1);
  const contracts = await syncContractMetadata({ client, catalog, capturedAt: start });
  assert.equal(contracts.dataType, HISTORICAL_DATA_TYPES.CONTRACTS);
  assert.equal(contracts.rowCount, 2, "元数据目录必须保留交易所实际返回的Unicode合约代号");
  const universe = await syncMarketUniverseSnapshot({
    client,
    catalog,
    capturedAt: start,
    minListingDays: 0,
    maxSpreadBps: 20,
    discoverySize: 1,
  });
  assert.equal(universe.dataType, HISTORICAL_DATA_TYPES.UNIVERSE);
  assert.equal(universe.rowCount, 1);
  const universeRows = await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
    symbol: "ALL",
    interval: null,
  });
  assert.ok(Math.abs(universeRows[0].items[0].spreadBps - 1.00005) < 0.00001);

  const invalidBook = structuredClone(universeRows[0]);
  invalidBook.items[0].askPrice = 99;
  const invalidUniverseAudit = auditHistoricalRecords([invalidBook], {
    dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
    interval: null,
  });
  assert.deepEqual(invalidUniverseAudit.invalidRecords, [{ index: 0, reason: "INVALID_UNIVERSE_SNAPSHOT" }]);

  const manifest = await catalog.loadManifest();
  assert.ok(manifest.datasets.some((item) => item.id === historicalDatasetId(descriptor())));
  assert.equal(manifest.datasets.length, 4);
});

test("M6历史回填严格按已封存流动性排名分批且单批不超过50个", () => {
  const snapshot = {
    complete: true,
    items: Array.from({ length: 60 }, (_, index) => ({
      symbol: `COIN${index + 1}USDT`,
      liquidityRank: index + 1,
    })),
  };
  assert.deepEqual(selectUniverseBackfillBatch(snapshot, { offset: 10, count: 3 }), [
    { symbol: "COIN11USDT", liquidityRank: 11 },
    { symbol: "COIN12USDT", liquidityRank: 12 },
    { symbol: "COIN13USDT", liquidityRank: 13 },
  ]);
  assert.throws(() => selectUniverseBackfillBatch(snapshot, { count: 51 }), /1到50/);
  assert.throws(() => selectUniverseBackfillBatch({ complete: false, items: [] }), /完整的全市场快照/);
});

test("M6后续批次固定复用首批榜单快照与分钟时间窗", () => {
  const snapshots = [{
    capturedAt: 120_001,
    complete: true,
    items: Array.from({ length: 20 }, (_, index) => ({
      symbol: `COIN${index + 1}USDT`,
      liquidityRank: index + 1,
    })),
  }, {
    capturedAt: 240_001,
    complete: true,
    items: Array.from({ length: 20 }, (_, index) => ({
      symbol: `NEW${index + 1}USDT`,
      liquidityRank: index + 1,
    })),
  }];
  const first = buildUniverseBackfillPlan(snapshots, { offset: 0, count: 10, days: 1, snapshotCapturedAt: 120_001 });
  const second = buildUniverseBackfillPlan(snapshots, { offset: 10, count: 10, days: 1, snapshotCapturedAt: 120_001 });
  assert.deepEqual(first.range, second.range);
  assert.equal(first.range.endTime, 119_999);
  assert.equal(second.rankedSelection[0].symbol, "COIN11USDT");
  assert.throws(
    () => buildUniverseBackfillPlan(snapshots, { offset: 10, count: 10, days: 1 }),
    /必须指定首批使用的 snapshotCapturedAt/,
  );
});

test("高频全市场事实按UTC小时分区且不改变K线月分区", () => {
  const first = Date.UTC(2026, 9, 4, 9, 5, 10);
  const second = Date.UTC(2026, 9, 4, 10, 0, 10);
  const universe = partitionRecordsByCatalogPeriod([
    { capturedAt: first },
    { capturedAt: second },
  ], HISTORICAL_DATA_TYPES.UNIVERSE);
  assert.deepEqual([...universe.keys()], ["2026-10-04T09", "2026-10-04T10"]);
  const klines = partitionRecordsByCatalogPeriod([candle(first)], HISTORICAL_DATA_TYPES.KLINES);
  assert.deepEqual([...klines.keys()], ["2026-10"]);
});

test("历史事实采集器按雷达周期对齐并降低合约快照写入频率", async () => {
  const now = Date.UTC(2026, 9, 4, 9, 2, 34);
  assert.equal(
    nextHistoricalFactRunAt(now, { intervalMinutes: 5, settleSeconds: 10 }),
    Date.UTC(2026, 9, 4, 9, 5, 10),
  );
  assert.equal(contractSnapshotDue(now, null, 24), true);
  assert.equal(contractSnapshotDue(now, now - 23 * 60 * 60_000, 24), false);
  assert.equal(latestContractCaptureTime([{ capturedAt: now - 1 }, { capturedAt: now }]), now);

  let universeCalls = 0;
  let contractCalls = 0;
  const common = {
    client: {},
    catalog: {},
    config: {
      universe: { minListingDays: 90, maxSpreadBps: 20 },
      marketRadar: { discoverySize: 100 },
    },
    now: () => now,
    syncUniverse: async () => {
      universeCalls += 1;
      return { id: "UNIVERSE", lastTime: now, rowCount: universeCalls };
    },
    syncContracts: async () => {
      contractCalls += 1;
      return { id: "CONTRACTS", lastTime: now };
    },
  };
  const first = await collectHistoricalFacts(common);
  const second = await collectHistoricalFacts({ ...common, lastContractCapturedAt: first.lastContractCapturedAt });
  assert.equal(universeCalls, 2);
  assert.equal(contractCalls, 1);
  assert.equal(first.contractDatasetId, "CONTRACTS");
  assert.equal(second.contractDatasetId, null);
});

test("可恢复回填固定榜单与时间窗并以目录覆盖作为完成事实", async () => {
  const capturedAt = Date.UTC(2026, 9, 4, 9, 30, 10);
  const snapshots = [{
    capturedAt,
    complete: true,
    items: [
      { symbol: "BTCUSDT", liquidityRank: 1, onboardDate: capturedAt - 1_000 * 86_400_000 },
      { symbol: "NEWUSDT", liquidityRank: 2, onboardDate: capturedAt - 10 * 86_400_000 },
    ],
  }];
  const plan = buildHistoricalBackfillJob(snapshots, { snapshotCapturedAt: capturedAt, count: 2, days: 30 });
  assert.equal(plan.selection[0].symbol, "BTCUSDT");
  assert.equal(symbolBackfillRange(plan, plan.selection[0]).listingLimited, false);
  assert.equal(symbolBackfillRange(plan, plan.selection[1]).listingLimited, true);

  const synced = [];
  const result = await runHistoricalBackfillJob({
    plan,
    catalog: {
      auditCoverage: async ({ symbol }) => ({ status: symbol === "BTCUSDT" ? "COMPLETE" : "GAPS_OR_INVALID" }),
    },
    client: {},
    maxSymbols: 1,
    syncSymbol: async (input) => {
      synced.push(input.symbol);
      return { coverage: { status: "COMPLETE" } };
    },
  });
  assert.deepEqual(synced, ["NEWUSDT"]);
  assert.equal(result.attempted, 1);
  assert.equal(result.complete, 2);
  assert.deepEqual(result.listingLimited, ["NEWUSDT"]);
});

test("回填检查点在运行中按逐币结果刷新成功与失败计数", () => {
  assert.deepEqual(summarizeHistoricalBackfillResults({
    BTCUSDT: { status: "ALREADY_COMPLETE" },
    ETHUSDT: { status: "SYNCED" },
    SOLUSDT: { status: "FAILED" },
    BNBUSDT: { status: "RUNNING" },
  }), {
    successfulSymbols: 2,
    failedSymbols: 1,
  });
});

test("分钟追平固定原Top100和目标快照，且主回填未完成时拒绝启动", async () => {
  const capturedAt = Date.UTC(2026, 9, 4, 9, 30, 10);
  const snapshots = [{
    capturedAt,
    complete: true,
    items: [
      { symbol: "BTCUSDT", liquidityRank: 1, onboardDate: capturedAt - 1_000 * 86_400_000 },
      { symbol: "ETHUSDT", liquidityRank: 2, onboardDate: capturedAt - 1_000 * 86_400_000 },
    ],
  }];
  const backfillPlan = buildHistoricalBackfillJob(snapshots, { snapshotCapturedAt: capturedAt, count: 2, days: 30 });
  const incomplete = { status: "RUNNING", plan: backfillPlan, results: { BTCUSDT: { status: "SYNCED" } } };
  assert.throws(
    () => buildHistoricalCatchupJob(incomplete, snapshots),
    /HISTORICAL_BACKFILL_NOT_COMPLETE:1\/2/,
  );

  const targetCapturedAt = capturedAt + 30 * 60_000;
  const checkpoint = {
    status: "COMPLETED",
    plan: backfillPlan,
    results: { BTCUSDT: { status: "SYNCED" }, ETHUSDT: { status: "ALREADY_COMPLETE" } },
  };
  const catchupPlan = buildHistoricalCatchupJob(checkpoint, [
    ...snapshots,
    { ...snapshots[0], capturedAt: targetCapturedAt },
  ]);
  assert.deepEqual(catchupPlan.selection.map((item) => item.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(catchupPlan.catchupStartTime, backfillPlan.endTime + 1);
  assert.equal(catchupPlan.targetEndTime, Math.floor(targetCapturedAt / 60_000) * 60_000 - 1);

  const synced = [];
  const result = await runHistoricalCatchupJob({
    plan: catchupPlan,
    client: {},
    catalog: {
      async auditCoverage({ symbol, endTime }) {
        if (endTime === backfillPlan.endTime) return { status: "COMPLETE" };
        return { status: symbol === "BTCUSDT" ? "COMPLETE" : "GAPS_OR_INVALID" };
      },
    },
    syncSymbol: async (input) => {
      synced.push(input.symbol);
      return { coverage: { status: "COMPLETE" } };
    },
  });
  assert.deepEqual(synced, ["ETHUSDT"]);
  assert.equal(result.complete, 2);
  assert.deepEqual(summarizeHistoricalCatchupResults(Object.fromEntries(
    result.results.map((item) => [item.symbol, item]),
  )), { successfulSymbols: 2, blockedSymbols: 0, failedSymbols: 0 });
});
