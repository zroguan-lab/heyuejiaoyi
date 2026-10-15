import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { createMarketDataClient } from "./exchanges/create-client.js";
import { analyzeMultiTimeframe } from "./domain/multi-timeframe-strategy.js";
import { advanceTradeTimeline, createSimulatedTrade, isActiveTrade } from "./domain/trade-lifecycle.js";
import { buildCorrelationMatrix, selectPortfolioCandidates } from "./domain/portfolio.js";

function orderedCandles(candles = []) {
  return [...candles].filter((item) => Number.isFinite(item?.closeTime)).sort((a, b) => a.closeTime - b.closeTime);
}

function upperBoundByCloseTime(candles, time) {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].closeTime <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function summarizeGroup(trades) {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const expired = trades.filter((trade) => trade.status === "EXPIRED");
  const filled = trades.filter((trade) => trade.events.some((event) => event.type === "ENTRY_FILLED"));
  const wins = closed.filter((trade) => trade.pnl.net > 0);
  const losses = closed.filter((trade) => trade.pnl.net <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl.net, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl.net, 0));
  const grossPnl = closed.reduce((sum, trade) => sum + trade.pnl.gross, 0);
  const netPnl = closed.reduce((sum, trade) => sum + trade.pnl.net, 0);
  const totalCosts = closed.reduce((sum, trade) => sum + trade.costs.total, 0);
  return {
    signalsSelected: trades.length,
    filled: filled.length,
    expired: expired.length,
    closed: closed.length,
    unresolved: trades.length - closed.length - expired.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : null,
    grossPnl: Number(grossPnl.toFixed(4)),
    costs: Number(totalCosts.toFixed(4)),
    netPnl: Number(netPnl.toFixed(4)),
    netR: Number(closed.reduce((sum, trade) => sum + trade.pnl.netR, 0).toFixed(4)),
    averageNetR: closed.length ? Number((closed.reduce((sum, trade) => sum + trade.pnl.netR, 0) / closed.length).toFixed(4)) : 0,
  };
}

export function evaluateParameterStability(variants = []) {
  const normalized = variants.map((variant) => {
    const portfolio = variant?.metrics?.portfolio ?? variant?.portfolio ?? {};
    return {
      label: variant.label ?? "unnamed",
      closed: Number(portfolio.closed) || 0,
      averageNetR: Number(portfolio.averageNetR) || 0,
      profitFactor: Number.isFinite(Number(portfolio.profitFactor)) ? Number(portfolio.profitFactor) : null,
      maxDrawdownPercent: Number(portfolio.maxDrawdownPercent) || 0,
    };
  });
  const positive = normalized.filter((item) => item.averageNetR > 0);
  const positiveRate = normalized.length ? positive.length / normalized.length : 0;
  const averageValues = normalized.map((item) => item.averageNetR).sort((a, b) => a - b);
  const middle = Math.floor(averageValues.length / 2);
  const medianAverageNetR = averageValues.length
    ? averageValues.length % 2 ? averageValues[middle] : (averageValues[middle - 1] + averageValues[middle]) / 2
    : 0;
  return {
    variantCount: normalized.length,
    positiveVariantCount: positive.length,
    positiveRate: Number(positiveRate.toFixed(4)),
    medianAverageNetR: Number(medianAverageNetR.toFixed(4)),
    stable: normalized.length >= 3 && positiveRate >= 2 / 3 && medianAverageNetR > 0,
    variants: normalized,
    note: "稳定性只说明邻近参数没有立即崩溃，不等于未来盈利保证",
  };
}

export function runWalkForwardValidation({
  timestamps,
  runWindow,
  validationOptions = {},
  openSealedHoldout = false,
  startingEquity = 500,
} = {}) {
  if (typeof runWindow !== "function") throw new TypeError("走步验证需要 runWindow 函数");
  const plan = createValidationPlan(timestamps, validationOptions);
  const folds = plan.windows.map((window) => {
    const result = runWindow({ startTime: window.validation.start, endTime: window.validation.end, window, phase: "VALIDATION" });
    return { ...window, result };
  });
  const validationTrades = folds.flatMap((fold) => fold.result?.trades ?? []);
  const validationMetrics = summarizeBacktest(validationTrades, { startingEquity });
  const sealedHoldout = openSealedHoldout
    ? {
      status: "OPENED",
      ...plan.sealedHoldout,
      result: runWindow({ startTime: plan.sealedHoldout.start, endTime: plan.sealedHoldout.end, phase: "SEALED_HOLDOUT" }),
    }
    : { status: "SEALED", ...plan.sealedHoldout, result: null };
  const portfolio = validationMetrics.portfolio;
  const gateChecks = {
    sealedHoldoutOpened: sealedHoldout.status === "OPENED",
    minimumSamples: portfolio.closed >= 100,
    positiveAverageNetR: portfolio.averageNetR > 0,
    profitFactor: Number(portfolio.profitFactor) >= 1.2,
    maxDrawdown: portfolio.maxDrawdownPercent < 10,
  };
  return {
    plan,
    folds,
    validationMetrics,
    sealedHoldout,
    promotionGate: {
      eligible: Object.values(gateChecks).every(Boolean),
      checks: gateChecks,
      policy: "100+ OOS/FORWARD CLOSED, AVG_NET_R>0, PF>=1.2, MAX_DD<10%, SEALED_HOLDOUT_OPENED",
    },
  };
}

export function runWalkForwardPortfolioValidation({
  markets,
  strategyConfig,
  portfolioConfig = {},
  costs = {},
  analyze = analyzeMultiTimeframe,
  validationOptions = {},
  openSealedHoldout = false,
} = {}) {
  const timestamps = Object.values(markets ?? {}).flatMap((market) => (market.five ?? []).map((item) => item.closeTime));
  return runWalkForwardValidation({
    timestamps,
    validationOptions,
    openSealedHoldout,
    startingEquity: portfolioConfig.startingEquity ?? 500,
    runWindow: ({ startTime, endTime }) => runPortfolioBacktest({
      markets,
      strategyConfig,
      portfolioConfig,
      costs,
      startTime,
      endTime,
      analyze,
    }),
  });
}

export function summarizeBacktest(trades, { startingEquity = 500 } = {}) {
  const portfolio = summarizeGroup(trades);
  const realized = trades
    .filter((trade) => trade.status === "CLOSED" && trade.closedAt)
    .sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
  let equity = startingEquity;
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const trade of realized) {
    equity += trade.pnl.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  const strategies = {};
  for (const strategy of new Set(trades.map((trade) => trade.strategy))) {
    strategies[strategy] = summarizeGroup(trades.filter((trade) => trade.strategy === strategy));
  }
  const directions = {};
  for (const direction of ["LONG", "SHORT"]) {
    directions[direction] = summarizeGroup(trades.filter((trade) => trade.direction === direction));
  }
  return {
    portfolio: {
      ...portfolio,
      startingEquity,
      endingEquity: Number(equity.toFixed(4)),
      returnPercent: Number((((equity - startingEquity) / startingEquity) * 100).toFixed(3)),
      maxDrawdownPercent: Number((maxDrawdown * 100).toFixed(3)),
    },
    strategies,
    directions,
  };
}

export function createValidationPlan(timestamps, {
  holdoutFraction = 0.2,
  folds = 4,
  minimumTrainFraction = 0.4,
} = {}) {
  const times = [...new Set(timestamps.filter(Number.isFinite))].sort((a, b) => a - b);
  if (times.length < 20) throw new Error("至少需要 20 个时间点才能创建样本外验证计划");
  if (!(holdoutFraction > 0 && holdoutFraction < 0.5)) throw new Error("holdoutFraction 必须大于 0 且小于 0.5");
  if (!Number.isInteger(folds) || folds < 1 || folds > 20) throw new Error("folds 必须是 1 到 20 的整数");
  const holdoutIndex = Math.max(1, Math.floor(times.length * (1 - holdoutFraction)));
  const researchCount = holdoutIndex;
  const minimumTrainCount = Math.max(1, Math.floor(researchCount * minimumTrainFraction));
  const validationWidth = Math.max(1, Math.floor((researchCount - minimumTrainCount) / folds));
  const windows = [];
  for (let index = 0; index < folds; index += 1) {
    const validationStartIndex = minimumTrainCount + index * validationWidth;
    const validationEndIndex = index === folds - 1
      ? researchCount - 1
      : Math.min(researchCount - 1, validationStartIndex + validationWidth - 1);
    if (validationStartIndex > validationEndIndex) break;
    windows.push({
      fold: index + 1,
      train: { start: times[0], end: times[validationStartIndex - 1] },
      validation: { start: times[validationStartIndex], end: times[validationEndIndex] },
    });
  }
  return {
    policy: "EXPANDING_WALK_FORWARD_WITH_SEALED_HOLDOUT",
    holdoutFraction,
    windows,
    sealedHoldout: { start: times[holdoutIndex], end: times.at(-1) },
  };
}

export function runMultiTimeframeBacktest({
  symbol,
  hourly,
  fifteen,
  five,
  oneMinute = [],
  fundingRates = [],
  strategyConfig,
  portfolioConfig = {},
  costs = {},
  startTime = -Infinity,
  endTime = Infinity,
  analyze = analyzeMultiTimeframe,
} = {}) {
  if (!symbol || !strategyConfig) throw new TypeError("回测需要 symbol 和 strategyConfig");
  const data = {
    hourly: orderedCandles(hourly),
    fifteen: orderedCandles(fifteen),
    five: orderedCandles(five),
    oneMinute: orderedCandles(oneMinute),
    fundingRates: [...fundingRates].filter((item) => Number.isFinite(item?.fundingTime)).sort((a, b) => a.fundingTime - b.fundingTime),
  };
  const decisions = data.five.filter((candle) => candle.closeTime >= startTime && candle.closeTime <= endTime);
  const seenCandidates = new Set();
  const trades = [];
  const rejected = [];
  let activeTrade = null;

  for (const decision of decisions) {
    const time = decision.closeTime;
    if (activeTrade && isActiveTrade(activeTrade)) {
      const pathSource = data.oneMinute.length ? data.oneMinute : data.five;
      const path = pathSource.slice(
        upperBoundByCloseTime(pathSource, activeTrade.lastProcessedAt),
        upperBoundByCloseTime(pathSource, time),
      );
      const funding = data.fundingRates.filter((event) => event.fundingTime > (activeTrade.lastFundingAt ?? activeTrade.lastProcessedAt) && event.fundingTime <= time);
      activeTrade = advanceTradeTimeline(activeTrade, path, funding);
      trades[trades.length - 1] = activeTrade;
    }

    const analysis = analyze({
      symbol,
      hourly: data.hourly.slice(0, upperBoundByCloseTime(data.hourly, time)),
      fifteen: data.fifteen.slice(0, upperBoundByCloseTime(data.fifteen, time)),
      five: data.five.slice(0, upperBoundByCloseTime(data.five, time)),
      config: strategyConfig,
    });
    const fresh = (analysis.candidates ?? []).filter((candidate) => {
      if (seenCandidates.has(candidate.id)) return false;
      seenCandidates.add(candidate.id);
      return true;
    });
    if (!fresh.length) continue;
    const allocation = selectPortfolioCandidates(fresh, activeTrade && isActiveTrade(activeTrade) ? [activeTrade] : []);
    rejected.push(...allocation.rejected.map((item) => ({ ...item, at: time })));
    const selected = allocation.selected[0];
    if (!selected) continue;
    activeTrade = createSimulatedTrade(selected, {
      margin: portfolioConfig.marginPerTrade ?? 10,
      leverage: portfolioConfig.leverage ?? 10,
      feeRate: costs.fallbackFeeRate ?? 0.0005,
      slippageRate: selected.order.style === "ACTIVE_DYNAMIC" ? (costs.fallbackSlippageRate ?? 0.0002) : 0,
    });
    trades.push(activeTrade);
  }

  if (activeTrade && isActiveTrade(activeTrade)) {
    const pathSource = data.oneMinute.length ? data.oneMinute : data.five;
    const finalPath = pathSource.slice(upperBoundByCloseTime(pathSource, activeTrade.lastProcessedAt));
    const boundedPath = finalPath.filter((candle) => candle.closeTime <= endTime);
    const fundingEnd = Math.min(endTime, boundedPath.at(-1)?.closeTime ?? -Infinity);
    const funding = data.fundingRates.filter((event) => event.fundingTime > (activeTrade.lastFundingAt ?? activeTrade.lastProcessedAt) && event.fundingTime <= fundingEnd);
    activeTrade = advanceTradeTimeline(activeTrade, boundedPath, funding);
    trades[trades.length - 1] = activeTrade;
  }

  return {
    assumptions: {
      signalDecision: "CLOSED_CANDLES_ONLY",
      pathResolution: data.oneMinute.length ? "1m" : "5m_STOP_FIRST_ON_AMBIGUITY",
      marginPerTrade: portfolioConfig.marginPerTrade ?? 10,
      leverage: portfolioConfig.leverage ?? 10,
      feeRate: costs.fallbackFeeRate ?? 0.0005,
      activeLimitSlippageRate: costs.fallbackSlippageRate ?? 0.0002,
    },
    metrics: summarizeBacktest(trades, { startingEquity: portfolioConfig.startingEquity ?? 500 }),
    trades,
    rejected,
    candidateCount: seenCandidates.size,
  };
}

export function runPortfolioBacktest({
  markets,
  strategyConfig,
  portfolioConfig = {},
  costs = {},
  startTime = -Infinity,
  endTime = Infinity,
  analyze = analyzeMultiTimeframe,
} = {}) {
  if (!markets || typeof markets !== "object" || !Object.keys(markets).length || !strategyConfig) {
    throw new TypeError("组合回测需要 markets 和 strategyConfig");
  }
  const normalized = Object.fromEntries(Object.entries(markets).map(([symbol, market]) => [symbol, {
    hourly: orderedCandles(market.hourly),
    fifteen: orderedCandles(market.fifteen),
    five: orderedCandles(market.five),
    oneMinute: orderedCandles(market.oneMinute),
    fundingRates: [...(market.fundingRates ?? [])].filter((item) => Number.isFinite(item?.fundingTime)).sort((a, b) => a.fundingTime - b.fundingTime),
    liquidityScore: Number.isFinite(market.liquidityScore) ? market.liquidityScore : 0,
  }]));
  const timeline = [...new Set(Object.values(normalized)
    .flatMap((market) => market.five.map((candle) => candle.closeTime))
    .filter((time) => time >= startTime && time <= endTime))]
    .sort((a, b) => a - b);
  const trades = [];
  const rejected = [];
  const seenCandidates = new Set();

  const advanceUntil = (trade, time) => {
    const market = normalized[trade.symbol];
    const pathSource = market.oneMinute.length ? market.oneMinute : market.five;
    const path = pathSource.slice(
      upperBoundByCloseTime(pathSource, trade.lastProcessedAt),
      upperBoundByCloseTime(pathSource, time),
    );
    const funding = market.fundingRates.filter((event) => event.fundingTime > (trade.lastFundingAt ?? trade.lastProcessedAt) && event.fundingTime <= time);
    return advanceTradeTimeline(trade, path, funding);
  };

  for (const time of timeline) {
    for (let index = 0; index < trades.length; index += 1) {
      if (isActiveTrade(trades[index])) trades[index] = advanceUntil(trades[index], time);
    }
    const active = trades.filter(isActiveTrade);
    const candidates = [];
    const returnSeries = new Map();
    for (const [symbol, market] of Object.entries(normalized)) {
      const fiveEnd = upperBoundByCloseTime(market.five, time);
      if (!fiveEnd || market.five[fiveEnd - 1].closeTime !== time) continue;
      const hourly = market.hourly.slice(0, upperBoundByCloseTime(market.hourly, time));
      const analysis = analyze({
        symbol,
        hourly,
        fifteen: market.fifteen.slice(0, upperBoundByCloseTime(market.fifteen, time)),
        five: market.five.slice(0, fiveEnd),
        config: strategyConfig,
      });
      const closes = hourly.slice(-97).map((item) => item.close);
      returnSeries.set(symbol, closes.slice(1).map((close, index) => (close / closes[index]) - 1));
      for (const candidate of analysis.candidates ?? []) {
        if (seenCandidates.has(candidate.id)) continue;
        seenCandidates.add(candidate.id);
        const entry = candidate.order?.entry ?? candidate.risk?.entry;
        const riskRate = Math.abs(entry - candidate.risk.stopLoss) / entry;
        const estimatedRoundTripRate = 2 * ((costs.fallbackFeeRate ?? 0.0005) + (candidate.order.style === "ACTIVE_DYNAMIC" ? (costs.fallbackSlippageRate ?? 0.0002) : 0));
        candidates.push({
          ...candidate,
          estimatedCostR: riskRate > 0 ? estimatedRoundTripRate / riskRate : Infinity,
          liquidityScore: market.liquidityScore,
        });
      }
    }
    if (!candidates.length) continue;
    const allocation = selectPortfolioCandidates(candidates, active, { correlations: buildCorrelationMatrix(returnSeries) });
    rejected.push(...allocation.rejected.map((item) => ({ ...item, at: time })));
    for (const selected of allocation.selected) {
      trades.push(createSimulatedTrade(selected, {
        margin: portfolioConfig.marginPerTrade ?? 10,
        leverage: portfolioConfig.leverage ?? 10,
        feeRate: costs.fallbackFeeRate ?? 0.0005,
        slippageRate: selected.order.style === "ACTIVE_DYNAMIC" ? (costs.fallbackSlippageRate ?? 0.0002) : 0,
      }));
    }
  }

  for (let index = 0; index < trades.length; index += 1) {
    if (!isActiveTrade(trades[index])) continue;
    const market = normalized[trades[index].symbol];
    const pathSource = market.oneMinute.length ? market.oneMinute : market.five;
    const marketEnd = Math.min(endTime, pathSource.at(-1)?.closeTime ?? -Infinity);
    trades[index] = advanceUntil(trades[index], marketEnd);
  }
  const pathResolution = Object.values(normalized).every((market) => market.oneMinute.length) ? "1m" : "MIXED_1m_5m_STOP_FIRST";
  return {
    assumptions: {
      signalDecision: "CLOSED_CANDLES_ONLY",
      pathResolution,
      activeLimitHistoricalPricing: "SIGNAL_PRICE_PLUS_CONFIGURED_COST_NO_ORDERBOOK_HISTORY",
      symbols: Object.keys(normalized),
      positionPolicy: "ALL_ELIGIBLE",
      marginPerTrade: portfolioConfig.marginPerTrade ?? 10,
      leverage: portfolioConfig.leverage ?? 10,
      feeRate: costs.fallbackFeeRate ?? 0.0005,
      activeLimitSlippageRate: costs.fallbackSlippageRate ?? 0.0002,
    },
    metrics: summarizeBacktest(trades, { startingEquity: portfolioConfig.startingEquity ?? 500 }),
    trades,
    rejected,
    candidateCount: seenCandidates.size,
  };
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const symbols = (process.argv[2] ?? config.symbols[0]).split(",").map((item) => item.trim().toUpperCase()).filter(Boolean).slice(0, 50);
  const days = Math.min(180, Math.max(7, Number.parseInt(process.argv[3] ?? "30", 10)));
  const endTime = Date.now();
  const startTime = endTime - days * 86_400_000;
  const exchange = createMarketDataClient(config);
  if (typeof exchange.fetchHistoricalKlines !== "function") throw new Error("当前主行情源不支持分页历史回测，请使用 Binance");
  const markets = {};
  for (const symbol of symbols) {
    const [hourly, fifteen, five, oneMinute, fundingRates] = await Promise.all([
      exchange.fetchHistoricalKlines(symbol, "1h", { startTime, endTime, maxCandles: days * 24 + 10 }),
      exchange.fetchHistoricalKlines(symbol, "15m", { startTime, endTime, maxCandles: days * 96 + 10 }),
      exchange.fetchHistoricalKlines(symbol, "5m", { startTime, endTime, maxCandles: days * 288 + 10 }),
      exchange.fetchHistoricalKlines(symbol, "1m", { startTime, endTime, maxCandles: days * 1440 + 10 }),
      typeof exchange.fetchFundingRates === "function" ? exchange.fetchFundingRates(symbol, { startTime, endTime }) : [],
    ]);
    markets[symbol] = { hourly, fifteen, five, oneMinute, fundingRates };
  }
  const result = runPortfolioBacktest({ markets, strategyConfig: config.strategy, portfolioConfig: config.portfolio, costs: config.costs });
  const validationTimes = Object.values(markets).flatMap((market) => market.five.map((item) => item.closeTime));
  const walkForward = runWalkForwardPortfolioValidation({
    markets,
    strategyConfig: config.strategy,
    portfolioConfig: config.portfolio,
    costs: config.costs,
  });
  const candleCounts = Object.fromEntries(Object.entries(markets).map(([symbol, market]) => [symbol, {
    hourly: market.hourly.length,
    fifteen: market.fifteen.length,
    five: market.five.length,
    oneMinute: market.oneMinute.length,
    fundingRates: market.fundingRates.length,
  }]));
  console.log(JSON.stringify({ symbols, days, candleCounts, validationPlan: walkForward.plan, walkForward, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
