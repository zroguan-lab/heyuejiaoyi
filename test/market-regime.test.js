import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketRegime } from "../src/domain/market-regime.js";

function risingCandles(count = 100) {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100 + index,
    high: 101.5 + index,
    low: 99.5 + index,
    close: 101 + index,
    volume: 100,
  }));
}

test("市场环境同时记录 BTC 双周期、市场宽度和波动分位", () => {
  const candles = risingCandles();
  const regime = buildMarketRegime({
    btcFourHour: candles,
    btcHourly: candles,
    analyses: [{ trend: "LONG" }, { trend: "LONG" }, { trend: "SHORT" }],
    config: { emaFast: 20, emaSlow: 50, atrPeriod: 14 },
  });
  assert.equal(regime.direction, "LONG");
  assert.equal(regime.btc4h.direction, "LONG");
  assert.equal(regime.breadth.direction, "LONG");
  assert.equal(regime.breadth.total, 3);
  assert.ok(Number.isFinite(regime.volatility.percentile));
});
