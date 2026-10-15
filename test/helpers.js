export const strategyConfig = Object.freeze({
  emaFast: 20,
  emaSlow: 50,
  rsiPeriod: 14,
  atrPeriod: 14,
  volumePeriod: 20,
  minConfidence: 70,
  atrStopMultiplier: 1.5,
  minStopPercent: 0.15,
  maxStopPercent: 4,
  takeProfitRR1: 1.5,
  takeProfitRR2: 2.5,
  riskPerTradePercent: 1,
});

export function trendingCandles(direction = "up", count = 120) {
  let price = 100;
  return Array.from({ length: count }, (_, index) => {
    const upChange = index % 3 === 0 ? -0.5 : 0.4;
    const change = direction === "up" ? upChange : -upChange;
    const open = price;
    price += change;
    const close = price;
    return {
      openTime: index * 60_000,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 100 + (index % 5),
      closeTime: (index + 1) * 60_000 - 1,
    };
  });
}
