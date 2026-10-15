import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeV23SignalSnapshot,
  buildV23StrategySnapshot,
  runV23StrategyAdapter,
  V23_HISTORICAL_ADAPTER,
  V23_LIVE_ADAPTER,
  v23DecisionFingerprint,
} from "../src/domain/v2-3-strategy-engine.js";
import {
  runV24StrategyAdapter,
  V24_HISTORICAL_ADAPTER,
  V24_LIVE_ADAPTER,
  V24_STRATEGY_CONTRACT_VERSION,
  v24DecisionFingerprint,
} from "../src/domain/v2-4-strategy-engine.js";
import { MARKET_RADAR_VERSION } from "../src/domain/market-radar.js";
import { analyzePreMove } from "../src/domain/pre-move-strategy.js";
import { strategyConfig } from "./helpers.js";

function fullConfig() {
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
      discoverySize: 100,
      deepScanSize: 30,
    },
    universe: { dynamic: true, size: 30, minListingDays: 90, maxSpreadBps: 20 },
    portfolio: { startingEquity: 500, leverage: 10, marginPerTrade: 10, positionMode: "ONE_WAY" },
    costs: { fallbackFeeRate: 0.0005, fallbackSlippageRate: 0.0002, activeLimitMaxBps: 10 },
    execution: {
      strategySource: "V2_PRODUCTION",
      positionPolicy: "V2_3_PREMOVE_ALL_ELIGIBLE",
      autoExecutionEnabled: true,
      orderSubmissionEnabled: true,
    },
  };
}

function trendCandles(count, intervalMs, endTime, step = 0.1) {
  const firstOpen = endTime - count * intervalMs + 1;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * step + Math.sin(index * Math.PI / 5) * 0.3;
    const openTime = firstOpen + index * intervalMs;
    return {
      openTime,
      closeTime: openTime + intervalMs - 1,
      open: close - 0.05,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 100,
      quoteVolume: 10_000,
    };
  });
}

function compressedCandles(count, intervalMs, endTime, { volumeLift = false } = {}) {
  const firstOpen = endTime - count * intervalMs + 1;
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.02;
    const narrow = index >= count - 4;
    const width = narrow ? 0.12 : 0.5;
    const openTime = firstOpen + index * intervalMs;
    return {
      openTime,
      closeTime: openTime + intervalMs - 1,
      open: close - 0.02,
      high: close + width,
      low: close - width,
      close,
      volume: volumeLift && index >= count - 3 ? 180 : 100,
      quoteVolume: volumeLift && index >= count - 3 ? 18_000 : 10_000,
    };
  });
}

function decisionSnapshot() {
  const decisionTime = Date.UTC(2026, 9, 4, 12, 0, 0) - 1;
  return {
    symbol: "BTCUSDT",
    decisionTime,
    hourly: trendCandles(160, 3_600_000, decisionTime),
    fifteen: compressedCandles(160, 900_000, decisionTime),
    five: compressedCandles(160, 300_000, decisionTime, { volumeLift: true }),
    radar: {
      version: MARKET_RADAR_VERSION,
      schemaRevision: 4,
      snapshotId: "radar-fixed",
      generatedAt: new Date(decisionTime).toISOString(),
      moverDataClosedAt: decisionTime,
      selected: true,
      radarTier: "CORE",
      radarScore: 80,
      bias: "LONG",
      marketDirection: "LONG",
      relativeStrengthMarket1h: 1,
      opportunitySources: ["EARLY_ACCELERATION"],
    },
    universeItem: { symbol: "BTCUSDT", quoteVolume24h: 1_000_000_000, spreadBps: 1 },
    universeIndex: 0,
    universeSize: 30,
    primarySource: "binance",
    marketRegime: { version: "MARKET_REGIME_V1", direction: "LONG", breadthAgrees: true },
    premium: {
      markPrice: 103,
      lastFundingRate: 0.0001,
      nextFundingTime: decisionTime + 3_600_000,
    },
    equity: 500,
  };
}

test("V2.3策略快照对同一配置生成稳定指纹且不包含捕获时间", () => {
  const config = fullConfig();
  const first = buildV23StrategySnapshot(config, { capturedAt: 1_000 });
  const second = buildV23StrategySnapshot(config, { capturedAt: 2_000 });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.capturedAt, second.capturedAt);
  assert.equal(Object.isFrozen(first.parameters.strategy), true);

  const changed = fullConfig();
  changed.strategy.preMoveMinimumDirectionScore += 1;
  assert.notEqual(first.fingerprint, buildV23StrategySnapshot(changed, { capturedAt: 1_000 }).fingerprint);
});

test("同一V2.3快照经Demo与历史适配器产生完全一致的策略决策", () => {
  const config = fullConfig();
  const snapshot = decisionSnapshot();
  const live = runV23StrategyAdapter({ adapter: V23_LIVE_ADAPTER, snapshot, config });
  const historical = runV23StrategyAdapter({ adapter: V23_HISTORICAL_ADAPTER, snapshot, config });

  assert.equal(live.decision.status, "CANDIDATE");
  assert.equal(live.decision.candidates[0].strategy, "PRE_BREAKOUT");
  assert.deepEqual(live.decision, historical.decision);
  assert.equal(v23DecisionFingerprint(live), v23DecisionFingerprint(historical));
  assert.equal(live.decision.candidates[0].shadowV2.evaluatedAt, snapshot.decisionTime);
});

test("V2.4.3 Live与Historical Replay调用同一策略合同并产生相同决策", () => {
  const config = fullConfig();
  config.shadowV2.strategyVersion = "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER";
  const snapshot = decisionSnapshot();
  const live = runV24StrategyAdapter({ adapter: V24_LIVE_ADAPTER, snapshot, config });
  const historical = runV24StrategyAdapter({ adapter: V24_HISTORICAL_ADAPTER, snapshot, config });
  assert.equal(live.contractVersion, V24_STRATEGY_CONTRACT_VERSION);
  assert.equal(historical.contractVersion, V24_STRATEGY_CONTRACT_VERSION);
  assert.deepEqual(live.decision, historical.decision);
  assert.equal(v24DecisionFingerprint(live), v24DecisionFingerprint(historical));
});

test("统一V2.3引擎保留重构前实时信号与流动性补充行为", () => {
  const config = fullConfig();
  const snapshot = decisionSnapshot();
  const legacy = analyzePreMove({
    symbol: snapshot.symbol,
    hourly: snapshot.hourly,
    fifteen: snapshot.fifteen,
    five: snapshot.five,
    radar: snapshot.radar,
    config: config.strategy,
    now: snapshot.decisionTime,
  });
  legacy.candidates = legacy.candidates.map((candidate) => {
    const entry = candidate.order.entry;
    const riskRate = Math.abs(entry - candidate.risk.stopLoss) / entry;
    const estimatedRoundTripRate = 2 * (config.costs.fallbackFeeRate + config.costs.fallbackSlippageRate);
    return {
      ...candidate,
      estimatedCostR: estimatedRoundTripRate / riskRate,
      liquidityScore: 5,
      liquidity: { quoteVolume24h: 1_000_000_000, spreadBps: 1, universeRank: 1 },
      marketRadar: snapshot.radar,
      primarySource: snapshot.primarySource,
      auxiliaryCheck: null,
    };
  });
  legacy.source = snapshot.primarySource;

  const unified = analyzeV23SignalSnapshot(snapshot, {
    strategyConfig: config.strategy,
    costsConfig: config.costs,
  });
  const { strategyContractVersion, decisionTime, ...comparable } = unified;
  assert.equal(strategyContractVersion, "V2_3_STRATEGY_CONTRACT_R1");
  assert.equal(decisionTime, snapshot.decisionTime);
  assert.deepEqual(comparable, legacy);
});

test("V2.3历史适配器发现未来K线时直接拒绝而不是静默使用", () => {
  const config = fullConfig();
  const snapshot = decisionSnapshot();
  snapshot.five = [...snapshot.five, {
    ...snapshot.five.at(-1),
    openTime: snapshot.decisionTime + 1,
    closeTime: snapshot.decisionTime + 300_000,
  }];
  assert.throws(
    () => runV23StrategyAdapter({ adapter: V23_HISTORICAL_ADAPTER, snapshot, config }),
    /V2_3_LOOKAHEAD_DETECTED/,
  );
});

test("V2.3历史适配器发现未来雷达快照时直接拒绝", () => {
  const config = fullConfig();
  const snapshot = decisionSnapshot();
  snapshot.radar = { ...snapshot.radar, moverDataClosedAt: snapshot.decisionTime + 1 };
  assert.throws(
    () => runV23StrategyAdapter({ adapter: V23_HISTORICAL_ADAPTER, snapshot, config }),
    /V2_3_LOOKAHEAD_DETECTED/,
  );
});
