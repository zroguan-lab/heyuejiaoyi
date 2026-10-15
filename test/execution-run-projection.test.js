import test from "node:test";
import assert from "node:assert/strict";
import { projectExecutionRun, projectExecutionRuns } from "../src/execution/execution-run-projection.js";

test("真实策略执行记录投影 Binance 成交、金额与净盈亏", () => {
  const run = {
    id: "canary-signal-1",
    signalId: "signal-1",
    sourceType: "SIGNAL",
    performanceEligible: true,
    symbol: "BTCUSDT",
    status: "CLOSED",
    updatedAt: 3_100,
    plan: {
      sourceType: "SIGNAL",
      direction: "LONG",
      entrySide: "BUY",
      exitSide: "SELL",
      quantity: "0.0012",
      leverage: 10,
      marginMode: "ISOLATED",
      marginTarget: 10,
      strategy: "BREAKOUT",
      strategyVersion: "MTF_1H_15M_5M_V1",
      signalModelVersion: "MTF_1H_15M_5M_V2_1_DUAL_TIER",
      experimentTier: "EXPLORATION",
      costCohort: "HIGH_COST_EXPLORATION",
      demoPromotion: { policyVersion: "V2_4_1_TIERED_COST_GATE_R2", totalCostR: 0.28 },
      qualityObservations: ["COST_R_ABOVE_CORE_BUDGET"],
      score: 84,
      marketEventId: "market-test",
      riskAmountEstimate: 1,
      prices: { entry: "85000" },
      entryPolicy: { mode: "MARKETABLE_LIMIT_IOC", timeInForce: "IOC" },
      orderReasons: { entry: "1小时趋势与结构方向一致，15分钟突破结构高点，因此开仓做多。" },
    },
    entryOrder: { orderId: "entry-1", executedQuantity: 0.0012, averagePrice: null, price: 85_000, updateTime: 1_900 },
    entryExecution: {
      mode: "MARKETABLE_LIMIT_IOC", timeInForce: "IOC", submittedLimitPrice: "85085",
      referencePrice: 85_000, spreadBps: 0.12, submittedAt: 1_800, completedAt: 1_900,
    },
    executionMetrics: { slippageBps: 0, submittedLimitPrice: 85_085, timeToFillMs: 100 },
    performance: { mfePnl: 0.5, maePnl: -0.25, mfeR: 0.5, maeR: -0.25, samples: 8 },
    result: {
      commission: 0.08,
      realizedPnl: 0.12,
      fundingPnl: -0.01,
      netPnl: 0.03,
      exitReason: "价格达到第二计划目标，因此平掉剩余仓位。",
      trades: [
        { orderId: "entry-1", side: "BUY", price: 85_000, quantity: 0.0012, quoteQuantity: 102, time: 2_000 },
        { orderId: "exit-1", side: "SELL", price: 85_100, quantity: 0.0012, quoteQuantity: 102.12, time: 3_000 },
      ],
    },
  };
  const signal = { candidate: { id: "signal-1", strategy: "BREAKOUT", score: 84, reasons: ["1小时趋势与结构一致"] } };

  const projected = projectExecutionRun(run, signal);

  assert.equal(projected.signalDriven, true);
  assert.equal(projected.performanceEligible, true);
  assert.equal(projected.strategy, "BREAKOUT");
  assert.equal(projected.score, 84);
  assert.equal(projected.entryReason, "1小时趋势与结构方向一致，15分钟突破结构高点，因此开仓做多。");
  assert.equal(projected.reason, projected.entryReason);
  assert.equal(projected.strategyVersion, "MTF_1H_15M_5M_V1");
  assert.equal(projected.signalModelVersion, "MTF_1H_15M_5M_V2_1_DUAL_TIER");
  assert.equal(projected.experimentTier, "EXPLORATION");
  assert.equal(projected.costCohort, "HIGH_COST_EXPLORATION");
  assert.equal(projected.demoPromotion.totalCostR, 0.28);
  assert.deepEqual(projected.qualityObservations, ["COST_R_ABOVE_CORE_BUDGET"]);
  assert.equal(projected.marketEventId, "market-test");
  assert.equal(projected.action, "BUY_LONG");
  assert.equal(projected.quantity, 0.0012);
  assert.ok(Math.abs(projected.entryPrice - 85_000) < 1e-8);
  assert.equal(projected.entryExecutionMode, "MARKETABLE_LIMIT_IOC");
  assert.equal(projected.entryTimeInForce, "IOC");
  assert.equal(projected.plannedEntryPrice, 85_000);
  assert.equal(projected.submittedLimitPrice, 85_085);
  assert.equal(projected.entrySpreadBps, 0.12);
  assert.equal(projected.entryWaitMs, 100);
  assert.ok(Math.abs(projected.exitPrice - 85_100) < 1e-8);
  assert.equal(projected.notional, 102);
  assert.equal(projected.actualMarginEstimate, 10.2);
  assert.equal(projected.openedAt, 2_000);
  assert.equal(projected.closedAt, 3_000);
  assert.equal(projected.realizedPnl, 0.12);
  assert.equal(projected.commission, 0.08);
  assert.equal(projected.fundingPnl, -0.01);
  assert.equal(projected.netPnl, 0.03);
  assert.equal(projected.netR, 0.03);
  assert.equal(projected.mfeR, 0.5);
  assert.equal(projected.maeR, -0.25);
  assert.equal(projected.excursionSamples, 8);
  assert.equal(projected.exitReason, "价格达到第二计划目标，因此平掉剩余仓位。");
  assert.equal(projected.stopLoss, null);
  assert.deepEqual(projected.protection, { stop: null, takeProfit1: null, takeProfit2: null, breakEvenStop: null });
});

test("人工金丝雀明确标记为技术验证且不计入策略绩效", () => {
  const projected = projectExecutionRuns([{
    id: "canary-operator-1",
    signalId: "operator-1",
    sourceType: "OPERATOR_CANARY",
    performanceEligible: false,
    symbol: "BTCUSDT",
    status: "OPEN_PROTECTED",
    updatedAt: 2_500,
    plan: {
      direction: "SHORT",
      entrySide: "SELL",
      exitSide: "BUY",
      quantity: "0.0012",
      leverage: 10,
      marginMode: "ISOLATED",
      marginTarget: 10,
      prices: { entry: "85000" },
    },
    entryOrder: { executedQuantity: 0.0012, averagePrice: 85_000, updateTime: 2_000 },
    exchange: { positions: [{ symbol: "BTCUSDT", unrealizedProfit: -0.05 }] },
  }]);

  assert.equal(projected.length, 1);
  assert.equal(projected[0].signalDriven, false);
  assert.equal(projected[0].performanceEligible, false);
  assert.equal(projected[0].strategy, "OPERATOR_CANARY");
  assert.equal(projected[0].action, "SELL_SHORT");
  assert.equal(projected[0].unrealizedPnl, -0.05);
});

test("部分成交的 NetR、MFE 和 MAE 使用实际成交风险而非计划风险", () => {
  const projected = projectExecutionRun({
    id: "canary-partial-1",
    signalId: "signal-partial-1",
    sourceType: "SIGNAL",
    performanceEligible: false,
    executionException: "ENTRY_FILL_BELOW_MINIMUM",
    symbol: "QUSDT",
    status: "CLOSED",
    updatedAt: 4_000,
    plan: {
      direction: "SHORT",
      entrySide: "SELL",
      exitSide: "BUY",
      quantity: "4341",
      leverage: 10,
      riskAmountEstimate: 1.91004,
      prices: { entry: "0.023031", stopLoss: "0.023471" },
    },
    entryOrder: { executedQuantity: 869, averagePrice: 0, price: 0.023031, updateTime: 2_000 },
    performance: { mfePnl: 0.19118, maePnl: -0.09559, mfeR: 0.1, maeR: -0.05, samples: 4 },
    result: { netPnl: 0.143985, trades: [] },
  });

  assert.ok(Math.abs(projected.actualRisk - 0.38236) < 1e-8);
  assert.ok(Math.abs(projected.netR - (0.143985 / 0.38236)) < 1e-8);
  assert.ok(Math.abs(projected.mfeR - 0.5) < 1e-8);
  assert.ok(Math.abs(projected.maeR + 0.25) < 1e-8);
  assert.equal(projected.performanceEligible, false);
  assert.equal(projected.executionException, "ENTRY_FILL_BELOW_MINIMUM");
});

test("未成交计划不会伪装成已成交数量或金额", () => {
  const projected = projectExecutionRun({
    id: "canary-prepared-1",
    signalId: "signal-2",
    symbol: "BTCUSDT",
    status: "PREPARED",
    updatedAt: 1_000,
    plan: {
      direction: "LONG",
      entrySide: "BUY",
      exitSide: "SELL",
      quantity: "0.0012",
      actualNotional: 102,
      prices: { entry: "85000" },
    },
  });

  assert.equal(projected.plannedQuantity, 0.0012);
  assert.equal(projected.quantity, null);
  assert.equal(projected.notional, null);
  assert.equal(projected.actualMarginEstimate, null);
});
