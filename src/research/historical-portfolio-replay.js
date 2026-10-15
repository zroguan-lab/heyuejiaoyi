import {
  advanceTradeTimeline,
  createFixedRiskSimulatedTrade,
  isActiveTrade,
} from "../domain/trade-lifecycle.js";
import { selectProductionShadowCandidates } from "../domain/shadow-v2.js";
import {
  runHistoricalV23Point,
  STRICT_POINT_IN_TIME_METADATA,
} from "./historical-market-replay.js";

const BEIJING_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function round(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function orderedMinutes(rows = []) {
  const seen = new Set();
  return [...rows]
    .filter((item) => Number.isFinite(Number(item?.openTime)) && Number.isFinite(Number(item?.closeTime)))
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime))
    .filter((item) => {
      const time = Number(item.openTime);
      if (seen.has(time)) throw new Error(`M4历史路径存在重复分钟: ${time}`);
      seen.add(time);
      return true;
    });
}

function upperBoundByCloseTime(rows, time) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(rows[middle].closeTime) <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function latestMark(rows, time) {
  const end = upperBoundByCloseTime(rows, time);
  return end ? Number(rows[end - 1].close) : null;
}

function incurredCosts(trade) {
  return Number(trade.costs?.entryFee ?? 0)
    + Number(trade.costs?.exitFees ?? 0)
    + Number(trade.costs?.funding ?? 0)
    + Number(trade.costs?.slippage ?? 0);
}

function accountSnapshot(trades, marketData, time, startingEquity) {
  const realizedNetPnl = trades
    .filter((trade) => trade.status === "CLOSED")
    .reduce((sum, trade) => sum + Number(trade.pnl?.net ?? 0), 0);
  const balance = startingEquity + realizedNetPnl;
  let unrealizedNetPnl = 0;
  let reservedMargin = 0;
  let activePositions = 0;
  let pendingOrders = 0;
  for (const trade of trades.filter(isActiveTrade)) {
    reservedMargin += Number(trade.margin ?? 0) * Number(trade.remainingFraction ?? 1);
    if (trade.status === "ENTRY_PENDING") {
      pendingOrders += 1;
      continue;
    }
    activePositions += 1;
    const mark = latestMark(marketData[trade.symbol] ?? [], time);
    if (!Number.isFinite(mark)) continue;
    const sign = trade.direction === "LONG" ? 1 : -1;
    const openGross = sign * (mark - trade.entryPrice) * trade.quantity * trade.remainingFraction;
    unrealizedNetPnl += Number(trade.pnl?.gross ?? 0) + openGross - incurredCosts(trade);
  }
  const equity = balance + unrealizedNetPnl;
  return {
    time,
    balance: round(balance, 4),
    equity: round(equity, 4),
    realizedNetPnl: round(realizedNetPnl, 4),
    unrealizedNetPnl: round(unrealizedNetPnl, 4),
    reservedMargin: round(reservedMargin, 4),
    freeMargin: round(equity - reservedMargin, 4),
    activePositions,
    pendingOrders,
  };
}

function advanceTo(trade, marketData, fundingBySymbol, time) {
  const minutes = marketData[trade.symbol];
  if (!minutes) throw new Error(`M4缺少${trade.symbol}的1分钟路径`);
  const from = upperBoundByCloseTime(minutes, Number(trade.lastProcessedAt));
  const to = upperBoundByCloseTime(minutes, time);
  const funding = (fundingBySymbol[trade.symbol] ?? []).filter((event) => (
    Number(event.fundingTime) > Number(trade.lastFundingAt ?? trade.lastProcessedAt)
    && Number(event.fundingTime) <= time
  ));
  return advanceTradeTimeline(trade, minutes.slice(from, to), funding);
}

function rejection(candidate, reason, time, details = {}) {
  return {
    at: time,
    candidateId: candidate?.id ?? null,
    symbol: candidate?.symbol ?? null,
    strategy: candidate?.strategy ?? null,
    direction: candidate?.direction ?? null,
    score: Number(candidate?.shadowV2?.score ?? candidate?.score ?? 0),
    tier: candidate?.shadowV2?.experimentTier ?? null,
    reason,
    ...details,
  };
}

function dailyCurve(equityCurve) {
  const byDay = new Map();
  for (const point of equityCurve) byDay.set(BEIJING_DATE.format(new Date(point.time)), point);
  return [...byDay.entries()].map(([date, point]) => ({ date, ...point }));
}

function maximumConcurrentPositions(trades) {
  const events = [];
  for (const trade of trades) {
    const entry = trade.events.find((event) => event.type === "ENTRY_FILLED");
    if (!entry) continue;
    events.push({ time: Number(entry.at), delta: 1 });
    if (trade.closedAt) events.push({ time: new Date(trade.closedAt).getTime(), delta: -1 });
  }
  events.sort((left, right) => left.time - right.time || right.delta - left.delta);
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    current += event.delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function summarize(trades, rejected, equityCurve, startingEquity) {
  const closed = trades.filter((trade) => trade.status === "CLOSED");
  const expired = trades.filter((trade) => trade.status === "EXPIRED");
  const filled = trades.filter((trade) => trade.events.some((event) => event.type === "ENTRY_FILLED"));
  const wins = closed.filter((trade) => Number(trade.pnl.net) > 0);
  const losses = closed.filter((trade) => Number(trade.pnl.net) <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Number(trade.pnl.net), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + Number(trade.pnl.net), 0));
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, Number(point.equity));
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - Number(point.equity)) / peak : 0);
  }
  const finalPoint = equityCurve.at(-1) ?? {
    balance: startingEquity,
    equity: startingEquity,
    realizedNetPnl: 0,
    unrealizedNetPnl: 0,
  };
  return {
    ordersCreated: trades.length,
    filled: filled.length,
    canceledOrExpired: expired.length,
    closed: closed.length,
    unresolved: trades.length - closed.length - expired.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: closed.length ? round(wins.length / closed.length * 100, 3) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    averageNetR: closed.length ? round(closed.reduce((sum, trade) => sum + Number(trade.pnl.netR), 0) / closed.length, 4) : 0,
    startingEquity,
    endingBalance: finalPoint.balance,
    endingEquity: finalPoint.equity,
    realizedNetPnl: finalPoint.realizedNetPnl,
    unrealizedNetPnl: finalPoint.unrealizedNetPnl,
    returnPercent: round((Number(finalPoint.equity) - startingEquity) / startingEquity * 100, 4),
    maxDrawdownPercent: round(maxDrawdown * 100, 4),
    maxConcurrentPositions: maximumConcurrentPositions(trades),
    rejected: rejected.length,
    fees: round(trades.reduce((sum, trade) => sum + Number(trade.costs.entryFee) + Number(trade.costs.exitFees), 0), 6),
    slippage: round(trades.reduce((sum, trade) => sum + Number(trade.costs.slippage), 0), 6),
    funding: round(trades.reduce((sum, trade) => sum + Number(trade.costs.funding), 0), 6),
  };
}

export function runHistoricalV23PortfolioReplay({
  marketData,
  contractRecords,
  fundingBySymbol = {},
  decisionTimes,
  config,
  metadataPolicy = STRICT_POINT_IN_TIME_METADATA,
  spreadSnapshots = null,
  marketCoverage = null,
  marketCoverageSnapshots = null,
  endTime = null,
  decisionRunner = runHistoricalV23Point,
} = {}) {
  if (!marketData || !contractRecords || !config || typeof decisionRunner !== "function") {
    throw new TypeError("M4组合回放缺少历史市场、合约快照、配置或决策引擎");
  }
  const times = [...new Set((decisionTimes ?? []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (!times.length) throw new Error("M4组合回放至少需要一个决策时间");
  const minutes = Object.fromEntries(Object.entries(marketData).map(([symbol, rows]) => [symbol, orderedMinutes(rows)]));
  const latestCommonTime = Math.min(...Object.values(minutes).filter((rows) => rows.length).map((rows) => Number(rows.at(-1).closeTime)));
  const replayEnd = Number.isFinite(Number(endTime)) ? Number(endTime) : latestCommonTime;
  if (!Number.isFinite(replayEnd) || replayEnd < times.at(-1)) throw new Error("M4组合回放结束时间早于最后决策时间");

  const startingEquity = Number(config.portfolio?.startingEquity ?? 500);
  const trades = [];
  const rejected = [];
  const decisions = [];
  const equityCurve = [];
  const seenCandidates = new Set();
  let previousRadar = null;

  for (const time of times) {
    for (let index = 0; index < trades.length; index += 1) {
      if (isActiveTrade(trades[index])) trades[index] = advanceTo(trades[index], minutes, fundingBySymbol, time);
    }
    const before = accountSnapshot(trades, minutes, time, startingEquity);
    const point = decisionRunner({
      marketData: minutes,
      contractRecords,
      fundingBySymbol,
      decisionTime: time,
      previousRadar,
      config,
      metadataPolicy,
      spreadSnapshots,
      marketCoverage,
      marketCoverageSnapshots,
      equity: before.equity,
    });
    previousRadar = point.radar;
    const fresh = [];
    for (const candidate of point.decisions.flatMap((item) => item.decision?.candidates ?? [])) {
      if (seenCandidates.has(candidate.id)) continue;
      seenCandidates.add(candidate.id);
      fresh.push(candidate);
    }
    const allocation = selectProductionShadowCandidates(fresh, trades.filter(isActiveTrade), {
      minimumScore: Number(config.shadowV2?.explorationMinimumScore ?? config.shadowV2?.minimumScore ?? 55),
    });
    rejected.push(...allocation.rejected.map((item) => rejection(item.candidate, item.reason, time)));

    let availableMargin = before.equity - before.reservedMargin;
    const selectedIds = [];
    for (const candidate of allocation.selected) {
      const trade = createFixedRiskSimulatedTrade(candidate, {
        feeRate: Number(config.costs?.fallbackFeeRate ?? 0.0005),
        slippageRate: candidate.order?.style === "ACTIVE_DYNAMIC"
          ? Number(config.costs?.fallbackSlippageRate ?? 0.0002)
          : 0,
        maxAdverseSlippageBps: Number(config.costs?.activeLimitMaxBps ?? 10),
      });
      if (trade.margin > availableMargin) {
        rejected.push(rejection(candidate, "INSUFFICIENT_MARGIN", time, {
          requiredMargin: round(trade.margin, 4),
          availableMargin: round(availableMargin, 4),
        }));
        continue;
      }
      trades.push(trade);
      availableMargin -= trade.margin;
      selectedIds.push(candidate.id);
    }
    const after = accountSnapshot(trades, minutes, time, startingEquity);
    equityCurve.push(after);
    decisions.push({
      decisionTime: time,
      radarSnapshotId: point.radar?.snapshotId ?? null,
      promotionEligible: Boolean(point.promotionEligible),
      candidates: fresh.length,
      selected: selectedIds,
      rejected: allocation.rejected.length + (allocation.selected.length - selectedIds.length),
      account: after,
    });
  }

  for (let index = 0; index < trades.length; index += 1) {
    if (isActiveTrade(trades[index])) trades[index] = advanceTo(trades[index], minutes, fundingBySymbol, replayEnd);
  }
  if (replayEnd > times.at(-1)) equityCurve.push(accountSnapshot(trades, minutes, replayEnd, startingEquity));
  const pointInTimeEligible = decisions.every((item) => item.promotionEligible);
  return {
    modelVersion: "V2_3_HISTORICAL_PORTFOLIO_REPLAY_M4_R1",
    assumptions: {
      startingEquity,
      positionSizing: "FIXED_RISK_PERCENT_OF_POINT_IN_TIME_EQUITY",
      positionLimit: null,
      marginConstraint: "AVAILABLE_EQUITY_ONLY",
      entryIocModel: "NEXT_1M_OPEN_BOUND_CHECK_PLUS_CONFIGURED_COST",
      passiveLimitModel: "ONE_MINUTE_TOUCH",
      ambiguousCandle: "STOP_FIRST",
      markToMarket: "LAST_CLOSED_1M",
      pointInTimeMetadata: metadataPolicy,
    },
    promotionEligible: false,
    researchOnlyReasons: [
      ...(!pointInTimeEligible ? ["POINT_IN_TIME_MARKET_COVERAGE_INCOMPLETE"] : []),
      "HISTORICAL_ORDERBOOK_AND_QUEUE_POSITION_UNAVAILABLE",
    ],
    metrics: summarize(trades, rejected, equityCurve, startingEquity),
    trades,
    rejected,
    decisions,
    equityCurve,
    dailyEquity: dailyCurve(equityCurve),
  };
}
