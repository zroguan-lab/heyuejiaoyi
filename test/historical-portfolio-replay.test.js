import test from "node:test";
import assert from "node:assert/strict";
import { runHistoricalV23PortfolioReplay } from "../src/research/historical-portfolio-replay.js";

function minute(openTime, { open = 100, high = 101, low = 99, close = 100 } = {}) {
  return { openTime, closeTime: openTime + 59_999, open, high, low, close, volume: 100, quoteVolume: 10_000, trades: 10 };
}

function candidate(symbol, triggerTime, {
  score = 80,
  targetNotional = 125,
  targetMargin = 12.5,
  targetQuantity = 1.25,
} = {}) {
  return {
    id: `${symbol}-${triggerTime}`,
    symbol,
    strategy: "PRE_BREAKOUT",
    direction: "LONG",
    status: "CANDIDATE",
    triggerTime,
    order: { entry: 100, expiresAt: triggerTime + 10 * 60_000, style: "ACTIVE_DYNAMIC" },
    risk: { entry: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 105 },
    shadowV2: {
      eligible: true,
      orderSubmissionAllowed: false,
      score,
      experimentTier: "CORE",
      fixedRiskPlan: {
        valid: true,
        modelVersion: "FIXED_RISK_V1",
        equity: 500,
        targetRiskPercent: 0.5,
        targetRiskAmount: 2.5,
        targetNotional,
        targetMargin,
        targetQuantity,
        leverage: 10,
      },
    },
  };
}

function config() {
  return {
    portfolio: { startingEquity: 500, leverage: 10 },
    shadowV2: { explorationMinimumScore: 55 },
    costs: { fallbackFeeRate: 0, fallbackSlippageRate: 0, activeLimitMaxBps: 10 },
  };
}

test("M4用下一分钟开盘检查IOC边界并按固定风险同时运行多个标的", () => {
  const decisionTime = 59_999;
  const marketData = {
    BTCUSDT: [
      minute(0),
      minute(60_000, { open: 100.05, high: 101, low: 99.5, close: 100.5 }),
      minute(120_000, { open: 100.5, high: 106, low: 100, close: 105 }),
    ],
    ETHUSDT: [
      minute(0),
      minute(60_000, { open: 100.02, high: 101, low: 99.5, close: 100.5 }),
      minute(120_000, { open: 100.5, high: 106, low: 100, close: 105 }),
    ],
  };
  const result = runHistoricalV23PortfolioReplay({
    marketData,
    contractRecords: [],
    fundingBySymbol: {
      BTCUSDT: [{ fundingTime: 120_000, rate: 0.001, markPrice: 100 }],
    },
    decisionTimes: [decisionTime],
    endTime: 179_999,
    config: config(),
    decisionRunner: ({ decisionTime: at }) => ({
      radar: { snapshotId: `radar-${at}` },
      promotionEligible: true,
      decisions: [
        { decision: { candidates: [candidate("BTCUSDT", at)] } },
        { decision: { candidates: [candidate("ETHUSDT", at, { score: 79 })] } },
      ],
    }),
  });

  assert.equal(result.trades.length, 2);
  assert.ok(result.trades.every((trade) => trade.status === "CLOSED"));
  assert.ok(result.trades.every((trade) => trade.positionSizing.modelVersion === "FIXED_RISK_V1"));
  assert.ok(result.trades.every((trade) => trade.events.some((event) => event.executionMode === "MARKETABLE_LIMIT_IOC")));
  assert.equal(result.trades.find((trade) => trade.symbol === "BTCUSDT").costs.funding, 0.125);
  assert.equal(result.metrics.ordersCreated, 2);
  assert.equal(result.metrics.closed, 2);
  assert.ok(result.metrics.endingEquity > 500);
  assert.equal(result.decisions[0].selected.length, 2);
  assert.equal(result.assumptions.positionLimit, null);
  assert.equal(result.promotionEligible, false);
  assert.deepEqual(result.researchOnlyReasons, ["HISTORICAL_ORDERBOOK_AND_QUEUE_POSITION_UNAVAILABLE"]);
});

test("M4取消超过滑点边界的IOC且不会把未成交记为亏损", () => {
  const decisionTime = 59_999;
  const result = runHistoricalV23PortfolioReplay({
    marketData: {
      BTCUSDT: [minute(0), minute(60_000, { open: 100.2, high: 101, low: 99, close: 100 })],
    },
    contractRecords: [],
    decisionTimes: [decisionTime],
    endTime: 119_999,
    config: config(),
    decisionRunner: ({ decisionTime: at }) => ({
      radar: { snapshotId: `radar-${at}` },
      promotionEligible: false,
      decisions: [{ decision: { candidates: [candidate("BTCUSDT", at)] } }],
    }),
  });

  assert.equal(result.trades[0].status, "EXPIRED");
  assert.equal(result.trades[0].exitReason, "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET");
  assert.equal(result.trades[0].pnl.net, 0);
  assert.equal(result.metrics.canceledOrExpired, 1);
  assert.equal(result.metrics.losses, 0);
  assert.ok(result.researchOnlyReasons.includes("POINT_IN_TIME_MARKET_COVERAGE_INCOMPLETE"));
});

test("M4不设持仓笔数上限但拒绝超过真实可用权益的保证金", () => {
  const decisionTime = 59_999;
  const marketData = {
    BTCUSDT: [minute(0), minute(60_000)],
    ETHUSDT: [minute(0), minute(60_000)],
  };
  const result = runHistoricalV23PortfolioReplay({
    marketData,
    contractRecords: [],
    decisionTimes: [decisionTime],
    endTime: 119_999,
    config: config(),
    decisionRunner: ({ decisionTime: at }) => ({
      radar: { snapshotId: `radar-${at}` },
      promotionEligible: true,
      decisions: [{ decision: { candidates: [
        candidate("BTCUSDT", at, { score: 90, targetNotional: 6_000, targetMargin: 600, targetQuantity: 60 }),
        candidate("ETHUSDT", at, { score: 80 }),
      ] } }],
    }),
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].symbol, "ETHUSDT");
  assert.equal(result.rejected.find((item) => item.symbol === "BTCUSDT").reason, "INSUFFICIENT_MARGIN");
});

test("M4把逐时点市场覆盖快照完整传给M3决策层", () => {
  const decisionTime = 59_999;
  const marketCoverageSnapshots = [{
    asOf: decisionTime,
    complete: true,
    eligibleCount: 100,
    source: "TEST_POINT_IN_TIME_UNIVERSE",
  }];
  const result = runHistoricalV23PortfolioReplay({
    marketData: { BTCUSDT: [minute(0), minute(60_000)] },
    contractRecords: [],
    decisionTimes: [decisionTime],
    endTime: 119_999,
    config: config(),
    marketCoverageSnapshots,
    decisionRunner: ({ marketCoverageSnapshots: received }) => ({
      radar: { snapshotId: "radar-with-point-in-time-coverage" },
      promotionEligible: received === marketCoverageSnapshots,
      decisions: [],
    }),
  });

  assert.equal(result.decisions[0].promotionEligible, true);
  assert.ok(!result.researchOnlyReasons.includes("POINT_IN_TIME_MARKET_COVERAGE_INCOMPLETE"));
});

test("V2.4.3把BOUNDARY_PRESSURE-only放入独立反事实账且不占主组合权益", () => {
  const decisionTime = 59_999;
  const boundary = candidate("BTCUSDT", decisionTime);
  boundary.marketRadar = { opportunitySources: ["RETAINED", "BOUNDARY_PRESSURE"] };
  boundary.shadowV2 = {
    ...boundary.shadowV2,
    eligible: false,
    hardRejectionReasons: ["V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE"],
    rejectionReasons: ["V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE"],
  };
  const result = runHistoricalV23PortfolioReplay({
    marketData: {
      BTCUSDT: [
        minute(0),
        minute(60_000, { open: 100, high: 101, low: 99.5, close: 100.5 }),
        minute(120_000, { open: 100.5, high: 106, low: 100, close: 105 }),
      ],
    },
    contractRecords: [],
    decisionTimes: [decisionTime],
    endTime: 179_999,
    config: config(),
    decisionRunner: () => ({
      radar: { snapshotId: "boundary-only" },
      promotionEligible: true,
      decisions: [{ decision: { candidates: [boundary] } }],
    }),
  });

  assert.equal(result.trades.length, 0);
  assert.equal(result.metrics.ordersCreated, 0);
  assert.equal(result.metrics.endingEquity, 500);
  assert.equal(result.counterfactualTrades.length, 1);
  assert.equal(result.counterfactualTrades[0].counterfactual, true);
  assert.equal(result.counterfactualTrades[0].portfolio, "V2_4_3_BOUNDARY_COUNTERFACTUAL");
  assert.equal(result.researchAttribution.counterfactualBoundaryOnly.opportunitySources.combinations[0].combination, "BOUNDARY_PRESSURE + RETAINED");
});
