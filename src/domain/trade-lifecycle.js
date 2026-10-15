import { buildEntryReason, buildMarketEventId, STRATEGY_VERSION } from "./trade-reason.js";

const ACTIVE_STATUSES = new Set(["ENTRY_PENDING", "OPEN", "TP1_FILLED"]);

function round(value, digits = 8) {
  return Number(value.toFixed(digits));
}

function addEvent(trade, type, at, details = {}) {
  trade.events.push({ type, at, ...details });
  trade.updatedAt = new Date(at).toISOString();
}

function exitFee(trade, price, fraction) {
  return price * trade.quantity * fraction * trade.costs.feeRate;
}

function exitSlippage(trade, price, fraction) {
  return price * trade.quantity * fraction * trade.costs.slippageRate;
}

function finalize(trade, { status = "CLOSED", reason, at, exitPrice }) {
  trade.status = status;
  trade.exitReason = reason;
  trade.exitPrice = exitPrice;
  trade.closedAt = new Date(at).toISOString();
  trade.costs.total = round(trade.costs.entryFee + trade.costs.exitFees + trade.costs.funding + trade.costs.slippage);
  trade.pnl.net = round(trade.pnl.gross - trade.costs.total);
  trade.pnl.netR = round(trade.pnl.net / trade.riskAmount, 4);
  addEvent(trade, status, at, { reason, exitPrice, netPnl: trade.pnl.net, netR: trade.pnl.netR });
}

function closeAtStop(trade, price, at, reason) {
  const fraction = trade.remainingFraction;
  const sign = trade.direction === "LONG" ? 1 : -1;
  trade.pnl.gross += sign * (price - trade.entryPrice) * trade.quantity * fraction;
  trade.costs.exitFees += exitFee(trade, price, fraction);
  trade.costs.slippage += exitSlippage(trade, price, fraction);
  trade.remainingFraction = 0;
  finalize(trade, { reason, at, exitPrice: price });
}

function fillTp1(trade, at) {
  const fraction = 0.5;
  const sign = trade.direction === "LONG" ? 1 : -1;
  trade.pnl.gross += sign * (trade.takeProfit1 - trade.entryPrice) * trade.quantity * fraction;
  trade.costs.exitFees += exitFee(trade, trade.takeProfit1, fraction);
  trade.costs.slippage += exitSlippage(trade, trade.takeProfit1, fraction);
  trade.remainingFraction = round(trade.remainingFraction - fraction);
  trade.status = "TP1_FILLED";
  trade.currentStop = trade.entryPrice;
  addEvent(trade, "TP1_FILLED", at, { price: trade.takeProfit1, remainingFraction: trade.remainingFraction, stopMovedTo: trade.entryPrice });
}

function fillTp2(trade, at) {
  const fraction = trade.remainingFraction;
  const sign = trade.direction === "LONG" ? 1 : -1;
  trade.pnl.gross += sign * (trade.takeProfit2 - trade.entryPrice) * trade.quantity * fraction;
  trade.costs.exitFees += exitFee(trade, trade.takeProfit2, fraction);
  trade.costs.slippage += exitSlippage(trade, trade.takeProfit2, fraction);
  trade.remainingFraction = 0;
  finalize(trade, { reason: "TAKE_PROFIT_2", at, exitPrice: trade.takeProfit2 });
}

function fillEntry(trade, candle, details = {}) {
  trade.status = "OPEN";
  trade.openedAt = new Date(candle.openTime).toISOString();
  trade.costs.entryFee = round(trade.notional * trade.costs.feeRate);
  trade.costs.slippage = round(trade.notional * trade.costs.slippageRate);
  addEvent(trade, "ENTRY_FILLED", candle.openTime, {
    price: trade.entryPrice,
    quantity: trade.quantity,
    ...details,
  });
}

function tryHistoricalIocEntry(trade, candle) {
  const maximumBps = Number(trade.entryExecution?.maxAdverseSlippageBps);
  const referencePrice = Number(candle.open);
  if (!Number.isFinite(maximumBps) || maximumBps < 0 || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error("历史IOC入场缺少有效的滑点边界或下一分钟开盘价");
  }
  const adverseBps = trade.direction === "LONG"
    ? ((referencePrice - trade.entryPrice) / trade.entryPrice) * 10_000
    : ((trade.entryPrice - referencePrice) / trade.entryPrice) * 10_000;
  if (adverseBps > maximumBps) {
    finalize(trade, {
      status: "EXPIRED",
      reason: "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET",
      at: candle.openTime,
      exitPrice: null,
    });
    addEvent(trade, "ENTRY_IOC_CANCELED", candle.openTime, {
      referencePrice,
      observedAdverseBps: round(adverseBps, 4),
      maxAdverseSlippageBps: maximumBps,
    });
    return false;
  }
  fillEntry(trade, candle, {
    executionMode: "MARKETABLE_LIMIT_IOC",
    referencePrice,
    observedAdverseBps: round(adverseBps, 4),
    maxAdverseSlippageBps: maximumBps,
  });
  return true;
}

function processOpenCandle(trade, candle) {
  const long = trade.direction === "LONG";
  const stopHit = long ? candle.low <= trade.currentStop : candle.high >= trade.currentStop;
  const tp2Hit = long ? candle.high >= trade.takeProfit2 : candle.low <= trade.takeProfit2;
  const tp1Hit = long ? candle.high >= trade.takeProfit1 : candle.low <= trade.takeProfit1;

  if (trade.status === "OPEN") {
    if (stopHit) {
      closeAtStop(trade, trade.currentStop, candle.closeTime, tp1Hit ? "AMBIGUOUS_STOP_FIRST" : "STOP_LOSS");
      return;
    }
    if (tp1Hit) {
      fillTp1(trade, candle.closeTime);
      if (tp2Hit) fillTp2(trade, candle.closeTime);
    }
    return;
  }

  if (trade.status === "TP1_FILLED") {
    if (stopHit) {
      closeAtStop(trade, trade.currentStop, candle.closeTime, tp2Hit ? "AMBIGUOUS_BREAKEVEN_FIRST" : "BREAKEVEN_AFTER_TP1");
      return;
    }
    if (tp2Hit) fillTp2(trade, candle.closeTime);
  }
}

export function createSimulatedTrade(candidate, {
  margin = 10,
  leverage = 10,
  feeRate = 0.0005,
  slippageRate = 0,
} = {}) {
  if (candidate?.status !== "CANDIDATE") throw new TypeError("只能从有效候选信号创建模拟交易");
  const entryPrice = candidate.order?.entry ?? candidate.risk?.entry;
  const stopLoss = candidate.risk?.stopLoss;
  if (![entryPrice, stopLoss, candidate.risk?.takeProfit1, candidate.risk?.takeProfit2].every(Number.isFinite)) {
    throw new TypeError("候选信号缺少有效的入场或风控价格");
  }
  const notional = margin * leverage;
  const quantity = notional / entryPrice;
  const riskAmount = Math.abs(entryPrice - stopLoss) * quantity;
  const createdAt = candidate.triggerTime;
  return {
    id: candidate.id,
    signalId: candidate.id,
    symbol: candidate.symbol,
    strategy: candidate.strategy,
    strategyVersion: candidate.strategyVersion ?? STRATEGY_VERSION,
    marketEventId: candidate.marketEventId ?? buildMarketEventId(candidate.triggerTime),
    entryReason: candidate.entryReason ?? buildEntryReason(candidate),
    attributionStrategies: candidate.attributionStrategies ?? [candidate.strategy],
    direction: candidate.direction,
    status: "ENTRY_PENDING",
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
    expiresAt: candidate.order.expiresAt,
    entryPrice,
    stopLoss,
    currentStop: stopLoss,
    takeProfit1: candidate.risk.takeProfit1,
    takeProfit2: candidate.risk.takeProfit2,
    margin,
    leverage,
    notional,
    quantity,
    riskAmount,
    remainingFraction: 1,
    lastProcessedAt: createdAt,
    lastFundingAt: createdAt,
    costs: { feeRate, slippageRate, entryFee: 0, exitFees: 0, funding: 0, slippage: 0, total: 0 },
    pnl: { gross: 0, net: 0, netR: 0 },
    events: [{ type: "ENTRY_PENDING", at: createdAt, entryPrice, expiresAt: candidate.order.expiresAt }],
  };
}

export function createFixedRiskSimulatedTrade(candidate, {
  feeRate = 0.0005,
  slippageRate = 0.0002,
  maxAdverseSlippageBps = 10,
} = {}) {
  const plan = candidate?.shadowV2?.fixedRiskPlan;
  if (!plan?.valid) throw new TypeError("固定风险历史交易缺少有效仓位计划");
  const notional = Number(plan.targetNotional);
  const margin = Number(plan.targetMargin);
  const leverage = Number(plan.leverage);
  const quantity = Number(plan.targetQuantity);
  if (![notional, margin, leverage, quantity].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError("固定风险历史交易的名义价值、保证金、杠杆或数量无效");
  }
  const entry = Number(candidate?.order?.entry ?? candidate?.risk?.entry);
  const quantityNotional = entry * quantity;
  if (!Number.isFinite(entry) || Math.abs(quantityNotional - notional) / notional > 0.0001) {
    throw new Error("固定风险历史交易的数量与名义价值不一致");
  }
  const trade = createSimulatedTrade(candidate, { margin, leverage, feeRate, slippageRate });
  trade.notional = notional;
  trade.margin = margin;
  trade.quantity = quantity;
  trade.riskAmount = round(Math.abs(trade.entryPrice - trade.stopLoss) * quantity);
  trade.shadowRiskPercent = Number(plan.targetRiskPercent);
  trade.positionSizing = {
    modelVersion: plan.modelVersion ?? "FIXED_RISK_V1",
    equityAtDecision: Number(plan.equity),
    targetRiskAmount: Number(plan.targetRiskAmount),
    targetRiskPercent: Number(plan.targetRiskPercent),
  };
  trade.signalEvaluation = {
    score: Number(candidate.shadowV2.score),
    experimentTier: candidate.shadowV2.experimentTier ?? null,
    strategyVersion: candidate.shadowV2.strategyVersion ?? candidate.strategyVersion ?? null,
    qualityObservations: [...(candidate.shadowV2.qualityObservations ?? [])],
    explosionScore: Number.isFinite(Number(candidate.preMove?.explosionScore))
      ? Number(candidate.preMove.explosionScore)
      : null,
    directionScore: Number.isFinite(Number(candidate.preMove?.directionScore))
      ? Number(candidate.preMove.directionScore)
      : null,
    candidateSources: [...(candidate.marketRadar?.opportunitySources ?? [])],
  };
  trade.entryExecution = candidate.order?.style === "ACTIVE_DYNAMIC"
    ? {
      mode: "MARKETABLE_LIMIT_IOC",
      timeInForce: "IOC",
      maxAdverseSlippageBps: Number(maxAdverseSlippageBps),
      historicalPriceModel: "NEXT_1M_OPEN_BOUND_CHECK_PLUS_CONFIGURED_COST",
    }
    : {
      mode: "PASSIVE_LIMIT_GTC",
      timeInForce: "GTC",
      maxAdverseSlippageBps: null,
      historicalPriceModel: "ONE_MINUTE_TOUCH",
    };
  return trade;
}

export function createManualTrade(candidate, {
  id,
  fillPrice,
  quantity,
  feeRate = 0.0005,
  createdAt = Date.now(),
} = {}) {
  if (!id) throw new TypeError("手动交易必须有唯一编号");
  if (![fillPrice, quantity].every(Number.isFinite) || fillPrice <= 0 || quantity <= 0) {
    throw new TypeError("实际成交价和数量必须是正数");
  }
  const stopLoss = candidate?.risk?.stopLoss;
  const takeProfit1 = candidate?.risk?.takeProfit1;
  const takeProfit2 = candidate?.risk?.takeProfit2;
  if (![stopLoss, takeProfit1, takeProfit2].every(Number.isFinite)) throw new TypeError("对应信号缺少有效风控价格");
  const notional = round(fillPrice * quantity);
  const riskAmount = round(Math.abs(fillPrice - stopLoss) * quantity);
  return {
    id,
    signalId: candidate.id,
    manual: true,
    symbol: candidate.symbol,
    strategy: candidate.strategy,
    attributionStrategies: candidate.attributionStrategies ?? [candidate.strategy],
    direction: candidate.direction,
    status: "OPEN",
    createdAt: new Date(createdAt).toISOString(),
    openedAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
    entryPrice: fillPrice,
    stopLoss,
    currentStop: stopLoss,
    takeProfit1,
    takeProfit2,
    margin: null,
    leverage: null,
    notional,
    quantity,
    riskAmount,
    remainingFraction: 1,
    lastProcessedAt: createdAt,
    lastFundingAt: createdAt,
    costs: { feeRate, slippageRate: 0, entryFee: round(notional * feeRate), exitFees: 0, funding: 0, slippage: 0, total: 0 },
    pnl: { gross: 0, net: 0, netR: 0 },
    events: [{ type: "MANUAL_ENTRY_RECORDED", at: createdAt, entryPrice: fillPrice, quantity }],
  };
}

export function advanceTrade(inputTrade, candles) {
  const trade = structuredClone(inputTrade);
  if (!ACTIVE_STATUSES.has(trade.status)) return trade;
  const ordered = [...candles]
    .filter((candle) => candle.closeTime > trade.lastProcessedAt)
    .sort((a, b) => a.closeTime - b.closeTime);

  for (const candle of ordered) {
    if (!ACTIVE_STATUSES.has(trade.status)) break;
    if (trade.status === "ENTRY_PENDING") {
      if (candle.openTime >= trade.expiresAt) {
        finalize(trade, { status: "EXPIRED", reason: "ENTRY_NOT_FILLED", at: candle.openTime, exitPrice: null });
        break;
      }
      if (trade.entryExecution?.timeInForce === "IOC") {
        if (!tryHistoricalIocEntry(trade, candle)) break;
        processOpenCandle(trade, candle);
        trade.lastProcessedAt = candle.closeTime;
        continue;
      }
      const filled = trade.direction === "LONG" ? candle.low <= trade.entryPrice : candle.high >= trade.entryPrice;
      if (!filled) {
        trade.lastProcessedAt = candle.closeTime;
        continue;
      }
      fillEntry(trade, candle);
    }

    processOpenCandle(trade, candle);
    trade.lastProcessedAt = candle.closeTime;
  }
  return trade;
}

export function applyFundingEvents(inputTrade, events = []) {
  const trade = structuredClone(inputTrade);
  if (!ACTIVE_STATUSES.has(trade.status) || trade.status === "ENTRY_PENDING") return trade;
  const openedAt = new Date(trade.openedAt).getTime();
  const lastFundingAt = Number.isFinite(trade.lastFundingAt) ? trade.lastFundingAt : openedAt;
  const ordered = [...events]
    .filter((event) => Number.isFinite(event?.fundingTime) && Number.isFinite(event?.rate) && Number.isFinite(event?.markPrice))
    .filter((event) => event.fundingTime > lastFundingAt && event.fundingTime >= openedAt)
    .sort((a, b) => a.fundingTime - b.fundingTime);
  for (const event of ordered) {
    if (!ACTIVE_STATUSES.has(trade.status) || trade.status === "ENTRY_PENDING") break;
    const directionSign = trade.direction === "LONG" ? 1 : -1;
    const amount = directionSign * event.markPrice * trade.quantity * trade.remainingFraction * event.rate;
    trade.costs.funding = round(trade.costs.funding + amount);
    trade.lastFundingAt = event.fundingTime;
    addEvent(trade, "FUNDING_SETTLED", event.fundingTime, { rate: event.rate, markPrice: event.markPrice, amount: round(amount) });
  }
  return trade;
}

export function advanceTradeTimeline(inputTrade, candles = [], fundingEvents = []) {
  let trade = structuredClone(inputTrade);
  const orderedCandles = [...candles].sort((a, b) => a.openTime - b.openTime);
  const orderedFunding = [...fundingEvents].sort((a, b) => a.fundingTime - b.fundingTime);
  let fundingIndex = 0;
  for (const candle of orderedCandles) {
    const before = [];
    while (fundingIndex < orderedFunding.length && orderedFunding[fundingIndex].fundingTime <= candle.openTime) {
      before.push(orderedFunding[fundingIndex]);
      fundingIndex += 1;
    }
    trade = applyFundingEvents(trade, before);
    trade = advanceTrade(trade, [candle]);
    const within = [];
    while (fundingIndex < orderedFunding.length && orderedFunding[fundingIndex].fundingTime <= candle.closeTime) {
      within.push(orderedFunding[fundingIndex]);
      fundingIndex += 1;
    }
    trade = applyFundingEvents(trade, within);
    if (!ACTIVE_STATUSES.has(trade.status)) break;
  }
  return trade;
}

export function isActiveTrade(trade) {
  return ACTIVE_STATUSES.has(trade?.status);
}
