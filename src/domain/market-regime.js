import { atr } from "./indicators.js";
import { classifyHourlyTrend } from "./market-structure.js";

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function percentileRank(values, target) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length || !Number.isFinite(target)) return null;
  return valid.filter((value) => value <= target).length / valid.length;
}

function volatilityLabel(percentile) {
  if (!Number.isFinite(percentile)) return "UNKNOWN";
  if (percentile >= 0.9) return "EXTREME";
  if (percentile >= 0.7) return "HIGH";
  if (percentile <= 0.2) return "LOW";
  return "NORMAL";
}

function summarizeTrend(candles, config) {
  const trend = classifyHourlyTrend(candles, config);
  return {
    direction: trend.direction,
    valid: trend.valid,
    reason: trend.reason,
    trendSpreadAtr: round(trend.metrics?.trendSpreadAtr),
    candleCloseTime: candles.at(-1)?.closeTime ?? null,
  };
}

export function buildMarketRegime({ btcFourHour, btcHourly, analyses = [], config = {} }) {
  if (!Array.isArray(btcFourHour) || !Array.isArray(btcHourly)) {
    throw new TypeError("市场环境需要 BTC 4小时和1小时K线");
  }
  const btc4h = summarizeTrend(btcFourHour, config);
  const btc1h = summarizeTrend(btcHourly, config);
  const directions = analyses.map((item) => item?.trend).filter((item) => ["LONG", "SHORT", "NEUTRAL"].includes(item));
  const total = directions.length;
  const long = directions.filter((item) => item === "LONG").length;
  const short = directions.filter((item) => item === "SHORT").length;
  const neutral = total - long - short;
  const longRatio = total ? long / total : 0;
  const shortRatio = total ? short / total : 0;
  let breadthDirection = "NEUTRAL";
  if (longRatio >= 0.6) breadthDirection = "LONG";
  if (shortRatio >= 0.6) breadthDirection = "SHORT";

  const atrSeries = atr(btcHourly, config.atrPeriod ?? 14);
  const atrPercents = atrSeries.map((value, index) => {
    const close = btcHourly[index]?.close;
    return Number.isFinite(value) && Number.isFinite(close) && close > 0 ? (value / close) * 100 : null;
  }).filter(Number.isFinite);
  const currentAtrPercent = atrPercents.at(-1) ?? null;
  const volatilityPercentile = percentileRank(atrPercents.slice(-180), currentAtrPercent);

  let direction = "MIXED";
  if (btc4h.direction === btc1h.direction && btc1h.direction !== "NEUTRAL") direction = btc1h.direction;
  const breadthAgrees = direction !== "MIXED" && breadthDirection === direction;
  return {
    version: "MARKET_REGIME_V1",
    decidedAt: Math.max(btc4h.candleCloseTime ?? 0, btc1h.candleCloseTime ?? 0) || Date.now(),
    direction,
    breadthAgrees,
    btc4h,
    btc1h,
    breadth: {
      direction: breadthDirection,
      total,
      long,
      short,
      neutral,
      longRatio: round(longRatio),
      shortRatio: round(shortRatio),
    },
    volatility: {
      atrPercent: round(currentAtrPercent),
      percentile: round(volatilityPercentile),
      regime: volatilityLabel(volatilityPercentile),
    },
  };
}

export function regimeDirectionScore(direction, regime) {
  if (!regime || regime.direction === "MIXED") return 8;
  if (regime.direction !== direction) return 0;
  return regime.breadthAgrees ? 20 : 15;
}
