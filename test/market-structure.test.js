import test from "node:test";
import assert from "node:assert/strict";
import { confirmedPivots, classifyHourlyTrend } from "../src/domain/market-structure.js";
import { trendingCandles } from "./helpers.js";

test("结构点只使用左右窗口都已完成的数据", () => {
  const candles = [1, 2, 5, 2, 1, 4, 3].map((price, index) => ({
    open: price,
    high: price + 0.1,
    low: price - 0.1,
    close: price,
    closeTime: index + 1,
  }));
  const pivots = confirmedPivots(candles, { left: 2, right: 2 });
  assert.equal(pivots.highs.length, 1);
  assert.equal(pivots.highs[0].index, 2);
});

test("1小时趋势要求均线、斜率、价格与结构一致", () => {
  const up = classifyHourlyTrend(trendingCandles("up", 160), { emaFast: 20, emaSlow: 50, atrPeriod: 14 });
  const down = classifyHourlyTrend(trendingCandles("down", 160), { emaFast: 20, emaSlow: 50, atrPeriod: 14 });
  assert.equal(up.direction, "LONG");
  assert.equal(down.direction, "SHORT");
});
