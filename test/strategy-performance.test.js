import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionSummary, buildStrategyPerformance } from "../src/presentation/strategy-performance.js";

test("TEAM-011 conflict is separately visible and never finalized", () => {
  const rows = [{ sourceType: "SIGNAL", status: "ENTRY_FACT_CONFLICT", performanceEligible: false, netPnl: null, netR: null }];
  const summary = buildExecutionSummary(rows);
  assert.equal(summary.entryFactConflict, 1);
  assert.equal(summary.finalized, 0);
  assert.equal(summary.accountingPending, 0);
  assert.equal(buildStrategyPerformance(rows).finalizedTradeCount, 0);
});

test("100笔只有1笔有效R不构成完整R证据，PnL仍独立结算", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    sourceType: "SIGNAL", status: "CLOSED", accountingComplete: true,
    closedAt: 1_790_000_000_000, netPnl: index === 0 ? -1 : 2,
    netR: index === 0 ? 1 : null,
  }));
  const result = buildStrategyPerformance(rows, { now: 1_790_000_000_000 });
  assert.equal(result.totalNetPnl, 197);
  assert.equal(result.averageNetR, 1);
  assert.deepEqual(result.coverage.netR, { total: 100, valid: 1, missing: 99, coverage: 0.01 });
  assert.equal(result.validationGate.checks.completeNetR, false);
  assert.equal(result.validationGate.eligible, false);
  assert.equal(result.sampleProgress.remaining, 0);
  assert.equal(result.evidenceProgress.missingNetR, 99);
  assert.equal(result.evidenceProgress.complete, false);
});

test("最终结算分母与eligible CLOSED分母分离，开放与排除记录均不混入", () => {
  const base = { sourceType: "SIGNAL", status: "CLOSED", accountingComplete: true, closedAt: 1_790_000_000_000, netPnl: 2, netR: 1 };
  const result = buildStrategyPerformance([
    base,
    { ...base, netPnl: null, netR: null },
    { ...base, accountingComplete: false },
    { ...base, status: "OPEN_PROTECTED" },
    { ...base, performanceEligible: false },
    { ...base, sourceType: "OPERATOR_CANARY" },
  ], { now: base.closedAt, sampleTarget: 1 });
  assert.equal(result.eligibleClosedTradeCount, 3);
  assert.equal(result.finalizedTradeCount, 1);
  assert.equal(result.pendingTradeCount, 3);
  assert.deepEqual(result.coverage.netPnl, { total: 1, valid: 1, missing: 0, coverage: 1 });
  assert.deepEqual(result.closedTradeCoverage.netPnl, { total: 3, valid: 2, missing: 1, coverage: 2 / 3 });
  assert.equal(result.researchAttribution.opportunitySources.closedTrades, 3);
  assert.equal(result.validationGate.checks.completeNetR, true);
  assert.equal(result.validationGate.checks.completeNetPnl, false);
  assert.equal(result.evidenceProgress.pendingClosedAccounting, 2);
  assert.equal(result.evidenceProgress.complete, false);
});

test("空样本与真实0区分，缺PnL不进入收益或胜率分母", () => {
  const empty = buildStrategyPerformance([], { now: 1_790_000_000_000 });
  assert.equal(empty.averageNetR, null);
  assert.equal(empty.winRate, null);
  assert.equal(empty.profitFactor, null);
  assert.equal(empty.coverage.netR.coverage, null);
  const base = { sourceType: "SIGNAL", status: "CLOSED", accountingComplete: true, closedAt: 1_790_000_000_000 };
  const result = buildStrategyPerformance([{ ...base, netPnl: 0, netR: 0 }, { ...base, netPnl: null }], { now: base.closedAt });
  assert.equal(result.averageNetR, 0);
  assert.equal(result.finalizedTradeCount, 1);
  assert.equal(result.winRate, 0);
  assert.equal(result.closedTradeCoverage.netPnl.missing, 1);
  assert.equal(result.validationGate.checks.completeNetPnl, false);
});

test("策略权益按北京时间平仓日聚合净盈亏并补齐无交易日期", () => {
  const performance = buildStrategyPerformance([
    {
      id: "trade-1", sourceType: "SIGNAL", performanceEligible: true, status: "CLOSED", accountingComplete: true,
      closedAt: Date.parse("2026-09-27T16:30:00Z"), netPnl: 3, realizedPnl: 3.6, commission: 0.5, fundingPnl: -0.1,
    },
    {
      id: "trade-2", sourceType: "SIGNAL", performanceEligible: true, status: "CLOSED", accountingComplete: true,
      closedAt: Date.parse("2026-09-29T01:00:00Z"), netPnl: -1, realizedPnl: -0.7, commission: 0.3, fundingPnl: 0,
    },
  ], {
    startingEquity: 500,
    now: Date.parse("2026-09-30T04:00:00Z"),
  });

  assert.deepEqual(performance.points.map((point) => point.date), ["2026-09-28", "2026-09-29", "2026-09-30"]);
  assert.deepEqual(performance.points.map((point) => point.dailyNetPnl), [3, -1, 0]);
  assert.deepEqual(performance.points.map((point) => point.equity), [503, 502, 502]);
  assert.equal(performance.totalNetPnl, 2);
  assert.equal(performance.currentEquity, 502);
  assert.equal(performance.finalizedTradeCount, 2);
  assert.equal(performance.wins, 1);
  assert.equal(performance.losses, 1);
});

test("策略收益排除未平仓、非策略和仍在对账的订单", () => {
  const performance = buildStrategyPerformance([
    { sourceType: "SIGNAL", performanceEligible: true, status: "OPEN_PROTECTED", accountingComplete: false, netPnl: 9 },
    { sourceType: "OPERATOR_CANARY", performanceEligible: false, status: "CLOSED", accountingComplete: true, closedAt: 1, netPnl: 8 },
    { sourceType: "SIGNAL", performanceEligible: true, status: "CLOSED", accountingComplete: false, closedAt: 2, netPnl: 7 },
  ], { startingEquity: 500, now: Date.parse("2026-09-29T04:00:00Z") });

  assert.equal(performance.currentEquity, 500);
  assert.equal(performance.finalizedTradeCount, 0);
  assert.equal(performance.pendingTradeCount, 2);
  assert.equal(performance.points.length, 1);
  assert.equal(performance.points[0].dailyNetPnl, 0);
});

test("执行摘要区分在途样本、未成交取消、排除、失败和未知", () => {
  const summary = buildExecutionSummary([
    { sourceType: "SIGNAL", status: "CLOSED", accountingComplete: true, performanceEligible: true, netPnl: 1 },
    { sourceType: "SIGNAL", status: "OPEN_PROTECTED", performanceEligible: true },
    { sourceType: "SIGNAL", status: "CANCELED", performanceEligible: false },
    { sourceType: "SIGNAL", status: "CLOSED", accountingComplete: true, performanceEligible: false, netPnl: -0.02 },
    { sourceType: "SIGNAL", status: "FAILED", performanceEligible: false },
    { sourceType: "SIGNAL", status: "SUBMISSION_UNKNOWN", performanceEligible: false },
    { sourceType: "SIGNAL", status: "PREPARED", performanceEligible: true },
    { sourceType: "OPERATOR_CANARY", status: "CLOSED", accountingComplete: true, netPnl: 9 },
  ]);
  assert.deepEqual(summary, {
    total: 7,
    finalized: 1,
    open: 1,
    accountingPending: 0,
    canceledUnfilled: 1,
    excluded: 1,
    failed: 1,
    submissionUnknown: 1,
    entryFactConflict: 0,
    preEntry: 1,
    excludedNetPnl: -0.02,
  });
});

test("V2.1 按双层和四类策略独立统计100笔样本进度", () => {
  const base = {
    sourceType: "SIGNAL",
    performanceEligible: true,
    status: "CLOSED",
    accountingComplete: true,
    closedAt: Date.parse("2026-09-30T03:00:00Z"),
  };
  const performance = buildStrategyPerformance([
    { ...base, id: "a", strategy: "BREAKOUT", direction: "LONG", experimentTier: "CORE", costCohort: "NORMAL_COST", netPnl: 2, netR: 1 },
    { ...base, id: "b", strategy: "BREAKOUT", direction: "SHORT", experimentTier: "EXPLORATION", costCohort: "HIGH_COST_EXPLORATION", netPnl: -1, netR: -0.5 },
    { ...base, id: "c", strategy: "PULLBACK", direction: "LONG", experimentTier: "EXPLORATION", costCohort: "HIGH_COST_EXPLORATION", netPnl: 1, netR: 0.5 },
    { ...base, id: "d", strategy: "PULLBACK", direction: "SHORT", experimentTier: "CORE", costCohort: "NORMAL_COST", netPnl: -0.5, netR: -0.25 },
  ], { startingEquity: 500, sampleTarget: 100, now: Date.parse("2026-09-30T04:00:00Z") });

  assert.deepEqual(performance.segments.map((item) => item.key), [
    "PRE_BREAKOUT_LONG", "PRE_BREAKOUT_SHORT", "BREAKOUT_LONG", "BREAKOUT_SHORT", "PULLBACK_LONG", "PULLBACK_SHORT",
  ]);
  assert.deepEqual(performance.segments.map((item) => item.finalizedTradeCount), [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(performance.tiers.map((item) => item.finalizedTradeCount), [2, 2]);
  assert.deepEqual(performance.costCohorts.map((item) => item.finalizedTradeCount), [2, 2]);
  assert.deepEqual(performance.sampleProgress, { target: 100, finalized: 4, remaining: 96, completionPercent: 4 });
  assert.equal(performance.validationGate.checks.minimumSamples, false);
});
