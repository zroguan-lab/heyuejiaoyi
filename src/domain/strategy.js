import { createHash } from "node:crypto";
import { atr, ema, rsi, sma } from "./indicators.js";
import { buildRiskPlan } from "./risk.js";

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function baseResult({ symbol, interval, candle, message, metrics = null }) {
  return {
    id: createHash("sha256").update(`${symbol}:${interval}:${candle?.closeTime ?? 0}:WAIT`).digest("hex").slice(0, 20),
    symbol,
    interval,
    status: "WAIT",
    action: "WAIT",
    direction: "FLAT",
    generatedAt: new Date().toISOString(),
    candleCloseTime: candle?.closeTime ?? null,
    price: candle?.close ?? null,
    confidence: 0,
    message,
    reasons: [],
    metrics,
    risk: null,
  };
}

export function analyzeMarket({ symbol, interval, candles, config }) {
  const minimumCandles = Math.max(config.emaSlow + 3, config.rsiPeriod + 3, config.atrPeriod + 3, config.volumePeriod + 3);
  const candle = candles.at(-1);
  if (candles.length < minimumCandles) {
    return baseResult({ symbol, interval, candle, message: `数据不足：需要至少 ${minimumCandles} 根已收盘 K 线` });
  }

  const closes = candles.map((item) => item.close);
  const volumes = candles.map((item) => item.volume);
  const fastValues = ema(closes, config.emaFast);
  const slowValues = ema(closes, config.emaSlow);
  const rsiValues = rsi(closes, config.rsiPeriod);
  const atrValues = atr(candles, config.atrPeriod);
  const volumeAverages = sma(volumes, config.volumePeriod);
  const index = candles.length - 1;
  const previous = candles[index - 1];
  const fast = fastValues[index];
  const previousFast = fastValues[index - 1];
  const slow = slowValues[index];
  const momentum = rsiValues[index];
  const volatility = atrValues[index];
  const volumeRatio = volumeAverages[index] === 0 ? 0 : candle.volume / volumeAverages[index];

  const metrics = {
    emaFast: round(fast, 6),
    emaSlow: round(slow, 6),
    rsi: round(momentum),
    atr: round(volatility, 6),
    atrPercent: round((volatility / candle.close) * 100),
    volumeRatio: round(volumeRatio),
  };

  const scores = { LONG: 0, SHORT: 0 };
  const reasons = { LONG: [], SHORT: [] };

  if (fast > slow && candle.close > slow) {
    scores.LONG += 30;
    reasons.LONG.push("快线位于慢线上方，价格保持在趋势线之上");
  }
  if (fast < slow && candle.close < slow) {
    scores.SHORT += 30;
    reasons.SHORT.push("快线位于慢线下方，价格保持在趋势线之下");
  }
  if (fast > previousFast) {
    scores.LONG += 20;
    reasons.LONG.push("短期趋势斜率向上");
  } else if (fast < previousFast) {
    scores.SHORT += 20;
    reasons.SHORT.push("短期趋势斜率向下");
  }
  if (momentum >= 52 && momentum <= 70) {
    scores.LONG += 20;
    reasons.LONG.push(`RSI ${momentum.toFixed(1)}，多头动量健康且未过热`);
  }
  if (momentum >= 30 && momentum <= 48) {
    scores.SHORT += 20;
    reasons.SHORT.push(`RSI ${momentum.toFixed(1)}，空头动量占优且未过度超卖`);
  }
  if (candle.close > previous.close) {
    scores.LONG += 15;
    reasons.LONG.push("最新收盘价高于前一根 K 线");
  } else if (candle.close < previous.close) {
    scores.SHORT += 15;
    reasons.SHORT.push("最新收盘价低于前一根 K 线");
  }
  if (volumeRatio >= 0.8) {
    scores.LONG += 15;
    scores.SHORT += 15;
    reasons.LONG.push(`成交量为均量的 ${volumeRatio.toFixed(2)} 倍`);
    reasons.SHORT.push(`成交量为均量的 ${volumeRatio.toFixed(2)} 倍`);
  }

  const direction = scores.LONG > scores.SHORT ? "LONG" : "SHORT";
  const confidence = scores[direction];
  if (confidence < config.minConfidence) {
    const result = baseResult({ symbol, interval, candle, message: "趋势、动量与量能尚未形成足够共振", metrics });
    result.confidence = confidence;
    result.reasons = reasons[direction];
    return result;
  }

  const recent = candles.slice(-10);
  const risk = buildRiskPlan({
    direction,
    entry: candle.close,
    atr: volatility,
    recentHigh: Math.max(...recent.map((item) => item.high)),
    recentLow: Math.min(...recent.map((item) => item.low)),
    config,
  });
  if (!risk.valid) {
    const result = baseResult({ symbol, interval, candle, message: risk.reason, metrics });
    result.confidence = confidence;
    result.reasons = reasons[direction];
    return result;
  }

  const action = direction === "LONG" ? "BUY" : "SELL";
  return {
    id: createHash("sha256").update(`${symbol}:${interval}:${candle.closeTime}:${direction}`).digest("hex").slice(0, 20),
    symbol,
    interval,
    status: "SIGNAL",
    action,
    direction,
    generatedAt: new Date().toISOString(),
    candleCloseTime: candle.closeTime,
    price: candle.close,
    confidence,
    message: direction === "LONG" ? "多头条件形成：考虑买入开多" : "空头条件形成：考虑卖出开空",
    reasons: reasons[direction],
    metrics,
    risk,
  };
}
