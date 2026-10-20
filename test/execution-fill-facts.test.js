import test from "node:test";
import assert from "node:assert/strict";
import { executionFillFacts, executionExcursionFacts, observeOwnedExitFills } from "../src/execution/execution-fill-facts.js";
import { projectExecutionRun } from "../src/execution/execution-run-projection.js";

function fixture(direction = "LONG") {
  const side = direction === "LONG" ? "BUY" : "SELL";
  return { id: "fixture", symbol: "BTCUSDT", status: "CLOSED",
    plan: { direction, entrySide: side, exitSide: side === "BUY" ? "SELL" : "BUY", quantity: 10,
      riskAmountEstimate: 999, prices: { entry: 100, stopLoss: direction === "LONG" ? 90 : 110 } },
    entryOrder: { orderId: "entry", executedQuantity: 2, price: 100, averagePrice: 0 },
    executionMetrics: { actualRiskAmount: 999 },
    result: { netPnl: 6, trades: [
      { id: "a", orderId: "entry", side, price: 101, quantity: 1 },
      { id: "b", orderId: "entry", side, price: 103, quantity: 1 },
      { id: "external", orderId: "external", side, price: 500, quantity: 100 },
    ] } };
}

test("fills override stale risk and missing avgPrice, exclude external same-side orders", () => {
  const run = fixture();
  const row = projectExecutionRun(run);
  assert.equal(row.entryPrice, 102);
  assert.equal(row.quantity, 2);
  assert.equal(row.actualRisk, 24);
  assert.equal(row.netR, 0.25);
  assert.equal(row.netPnl, 6);
  assert.equal(row.fillRatio, 0.2);
});

test("short fill risk and price extrema replace polluted legacy money, TP1 keeps original quantity basis", () => {
  const run = fixture("SHORT");
  run.status = "TP1_FILLED";
  run.exchange = { positions: [{ symbol: "BTCUSDT", quantity: 1 }] };
  run.performance = { modelVersion: "TRADE_EXCURSION_R1", factBasis: "ACTUAL_ENTRY_V1", observationSource: "MARK_PRICE_POLL_AND_EXIT_FILLS",
    observedPriceLow: 98, observedPriceHigh: 104, samples: 4, mfePrice: 98, maePrice: 104,
    mfePnl: 999, maePnl: -999, mfeR: 999, maeR: 999 };
  const row = projectExecutionRun(run);
  assert.equal(row.actualRisk, 16);
  assert.equal(row.mfePnl, 8);
  assert.equal(row.maePnl, -4);
  assert.equal(row.mfeR, 0.5);
  assert.equal(row.maeR, 0.25);
  assert.equal(row.excursionCoverage, "POLL_SAMPLED_PARTIAL");
  assert.equal(row.maeBeforeTp1R, null);
});

test("missing, partial, duplicate, conflicting and foreign fills stay unknown", () => {
  for (const mutate of [
    r => r.result.trades = [],
    r => r.result.trades.splice(1, 1),
    r => r.result.trades.push(r.result.trades[0]),
    r => r.result.trades[0].quoteQuantity = 999,
    r => r.result.trades[0].side = "SELL",
    r => r.entryOrder.executedQuantity = 0,
    r => delete r.entryOrder.orderId,
  ]) {
    const run = fixture(); mutate(run);
    assert.equal(executionFillFacts(run).status, "UNKNOWN");
    const row = projectExecutionRun(run);
    assert.equal(row.actualRisk, null);
    assert.equal(row.netR, null);
    assert.equal(row.mfeR, null);
  }
});

test("verified cumulative quote supports IOC aggregate, conflict does not", () => {
  const run = fixture(); run.result.trades = [];
  Object.assign(run.entryOrder, { symbol: run.symbol, side: "BUY", cumulativeQuote: 204 });
  assert.equal(executionFillFacts(run).entryPrice, 102);
  run.entryOrder.averagePrice = 100;
  assert.equal(executionFillFacts(run).status, "UNKNOWN");
});

test("old R or money without sampled prices cannot reconstruct a market path", () => {
  const run = fixture();
  run.performance = { mfePnl: 999, maePnl: -999, mfeR: 3, maeR: 1, samples: 50 };
  assert.equal(executionExcursionFacts(run).mfeR, null);
  assert.equal(projectExecutionRun(run).mfeR, null);
});

test("long sampled extrema use actual entry and initial risk", () => {
  const run = fixture();
  run.performance = { modelVersion: "TRADE_EXCURSION_R1", factBasis: "ACTUAL_ENTRY_V1", observationSource: "MARK_PRICE_POLL_AND_EXIT_FILLS",
    observedPriceLow: 96, observedPriceHigh: 108, samples: 2, mfePrice: 108, maePrice: 96 };
  const row = projectExecutionRun(run);
  assert.equal(row.mfeR, 0.5);
  assert.equal(row.maeR, 0.5);
});

test("legacy synthesized R1 extrema remain unknown even after polling increments samples", () => {
  const run = fixture();
  run.performance = { modelVersion: "TRADE_EXCURSION_R1", samples: 80, mfePrice: 999, maePrice: 1,
    mfeR: 99, maeR: 99, timeToMfeMs: 20, timeToMaeMs: 30, maeBeforeTp1R: 99 };
  const row = projectExecutionRun(run);
  assert.equal(row.mfeR, null);
  assert.equal(row.maeR, null);
  assert.equal(row.timeToMfeMs, null);
  assert.equal(row.timeToMaeMs, null);
  assert.equal(row.maeBeforeTp1R, null);
  assert.equal(row.excursionReason, "OBSERVED_PRICE_EXTREMA_MISSING");
});

test("PLAY/COLLECT accounting counterexamples recompute fills, not persisted risk", () => {
  for (const [symbol, price, quantity, stop, pnl, expectedRisk] of [
    ["PLAYUSDT", 0.01925, 5194, 0.01944, 2.13455222, 0.98686],
    ["COLLECTUSDT", 0.02345, 4264, 0.02386, -1.25069508, 1.74824],
  ]) {
    const run = fixture("SHORT"); run.symbol = symbol;
    run.plan.prices.stopLoss = stop;
    run.entryOrder.executedQuantity = quantity;
    run.result.netPnl = pnl;
    run.result.trades = [{ orderId: "entry", symbol, side: "SELL", price, quantity }];
    const row = projectExecutionRun(run);
    assert.ok(Math.abs(row.actualRisk - expectedRisk) < 1e-10);
    assert.ok(Math.abs(row.netR - pnl / expectedRisk) < 1e-10);
    assert.equal(row.netPnl, pnl);
  }
});

test("late extrema and synthetic TP milestones cannot become pre-close evidence", () => {
  const run = fixture();
  run.performance = { factBasis: "ACTUAL_ENTRY_V1", observationSource: "MARK_PRICE_POLL_AND_EXIT_FILLS",
    entryPrice: 102, samples: 20, observedPriceLow: 1, observedPriceHigh: 999,
    closedAt: 100000, lastObservedAt: 125199, timeToMfeMs: 125199,
    timeToTp1Ms: 30, timeToTp2Ms: 40, timeToStopMs: 50, mfeBeforeStopR: 9, maeBeforeTp1R: 9 };
  const row = projectExecutionRun(run);
  assert.equal(row.excursionReason, "OBSERVATION_AFTER_CLOSE");
  for (const key of ["mfeR", "maeR", "timeToMfeMs", "timeToTp1Ms", "timeToTp2Ms", "timeToStopMs", "mfeBeforeStopR", "maeBeforeTp1R", "maxFavorableExcursionBeforeExitR"]) assert.equal(row[key], null, key);
});

test("R-only migration and legacy virtual TP prices keep all corrected path fields unknown", () => {
  const run = fixture();
  run.performance = { mfeR: 4, maeR: 2, mfePrice: 150, maePrice: 80, samples: 100,
    timeToTp1Ms: 10, timeToTp2Ms: 20, timeToStopMs: 30 };
  const row = projectExecutionRun(run);
  for (const key of ["mfeR", "maeR", "mfePrice", "maePrice", "timeToTp1Ms", "timeToTp2Ms", "timeToStopMs"]) assert.equal(row[key], null, key);
});

test("accounting projection preserves realized PnL commission funding and net amounts", () => {
  const run = fixture();
  Object.assign(run.result, { realizedPnl: -8.14431, commission: 0.59843818, fundingPnl: 0.00807545, netPnl: -8.73467273 });
  const before = JSON.stringify(run);
  const row = projectExecutionRun(run);
  for (const key of ["realizedPnl", "commission", "fundingPnl", "netPnl"]) assert.equal(row[key], run.result[key]);
  assert.equal(JSON.stringify(run), before);
});

test("missing funding remains null, explicit zero is retained, saved net PnL is unchanged", () => {
  const run = fixture(); Object.assign(run.result, { realizedPnl: 7, commission: 1 });
  assert.equal(projectExecutionRun(run).fundingPnl, null);
  assert.equal(projectExecutionRun(run).netPnl, 6);
  delete run.result.netPnl;
  assert.equal(projectExecutionRun(run).netPnl, null);
  run.result.fundingPnl = 0;
  assert.equal(projectExecutionRun(run).fundingPnl, 0);
  assert.equal(projectExecutionRun(run).netPnl, 6);
});

test("owned partial exit fills are all observed at real timestamps regardless of array order", () => {
  const run = fixture(); run.protection = { takeProfit1: { actualOrderId: "tp1" }, takeProfit2: { actualOrderId: "tp2" } };
  const exits = [
    { id: "x1", orderId: "tp1", side: "SELL", price: 110, quantity: 0.5, time: 300 },
    { id: "x2", orderId: "tp1", side: "SELL", price: 95, quantity: 0.5, time: 200 },
    { id: "x3", orderId: "tp2", side: "SELL", price: 108, quantity: 1, time: 400 },
    { id: "foreign", orderId: "external-exit", side: "SELL", price: 9999, quantity: 100, time: 500 },
  ];
  const initial = { openedAt: 100, lastObservedAt: 100, mfeR: 0, maeR: 0, samples: 0 };
  run.result.trades.push(...exits);
  const first = observeOwnedExitFills(initial, run);
  run.result.trades.reverse();
  assert.deepEqual(observeOwnedExitFills(initial, run), first);
  assert.equal(first.observedPriceLow, 95);
  assert.equal(first.observedPriceHigh, 110);
  assert.equal(first.timeToMfeMs, 200);
  assert.equal(first.timeToMaeMs, 100);
  assert.equal(first.samples, 3);
  assert.equal(projectExecutionRun(run).exitPrice, (110 * 0.5 + 95 * 0.5 + 108) / 2);
  run.result.trades = run.result.trades.filter(t => !["tp1", "tp2"].includes(t.orderId));
  assert.equal(projectExecutionRun(run).exitPrice, null);
  assert.equal(observeOwnedExitFills(initial, run).samples, 0);
});

test("mixed exit quote availability sums every fill without mutating source records", () => {
  const run = fixture();
  run.operatorCloseOrder = { orderId: "close" };
  run.result.trades.push(
    { id: "close-a", orderId: "close", side: "SELL", price: 110, quantity: 0.5, quoteQuantity: 55, time: 100 },
    { id: "close-b", orderId: "close", side: "SELL", price: 106, quantity: 1.5, time: 200 },
  );
  const before = JSON.stringify(run);
  const row = projectExecutionRun(run);
  assert.equal(row.exitPrice, (55 + 106 * 1.5) / 2);
  assert.equal(row.exitPrice, 107);
  assert.equal(JSON.stringify(run), before);
});
