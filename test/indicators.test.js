import test from "node:test";
import assert from "node:assert/strict";
import { atr, ema, rsi, sma } from "../src/domain/indicators.js";

test("SMA 与 EMA 使用完整周期后才输出", () => {
  assert.deepEqual(sma([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
});

test("RSI 能处理单边上涨和横盘", () => {
  assert.equal(rsi([1, 2, 3, 4, 5], 3).at(-1), 100);
  assert.equal(rsi([2, 2, 2, 2, 2], 3).at(-1), 50);
});

test("ATR 使用 Wilder 平滑", () => {
  const candles = [
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 11 },
    { high: 13, low: 11, close: 12 },
    { high: 14, low: 12, close: 13 },
  ];
  assert.deepEqual(atr(candles, 3), [null, null, 2, 2]);
});
