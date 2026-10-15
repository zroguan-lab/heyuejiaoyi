import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket } from "../src/domain/strategy.js";
import { strategyConfig, trendingCandles } from "./helpers.js";

test("趋势、动量和成交量共振时生成多头信号", () => {
  const result = analyzeMarket({ symbol: "BTCUSDT", interval: "15m", candles: trendingCandles("up"), config: strategyConfig });
  assert.equal(result.status, "SIGNAL");
  assert.equal(result.action, "BUY");
  assert.equal(result.direction, "LONG");
  assert.ok(result.risk.stopLoss < result.risk.entry);
  assert.ok(result.risk.takeProfit1 > result.risk.entry);
});

test("下降趋势生成空头信号", () => {
  const result = analyzeMarket({ symbol: "ETHUSDT", interval: "15m", candles: trendingCandles("down"), config: strategyConfig });
  assert.equal(result.status, "SIGNAL");
  assert.equal(result.action, "SELL");
  assert.equal(result.direction, "SHORT");
  assert.ok(result.risk.stopLoss > result.risk.entry);
});

test("数据不足时明确观望", () => {
  const result = analyzeMarket({ symbol: "BTCUSDT", interval: "15m", candles: trendingCandles("up", 20), config: strategyConfig });
  assert.equal(result.status, "WAIT");
  assert.match(result.message, /数据不足/);
});
