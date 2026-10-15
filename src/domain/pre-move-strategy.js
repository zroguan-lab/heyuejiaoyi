import { createHash } from "node:crypto";
import { atr } from "./indicators.js";
import { buildRiskPlan } from "./risk.js";
import { classifyHourlyTrend } from "./market-structure.js";
import { buildEntryReason, buildMarketEventId } from "./trade-reason.js";

export const PRE_MOVE_SIGNAL_VERSION = "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER";

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function trueRanges(candles) {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

function candidateId({ symbol, direction, triggerTime }) {
  return createHash("sha256")
    .update(`${symbol}:PRE_BREAKOUT:${direction}:${triggerTime}`)
    .digest("hex")
    .slice(0, 24);
}

function volumeOf(candle) {
  return Number(candle?.quoteVolume ?? candle?.volume);
}

function directionPressure(five, direction, volatility) {
  const recent = five.slice(-4);
  if (recent.length < 4 || !Number.isFinite(volatility) || volatility <= 0) return null;
  const sign = direction === "LONG" ? 1 : -1;
  const netMoveAtr = sign * (recent.at(-1).close - recent[0].open) / volatility;
  const closes = recent.slice(1).reduce((count, candle, index) => {
    const previous = recent[index];
    return count + (sign * (candle.close - previous.close) > 0 ? 1 : 0);
  }, 0) / 3;
  const bodyPressure = recent.reduce((sum, candle) => {
    const range = Math.max(candle.high - candle.low, Number.EPSILON);
    return sum + sign * (candle.close - candle.open) / range;
  }, 0) / recent.length;
  const latest = recent.at(-1);
  const previous = recent.at(-2);
  const latestRange = Math.max(latest.high - latest.low, Number.EPSILON);
  const latestDirectionalBodyAtr = sign * (latest.close - latest.open) / volatility;
  const latestDirectionalCloseChangeAtr = sign * (latest.close - previous.close) / volatility;
  const latestCloseLocation = direction === "LONG"
    ? (latest.close - latest.low) / latestRange
    : (latest.high - latest.close) / latestRange;
  const score = clamp(0.45 * clamp((netMoveAtr + 0.5) / 1.5) + 0.35 * closes + 0.2 * clamp((bodyPressure + 1) / 2));
  return {
    score,
    netMoveAtr,
    advancingCloseRatio: closes,
    bodyPressure,
    latestDirectionalBodyAtr,
    latestDirectionalCloseChangeAtr,
    latestCloseLocation,
  };
}

function buildPreMoveMetrics({ fifteen, five, direction, trend, radar }) {
  const latest15 = fifteen.at(-1);
  const latest5 = five.at(-1);
  const atr15 = atr(fifteen, 14).at(-1);
  const atr5 = atr(five, 14).at(-1);
  if (![atr15, atr5, latest15?.close, latest5?.close].every(Number.isFinite) || atr15 <= 0 || atr5 <= 0) return null;

  const ranges = trueRanges(fifteen);
  const recentRange = average(ranges.slice(-4));
  const baselineRange = average(ranges.slice(-16, -4));
  const compressionRatio = recentRange !== null && baselineRange > 0 ? recentRange / baselineRange : null;

  const history = fifteen.slice(-9, -1);
  if (history.length < 8) return null;
  const rangeHigh = Math.max(...history.map((candle) => candle.high));
  const rangeLow = Math.min(...history.map((candle) => candle.low));
  const rangeWidth = rangeHigh - rangeLow;
  const rangePosition = rangeWidth > 0 ? clamp((latest5.close - rangeLow) / rangeWidth) : 0.5;
  const boundary = direction === "LONG" ? rangeHigh : rangeLow;
  const signedBoundaryDistance = direction === "LONG" ? boundary - latest5.close : latest5.close - boundary;
  const boundaryDistanceAtr = signedBoundaryDistance / atr15;
  const alreadyBroken = signedBoundaryDistance < 0;

  const volumes = five.map(volumeOf);
  const recentVolume = average(volumes.slice(-3));
  const baselineVolume = average(volumes.slice(-23, -3));
  const volumeAcceleration = recentVolume !== null && baselineVolume > 0 ? recentVolume / baselineVolume : null;
  const pressure = directionPressure(five, direction, atr5);
  if (!pressure) return null;
  const directionalRangePosition = direction === "LONG" ? rangePosition : 1 - rangePosition;
  const radarDirectionAgreement = !radar?.bias || radar.bias === "NEUTRAL" || radar.bias === direction ? 1 : 0;
  const relativeStrength = Number(radar?.relativeStrengthMarket1h);
  const signedRelativeStrength = Number.isFinite(relativeStrength)
    ? (direction === "LONG" ? relativeStrength : -relativeStrength)
    : 0;

  const compressionComponent = 35 * clamp((1.25 - compressionRatio) / 0.75);
  const volumeComponent = 25 * clamp((volumeAcceleration - 0.7) / 1.3);
  const proximityComponent = 25 * clamp(1 - Math.max(0, boundaryDistanceAtr) / 1.2);
  const tightnessComponent = 15 * clamp((4 - rangeWidth / atr15) / 3);
  const explosionScore = Math.round(compressionComponent + volumeComponent + proximityComponent + tightnessComponent);

  const trendComponent = 30 * clamp(Number(trend.metrics?.trendSpreadAtr) / 1.5);
  const positionComponent = 20 * clamp((directionalRangePosition - 0.35) / 0.65);
  const pressureComponent = 20 * pressure.score;
  const relativeComponent = 20 * clamp((signedRelativeStrength + 1) / 3);
  const radarComponent = 10 * radarDirectionAgreement;
  const directionScore = Math.round(trendComponent + positionComponent + pressureComponent + relativeComponent + radarComponent);

  return {
    modelVersion: PRE_MOVE_SIGNAL_VERSION,
    explosionScore,
    directionScore,
    compressionRatio: round(compressionRatio, 4),
    volumeAcceleration: round(volumeAcceleration, 4),
    boundary: round(boundary, 10),
    boundaryDistanceAtr: round(boundaryDistanceAtr, 4),
    rangeHigh: round(rangeHigh, 10),
    rangeLow: round(rangeLow, 10),
    rangeWidthAtr: round(rangeWidth / atr15, 4),
    rangePosition: round(rangePosition, 4),
    directionalPressure: round(pressure.score, 4),
    triggerConfirmation: {
      netMoveAtr: round(pressure.netMoveAtr, 4),
      advancingCloseRatio: round(pressure.advancingCloseRatio, 4),
      bodyPressure: round(pressure.bodyPressure, 4),
      latestDirectionalBodyAtr: round(pressure.latestDirectionalBodyAtr, 4),
      latestDirectionalCloseChangeAtr: round(pressure.latestDirectionalCloseChangeAtr, 4),
      latestCloseLocation: round(pressure.latestCloseLocation, 4),
    },
    atr15: round(atr15, 10),
    atr5: round(atr5, 10),
    alreadyBroken,
    components: {
      compression: round(compressionComponent, 2),
      volumeAcceleration: round(volumeComponent, 2),
      boundaryProximity: round(proximityComponent, 2),
      rangeTightness: round(tightnessComponent, 2),
      trend: round(trendComponent, 2),
      rangePosition: round(positionComponent, 2),
      directionalPressure: round(pressureComponent, 2),
      relativeStrength: round(relativeComponent, 2),
      radarAgreement: round(radarComponent, 2),
    },
  };
}

export function analyzePreMove({ symbol, hourly, fifteen, five, radar = null, config, now = Date.now() }) {
  if (!Number.isFinite(now) || now < 0) throw new TypeError("V2.4.3分析需要有效的now时间");
  const minimum = Math.max(config.emaSlow + 5, config.atrPeriod + 10, 40);
  if (hourly.length < minimum || fifteen.length < minimum || five.length < minimum) {
    return { symbol, status: "WAIT", message: "V2.4.3爆发前识别数据不足", trend: "NEUTRAL", candidates: [] };
  }

  const trend = classifyHourlyTrend(hourly, config);
  if (!trend.valid) {
    return { symbol, status: "WAIT", message: trend.reason, trend: "NEUTRAL", candidates: [] };
  }

  const preMove = buildPreMoveMetrics({ fifteen, five, direction: trend.direction, trend, radar });
  if (!preMove) {
    return { symbol, status: "WAIT", message: "V2.4.3爆发前指标不可用", trend: trend.direction, candidates: [] };
  }
  const maxBoundaryDistanceAtr = Number(config.preMoveMaxBoundaryDistanceAtr ?? 1.2);
  const maxCompressionRatio = Number(config.preMoveMaxCompressionRatio ?? 1.25);
  const minimumExplosionScore = Number(config.preMoveMinimumExplosionScore ?? 40);
  const minimumDirectionScore = Number(config.preMoveMinimumDirectionScore ?? 48);
  const directionalPosition = trend.direction === "LONG" ? preMove.rangePosition : 1 - preMove.rangePosition;
  const waits = [];
  if (preMove.alreadyBroken) waits.push("结构边界已经突破");
  if (preMove.boundaryDistanceAtr < 0 || preMove.boundaryDistanceAtr > maxBoundaryDistanceAtr) waits.push("距离结构边界过远");
  if (preMove.compressionRatio > maxCompressionRatio) waits.push("波动尚未收缩");
  if (directionalPosition < 0.45) waits.push("价格尚未靠近方向侧");
  if (preMove.explosionScore < minimumExplosionScore) waits.push("爆发概率评分不足");
  if (preMove.directionScore < minimumDirectionScore) waits.push("方向可信度不足");
  if (waits.length) {
    return {
      symbol,
      status: "WAIT",
      message: `V2.4.3等待：${waits.join("、")}`,
      trend: trend.direction,
      trendMetrics: trend.metrics,
      preMove,
      candidates: [],
      analyzedAt: new Date(now).toISOString(),
      candleCloseTime: five.at(-1)?.closeTime ?? null,
    };
  }

  const latestFive = five.at(-1);
  const recentFive = five.slice(-8);
  const risk = buildRiskPlan({
    direction: trend.direction,
    entry: latestFive.close,
    atr: preMove.atr5,
    recentHigh: Math.max(...recentFive.map((candle) => candle.high)),
    recentLow: Math.min(...recentFive.map((candle) => candle.low)),
    config,
  });
  if (!risk.valid) {
    return {
      symbol,
      status: "WAIT",
      message: `V2.4.3风控未通过：${risk.reason}`,
      trend: trend.direction,
      trendMetrics: trend.metrics,
      preMove,
      candidates: [],
    };
  }

  const triggerTime = latestFive.closeTime;
  const score = Math.round(preMove.explosionScore * 0.55 + preMove.directionScore * 0.45);
  const base = {
    id: candidateId({ symbol, direction: trend.direction, triggerTime }),
    symbol,
    strategy: "PRE_BREAKOUT",
    direction: trend.direction,
    action: trend.direction === "LONG" ? "BUY" : "SELL",
    status: "CANDIDATE",
    generatedAt: new Date(triggerTime).toISOString(),
    triggerTime,
    triggerInterval: "5m",
    score,
    reasons: [
      "15分钟波动收缩且价格靠近结构边界",
      "5分钟量能与方向压力用于识别潜在扩张",
      "1小时趋势决定预突破交易方向",
    ],
    metrics: {
      atr: preMove.atr5,
      atrPercent: round(preMove.atr5 / latestFive.close * 100, 4),
      volumeRatio: preMove.volumeAcceleration,
      trendSpreadAtr: round(trend.metrics?.trendSpreadAtr, 4),
      boundaryDistanceAtr: preMove.boundaryDistanceAtr,
      compressionRatio: preMove.compressionRatio,
      bodyAtr: round(Math.abs(latestFive.close - latestFive.open) / preMove.atr5, 4),
    },
    preMove,
    risk,
    order: {
      type: "LIMIT",
      style: "ACTIVE_DYNAMIC",
      entry: risk.entry,
      expiresAt: triggerTime + 10 * 60_000,
      expiryBars: 2,
    },
    strategyVersion: PRE_MOVE_SIGNAL_VERSION,
    marketEventId: buildMarketEventId(triggerTime, 5 * 60_000),
  };
  const candidate = { ...base, entryReason: buildEntryReason(base) };
  return {
    symbol,
    status: "CANDIDATE",
    message: `V2.4.3发现爆发前${trend.direction === "LONG" ? "做多" : "做空"}候选`,
    trend: trend.direction,
    trendMetrics: trend.metrics,
    preMove,
    candidates: [candidate],
    analyzedAt: new Date(now).toISOString(),
    candleCloseTime: triggerTime,
  };
}
