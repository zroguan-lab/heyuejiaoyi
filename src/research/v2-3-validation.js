import { buildV23StrategySnapshot } from "../domain/v2-3-strategy-engine.js";
import { createValidationPlan } from "../research-backtest.js";
import { runHistoricalV23PortfolioReplay } from "./historical-portfolio-replay.js";

export const SEALED_HOLDOUT_AUTHORIZATION = "OPEN_V2_3_SEALED_HOLDOUT";

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeTrades(trades = []) {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const wins = closed.filter((trade) => Number(trade.pnl?.net) > 0);
  const losses = closed.filter((trade) => Number(trade.pnl?.net) <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl.net), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl.net), 0));
  const netPnl = closed.reduce((sum, trade) => sum + Number(trade.pnl.net), 0);
  const netR = closed.reduce((sum, trade) => sum + Number(trade.pnl.netR), 0);
  return {
    selected: trades.length,
    filled: trades.filter((trade) => trade.events?.some((event) => event.type === "ENTRY_FILLED")).length,
    expired: trades.filter((trade) => trade.status === "EXPIRED").length,
    closed: closed.length,
    unresolved: trades.filter((trade) => !new Set(["CLOSED", "EXPIRED"]).has(trade.status)).length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: closed.length ? round(wins.length / closed.length * 100, 3) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    netPnl: round(netPnl, 6),
    netR: round(netR, 4),
    averageNetR: closed.length ? round(netR / closed.length, 4) : 0,
  };
}

function groupedTrades(trades, keyOf) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyOf(trade) ?? "UNKNOWN";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, summarizeTrades(rows)]));
}

function groupedMultiValueTrades(trades, valuesOf) {
  const groups = new Map();
  for (const trade of trades) {
    const values = [...new Set((valuesOf(trade) ?? []).filter(Boolean))];
    for (const value of values.length ? values : ["UNKNOWN"]) {
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(trade);
    }
  }
  return Object.fromEntries([...groups.entries()].map(([key, rows]) => [key, summarizeTrades(rows)]));
}

function scoreBand(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "UNKNOWN";
  if (score < 50) return "00-49";
  if (score < 60) return "50-59";
  if (score < 70) return "60-69";
  if (score < 80) return "70-79";
  return "80-100";
}

function profitConcentration(trades, keyOf) {
  const profits = new Map();
  for (const trade of trades.filter((item) => item.status === "CLOSED" && Number(item.pnl?.net) > 0)) {
    const key = keyOf(trade) ?? "UNKNOWN";
    profits.set(key, (profits.get(key) ?? 0) + Number(trade.pnl.net));
  }
  const grossProfit = [...profits.values()].reduce((sum, value) => sum + value, 0);
  const shares = [...profits.entries()]
    .map(([key, profit]) => ({ key, profit: round(profit, 6), sharePercent: round(profit / grossProfit * 100, 4) }))
    .sort((left, right) => right.sharePercent - left.sharePercent);
  return {
    grossProfit: round(grossProfit, 6),
    contributorCount: shares.length,
    dominant: shares[0] ?? null,
    maximumSharePercent: shares[0]?.sharePercent ?? null,
    shares,
  };
}

function aggregateValidation(folds, startingEquity) {
  const trades = folds.flatMap((fold) => fold.result.trades ?? []);
  const summary = summarizeTrades(trades);
  const profitableFolds = folds.filter((fold) => Number(fold.result.metrics?.realizedNetPnl) > 0).length;
  return {
    ...summary,
    foldCount: folds.length,
    profitableFolds,
    profitableFoldRate: folds.length ? round(profitableFolds / folds.length, 4) : 0,
    worstFoldDrawdownPercent: folds.length
      ? Math.max(...folds.map((fold) => Number(fold.result.metrics?.maxDrawdownPercent ?? 0)))
      : 0,
    startingEquityPerFold: startingEquity,
    pointInTimeEligible: folds.length > 0 && folds.every((fold) => fold.result.promotionEligible === true),
    byStrategy: groupedTrades(trades, (trade) => trade.strategy),
    byDirection: groupedTrades(trades, (trade) => trade.direction),
    bySetupDirection: groupedTrades(trades, (trade) => `${trade.strategy ?? "UNKNOWN"}-${trade.direction ?? "UNKNOWN"}`),
    byTier: groupedTrades(trades, (trade) => trade.signalEvaluation?.experimentTier),
    byCandidateSource: groupedMultiValueTrades(trades, (trade) => trade.signalEvaluation?.candidateSources),
    byExplosionScoreBand: groupedTrades(trades, (trade) => scoreBand(trade.signalEvaluation?.explosionScore)),
    byDirectionScoreBand: groupedTrades(trades, (trade) => scoreBand(trade.signalEvaluation?.directionScore)),
    profitConcentration: {
      bySymbol: profitConcentration(trades, (trade) => trade.symbol),
      byMarketEvent: profitConcentration(trades, (trade) => trade.marketEventId),
    },
  };
}

function promotionGate(metrics, {
  minimumClosedTrades,
  minimumProfitFactor = 1.2,
  minimumAverageNetR = 0.1,
  maximumDrawdownPercent = 10,
  minimumProfitableFoldRate = 0.5,
  maximumSymbolProfitSharePercent = 20,
  maximumMarketEventProfitSharePercent = 25,
} = {}) {
  const infiniteProfitFactor = metrics.wins > 0 && metrics.losses === 0;
  const criteria = {
    pointInTimeInputs: {
      passed: metrics.pointInTimeEligible,
      actual: metrics.pointInTimeEligible,
      required: true,
    },
    sampleSize: {
      passed: metrics.closed >= minimumClosedTrades,
      actual: metrics.closed,
      required: minimumClosedTrades,
    },
    profitFactor: {
      passed: infiniteProfitFactor || (Number.isFinite(metrics.profitFactor) && metrics.profitFactor >= minimumProfitFactor),
      actual: infiniteProfitFactor ? "INFINITY" : metrics.profitFactor,
      required: minimumProfitFactor,
    },
    averageNetR: {
      passed: metrics.averageNetR > minimumAverageNetR,
      actual: metrics.averageNetR,
      required: `>${minimumAverageNetR}`,
    },
    drawdown: {
      passed: metrics.worstFoldDrawdownPercent <= maximumDrawdownPercent,
      actual: metrics.worstFoldDrawdownPercent,
      required: `<=${maximumDrawdownPercent}`,
    },
    foldConsistency: {
      passed: metrics.profitableFoldRate >= minimumProfitableFoldRate,
      actual: metrics.profitableFoldRate,
      required: minimumProfitableFoldRate,
    },
    symbolProfitConcentration: {
      passed: Number.isFinite(metrics.profitConcentration?.bySymbol?.maximumSharePercent)
        && metrics.profitConcentration.bySymbol.maximumSharePercent < maximumSymbolProfitSharePercent,
      actual: metrics.profitConcentration?.bySymbol?.maximumSharePercent ?? null,
      required: `<${maximumSymbolProfitSharePercent}%`,
    },
    marketEventProfitConcentration: {
      passed: Number.isFinite(metrics.profitConcentration?.byMarketEvent?.maximumSharePercent)
        && metrics.profitConcentration.byMarketEvent.maximumSharePercent < maximumMarketEventProfitSharePercent,
      actual: metrics.profitConcentration?.byMarketEvent?.maximumSharePercent ?? null,
      required: `<${maximumMarketEventProfitSharePercent}%`,
    },
  };
  const failed = Object.entries(criteria).filter(([, value]) => !value.passed).map(([name]) => name);
  return {
    status: failed.length ? "BLOCKED" : "PASSED",
    passed: failed.length === 0,
    failed,
    criteria,
    note: "通过只代表达到历史验证闸门，不保证未来盈利",
  };
}

function replayWindow({ decisionTimes, start, end, replayRunner, replayOptions }) {
  const windowTimes = decisionTimes.filter((time) => time >= start && time <= end);
  if (!windowTimes.length) throw new Error(`M5验证窗口没有决策时点: ${start}-${end}`);
  return replayRunner({
    ...replayOptions,
    decisionTimes: windowTimes,
    endTime: end,
  });
}

function assessDataCoverage(replayOptions, config) {
  const markets = Object.entries(replayOptions.marketData ?? {})
    .map(([symbol, rows]) => ({
      symbol,
      rows: Array.isArray(rows) ? rows.length : 0,
      start: Array.isArray(rows) && rows.length ? Number(rows[0].openTime) : null,
      end: Array.isArray(rows) && rows.length ? Number(rows.at(-1).closeTime) : null,
    }))
    .filter((item) => item.rows > 0 && Number.isFinite(item.start) && Number.isFinite(item.end));
  const commonStart = markets.length ? Math.max(...markets.map((item) => item.start)) : null;
  const commonEnd = markets.length ? Math.min(...markets.map((item) => item.end)) : null;
  const commonHistoryDays = Number.isFinite(commonStart) && Number.isFinite(commonEnd) && commonEnd >= commonStart
    ? (commonEnd - commonStart + 1) / 86_400_000
    : 0;
  const spreadSymbolCount = Object.values(replayOptions.spreadSnapshots ?? {})
    .filter((rows) => Array.isArray(rows) && rows.length > 0).length;
  const contractSnapshotCount = new Set((replayOptions.contractRecords ?? [])
    .map((item) => Number(item.capturedAt))
    .filter(Number.isFinite)).size;
  const requiredSymbols = Number(config.marketRadar?.discoverySize ?? 100);
  const requiredHistoryDays = 180;
  const coverageSnapshots = replayOptions.marketCoverageSnapshots ?? [];
  const marketCoverageDeclared = replayOptions.marketCoverage?.complete === true
    || coverageSnapshots.some((snapshot) => snapshot?.complete === true
      && Number(snapshot.eligibleCount) >= requiredSymbols);
  return {
    symbolCount: markets.length,
    requiredSymbols,
    commonHistoryDays: round(commonHistoryDays, 3),
    requiredHistoryDays,
    spreadSymbolCount,
    contractSnapshotCount,
    marketCoverageSnapshotCount: coverageSnapshots.length,
    marketCoverageDeclared,
    symbolsReady: markets.length >= requiredSymbols,
    historyReady: commonHistoryDays >= requiredHistoryDays,
    spreadsReady: spreadSymbolCount >= requiredSymbols,
    contractsReady: contractSnapshotCount > 1,
    ready: markets.length >= requiredSymbols
      && commonHistoryDays >= requiredHistoryDays
      && spreadSymbolCount >= requiredSymbols
      && contractSnapshotCount > 1
      && marketCoverageDeclared,
  };
}

export function assessPointInTimeWindowCoverage({
  decisionTimes,
  contractRecords = [],
  marketCoverageSnapshots = [],
  config,
} = {}) {
  const times = [...new Set((decisionTimes ?? []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const contractTimes = [...new Set(contractRecords.map((item) => Number(item?.capturedAt)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const marketSnapshots = [...marketCoverageSnapshots]
    .filter((item) => Number.isFinite(Number(item?.asOf)))
    .sort((left, right) => Number(left.asOf) - Number(right.asOf));
  const requiredSymbols = Number(config?.marketRadar?.discoverySize ?? 100);
  const contractMaximumAgeMs = Number(config?.universe?.refreshHours ?? 168) * 3_600_000;
  const marketMaximumAgeMs = Math.max(60_000, Number(config?.marketRadar?.refreshMinutes ?? 15) * 60_000);
  const blockers = { contractUnavailable: 0, contractStale: 0, marketUnavailable: 0, marketStale: 0, marketIncomplete: 0 };
  const eligibleTimes = [];
  for (const decisionTime of times) {
    const contractTime = contractTimes.filter((time) => time <= decisionTime).at(-1) ?? null;
    const market = marketSnapshots.filter((item) => Number(item.asOf) <= decisionTime).at(-1) ?? null;
    let eligible = true;
    if (contractTime === null) {
      blockers.contractUnavailable += 1;
      eligible = false;
    } else if (decisionTime - contractTime > contractMaximumAgeMs) {
      blockers.contractStale += 1;
      eligible = false;
    }
    if (!market) {
      blockers.marketUnavailable += 1;
      eligible = false;
    } else {
      if (decisionTime - Number(market.asOf) > marketMaximumAgeMs) {
        blockers.marketStale += 1;
        eligible = false;
      }
      if (market.complete !== true || Number(market.eligibleCount) < requiredSymbols) {
        blockers.marketIncomplete += 1;
        eligible = false;
      }
    }
    if (eligible) eligibleTimes.push(decisionTime);
  }
  return {
    ready: times.length > 0 && eligibleTimes.length === times.length,
    requestedDecisionPoints: times.length,
    eligibleDecisionPoints: eligibleTimes.length,
    firstRequestedAt: times[0] ?? null,
    lastRequestedAt: times.at(-1) ?? null,
    firstEligibleAt: eligibleTimes[0] ?? null,
    lastEligibleAt: eligibleTimes.at(-1) ?? null,
    earliestContractSnapshotAt: contractTimes[0] ?? null,
    earliestMarketSnapshotAt: marketSnapshots[0]?.asOf ?? null,
    requiredSymbols,
    contractMaximumAgeMs,
    marketMaximumAgeMs,
    blockers,
  };
}

export function runHistoricalV23WalkForwardValidation({
  decisionTimes,
  config,
  validationOptions = {},
  gateOptions = {},
  openSealedHoldout = false,
  holdoutAuthorization = null,
  replayRunner = runHistoricalV23PortfolioReplay,
  ...replayOptions
} = {}) {
  if (!config || typeof replayRunner !== "function") throw new TypeError("M5验证缺少配置或M4回放引擎");
  const times = [...new Set((decisionTimes ?? []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const plan = createValidationPlan(times, validationOptions);
  const strategySnapshot = buildV23StrategySnapshot(config, { capturedAt: times[0] });
  const common = { ...replayOptions, config };
  const dataCoverage = assessDataCoverage(replayOptions, config);
  const folds = plan.windows.map((window) => ({
    ...window,
    result: replayWindow({
      decisionTimes: times,
      start: window.validation.start,
      end: window.validation.end,
      replayRunner,
      replayOptions: common,
    }),
  }));
  const metrics = aggregateValidation(folds, Number(config.portfolio?.startingEquity ?? 500));
  const gate = promotionGate(metrics, {
    minimumClosedTrades: Number(gateOptions.minimumClosedTrades ?? config.shadowV2?.sampleTarget ?? 100),
    ...gateOptions,
  });

  let sealedHoldout = {
    status: "SEALED",
    start: plan.sealedHoldout.start,
    end: plan.sealedHoldout.end,
    decisionPointCount: times.filter((time) => time >= plan.sealedHoldout.start && time <= plan.sealedHoldout.end).length,
    strategyFingerprint: strategySnapshot.fingerprint,
  };
  if (openSealedHoldout) {
    if (holdoutAuthorization !== SEALED_HOLDOUT_AUTHORIZATION) {
      throw new Error("M5_OPEN_HOLDOUT_REQUIRES_EXPLICIT_AUTHORIZATION");
    }
    sealedHoldout = {
      ...sealedHoldout,
      status: "OPENED",
      openedAt: new Date().toISOString(),
      result: replayWindow({
        decisionTimes: times,
        start: plan.sealedHoldout.start,
        end: plan.sealedHoldout.end,
        replayRunner,
        replayOptions: common,
      }),
    };
  }
  return {
    modelVersion: "V2_3_WALK_FORWARD_VALIDATION_M5_R2",
    strategyFingerprint: strategySnapshot.fingerprint,
    policy: plan.policy,
    holdoutFraction: plan.holdoutFraction,
    folds,
    dataCoverage,
    validation: metrics,
    promotionGate: gate,
    sealedHoldout,
  };
}

export function evaluateV23ParameterStability(variants = []) {
  const normalized = variants.map((variant) => {
    const metrics = variant.result?.validation ?? variant.validation ?? {};
    const rawProfitFactor = metrics.profitFactor;
    return {
      label: variant.label ?? "unnamed",
      strategyFingerprint: variant.result?.strategyFingerprint ?? variant.strategyFingerprint ?? null,
      closed: Number(metrics.closed ?? 0),
      averageNetR: Number(metrics.averageNetR ?? 0),
      profitFactor: rawProfitFactor !== null && rawProfitFactor !== undefined && Number.isFinite(Number(rawProfitFactor))
        ? Number(rawProfitFactor)
        : null,
      profitableFoldRate: Number(metrics.profitableFoldRate ?? 0),
      worstFoldDrawdownPercent: Number(metrics.worstFoldDrawdownPercent ?? 0),
    };
  });
  const positive = normalized.filter((item) => item.averageNetR > 0 && Number(item.profitFactor) > 1);
  const positiveRate = normalized.length ? positive.length / normalized.length : 0;
  const medianAverageNetR = median(normalized.map((item) => item.averageNetR));
  return {
    variantCount: normalized.length,
    positiveVariantCount: positive.length,
    positiveRate: round(positiveRate, 4),
    medianAverageNetR: round(medianAverageNetR, 4),
    stable: normalized.length >= 3 && positiveRate >= 2 / 3 && medianAverageNetR > 0,
    variants: normalized,
    note: "参数稳定性通过也不能替代封存样本和Demo前向验证",
  };
}
