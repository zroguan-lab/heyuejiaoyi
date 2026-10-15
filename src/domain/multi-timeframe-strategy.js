import { createHash } from "node:crypto";
import { atr, ema, rsi, sma } from "./indicators.js";
import { buildRiskPlan } from "./risk.js";
import { classifyHourlyTrend, latestConfirmedSwing } from "./market-structure.js";
import { buildEntryReason, buildMarketEventId, STRATEGY_VERSION } from "./trade-reason.js";

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function candidateId({ symbol, strategy, direction, triggerTime }) {
  return createHash("sha256")
    .update(`${symbol}:${strategy}:${direction}:${triggerTime}`)
    .digest("hex")
    .slice(0, 24);
}

function intervalMs(interval) {
  if (interval === "5m") return 5 * 60_000;
  if (interval === "15m") return 15 * 60_000;
  throw new Error(`无法计算周期时长: ${interval}`);
}

function scoreContext({ trend, volumeRatio, priceMoveAtr, bodyRatio }) {
  const trendScore = Math.min(20, Math.max(0, trend.metrics.trendSpreadAtr * 10));
  const volumeScore = Math.min(15, Math.max(0, (volumeRatio - 0.5) * 15));
  const moveScore = Math.min(10, Math.max(0, priceMoveAtr * 10));
  const bodyScore = Math.min(10, Math.max(0, bodyRatio * 10));
  return Math.round(Math.min(100, 45 + trendScore + volumeScore + moveScore + bodyScore));
}

function marketMetrics(candles, config) {
  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  const atrValues = atr(candles, config.atrPeriod);
  const rsiValues = rsi(closes, config.rsiPeriod);
  const volumeAverages = sma(volumes, config.volumePeriod);
  const index = candles.length - 1;
  const candle = candles[index];
  const volatility = atrValues[index];
  const averageVolume = volumeAverages[index];
  return {
    candle,
    atr: volatility,
    rsi: rsiValues[index],
    volumeRatio: averageVolume > 0 ? candle.volume / averageVolume : 0,
    bodyRatio: volatility > 0 ? Math.abs(candle.close - candle.open) / volatility : 0,
  };
}

function buildCandidate({ symbol, strategy, direction, triggerInterval, triggerTime, entry, risk, score, reasons, metrics, expiryBars, orderType }) {
  const candidate = {
    id: candidateId({ symbol, strategy, direction, triggerTime }),
    symbol,
    strategy,
    direction,
    action: direction === "LONG" ? "BUY" : "SELL",
    status: "CANDIDATE",
    generatedAt: new Date(triggerTime).toISOString(),
    triggerTime,
    triggerInterval,
    score,
    reasons,
    metrics,
    risk,
    order: {
      type: "LIMIT",
      style: orderType,
      entry,
      expiresAt: triggerTime + intervalMs(triggerInterval) * expiryBars,
      expiryBars,
    },
  };
  return {
    ...candidate,
    strategyVersion: STRATEGY_VERSION,
    marketEventId: buildMarketEventId(triggerTime),
    entryReason: buildEntryReason(candidate),
  };
}

function breakoutCandidate({ symbol, fifteen, trend, config }) {
  const metrics = marketMetrics(fifteen, config);
  if (!Number.isFinite(metrics.atr) || metrics.atr <= 0) return null;
  const history = fifteen.slice(0, -1);
  const kind = trend.direction === "LONG" ? "HIGH" : "LOW";
  const swing = latestConfirmedSwing(history, kind);
  if (!swing) return null;

  const buffer = metrics.atr * (config.breakoutBufferAtr ?? 0.05);
  const threshold = swing.price + (trend.direction === "LONG" ? buffer : -buffer);
  const crossed = trend.direction === "LONG" ? metrics.candle.close > threshold : metrics.candle.close < threshold;
  if (!crossed) return null;

  const recent = fifteen.slice(-10);
  const risk = buildRiskPlan({
    direction: trend.direction,
    entry: metrics.candle.close,
    atr: metrics.atr,
    recentHigh: Math.max(...recent.map((item) => item.high)),
    recentLow: Math.min(...recent.map((item) => item.low)),
    config,
  });
  if (!risk.valid) return null;

  const priceMoveAtr = Math.abs(metrics.candle.close - swing.price) / metrics.atr;
  const score = scoreContext({ trend, volumeRatio: metrics.volumeRatio, priceMoveAtr, bodyRatio: metrics.bodyRatio });
  return buildCandidate({
    symbol,
    strategy: "BREAKOUT",
    direction: trend.direction,
    triggerInterval: "15m",
    triggerTime: metrics.candle.closeTime,
    entry: risk.entry,
    risk,
    score,
    expiryBars: 1,
    orderType: "ACTIVE_DYNAMIC",
    reasons: [
      "1小时均线、斜率与结构方向一致",
      `15分钟收盘有效突破最近结构${kind === "HIGH" ? "高点" : "低点"}`,
      "成交量与K线实体仅参与质量排序，不作为硬门槛",
    ],
    metrics: {
      rsi: round(metrics.rsi, 2),
      atr: round(metrics.atr, 8),
      atrPercent: round((metrics.atr / metrics.candle.close) * 100, 3),
      volumeRatio: round(metrics.volumeRatio, 3),
      structureLevel: swing.price,
      trendSpreadAtr: round(trend.metrics.trendSpreadAtr, 3),
      bodyAtr: round(metrics.bodyRatio, 3),
      breakoutDistanceAtr: round(priceMoveAtr, 3),
      distanceFromFastEmaAtr: round(Math.abs(metrics.candle.close - trend.metrics.emaFast) / metrics.atr, 3),
    },
  });
}

function pullbackCandidate({ symbol, fifteen, five, trend, config }) {
  const fifteenMetrics = marketMetrics(fifteen, config);
  if (!Number.isFinite(fifteenMetrics.atr) || fifteenMetrics.atr <= 0 || five.length < config.atrPeriod + 8) return null;
  const fifteenEma = ema(fifteen.map((item) => item.close), config.emaFast).at(-1);
  if (!Number.isFinite(fifteenEma)) return null;

  const zoneTolerance = fifteenMetrics.atr * (config.pullbackZoneAtr ?? 0.25);
  const zoneTouched = trend.direction === "LONG"
    ? fifteenMetrics.candle.low <= fifteenEma + zoneTolerance && fifteenMetrics.candle.close >= fifteenEma - zoneTolerance
    : fifteenMetrics.candle.high >= fifteenEma - zoneTolerance && fifteenMetrics.candle.close <= fifteenEma + zoneTolerance;
  if (!zoneTouched) return null;

  const fiveAtr = atr(five, config.atrPeriod).at(-1);
  if (!Number.isFinite(fiveAtr) || fiveAtr <= 0) return null;
  const history = five.slice(0, -1);
  const kind = trend.direction === "LONG" ? "HIGH" : "LOW";
  const triggerSwing = latestConfirmedSwing(history, kind, { left: 2, right: 1 });
  if (!triggerSwing) return null;
  const latestFive = five.at(-1);
  const triggerBuffer = fiveAtr * (config.pullbackTriggerBufferAtr ?? 0.03);
  const triggerLevel = triggerSwing.price + (trend.direction === "LONG" ? triggerBuffer : -triggerBuffer);
  const confirmed = trend.direction === "LONG" ? latestFive.close > triggerLevel : latestFive.close < triggerLevel;
  if (!confirmed) return null;

  const recent = fifteen.slice(-10);
  const risk = buildRiskPlan({
    direction: trend.direction,
    entry: triggerLevel,
    atr: fifteenMetrics.atr,
    recentHigh: Math.max(...recent.map((item) => item.high)),
    recentLow: Math.min(...recent.map((item) => item.low)),
    config,
  });
  if (!risk.valid) return null;

  const volumeAverage = sma(five.map((item) => item.volume), config.volumePeriod).at(-1);
  const volumeRatio = volumeAverage > 0 ? latestFive.volume / volumeAverage : 0;
  const score = scoreContext({
    trend,
    volumeRatio,
    priceMoveAtr: Math.abs(latestFive.close - triggerSwing.price) / fiveAtr,
    bodyRatio: Math.abs(latestFive.close - latestFive.open) / fiveAtr,
  });
  return buildCandidate({
    symbol,
    strategy: "PULLBACK",
    direction: trend.direction,
    triggerInterval: "5m",
    triggerTime: latestFive.closeTime,
    entry: risk.entry,
    risk,
    score,
    expiryBars: 3,
    orderType: "PASSIVE_RETEST",
    reasons: [
      "1小时趋势保持有效",
      "15分钟价格进入EMA与结构回调区域",
      "5分钟收盘确认短期市场结构反转",
    ],
    metrics: {
      rsi: round(fifteenMetrics.rsi, 2),
      atr: round(fifteenMetrics.atr, 8),
      atrPercent: round((fifteenMetrics.atr / fifteenMetrics.candle.close) * 100, 3),
      volumeRatio: round(volumeRatio, 3),
      pullbackEma: round(fifteenEma, 8),
      triggerLevel: round(triggerSwing.price, 8),
      trendSpreadAtr: round(trend.metrics.trendSpreadAtr, 3),
      bodyAtr: round(Math.abs(latestFive.close - latestFive.open) / fiveAtr, 3),
      pullbackDepthAtr: round(Math.abs(fifteenMetrics.candle.close - fifteenEma) / fifteenMetrics.atr, 3),
      triggerDistanceAtr: round(Math.abs(latestFive.close - triggerSwing.price) / fiveAtr, 3),
    },
  });
}

export function analyzeMultiTimeframe({ symbol, hourly, fifteen, five, config }) {
  const minimum15m = Math.max(config.emaSlow + 5, config.rsiPeriod + 5, config.atrPeriod + 5, config.volumePeriod + 5);
  if (fifteen.length < minimum15m || five.length < minimum15m) {
    return { symbol, status: "WAIT", message: "多周期数据不足", trend: "NEUTRAL", candidates: [] };
  }

  const trend = classifyHourlyTrend(hourly, config);
  if (!trend.valid) {
    return { symbol, status: "WAIT", message: trend.reason, trend: "NEUTRAL", candidates: [] };
  }

  const candidates = [
    breakoutCandidate({ symbol, fifteen, trend, config }),
    pullbackCandidate({ symbol, fifteen, five, trend, config }),
  ].filter(Boolean);

  return {
    symbol,
    status: candidates.length ? "CANDIDATE" : "WAIT",
    message: candidates.length ? `发现 ${candidates.length} 个规则候选` : "趋势有效，但尚未出现突破或回调触发",
    trend: trend.direction,
    trendMetrics: trend.metrics,
    candidates,
    analyzedAt: new Date().toISOString(),
    candleCloseTime: fifteen.at(-1)?.closeTime ?? null,
  };
}
