function pricePrecision(price) {
  if (price >= 10_000) return 1;
  if (price >= 1_000) return 2;
  if (price >= 1) return 4;
  return 6;
}

function roundPrice(value, reference) {
  return Number(value.toFixed(pricePrecision(reference)));
}

export function buildRiskPlan({ direction, entry, atr, recentHigh, recentLow, config }) {
  if (![entry, atr, recentHigh, recentLow].every(Number.isFinite) || entry <= 0 || atr <= 0) {
    return { valid: false, reason: "波动率或价格数据无效" };
  }
  if (direction !== "LONG" && direction !== "SHORT") {
    return { valid: false, reason: "没有可计算风控的交易方向" };
  }

  const atrDistance = atr * config.atrStopMultiplier;
  const structuralBuffer = atr * 0.1;
  const rawStop = direction === "LONG"
    ? Math.min(entry - atrDistance, recentLow - structuralBuffer)
    : Math.max(entry + atrDistance, recentHigh + structuralBuffer);
  const riskDistance = Math.abs(entry - rawStop);
  const stopPercent = (riskDistance / entry) * 100;

  if (stopPercent < config.minStopPercent) {
    return { valid: false, reason: `止损距离 ${stopPercent.toFixed(2)}% 过窄，容易被市场噪声触发` };
  }
  if (stopPercent > config.maxStopPercent) {
    return { valid: false, reason: `止损距离 ${stopPercent.toFixed(2)}% 超过风控上限` };
  }

  const sign = direction === "LONG" ? 1 : -1;
  const takeProfit1 = entry + sign * riskDistance * config.takeProfitRR1;
  const takeProfit2 = entry + sign * riskDistance * config.takeProfitRR2;

  return {
    valid: true,
    entry: roundPrice(entry, entry),
    stopLoss: roundPrice(rawStop, entry),
    takeProfit1: roundPrice(takeProfit1, entry),
    takeProfit2: roundPrice(takeProfit2, entry),
    stopPercent: Number(stopPercent.toFixed(2)),
    riskReward1: config.takeProfitRR1,
    riskReward2: config.takeProfitRR2,
    riskPerTradePercent: config.riskPerTradePercent,
    trailingRule: `触及第一止盈后，可将止损上移到入场价；单笔账户风险不超过 ${config.riskPerTradePercent}%`,
  };
}
