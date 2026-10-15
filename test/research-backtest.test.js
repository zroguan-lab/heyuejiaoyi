import test from "node:test";
import assert from "node:assert/strict";
import { createValidationPlan, evaluateParameterStability, runMultiTimeframeBacktest, runPortfolioBacktest, runWalkForwardValidation } from "../src/research-backtest.js";
import { strategyConfig } from "./helpers.js";

function candles(count, intervalMs, start = 100) {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * intervalMs,
    closeTime: (index + 1) * intervalMs - 1,
    open: start,
    high: start + 0.4,
    low: start - 0.4,
    close: start,
    volume: 100,
  }));
}

test("研究回测只用信号出现后的1分钟路径，并分别汇总策略与组合", () => {
  const five = candles(6, 300_000);
  const oneMinute = candles(30, 60_000);
  oneMinute[6] = { ...oneMinute[6], low: 99.8, high: 101 };
  oneMinute[7] = { ...oneMinute[7], low: 99.5, high: 103.2 };
  oneMinute[8] = { ...oneMinute[8], low: 102, high: 105.2 };
  let emitted = false;
  const analyze = ({ five: available }) => {
    if (emitted || available.length < 1) return { candidates: [] };
    emitted = true;
    const triggerTime = available.at(-1).closeTime;
    return { candidates: [{
      id: "bt-1", symbol: "BTCUSDT", strategy: "BREAKOUT", direction: "LONG", status: "CANDIDATE", score: 80, triggerTime,
      order: { style: "ACTIVE_DYNAMIC", entry: 100, expiresAt: triggerTime + 300_000 },
      risk: { entry: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 105 },
    }] };
  };
  const result = runMultiTimeframeBacktest({
    symbol: "BTCUSDT", hourly: candles(2, 3_600_000), fifteen: candles(2, 900_000), five, oneMinute,
    strategyConfig, portfolioConfig: { startingEquity: 500, marginPerTrade: 10, leverage: 10 },
    costs: { fallbackFeeRate: 0, fallbackSlippageRate: 0 }, analyze,
  });
  assert.equal(result.assumptions.pathResolution, "1m");
  assert.equal(result.trades[0].exitReason, "TAKE_PROFIT_2");
  assert.equal(result.metrics.portfolio.netR, 2);
  assert.equal(result.metrics.strategies.BREAKOUT.closed, 1);
  assert.equal(result.metrics.directions.LONG.wins, 1);
});

test("验证计划使用扩展窗口并封存最后20%数据", () => {
  const times = Array.from({ length: 100 }, (_, index) => index + 1);
  const plan = createValidationPlan(times, { folds: 4 });
  assert.equal(plan.windows.length, 4);
  assert.equal(plan.sealedHoldout.start, 81);
  assert.equal(plan.sealedHoldout.end, 100);
  assert.ok(plan.windows.every((window) => window.validation.end < plan.sealedHoldout.start));
  assert.ok(plan.windows[1].train.end > plan.windows[0].train.end);
});

test("走步验证实际执行每个样本外窗口且默认不偷看封存集", () => {
  const calls = [];
  const result = runWalkForwardValidation({
    timestamps: Array.from({ length: 100 }, (_, index) => index + 1),
    validationOptions: { folds: 4 },
    runWindow: (window) => {
      calls.push(window);
      return { trades: [] };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(result.sealedHoldout.status, "SEALED");
  assert.equal(result.sealedHoldout.result, null);
  assert.equal(result.promotionGate.eligible, false);
});

test("参数稳定性要求至少三组邻近参数且多数保持正期望", () => {
  const stability = evaluateParameterStability([
    { label: "low", portfolio: { closed: 30, averageNetR: 0.1, profitFactor: 1.2 } },
    { label: "base", portfolio: { closed: 35, averageNetR: 0.2, profitFactor: 1.4 } },
    { label: "high", portfolio: { closed: 28, averageNetR: -0.05, profitFactor: 0.9 } },
  ]);
  assert.equal(stability.stable, true);
  assert.equal(stability.positiveVariantCount, 2);
});

test("多币回测在同一时间执行全部合格标的并保留质量排序", () => {
  const market = { hourly: candles(3, 3_600_000), fifteen: candles(3, 900_000), five: candles(4, 300_000), oneMinute: candles(20, 60_000) };
  const emitted = new Set();
  const analyze = ({ symbol, five: available }) => {
    if (emitted.has(symbol)) return { candidates: [] };
    emitted.add(symbol);
    const triggerTime = available.at(-1).closeTime;
    return { candidates: [{
      id: `${symbol}-1`, symbol, strategy: "BREAKOUT", direction: "LONG", status: "CANDIDATE",
      score: symbol === "ETHUSDT" ? 90 : 70, triggerTime,
      order: { style: "ACTIVE_DYNAMIC", entry: 100, expiresAt: triggerTime + 300_000 },
      risk: { entry: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 105 },
    }] };
  };
  const result = runPortfolioBacktest({
    markets: { BTCUSDT: structuredClone(market), ETHUSDT: structuredClone(market) },
    strategyConfig, portfolioConfig: { startingEquity: 500, marginPerTrade: 10, leverage: 10, selectionMode: "ALL_ELIGIBLE" },
    costs: { fallbackFeeRate: 0, fallbackSlippageRate: 0 }, analyze,
  });
  assert.equal(result.trades.length, 2);
  assert.deepEqual(result.trades.map((trade) => trade.symbol), ["ETHUSDT", "BTCUSDT"]);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.assumptions.positionPolicy, "ALL_ELIGIBLE");
});
