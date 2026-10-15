import test from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/backtest.js";
import { analyzeMarket } from "../src/domain/strategy.js";
import { strategyConfig, trendingCandles } from "./helpers.js";

test("回测不会用信号 K 线自身判断出场，并对同根双触发按止损处理", () => {
  const candles = trendingCandles("up", 120);
  const signalIndex = 60;
  const signal = analyzeMarket({ symbol: "BTCUSDT", interval: "15m", candles: candles.slice(0, signalIndex + 1), config: strategyConfig });
  assert.equal(signal.status, "SIGNAL");
  candles[signalIndex + 1] = {
    ...candles[signalIndex + 1],
    high: signal.risk.takeProfit1 + 1,
    low: signal.risk.stopLoss - 1,
  };

  const result = runBacktest({ candles, symbol: "BTCUSDT", interval: "15m", strategyConfig });
  assert.ok(result.metrics.trades > 0);
  assert.equal(result.trades[0].signalTime, candles[signalIndex].closeTime);
  assert.equal(result.trades[0].exitTime, candles[signalIndex + 1].closeTime);
  assert.equal(result.trades[0].exitReason, "AMBIGUOUS_STOP_FIRST");
  assert.ok(result.trades[0].netR < 0);
});
