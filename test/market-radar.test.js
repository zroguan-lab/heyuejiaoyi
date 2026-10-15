import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketRadarSnapshot,
  deriveMoverMetrics,
  marketRadarContext,
  MARKET_RADAR_VERSION,
} from "../src/domain/market-radar.js";

function market(symbol, quoteVolume24h, return1h, {
  return15m = return1h / 4,
  return4h = return1h * 2,
  volumeRatio15m = 1,
  volumeBuildRatio = 0.5,
  compressionRatio = 1.5,
  nearestBoundaryAtr = 2,
  rangePosition = 0.5,
  spreadBps = 2,
} = {}) {
  return {
    symbol,
    quoteVolume24h,
    priceChangePercent24h: return4h,
    spreadBps,
    tradeCount24h: 10_000,
    lastPrice: 100,
    return15m,
    return1h,
    return4h,
    volumeRatio15m,
    volumeBuildRatio,
    compressionRatio,
    nearestBoundaryAtr,
    rangePosition,
    moverDataClosedAt: 900_000,
    moverCandleCount: 33,
    moverDataComplete: true,
  };
}

test("R3只用已收盘15分钟K线推导收益、量能、收缩与结构边界", () => {
  const candles = Array.from({ length: 21 }, (_, index) => ({
    closeTime: (index + 1) * 900_000 - 1,
    open: 100 + index - 0.2,
    high: 100 + index + (index >= 17 ? 0.2 : 0.8),
    low: 100 + index - (index >= 17 ? 0.2 : 0.8),
    close: 100 + index,
    quoteVolume: index === 20 ? 300 : 100,
  }));
  const metrics = deriveMoverMetrics(candles);
  assert.equal(metrics.moverDataComplete, true);
  assert.equal(metrics.moverDataClosedAt, candles.at(-1).closeTime);
  assert.equal(metrics.return15m, Number((((120 / 119) - 1) * 100).toFixed(4)));
  assert.equal(metrics.return1h, Number((((120 / 116) - 1) * 100).toFixed(4)));
  assert.equal(metrics.return4h, Number((((120 / 104) - 1) * 100).toFixed(4)));
  assert.equal(metrics.volumeRatio15m, 3);
  assert.equal(Number.isFinite(metrics.compressionRatio), true);
  assert.equal(Number.isFinite(metrics.nearestBoundaryAtr), true);
  assert.equal(Number.isFinite(metrics.volumeBuildRatio), true);
});

test("R3从高流动性发现池同时选择早期蓄势与异动标的", () => {
  const now = 1_000_000;
  const snapshot = buildMarketRadarSnapshot([
    market("BTCUSDT", 1_000_000, 1),
    market("ETHUSDT", 900_000, 0.5),
    market("SOLUSDT", 800_000, 8, { volumeRatio15m: 2.4, volumeBuildRatio: 1.4, compressionRatio: 0.6, nearestBoundaryAtr: 0.2 }),
    market("XRPUSDT", 700_000, -5, { volumeRatio15m: 1.8, volumeBuildRatio: 1.3, compressionRatio: 0.7, nearestBoundaryAtr: 0.3 }),
    market("DOGEUSDT", 600_000, 0.1),
  ], {
    now,
    discoverySize: 5,
    deepScanSize: 4,
    gainerCount: 1,
    loserCount: 1,
    volumeShockCount: 2,
    rankVelocityCount: 0,
  });

  assert.equal(snapshot.version, MARKET_RADAR_VERSION);
  assert.equal(snapshot.discoverySize, 5);
  assert.equal(snapshot.deepScanSize, 4);
  assert.equal(snapshot.selectedSymbols.includes("BTCUSDT"), true);
  assert.equal(snapshot.selectedSymbols.includes("ETHUSDT"), true);
  assert.equal(snapshot.selectedSymbols.includes("SOLUSDT"), true);
  assert.equal(snapshot.selectedSymbols.includes("XRPUSDT"), true);
  assert.equal(snapshot.market.breadth.total, 5);
  assert.equal(snapshot.leaders[0].symbol, "SOLUSDT");
  assert.equal(snapshot.laggards[0].symbol, "XRPUSDT");
  assert.equal(snapshot.items.find((item) => item.symbol === "SOLUSDT").opportunitySources.includes("RANK_GAINER"), true);
  assert.equal(snapshot.items.find((item) => item.symbol === "XRPUSDT").opportunitySources.includes("RANK_LOSER"), true);
});

test("R3记录排名速度并在最短观察期内保留已选标的", () => {
  const firstAt = 2_000_000;
  const first = buildMarketRadarSnapshot([
    market("BTCUSDT", 1_000_000, 1),
    market("ETHUSDT", 900_000, 0.8),
    market("SOLUSDT", 800_000, 6),
    market("XRPUSDT", 700_000, 4),
    market("DOGEUSDT", 600_000, 2),
  ], { now: firstAt, discoverySize: 5, deepScanSize: 4, gainerCount: 2, loserCount: 0, volumeShockCount: 0 });
  assert.equal(first.selectedSymbols.includes("SOLUSDT"), true);

  const second = buildMarketRadarSnapshot([
    market("BTCUSDT", 1_100_000, 1),
    market("ETHUSDT", 1_000_000, 0.8),
    market("SOLUSDT", 800_000, 3),
    market("XRPUSDT", 999_000, 4),
    market("DOGEUSDT", 600_000, 7),
  ], {
    previousSnapshot: first,
    now: firstAt + 10 * 60_000,
    discoverySize: 5,
    deepScanSize: 4,
    minimumHoldMs: 30 * 60_000,
    gainerCount: 2,
    loserCount: 0,
    volumeShockCount: 0,
    rankVelocityCount: 2,
  });

  assert.equal(second.selectedSymbols.includes("SOLUSDT"), true);
  const rising = second.items.find((item) => item.symbol === "DOGEUSDT");
  assert.equal(rising.rankVelocity > 0, true);
  assert.equal(rising.opportunitySources.includes("RANK_VELOCITY"), true);
  const context = marketRadarContext(second, rising);
  assert.equal(context.version, MARKET_RADAR_VERSION);
  assert.equal(context.snapshotId, second.snapshotId);
  assert.equal(context.rankVelocity, rising.rankVelocity);
});
