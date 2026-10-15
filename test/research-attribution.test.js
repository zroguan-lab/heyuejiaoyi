import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExcursionAttribution,
  buildOpportunitySourceAttribution,
  opportunitySourceCombination,
} from "../src/presentation/research-attribution.js";

function trade(overrides = {}) {
  return {
    status: "CLOSED",
    openedAt: 1_000,
    closedAt: 61_000,
    pnl: { net: 1, netR: 0.5 },
    mfeR: 1.2,
    maeR: 0.3,
    timeToMfeMs: 30_000,
    demoPromotion: { totalCostR: 0.1 },
    marketRadar: { opportunitySources: ["RETAINED", "BOUNDARY_PRESSURE"] },
    ...overrides,
  };
}

test("来源组合使用完整排序组合且保留RETAINED并对小样本显式标记", () => {
  const first = trade();
  const second = trade({
    pnl: { net: -0.5, netR: -0.25 },
    marketRadar: { opportunitySources: ["BOUNDARY_PRESSURE", "RETAINED"] },
    mfeR: 0.1,
    maeR: 1,
  });
  assert.equal(opportunitySourceCombination(first), "BOUNDARY_PRESSURE + RETAINED");
  const result = buildOpportunitySourceAttribution([first, second]);
  assert.equal(result.combinations.length, 1);
  assert.equal(result.combinations[0].trades, 2);
  assert.equal(result.combinations[0].sampleStatus, "LOW_SAMPLE");
  assert.equal(result.combinations[0].winRate, 0.5);
  assert.equal(result.combinations[0].avgNetR, 0.125);
  assert.equal(result.combinations[0].profitFactor, 2);
  assert.equal(result.combinations[0].avgMfeR, 0.65);
  assert.equal(result.combinations[0].avgMaeR, 0.65);
  assert.equal(result.combinations[0].avgCostR, 0.1);
  assert.equal(result.combinations[0].avgHoldingMinutes, 1);
});

test("来源组合达到10笔后才进入正式观察", () => {
  const result = buildOpportunitySourceAttribution(Array.from({ length: 10 }, () => trade()));
  assert.equal(result.formalObservationCount, 1);
  assert.equal(result.combinations[0].sampleStatus, "FORMAL_OBSERVATION");
});

test("MFE/MAE归因区分止损、盈利和保本止损路径", () => {
  const result = buildExcursionAttribution([
    trade({ exitReason: "STOP_LOSS", pnl: { net: -1, netR: -1 }, mfeR: 0.1, maeR: 1, timeToStopMs: 60_000 }),
    trade({ exitReason: "STOP_LOSS", pnl: { net: -1, netR: -1 }, mfeR: 0.8, maeR: 1, timeToStopMs: 120_000 }),
    trade({ exitReason: "BREAKEVEN_AFTER_TP1", pnl: { net: 0.5, netR: 0.25 }, mfeR: 1.6, maeR: 0.2, timeToStopMs: 180_000 }),
    trade({ exitReason: "TAKE_PROFIT_2", pnl: { net: 2, netR: 2 }, mfeR: 2.5, maeR: 0.1 }),
  ]);
  assert.equal(result.stopTrades, 3);
  assert.equal(result.stopMedianMfeR, 0.8);
  assert.equal(result.winnerMedianMaeR, 0.15);
  assert.equal(result.stopMfeBelow0_2RRatio, 0.333333);
  assert.equal(result.stopMfeAbove0_5RRatio, 0.666667);
  assert.equal(result.stopMfeAbove1RRatio, 0.333333);
  assert.equal(result.breakEvenStopMfeDistribution.count, 1);
  assert.equal(result.breakEvenStopMfeDistribution.median, 1.6);
  assert.equal(result.medianTimeToStopMs, 120_000);
});
