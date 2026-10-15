import { buildExcursionAttribution, buildOpportunitySourceAttribution } from "./research-attribution.js";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateKey(value, timeZone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextDateKey(key) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function emptyDay(date) {
  return {
    date,
    dailyNetPnl: 0,
    realizedPnl: 0,
    commission: 0,
    fundingPnl: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
  };
}

const SEGMENT_DEFINITIONS = [
  { key: "PRE_BREAKOUT_LONG", strategy: "PRE_BREAKOUT", direction: "LONG", label: "爆发前做多" },
  { key: "PRE_BREAKOUT_SHORT", strategy: "PRE_BREAKOUT", direction: "SHORT", label: "爆发前做空" },
  { key: "BREAKOUT_LONG", strategy: "BREAKOUT", direction: "LONG", label: "突破做多" },
  { key: "BREAKOUT_SHORT", strategy: "BREAKOUT", direction: "SHORT", label: "突破做空" },
  { key: "PULLBACK_LONG", strategy: "PULLBACK", direction: "LONG", label: "回调做多" },
  { key: "PULLBACK_SHORT", strategy: "PULLBACK", direction: "SHORT", label: "回调做空" },
];

const OPEN_SAMPLE_STATUSES = new Set([
  "ENTRY_SUBMITTING",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "PROTECTION_PENDING",
  "PROTECTION_INCOMPLETE",
  "OPEN_PROTECTED",
  "TP1_FILLED",
  "ERROR_UNPROTECTED",
  "OPERATOR_CLOSE_SUBMITTING",
  "OPERATOR_CLOSE_PENDING",
  "OPERATOR_CLOSE_UNKNOWN",
  "PROTECTION_CLEANUP_PENDING",
  "ACCOUNTING_PENDING",
]);

export function buildExecutionSummary(trades = []) {
  const summary = {
    total: 0,
    finalized: 0,
    open: 0,
    accountingPending: 0,
    canceledUnfilled: 0,
    excluded: 0,
    failed: 0,
    submissionUnknown: 0,
    preEntry: 0,
    excludedNetPnl: 0,
  };
  for (const trade of trades.filter((item) => item?.sourceType === "SIGNAL")) {
    summary.total += 1;
    if (trade.status === "SUBMISSION_UNKNOWN" || trade.status === "OPERATOR_CLOSE_UNKNOWN") {
      summary.submissionUnknown += 1;
    } else if (trade.status === "CANCELED") {
      summary.canceledUnfilled += 1;
    } else if (trade.status === "FAILED" || trade.status === "REJECTED") {
      summary.failed += 1;
    } else if (trade.performanceEligible === false) {
      summary.excluded += 1;
      summary.excludedNetPnl += finiteNumber(trade.netPnl, 0);
    } else if (trade.status === "CLOSED" && trade.accountingComplete === true && finiteNumber(trade.netPnl) !== null) {
      summary.finalized += 1;
    } else if (trade.status === "CLOSED" || trade.status === "ACCOUNTING_PENDING") {
      summary.accountingPending += 1;
    } else if (OPEN_SAMPLE_STATUSES.has(trade.status)) {
      summary.open += 1;
    } else {
      summary.preEntry += 1;
    }
  }
  return summary;
}

function summarizeTrades(trades, pendingTrades = [], identity = {}) {
  const netValues = trades.map((trade) => finiteNumber(trade.netPnl, 0));
  const netRValues = trades.map((trade) => finiteNumber(trade.netR)).filter((value) => value !== null);
  const grossProfit = netValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(netValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const wins = netValues.filter((value) => value > 0).length;
  const losses = netValues.filter((value) => value < 0).length;
  return {
    ...identity,
    finalizedTradeCount: trades.length,
    pendingTradeCount: pendingTrades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    totalNetPnl: netValues.reduce((sum, value) => sum + value, 0),
    averageNetR: netRValues.length ? netRValues.reduce((sum, value) => sum + value, 0) / netRValues.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
  };
}

export function buildStrategyPerformance(trades = [], {
  startingEquity = 500,
  timeZone = DEFAULT_TIME_ZONE,
  now = Date.now(),
  sampleTarget = 100,
} = {}) {
  const baseEquity = finiteNumber(startingEquity, 500);
  const eligibleClosedTrades = trades.filter((trade) => (
    trade?.sourceType === "SIGNAL"
    && trade?.performanceEligible !== false
    && trade?.status === "CLOSED"
  ));
  const finalizedTrades = eligibleClosedTrades.filter((trade) => (
    trade.accountingComplete === true
    && finiteNumber(trade.closedAt) !== null
    && finiteNumber(trade.netPnl) !== null
  ));
  const accountingPendingTrades = eligibleClosedTrades.filter((trade) => !finalizedTrades.includes(trade));
  const openPendingTrades = trades.filter((trade) => (
    trade?.sourceType === "SIGNAL"
    && trade?.performanceEligible !== false
    && OPEN_SAMPLE_STATUSES.has(trade?.status)
  ));
  const pendingStrategyTrades = [...accountingPendingTrades, ...openPendingTrades];
  const grouped = new Map();

  for (const trade of finalizedTrades) {
    const dayKey = dateKey(finiteNumber(trade.closedAt), timeZone);
    if (!dayKey) continue;
    const day = grouped.get(dayKey) ?? emptyDay(dayKey);
    const netPnl = finiteNumber(trade.netPnl, 0);
    day.dailyNetPnl += netPnl;
    day.realizedPnl += finiteNumber(trade.realizedPnl, 0);
    day.commission += finiteNumber(trade.commission, 0);
    day.fundingPnl += finiteNumber(trade.fundingPnl, 0);
    day.tradeCount += 1;
    if (netPnl > 0) day.wins += 1;
    if (netPnl < 0) day.losses += 1;
    grouped.set(dayKey, day);
  }

  const today = dateKey(now, timeZone);
  const firstDay = [...grouped.keys()].sort()[0] ?? today;
  const points = [];
  let cumulativeNetPnl = 0;
  for (let dayKey = firstDay; dayKey <= today; dayKey = nextDateKey(dayKey)) {
    const day = grouped.get(dayKey) ?? emptyDay(dayKey);
    cumulativeNetPnl += day.dailyNetPnl;
    points.push({
      ...day,
      cumulativeNetPnl,
      equity: baseEquity + cumulativeNetPnl,
    });
  }

  const totalNetPnl = points.at(-1)?.cumulativeNetPnl ?? 0;
  const wins = finalizedTrades.filter((trade) => finiteNumber(trade.netPnl, 0) > 0).length;
  const losses = finalizedTrades.filter((trade) => finiteNumber(trade.netPnl, 0) < 0).length;
  const overall = summarizeTrades(finalizedTrades, pendingStrategyTrades);
  let runningEquity = baseEquity;
  let peakEquity = baseEquity;
  let maxDrawdownPercent = 0;
  for (const trade of [...finalizedTrades].sort((left, right) => finiteNumber(left.closedAt, 0) - finiteNumber(right.closedAt, 0))) {
    runningEquity += finiteNumber(trade.netPnl, 0);
    peakEquity = Math.max(peakEquity, runningEquity);
    if (peakEquity > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peakEquity - runningEquity) / peakEquity) * 100);
  }
  const segments = SEGMENT_DEFINITIONS.map((definition) => summarizeTrades(
    finalizedTrades.filter((trade) => trade.strategy === definition.strategy && trade.direction === definition.direction),
    pendingStrategyTrades.filter((trade) => trade.strategy === definition.strategy && trade.direction === definition.direction),
    definition,
  ));
  const tiers = [
    { key: "CORE", label: "A级核心层" },
    { key: "EXPLORATION", label: "B级探索层" },
  ].map((definition) => summarizeTrades(
    finalizedTrades.filter((trade) => trade.experimentTier === definition.key),
    pendingStrategyTrades.filter((trade) => trade.experimentTier === definition.key),
    definition,
  ));
  const costCohorts = [
    { key: "NORMAL_COST", label: "普通成本组" },
    { key: "HIGH_COST_EXPLORATION", label: "高成本探索组" },
  ].map((definition) => summarizeTrades(
    finalizedTrades.filter((trade) => trade.costCohort === definition.key),
    pendingStrategyTrades.filter((trade) => trade.costCohort === definition.key),
    definition,
  ));
  const target = Math.max(1, Math.trunc(finiteNumber(sampleTarget, 100)));
  const gateChecks = {
    minimumSamples: finalizedTrades.length >= target,
    positiveAverageNetR: overall.averageNetR > 0,
    profitFactor: Number.isFinite(overall.profitFactor) && overall.profitFactor >= 1.2,
    maxDrawdown: maxDrawdownPercent < 10,
  };
  return {
    currency: "USDT",
    timeZone,
    accountingBasis: "CLOSED_NET_PNL",
    startingEquity: baseEquity,
    currentEquity: baseEquity + totalNetPnl,
    totalNetPnl,
    finalizedTradeCount: finalizedTrades.length,
    pendingTradeCount: pendingStrategyTrades.length,
    wins,
    losses,
    winRate: overall.winRate,
    averageNetR: overall.averageNetR,
    profitFactor: overall.profitFactor,
    maxDrawdownPercent,
    segments,
    tiers,
    costCohorts,
    sampleProgress: {
      target,
      finalized: finalizedTrades.length,
      remaining: Math.max(0, target - finalizedTrades.length),
      completionPercent: Math.min(100, (finalizedTrades.length / target) * 100),
    },
    validationGate: {
      eligible: Object.values(gateChecks).every(Boolean),
      checks: gateChecks,
      note: "达到100笔仅允许进入样本外复核，不等于可以使用真实资金",
    },
    researchAttribution: {
      excursion: buildExcursionAttribution(finalizedTrades),
      opportunitySources: buildOpportunitySourceAttribution(finalizedTrades),
    },
    points,
  };
}
