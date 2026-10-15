import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPointInTimeWindowCoverage,
  evaluateV23ParameterStability,
  runHistoricalV23WalkForwardValidation,
  SEALED_HOLDOUT_AUTHORIZATION,
} from "../src/research/v2-3-validation.js";

function config() {
  return {
    intervals: { trend: "1h", setup: "15m", trigger: "5m", path: "1m" },
    strategy: { emaFast: 20, emaSlow: 50 },
    shadowV2: { sampleTarget: 4, explorationMinimumScore: 55 },
    marketRadar: { modelVersion: "TEST_RADAR" },
    universe: { size: 100 },
    portfolio: { startingEquity: 500, leverage: 10 },
    costs: { fallbackFeeRate: 0.0005 },
    execution: { strategySource: "V2_PRODUCTION" },
  };
}

function closedTrade(id, direction = "LONG") {
  return {
    id,
    symbol: `${id}USDT`,
    marketEventId: `${id}-event`,
    strategy: "PRE_BREAKOUT",
    direction,
    status: "CLOSED",
    signalEvaluation: {
      experimentTier: "CORE",
      explosionScore: 72,
      directionScore: 81,
      candidateSources: ["EARLY_ACCELERATION"],
    },
    pnl: { net: 1, netR: 0.5 },
    events: [{ type: "ENTRY_FILLED", at: 1 }],
  };
}

function replay({ decisionTimes }) {
  const suffix = decisionTimes[0];
  return {
    promotionEligible: true,
    metrics: { realizedNetPnl: 2, maxDrawdownPercent: 1 },
    trades: [closedTrade(`A${suffix}`), closedTrade(`B${suffix}`, "SHORT")],
  };
}

function times() {
  return Array.from({ length: 40 }, (_, index) => 1_000_000 + index * 300_000);
}

test("M5只运行走步验证窗口并默认封存最后20%样本", () => {
  const result = runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: config(),
    replayRunner: replay,
    validationOptions: { folds: 4, holdoutFraction: 0.2, minimumTrainFraction: 0.4 },
  });
  assert.equal(result.folds.length, 4);
  assert.equal(result.sealedHoldout.status, "SEALED");
  assert.equal("result" in result.sealedHoldout, false);
  assert.equal(result.validation.closed, 8);
  assert.equal(result.validation.byDirection.LONG.closed, 4);
  assert.equal(result.validation.byDirection.SHORT.closed, 4);
  assert.equal(result.validation.bySetupDirection["PRE_BREAKOUT-LONG"].closed, 4);
  assert.equal(result.validation.byCandidateSource.EARLY_ACCELERATION.closed, 8);
  assert.equal(result.validation.byExplosionScoreBand["70-79"].closed, 8);
  assert.equal(result.validation.byDirectionScoreBand["80-100"].closed, 8);
  assert.equal(result.promotionGate.passed, true);
  assert.match(result.strategyFingerprint, /^sha256:/);
});

test("M5正式闸门执行PF、平均净R和利润集中度基线", () => {
  const weakEdge = runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: config(),
    replayRunner: ({ decisionTimes }) => {
      const result = replay({ decisionTimes });
      result.trades = result.trades.map((trade) => ({ ...trade, pnl: { ...trade.pnl, netR: 0.1 } }));
      return result;
    },
  });
  assert.equal(weakEdge.promotionGate.criteria.profitFactor.required, 1.2);
  assert.equal(weakEdge.promotionGate.criteria.averageNetR.required, ">0.1");
  assert.ok(weakEdge.promotionGate.failed.includes("averageNetR"));

  const concentrated = runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: config(),
    replayRunner: ({ decisionTimes }) => {
      const result = replay({ decisionTimes });
      result.trades = result.trades.map((trade) => ({
        ...trade,
        symbol: "ONEUSDT",
        marketEventId: "one-event",
      }));
      return result;
    },
  });
  assert.equal(concentrated.validation.profitConcentration.bySymbol.maximumSharePercent, 100);
  assert.equal(concentrated.validation.profitConcentration.byMarketEvent.maximumSharePercent, 100);
  assert.ok(concentrated.promotionGate.failed.includes("symbolProfitConcentration"));
  assert.ok(concentrated.promotionGate.failed.includes("marketEventProfitConcentration"));
});

test("M5没有明确口令时不能打开封存样本", () => {
  assert.throws(() => runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: config(),
    replayRunner: replay,
    openSealedHoldout: true,
  }), /M5_OPEN_HOLDOUT_REQUIRES_EXPLICIT_AUTHORIZATION/);

  const opened = runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: config(),
    replayRunner: replay,
    openSealedHoldout: true,
    holdoutAuthorization: SEALED_HOLDOUT_AUTHORIZATION,
  });
  assert.equal(opened.sealedHoldout.status, "OPENED");
  assert.ok(opened.sealedHoldout.result.trades.length > 0);
});

test("M5晋级闸门会拒绝数据覆盖不足和样本不足", () => {
  const result = runHistoricalV23WalkForwardValidation({
    decisionTimes: times(),
    config: { ...config(), shadowV2: { sampleTarget: 100 } },
    replayRunner: ({ decisionTimes }) => ({
      ...replay({ decisionTimes }),
      promotionEligible: false,
    }),
  });
  assert.equal(result.promotionGate.passed, false);
  assert.ok(result.promotionGate.failed.includes("pointInTimeInputs"));
  assert.ok(result.promotionGate.failed.includes("sampleSize"));
});

test("M5参数稳定性要求至少三组且多数保持正期望", () => {
  const stable = evaluateV23ParameterStability([
    { label: "low", validation: { closed: 100, averageNetR: 0.1, profitFactor: 1.2, profitableFoldRate: 0.75 } },
    { label: "base", validation: { closed: 110, averageNetR: 0.2, profitFactor: 1.3, profitableFoldRate: 0.75 } },
    { label: "high", validation: { closed: 90, averageNetR: -0.02, profitFactor: 0.98, profitableFoldRate: 0.5 } },
  ]);
  assert.equal(stable.stable, true);
  assert.equal(stable.positiveVariantCount, 2);
  const unavailable = evaluateV23ParameterStability([{ label: "empty", validation: { profitFactor: null } }]);
  assert.equal(unavailable.variants[0].profitFactor, null);
});

test("M5预检把尚未积累的逐时点事实报告为阻断而不是回测异常", () => {
  const decisionTimes = [100_000, 400_000, 700_000];
  const coverage = assessPointInTimeWindowCoverage({
    decisionTimes,
    contractRecords: [{ capturedAt: 350_000 }],
    marketCoverageSnapshots: [
      { asOf: 390_000, complete: true, eligibleCount: 100 },
      { asOf: 690_000, complete: true, eligibleCount: 100 },
    ],
    config: {
      marketRadar: { discoverySize: 100, refreshMinutes: 5 },
      universe: { refreshHours: 1 },
    },
  });
  assert.equal(coverage.ready, false);
  assert.equal(coverage.requestedDecisionPoints, 3);
  assert.equal(coverage.eligibleDecisionPoints, 2);
  assert.equal(coverage.blockers.contractUnavailable, 1);
  assert.equal(coverage.blockers.marketUnavailable, 1);
  assert.equal(coverage.firstEligibleAt, 400_000);
});
