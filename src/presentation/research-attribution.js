function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function median(values) {
  const ordered = values.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function netPnl(trade) {
  return finite(trade?.netPnl) ?? finite(trade?.pnl?.net);
}

export function metricCoverage(values) {
  const total = values.length;
  const valid = values.filter((value) => finite(value) !== null).length;
  return { total, valid, missing: total - valid, coverage: total ? valid / total : null };
}

export function tradeMetricCoverage(trades) {
  return Object.fromEntries(Object.entries({
    netPnl, netR, mfeR: (trade) => trade?.mfeR, maeR: (trade) => trade?.maeR,
    costR, holdingMinutes,
    commission: (trade) => trade?.commission,
    fundingPnl: (trade) => trade?.fundingPnl,
    realizedPnl: (trade) => trade?.realizedPnl,
  }).map(([key, getter]) => [key, metricCoverage(trades.map(getter))]));
}

function netR(trade) {
  return finite(trade?.netR) ?? finite(trade?.pnl?.netR);
}

function closedAt(trade) {
  const direct = finite(trade?.closedAt);
  if (direct !== null) return direct;
  const parsed = Date.parse(trade?.closedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function openedAt(trade) {
  const direct = finite(trade?.openedAt);
  if (direct !== null) return direct;
  const parsed = Date.parse(trade?.openedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function holdingMinutes(trade) {
  const recorded = finite(trade?.minutesHeld);
  if (recorded !== null) return recorded;
  const opened = openedAt(trade);
  const closed = closedAt(trade);
  return opened !== null && closed !== null && closed >= opened ? (closed - opened) / 60_000 : null;
}

function costR(trade) {
  return finite(trade?.demoPromotion?.totalCostR)
    ?? finite(trade?.signalEvaluation?.totalCostR)
    ?? finite(trade?.signalEvaluation?.costs?.totalCostR)
    ?? finite(trade?.estimatedCostR);
}

function opportunitySources(trade) {
  const raw = trade?.marketRadar?.opportunitySources
    ?? trade?.signalEvaluation?.candidateSources
    ?? trade?.candidateSources
    ?? [];
  return [...new Set((Array.isArray(raw) ? raw : []).filter(Boolean).map(String))].sort();
}

export function opportunitySourceCombination(trade) {
  const sources = opportunitySources(trade);
  return sources.length ? sources.join(" + ") : "NONE";
}

function drawdownR(trades) {
  if (!trades.length || trades.some((trade) => netR(trade) === null)) return null;
  let equityR = 0;
  let peakR = 0;
  let maximum = 0;
  for (const trade of [...trades].sort((left, right) => (closedAt(left) ?? 0) - (closedAt(right) ?? 0))) {
    equityR += netR(trade);
    peakR = Math.max(peakR, equityR);
    maximum = Math.max(maximum, peakR - equityR);
  }
  return maximum;
}

function average(values) {
  const usable = values.map(finite).filter((value) => value !== null);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function summarizeCombination(key, trades, minimumSample) {
  const pnl = trades.map(netPnl).filter((value) => value !== null);
  const rValues = trades.map(netR).filter((value) => value !== null);
  const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const wins = pnl.filter((value) => value > 0).length;
  return {
    combination: key,
    sources: key === "NONE" ? [] : key.split(" + "),
    trades: trades.length,
    sampleStatus: trades.length < minimumSample ? "LOW_SAMPLE" : rValues.length !== trades.length || pnl.length !== trades.length ? "INCOMPLETE_METRICS" : "FORMAL_OBSERVATION",
    coverage: tradeMetricCoverage(trades),
    winRate: pnl.length ? round(wins / pnl.length, 6) : null,
    avgNetR: round(average(rValues)),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    profitFactorReason: grossLoss > 0 ? null : pnl.length ? "NO_LOSSES" : "NO_VALID_NET_PNL",
    groupMaxDrawdownR: round(drawdownR(trades)),
    drawdownBasis: "INDEPENDENT_GROUP_CURVE_NON_ADDITIVE",
    groupMaxDrawdownRReason: !trades.length ? "NO_TRADES" : rValues.length !== trades.length ? "INCOMPLETE_NET_R" : null,
    deprecatedFields: { maxDrawdownContributionR: "Use groupMaxDrawdownR; independent group curves are not additive contributions." },
    // Deprecated compatibility alias; this is not an additive portfolio contribution.
    maxDrawdownContributionR: round(drawdownR(trades)),
    avgMfeR: round(average(trades.map((trade) => trade?.mfeR))),
    avgMaeR: round(average(trades.map((trade) => trade?.maeR))),
    avgCostR: round(average(trades.map(costR))),
    avgHoldingMinutes: round(average(trades.map(holdingMinutes)), 2),
  };
}

export function buildOpportunitySourceAttribution(trades = [], { minimumSample = 10 } = {}) {
  const closed = trades.filter((trade) => trade?.status === "CLOSED");
  const grouped = new Map();
  for (const trade of closed) {
    const key = opportunitySourceCombination(trade);
    const values = grouped.get(key) ?? [];
    values.push(trade);
    grouped.set(key, values);
  }
  const combinations = [...grouped.entries()]
    .map(([key, values]) => summarizeCombination(key, values, minimumSample))
    .sort((left, right) => right.trades - left.trades || left.combination.localeCompare(right.combination));
  return {
    minimumFormalSample: minimumSample,
    closedTrades: closed.length,
    coverage: tradeMetricCoverage(closed),
    formalObservationCount: combinations.filter((item) => item.sampleStatus === "FORMAL_OBSERVATION").length,
    combinations,
  };
}

function stopTrade(trade) {
  return new Set(["STOP_LOSS", "AMBIGUOUS_STOP_FIRST", "BREAKEVEN_AFTER_TP1", "AMBIGUOUS_BREAKEVEN_FIRST"])
    .has(trade?.exitReason)
    || new Set(["stop", "breakEvenStop"]).has(trade?.exitRole);
}

function breakEvenStop(trade) {
  return new Set(["BREAKEVEN_AFTER_TP1", "AMBIGUOUS_BREAKEVEN_FIRST"]).has(trade?.exitReason)
    || trade?.exitRole === "breakEvenStop";
}

function distribution(values) {
  const usable = values.map(finite).filter((value) => value !== null);
  const buckets = [
    { key: "LT_0_5R", minimum: -Infinity, maximum: 0.5 },
    { key: "0_5_TO_1R", minimum: 0.5, maximum: 1 },
    { key: "1_TO_1_5R", minimum: 1, maximum: 1.5 },
    { key: "GTE_1_5R", minimum: 1.5, maximum: Infinity },
  ].map((bucket) => ({
    key: bucket.key,
    count: usable.filter((value) => value >= bucket.minimum && value < bucket.maximum).length,
  }));
  return { count: usable.length, coverage: metricCoverage(values), median: round(median(usable)), buckets };
}

export function buildExcursionAttribution(trades = []) {
  const closed = trades.filter((trade) => trade?.status === "CLOSED");
  const stops = closed.filter(stopTrade);
  const winners = closed.filter((trade) => netPnl(trade) !== null && netPnl(trade) > 0);
  const withMfe = stops.filter((trade) => finite(trade?.mfeR) !== null);
  const proportion = (predicate) => withMfe.length
    ? round(withMfe.filter(predicate).length / withMfe.length, 6)
    : null;
  return {
    modelVersion: "EXCURSION_ATTRIBUTION_R1",
    closedTrades: closed.length,
    coverage: tradeMetricCoverage(closed),
    pathCoverageNote: "Metric availability does not establish full historical path coverage; absent history remains unknown.",
    statisticCoverage: {
      stopMfeR: metricCoverage(stops.map((trade) => trade?.mfeR)),
      winnerMaeR: metricCoverage(winners.map((trade) => trade?.maeR)),
      timeToMfeMs: metricCoverage(closed.map((trade) => trade?.timeToMfeMs)),
      timeToStopMs: metricCoverage(stops.map((trade) => trade?.timeToStopMs)),
    },
    stopTrades: stops.length,
    stopTradesWithExcursion: withMfe.length,
    stopMedianMfeR: round(median(stops.map((trade) => trade?.mfeR))),
    winnerMedianMaeR: round(median(winners.map((trade) => trade?.maeR))),
    stopMfeBelow0_2RRatio: proportion((trade) => Number(trade.mfeR) < 0.2),
    stopMfeAbove0_5RRatio: proportion((trade) => Number(trade.mfeR) > 0.5),
    stopMfeAbove1RRatio: proportion((trade) => Number(trade.mfeR) > 1),
    breakEvenStopMfeDistribution: distribution(closed.filter(breakEvenStop).map((trade) => trade?.mfeR)),
    medianTimeToMfeMs: round(median(closed.map((trade) => trade?.timeToMfeMs)), 0),
    medianTimeToStopMs: round(median(stops.map((trade) => trade?.timeToStopMs)), 0),
  };
}
