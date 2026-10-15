function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function buildShadowPerformance(records = [], { startingEquity = 500 } = {}) {
  const trades = records.map((record) => record?.trade).filter(Boolean);
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const netValues = closed.map((trade) => Number(trade.pnl?.net) || 0);
  const rValues = closed.map((trade) => Number(trade.pnl?.netR)).filter(Number.isFinite);
  const grossProfit = netValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(netValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  let equity = startingEquity;
  let peak = equity;
  let maxDrawdownPercent = 0;
  for (const trade of [...closed].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))) {
    equity += Number(trade.pnl?.net) || 0;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdown);
  }
  const totalNetPnl = netValues.reduce((sum, value) => sum + value, 0);
  const wins = netValues.filter((value) => value > 0).length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const averageNetR = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : 0;
  const gateChecks = {
    minimumSamples: closed.length >= 100,
    positiveAverageNetR: averageNetR > 0,
    profitFactor: profitFactor >= 1.2,
    maxDrawdown: maxDrawdownPercent < 10,
  };
  return {
    portfolio: "V2_4_1_PREMOVE",
    sampleType: "FORWARD_DEMO_RESEARCH",
    startingEquity,
    currentEquity: round(startingEquity + totalNetPnl, 6),
    totalNetPnl: round(totalNetPnl, 6),
    activeTradeCount: trades.filter((trade) => ["ENTRY_PENDING", "OPEN", "TP1_FILLED"].includes(trade.status)).length,
    closedTradeCount: closed.length,
    wins,
    losses: netValues.filter((value) => value < 0).length,
    winRate: closed.length ? round(wins / closed.length, 4) : 0,
    averageNetR: round(averageNetR, 4),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 4) : null,
    maxDrawdownPercent: round(maxDrawdownPercent, 4),
    promotionGate: {
      eligible: Object.values(gateChecks).every(Boolean),
      checks: gateChecks,
      note: "必须同时结合封存样本外/走步验证，不以在线影子结果单独晋级",
    },
  };
}
