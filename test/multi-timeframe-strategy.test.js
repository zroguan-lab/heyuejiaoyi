import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMultiTimeframe } from "../src/domain/multi-timeframe-strategy.js";
import { strategyConfig } from "./helpers.js";

function waveCandles(count, trend = 0.1) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * trend + Math.sin(index * Math.PI / 5);
    return {
      openTime: index * 60_000,
      open: close - Math.sign(trend || 1) * 0.05,
      high: close + 0.25,
      low: close - 0.25,
      close,
      volume: 100 + (index % 7),
      closeTime: (index + 1) * 60_000 - 1,
    };
  });
}

test("1小时多头趋势下的15分钟结构突破生成独立突破候选", () => {
  const hourly = waveCandles(160);
  const fifteen = waveCandles(160);
  const five = waveCandles(160);
  fifteen[159] = { ...fifteen[159], open: fifteen[158].close, close: 117.2, high: 117.4, low: fifteen[158].close - 0.2 };
  const result = analyzeMultiTimeframe({ symbol: "BTCUSDT", hourly, fifteen, five, config: strategyConfig });
  const breakout = result.candidates.find((item) => item.strategy === "BREAKOUT");
  assert.equal(result.trend, "LONG");
  assert.equal(breakout.direction, "LONG");
  assert.equal(breakout.order.style, "ACTIVE_DYNAMIC");
  assert.equal(breakout.order.expiryBars, 1);
});

test("1小时趋势中性时禁止15分钟和5分钟产生候选", () => {
  const flat = waveCandles(160, 0);
  const fifteen = waveCandles(160);
  fifteen[159] = { ...fifteen[159], close: 117.2, high: 117.4 };
  const result = analyzeMultiTimeframe({ symbol: "BTCUSDT", hourly: flat, fifteen, five: waveCandles(160), config: strategyConfig });
  assert.equal(result.status, "WAIT");
  assert.equal(result.candidates.length, 0);
});

test("15分钟进入回调区且5分钟结构反转时生成被动回踩候选", () => {
  const hourly = waveCandles(160);
  const fifteen = waveCandles(160);
  const five = waveCandles(160);
  fifteen[159] = { ...fifteen[159], low: 114.7, close: 115 };
  five[159] = { ...five[159], open: five[158].close, close: 117.2, high: 117.4, low: five[158].close - 0.2 };
  const result = analyzeMultiTimeframe({ symbol: "ETHUSDT", hourly, fifteen, five, config: strategyConfig });
  const pullback = result.candidates.find((item) => item.strategy === "PULLBACK");
  assert.equal(pullback.direction, "LONG");
  assert.equal(pullback.triggerInterval, "5m");
  assert.equal(pullback.order.style, "PASSIVE_RETEST");
  assert.equal(pullback.order.expiryBars, 3);
});
