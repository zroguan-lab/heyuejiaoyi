import test from "node:test";
import assert from "node:assert/strict";
import { buildV23DemoBaseline, renderV23DemoBaselineMarkdown } from "../src/research/v2-3-demo-baseline.js";

const epoch = {
  id: "V2.3-test",
  strategySource: "V2_PRODUCTION",
  strategyVersion: "PRE_MOVE_1H_15M_5M_V2_3_DEMO_20261003",
  startedAt: 1_000,
  startingEquity: 500,
};

function trade(id, overrides = {}) {
  return {
    id,
    signalId: `signal-${id}`,
    sourceType: "SIGNAL",
    executionSource: epoch.strategySource,
    strategyVersion: epoch.strategyVersion,
    performanceEligible: true,
    status: "CLOSED",
    accountingComplete: true,
    createdAt: 2_000,
    openedAt: 2_100,
    closedAt: 3_000,
    symbol: "BTCUSDT",
    direction: "LONG",
    experimentTier: "EXPLORATION",
    score: 60,
    marketEventId: "event-1",
    marketRadar: { marketDirection: "LONG", opportunitySources: ["VOLATILITY_COMPRESSION"], tags: ["TIGHT_SPREAD"] },
    qualityObservations: [],
    exitRole: "stop",
    realizedPnl: -0.9,
    commission: 0.1,
    fundingPnl: 0,
    netPnl: -1,
    netR: -1,
    riskAmount: 1,
    entrySlippageCost: 0.02,
    ...overrides,
  };
}

test("V2.3正式基线只纳入当前纪元内账务完整且截止时间前的交易", () => {
  const validLoss = trade("loss");
  const validWin = trade("win", {
    closedAt: 4_000,
    symbol: "ETHUSDT",
    direction: "SHORT",
    experimentTier: "CORE",
    score: 72,
    exitRole: "takeProfit2",
    realizedPnl: 2.1,
    commission: 0.1,
    netPnl: 2,
    netR: 2,
    qualityObservations: ["COST_R_ABOVE_CORE_BUDGET"],
  });
  const report = buildV23DemoBaseline({
    trades: [
      validLoss,
      validWin,
      trade("pending", { status: "OPEN_PROTECTED", accountingComplete: false }),
      trade("future", { closedAt: 6_000 }),
      trade("old", { strategyVersion: "OLD" }),
      trade("excluded", { performanceEligible: false }),
    ],
    epoch,
    asOf: 5_000,
    generatedAt: 5_001,
  });

  assert.equal(report.sample.selectedTradeCount, 2);
  assert.deepEqual(report.sample.tradeIds, ["loss", "win"]);
  assert.equal(report.overall.totalNetPnlUsdt, 1);
  assert.equal(report.overall.averageNetR, 0.5);
  assert.equal(report.overall.profitFactor, 2);
  assert.equal(report.accounting.reconciliation.mismatchCount, 0);
  assert.equal(report.profitabilityGate.eligible, false);
  assert.match(renderV23DemoBaselineMarkdown(report), /正式基线已冻结/);
});

test("V2.3基线样本哈希不受输入顺序影响且成本组独立归因", () => {
  const lowCost = trade("a", { closedAt: 3_000 });
  const highCost = trade("b", { closedAt: 4_000, qualityObservations: ["COST_R_ABOVE_CORE_BUDGET"] });
  const first = buildV23DemoBaseline({ trades: [lowCost, highCost], epoch, asOf: 5_000, generatedAt: 6_000 });
  const second = buildV23DemoBaseline({ trades: [highCost, lowCost], epoch, asOf: 5_000, generatedAt: 7_000 });

  assert.equal(first.sample.sampleHash, second.sample.sampleHash);
  assert.deepEqual(first.attribution.costQuality.map((item) => [item.key, item.tradeCount]), [
    ["WITHIN_CORE_BUDGET", 1],
    ["ABOVE_CORE_BUDGET", 1],
  ]);
});
