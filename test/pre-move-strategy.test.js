import test from "node:test";
import assert from "node:assert/strict";
import { analyzePreMove, PRE_MOVE_SIGNAL_VERSION } from "../src/domain/pre-move-strategy.js";
import { strategyConfig } from "./helpers.js";

function trendCandles(count, step = 0.1) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * step + Math.sin(index * Math.PI / 5) * 0.3;
    return {
      openTime: index * 3_600_000,
      closeTime: (index + 1) * 3_600_000 - 1,
      open: close - 0.05,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 100,
    };
  });
}

function compressedCandles(count, intervalMs, { volumeLift = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * 0.02;
    const narrow = index >= count - 4;
    const width = narrow ? 0.12 : 0.5;
    return {
      openTime: index * intervalMs,
      closeTime: (index + 1) * intervalMs - 1,
      open: close - 0.02,
      high: close + width,
      low: close - width,
      close,
      volume: volumeLift && index >= count - 3 ? 180 : 100,
    };
  });
}

test("V2.4.1在突破前的收缩、量能抬升和方向共振时生成研究候选与5分钟确认事实", () => {
  const result = analyzePreMove({
    symbol: "BTCUSDT",
    hourly: trendCandles(160),
    fifteen: compressedCandles(160, 15 * 60_000),
    five: compressedCandles(160, 5 * 60_000, { volumeLift: true }),
    radar: {
      bias: "LONG",
      relativeStrengthMarket1h: 1,
      radarScore: 80,
      selected: true,
      version: "MARKET_RADAR_R3_PREMOVE",
    },
    config: {
      ...strategyConfig,
      preMoveMaxBoundaryDistanceAtr: 1.2,
      preMoveMaxCompressionRatio: 1.25,
      preMoveMinimumExplosionScore: 35,
      preMoveMinimumDirectionScore: 40,
    },
  });
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.strategy, "PRE_BREAKOUT");
  assert.equal(candidate.strategyVersion, PRE_MOVE_SIGNAL_VERSION);
  assert.equal(candidate.direction, "LONG");
  assert.equal(candidate.order.style, "ACTIVE_DYNAMIC");
  assert.equal(candidate.preMove.alreadyBroken, false);
  assert.equal(candidate.preMove.explosionScore >= 35, true);
  assert.equal(candidate.preMove.directionScore >= 40, true);
  assert.equal(Number.isFinite(candidate.preMove.directionalPressure), true);
  assert.equal(Number.isFinite(candidate.preMove.triggerConfirmation.latestDirectionalBodyAtr), true);
  assert.equal(Number.isFinite(candidate.preMove.triggerConfirmation.latestDirectionalCloseChangeAtr), true);
  assert.equal(Number.isFinite(candidate.preMove.triggerConfirmation.latestCloseLocation), true);
  assert.match(candidate.entryReason, /爆发评分/);
});

test("V2.4.1不会把已经突破结构边界的K线伪装成爆发前机会", () => {
  const fifteen = compressedCandles(160, 15 * 60_000);
  const five = compressedCandles(160, 5 * 60_000, { volumeLift: true });
  five[159] = { ...five[159], close: 105, high: 105.1 };
  const result = analyzePreMove({
    symbol: "BTCUSDT",
    hourly: trendCandles(160),
    fifteen,
    five,
    radar: { bias: "LONG", relativeStrengthMarket1h: 1 },
    config: { ...strategyConfig, preMoveMinimumExplosionScore: 0, preMoveMinimumDirectionScore: 0 },
  });
  assert.equal(result.status, "WAIT");
  assert.match(result.message, /已经突破/);
});
