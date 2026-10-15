import { atr, ema } from "./indicators.js";

function assertCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError("K 线必须是数组");
  for (const candle of candles) {
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) {
      throw new TypeError("K 线价格必须是有限数字");
    }
  }
}

export function confirmedPivots(candles, { left = 2, right = 2 } = {}) {
  assertCandles(candles);
  if (!Number.isInteger(left) || !Number.isInteger(right) || left < 1 || right < 1) {
    throw new TypeError("pivot 左右窗口必须是正整数");
  }

  const highs = [];
  const lows = [];
  for (let index = left; index < candles.length - right; index += 1) {
    const window = candles.slice(index - left, index + right + 1);
    const candle = candles[index];
    const other = window.filter((_, windowIndex) => windowIndex !== left);
    if (other.every((item) => candle.high > item.high)) {
      highs.push({ index, price: candle.high, time: candle.closeTime });
    }
    if (other.every((item) => candle.low < item.low)) {
      lows.push({ index, price: candle.low, time: candle.closeTime });
    }
  }
  return { highs, lows };
}

export function latestConfirmedSwing(candles, kind, options) {
  const pivots = confirmedPivots(candles, options);
  if (kind === "HIGH") return pivots.highs.at(-1) ?? null;
  if (kind === "LOW") return pivots.lows.at(-1) ?? null;
  throw new TypeError("kind 必须是 HIGH 或 LOW");
}

export function classifyHourlyTrend(candles, {
  emaFast = 20,
  emaSlow = 50,
  atrPeriod = 14,
  slopeLookback = 3,
  pivotLeft = 2,
  pivotRight = 2,
} = {}) {
  assertCandles(candles);
  const minimum = Math.max(emaSlow + slopeLookback, atrPeriod + 2, pivotLeft + pivotRight + 5);
  if (candles.length < minimum) {
    return { direction: "NEUTRAL", valid: false, reason: `1小时数据不足：至少需要 ${minimum} 根` };
  }

  const closes = candles.map((item) => item.close);
  const fastValues = ema(closes, emaFast);
  const slowValues = ema(closes, emaSlow);
  const atrValues = atr(candles, atrPeriod);
  const index = candles.length - 1;
  const fast = fastValues[index];
  const slow = slowValues[index];
  const volatility = atrValues[index];
  const slope = fast - fastValues[index - slopeLookback];
  const { highs, lows } = confirmedPivots(candles, { left: pivotLeft, right: pivotRight });
  const lastHighs = highs.slice(-2);
  const lastLows = lows.slice(-2);
  const longStructure = lastLows.length < 2 || lastLows[1].price >= lastLows[0].price;
  const shortStructure = lastHighs.length < 2 || lastHighs[1].price <= lastHighs[0].price;
  const candle = candles[index];

  let direction = "NEUTRAL";
  if (fast > slow && slope > 0 && candle.close > fast && longStructure) direction = "LONG";
  if (fast < slow && slope < 0 && candle.close < fast && shortStructure) direction = "SHORT";

  return {
    direction,
    valid: direction !== "NEUTRAL",
    reason: direction === "NEUTRAL" ? "均线、斜率、价格位置与结构尚未形成一致趋势" : null,
    metrics: {
      emaFast: fast,
      emaSlow: slow,
      emaSlope: slope,
      atr: volatility,
      trendSpreadAtr: volatility > 0 ? Math.abs(fast - slow) / volatility : 0,
      lastSwingHigh: highs.at(-1) ?? null,
      lastSwingLow: lows.at(-1) ?? null,
    },
  };
}
