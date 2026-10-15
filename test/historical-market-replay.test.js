import test from "node:test";
import assert from "node:assert/strict";
import { MARKET_RADAR_VERSION } from "../src/domain/market-radar.js";
import {
  aggregateClosedKlines,
  buildHistoricalRadarPoint,
  loadHistoricalReplayInputs,
  RESEARCH_CURRENT_METADATA,
  resolveHistoricalReplayWindow,
  runHistoricalV23Point,
  runHistoricalV23Timeline,
} from "../src/research/historical-market-replay.js";
import { strategyConfig } from "./helpers.js";

function config({ discoverySize = 100, deepScanSize = 30 } = {}) {
  return {
    intervals: { trend: "1h", setup: "15m", trigger: "5m", path: "1m" },
    strategy: {
      ...strategyConfig,
      preMoveMaxBoundaryDistanceAtr: 1.2,
      preMoveMaxCompressionRatio: 1.25,
      preMoveMinimumExplosionScore: 35,
      preMoveMinimumDirectionScore: 40,
    },
    shadowV2: {
      strategyVersion: "PRE_MOVE_1H_15M_5M_V2_3",
      targetRiskPercent: 0.5,
      expectedHoldingHours: 12,
      maxCostR: 0.2,
      maxFundingCostR: 0.1,
      extremeCostR: 0.35,
      extremeFundingCostR: 0.2,
      coreMinimumScore: 70,
      explorationMinimumScore: 55,
      preMoveHardMinimumExplosionScore: 35,
      preMoveHardMinimumDirectionScore: 42,
    },
    marketRadar: {
      enabled: true,
      requiredForV2: true,
      modelVersion: MARKET_RADAR_VERSION,
      refreshMinutes: 5,
      minimumHoldMinutes: 30,
      discoverySize,
      deepScanSize,
      coreMinimumScore: 68,
      moverCandleLimit: 33,
      gainerCount: 15,
      loserCount: 15,
      rankVelocityCount: 10,
      volumeShockCount: 10,
      minimumVolumeShockRatio: 1.2,
      compressionCount: 15,
      boundaryPressureCount: 15,
      earlyAccelerationCount: 10,
    },
    universe: { dynamic: true, size: 30, minListingDays: 0, maxSpreadBps: 20 },
    portfolio: { startingEquity: 500, marginPerTrade: 10, leverage: 10, positionMode: "ONE_WAY" },
    costs: { fallbackFeeRate: 0.0005, fallbackSlippageRate: 0.0002, activeLimitMaxBps: 10 },
    execution: { strategySource: "V2_PRODUCTION", positionPolicy: "V2_3_PREMOVE_ALL_ELIGIBLE" },
  };
}

function minuteSeries({ start, count = 4_500, slope = 0.002, volume = 100, acceleration = 0 } = {}) {
  let price = 100;
  return Array.from({ length: count }, (_, index) => {
    const late = index >= count - 60 ? acceleration : 0;
    const open = price;
    price = Math.max(1, price + slope + late + Math.sin(index / 13) * 0.001);
    const close = price;
    const openTime = start + index * 60_000;
    const rowVolume = volume + (index % 11) + (index >= count - 3 ? 30 : 0);
    return {
      openTime,
      open,
      high: Math.max(open, close) + 0.03,
      low: Math.min(open, close) - 0.03,
      close,
      volume: rowVolume,
      closeTime: openTime + 59_999,
      quoteVolume: rowVolume * close,
      trades: 10 + (index % 5),
    };
  });
}

function fixtures() {
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  const marketData = {
    BTCUSDT: minuteSeries({ start, slope: 0.001 }),
    ETHUSDT: minuteSeries({ start, slope: 0.002, acceleration: 0.002 }),
    SOLUSDT: minuteSeries({ start, slope: -0.001, acceleration: -0.001 }),
  };
  const decisionTime = marketData.BTCUSDT.at(-1).closeTime;
  const capturedAt = start - 1;
  const contractRecords = Object.keys(marketData).map((symbol) => ({
    capturedAt,
    symbol,
    contractType: "PERPETUAL",
    status: "TRADING",
    baseAsset: symbol.replace("USDT", ""),
    quoteAsset: "USDT",
    onboardDate: start - 365 * 86_400_000,
  }));
  const spreadSnapshots = Object.fromEntries(Object.keys(marketData).map((symbol) => [symbol, [{ time: decisionTime, spreadBps: 2 }]]));
  return { start, marketData, decisionTime, contractRecords, spreadSnapshots };
}

test("历史聚合只生成分钟完整且在决策时间前收盘的K线", () => {
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  const complete = minuteSeries({ start, count: 30 });
  const missing = complete.filter((_, index) => index !== 5);
  assert.equal(aggregateClosedKlines(missing, 15 * 60_000, { decisionTime: complete.at(-1).closeTime }).length, 1);
  assert.equal(aggregateClosedKlines(complete, 15 * 60_000, { decisionTime: complete[14].closeTime }).length, 1);
});

test("严格模式拒绝使用决策时间之后采集的合约快照", () => {
  const input = fixtures();
  const futureContracts = input.contractRecords.map((item) => ({ ...item, capturedAt: input.decisionTime + 1 }));
  assert.throws(
    () => buildHistoricalRadarPoint({ ...input, contractRecords: futureContracts, config: config() }),
    /HISTORICAL_POINT_IN_TIME_CONTRACT_SNAPSHOT_UNAVAILABLE/,
  );
  const research = buildHistoricalRadarPoint({
    ...input,
    contractRecords: futureContracts,
    config: config(),
    metadataPolicy: RESEARCH_CURRENT_METADATA,
  });
  assert.equal(research.snapshot.reconstruction.survivorshipBias, true);
  assert.equal(research.snapshot.reconstruction.contractSnapshotAgeMs, null);
  assert.equal(research.snapshot.reconstruction.contractSnapshotFutureLeadMs, 1);
  assert.equal(research.snapshot.reconstruction.promotionEligible, false);
});

test("M3按历史时点重建雷达并通过统一V2.3历史适配器生成决策", () => {
  const input = fixtures();
  const replayConfig = config({ discoverySize: 3, deepScanSize: 3 });
  const replaySpreads = Object.fromEntries(Object.keys(input.marketData).map((symbol) => [symbol, [
    { time: input.decisionTime - 15 * 60_000, spreadBps: 2 },
    { time: input.decisionTime, spreadBps: 2 },
  ]]));
  const [first, result] = runHistoricalV23Timeline({
    ...input,
    decisionTimes: [input.decisionTime - 15 * 60_000, input.decisionTime],
    config: replayConfig,
    spreadSnapshots: replaySpreads,
    marketCoverage: { complete: true, asOf: input.start, source: "TEST_COMPLETE_UNIVERSE" },
  });
  assert.equal(result.radar.previousSnapshotId, first.radar.snapshotId);
  assert.equal(result.radar.reconstruction.promotionEligible, true);
  assert.ok(result.radar.leaders.length > 0);
  assert.ok(result.radar.laggards.length > 0);
  assert.ok(result.radar.selectedSymbols.includes("BTCUSDT"));
  assert.ok(result.decisions.length > 0);
  assert.ok(result.decisions.every((item) => item.adapter === "HISTORICAL_REPLAY"));
  assert.ok(result.decisions.every((item) => item.decision.decisionTime === input.decisionTime));
  assert.ok(result.radar.items.every((item) => item.moverDataClosedAt <= input.decisionTime));
});

test("缺少历史盘口时采用保守点差代理且结果禁止晋级", () => {
  const input = fixtures();
  const point = buildHistoricalRadarPoint({ ...input, spreadSnapshots: null, config: config() });
  assert.equal(point.snapshot.reconstruction.spreadModel, "CONSERVATIVE_MAX_BPS_PROXY");
  assert.equal(point.snapshot.reconstruction.promotionEligible, false);
  assert.equal(point.snapshot.reconstruction.marketCoverageComplete, false);
  assert.equal(point.snapshot.reconstruction.marketCoverageDeclared, false);
  assert.ok(point.universe.every((item) => item.spreadBps === 20));
});

test("历史加载器把全市场快照投影为逐时点点差和覆盖声明", async () => {
  const input = fixtures();
  const universeSnapshot = {
    capturedAt: input.decisionTime,
    complete: true,
    discoverySize: 3,
    eligibleCount: 3,
    items: Object.keys(input.marketData).map((symbol, index) => ({
      symbol,
      spreadBps: index + 1,
      bidPrice: 99,
      askPrice: 100,
      liquidityRank: index + 1,
    })),
  };
  const queries = [];
  const catalog = {
    async availableSymbols() { return Object.keys(input.marketData); },
    async queryRecords(query) {
      queries.push(query);
      const { dataType, symbol } = query;
      if (dataType === "KLINES") return input.marketData[symbol];
      if (dataType === "CONTRACTS") return input.contractRecords;
      if (dataType === "UNIVERSE") return [universeSnapshot];
      return [];
    },
  };
  const startTime = input.decisionTime - 86_400_000;
  const loaded = await loadHistoricalReplayInputs({ catalog, startTime, endTime: input.decisionTime });
  const klineQuery = queries.find((item) => item.dataType === "KLINES");
  assert.equal(klineQuery.startTime, startTime);
  assert.equal(klineQuery.endTime, input.decisionTime);
  assert.equal(loaded.spreadSnapshots.BTCUSDT[0].time, input.decisionTime);
  assert.equal(loaded.marketCoverageSnapshots[0].eligibleCount, 3);
  const result = runHistoricalV23Point({
    ...loaded,
    decisionTime: input.decisionTime,
    config: config({ discoverySize: 3, deepScanSize: 3 }),
  });
  assert.equal(result.radar.reconstruction.marketCoverageSource, "BINANCE_POINT_IN_TIME_UNIVERSE_SNAPSHOT");
  assert.equal(result.radar.reconstruction.exactSpreadCount, 3);
  assert.equal(result.promotionEligible, true);
});

test("历史重放窗口从目录摘要确定共同终点并只加载所需预热区间", async () => {
  const lastOpen = Date.UTC(2026, 9, 4, 9, 29);
  const catalog = {
    async availableSymbols() { return ["BTCUSDT", "ETHUSDT"]; },
    async availableCoverageRanges() {
      return [
        { symbol: "BTCUSDT", firstTime: lastOpen - 30 * 86_400_000, lastTime: lastOpen },
        { symbol: "ETHUSDT", firstTime: lastOpen - 30 * 86_400_000, lastTime: lastOpen - 60_000 },
      ];
    },
  };
  const replay = await resolveHistoricalReplayWindow({
    catalog,
    decisionPoints: 3,
    stepMs: 5 * 60_000,
    warmupMs: 24 * 3_600_000,
  });
  assert.equal(replay.decisionEndTime, lastOpen - 1);
  assert.equal(replay.decisionStartTime, lastOpen - 1 - 10 * 60_000);
  assert.equal(replay.loadStartTime, replay.decisionStartTime - 24 * 3_600_000);
  assert.deepEqual(replay.symbols, ["BTCUSDT", "ETHUSDT"]);
});
