import { isExecutionSymbol } from "./execution-symbols.js";
import { executionFillFacts, executionExcursionFacts, ownedExitFills } from "./execution-fill-facts.js";
import { V1_EXECUTION_SOURCE } from "./execution-strategy-source.js";

const CLOSED_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sum(items) {
  return items.reduce((total, item) => total + (finiteNumber(item) ?? 0), 0);
}

function weightedAverage(trades) {
  const quantity = sum(trades.map((trade) => trade.quantity));
  if (quantity <= 0) return null;
  // Owned fills have validated prices and quantities; mixed quote availability
  // must not divide a partial quote sum by the full executed quantity.
  return sum(trades.map((trade) => finiteNumber(trade.quoteQuantity)
    ?? (finiteNumber(trade.price) ?? 0) * (finiteNumber(trade.quantity) ?? 0))) / quantity;
}

function tradeTime(trade) {
  return finiteNumber(trade?.time);
}

export function projectExecutionRun(run, signalRecord = null) {
  if (!run?.id || !isExecutionSymbol(run.symbol) || !run.plan) return null;
  const trades = Array.isArray(run.result?.trades) ? run.result.trades : [];
  const facts = executionFillFacts(run);
  const excursion = executionExcursionFacts(run, facts);
  const sameExcursionBasis = excursion.mfeR !== null && run.performance?.factBasis === "ACTUAL_ENTRY_V1"
    && finiteNumber(run.performance?.entryPrice) === facts.entryPrice;
  const entryTrades = trades.filter((trade) => run.entryOrder?.orderId != null && String(trade.orderId) === String(run.entryOrder.orderId));
  const exitTrades = ownedExitFills(run);
  const executedQuantity = facts.quantity;
  const entryPrice = facts.entryPrice;
  const exitPrice = weightedAverage(exitTrades);
  const notional = facts.notional;
  const leverage = finiteNumber(run.plan.leverage);
  const actualMarginEstimate = notional !== null && leverage !== null && leverage > 0
    ? notional / leverage
    : null;
  const entryTimes = entryTrades.map(tradeTime).filter((value) => value !== null);
  const exitTimes = exitTrades.map(tradeTime).filter((value) => value !== null);
  const sourceType = run.sourceType ?? run.plan.sourceType ?? "SIGNAL";
  const signalDriven = sourceType === "SIGNAL";
  const strategy = signalRecord?.candidate?.strategy
    ?? (sourceType === "OPERATOR_CANARY" ? "OPERATOR_CANARY" : null);
  const candidate = signalRecord?.candidate ?? null;
  const position = (run.exchange?.positions ?? []).find((item) => item.symbol === run.symbol);
  const unrealizedPnl = position
    ? finiteNumber(position.unrealizedProfit ?? position.unrealizedPnl) ?? 0
    : null;
  const realizedPnl = finiteNumber(run.result?.realizedPnl);
  const commission = finiteNumber(run.result?.commission);
  const fundingPnl = finiteNumber(run.result?.fundingPnl);
  const entryConflict = run.status === "ENTRY_FACT_CONFLICT";
  const accountingComplete = !entryConflict && run.result?.accountingComplete === true;
  const netPnl = accountingComplete
    ? finiteNumber(run.result?.netPnl)
      ?? (realizedPnl !== null && commission !== null && fundingPnl !== null ? realizedPnl - commission + fundingPnl : null)
    : null;
  const plannedEntryPrice = finiteNumber(run.plan.prices?.entry);
  const plannedRisk = finiteNumber(run.plan.riskAmountEstimate);
  const stopLoss = finiteNumber(run.plan.prices?.stopLoss);
  const actualRisk = facts.riskAmount;
  const riskAmount = actualRisk;
  const directionSign = run.plan.direction === "LONG" ? 1 : -1;
  const entrySlippageCost = entryPrice !== null && plannedEntryPrice !== null && executedQuantity !== null
    ? directionSign * (entryPrice - plannedEntryPrice) * executedQuantity
    : null;
  const netR = netPnl !== null && riskAmount !== null && riskAmount > 0 ? netPnl / riskAmount : null;
  const mfePnl = excursion.mfePnl;
  const maePnl = excursion.maePnl;
  const entryReason = run.plan.orderReasons?.entry
    ?? (Array.isArray(candidate?.reasons) ? candidate.reasons[0] ?? null : null);

  return {
    id: run.id,
    signalId: run.signalId,
    sourceType,
    executionSource: run.executionSource ?? run.plan.executionSource ?? V1_EXECUTION_SOURCE,
    signalDriven,
    performanceEligible: entryConflict ? false : run.performanceEligible ?? signalDriven,
    strategy: run.plan.strategy ?? strategy,
    strategyVersion: run.plan.strategyVersion ?? candidate?.strategyVersion ?? null,
    signalModelVersion: run.plan.signalModelVersion ?? candidate?.signalModelVersion ?? null,
    experimentTier: run.experimentTier ?? run.plan.experimentTier ?? candidate?.experimentTier ?? null,
    costCohort: run.costCohort ?? run.plan.costCohort ?? candidate?.costCohort ?? null,
    demoPromotion: run.plan.demoPromotion ?? candidate?.demoPromotion ?? null,
    qualityObservations: Array.isArray(run.plan.qualityObservations)
      ? [...run.plan.qualityObservations]
      : Array.isArray(candidate?.qualityObservations) ? [...candidate.qualityObservations] : [],
    marketRadar: run.plan.marketRadar ?? candidate?.marketRadar ?? null,
    score: finiteNumber(run.plan.score) ?? finiteNumber(candidate?.score),
    marketEventId: run.plan.marketEventId ?? candidate?.marketEventId ?? null,
    entryReason,
    reason: entryReason,
    symbol: run.symbol,
    status: run.status,
    terminal: CLOSED_STATUSES.has(run.status),
    direction: run.plan.direction,
    action: run.plan.direction === "SHORT" ? "SELL_SHORT" : "BUY_LONG",
    leverage,
    marginMode: run.plan.marginMode ?? null,
    marginTarget: finiteNumber(run.plan.marginTarget),
    marginEstimate: finiteNumber(run.plan.marginEstimate),
    actualMarginEstimate,
    plannedQuantity: finiteNumber(run.plan.quantity),
    quantity: executedQuantity,
    entryPrice,
    exitPrice,
    stopLoss,
    takeProfit1: finiteNumber(run.plan.prices?.takeProfit1),
    takeProfit2: finiteNumber(run.plan.prices?.takeProfit2),
    notional,
    openedAt: entryTimes.length ? Math.min(...entryTimes) : finiteNumber(run.entryOrder?.updateTime),
    closedAt: exitTimes.length
      ? Math.max(...exitTimes)
      : run.status === "CLOSED" ? finiteNumber(run.updatedAt) : null,
    unrealizedPnl,
    realizedPnl,
    commission,
    fundingPnl,
    entrySlippageCost,
    entrySlippageBps: entryPrice !== null && plannedEntryPrice > 0
      ? directionSign * (entryPrice - plannedEntryPrice) / plannedEntryPrice * 10_000 : null,
    entryExecutionMode: run.entryExecution?.mode ?? run.plan.entryPolicy?.mode ?? null,
    entryTimeInForce: run.entryExecution?.timeInForce ?? run.plan.entryPolicy?.timeInForce ?? run.entryOrder?.timeInForce ?? null,
    plannedEntryPrice,
    submittedLimitPrice: finiteNumber(run.entryExecution?.submittedLimitPrice)
      ?? finiteNumber(run.executionMetrics?.submittedLimitPrice)
      ?? finiteNumber(run.entryOrder?.price),
    entryReferencePrice: finiteNumber(run.entryExecution?.referencePrice),
    entrySpreadBps: finiteNumber(run.entryExecution?.spreadBps),
    entryWaitMs: finiteNumber(run.executionMetrics?.timeToFillMs)
      ?? (finiteNumber(run.entryExecution?.completedAt) !== null && finiteNumber(run.entryExecution?.submittedAt) !== null
        ? finiteNumber(run.entryExecution?.completedAt) - finiteNumber(run.entryExecution?.submittedAt)
        : null),
    entryCancellationReason: run.entryExecution?.cancellationReason ?? run.result?.cancellationReason ?? null,
    plannedRisk,
    actualRisk,
    riskAmount,
    entryFactStatus: facts.status,
    entryFactSource: facts.source,
    entryFactReason: facts.reason,
    entryVerificationStatus: run.entryFactVerification?.status ?? null,
    entryFillsStatus: run.entryFactVerification?.fills?.status ?? null,
    excursionSource: excursion.source,
    excursionCoverage: excursion.coverage,
    excursionReason: excursion.reason,
    excursionTimingReason: sameExcursionBasis ? null : "EXCURSION_TIMING_BASIS_UNVERIFIED",
    fillRatio: finiteNumber(run.executionMetrics?.fillRatio)
      ?? (executedQuantity !== null && finiteNumber(run.plan.quantity) > 0
        ? executedQuantity / finiteNumber(run.plan.quantity)
        : null),
    executionException: run.executionException ?? null,
    error: run.error ?? null,
    netR,
    netPnl,
    mfePnl,
    maePnl,
    mfeR: mfePnl !== null && riskAmount !== null && riskAmount > 0
      ? Math.max(0, mfePnl / riskAmount)
      : null,
    maeR: maePnl !== null && riskAmount !== null && riskAmount > 0
      ? Math.abs(maePnl / riskAmount)
      : null,
    mfePrice: excursion.mfePrice,
    maePrice: excursion.maePrice,
    timeToMfeMs: sameExcursionBasis ? finiteNumber(run.performance?.timeToMfeMs) : null,
    timeToMaeMs: sameExcursionBasis ? finiteNumber(run.performance?.timeToMaeMs) : null,
    timeToTp1Ms: sameExcursionBasis ? finiteNumber(run.performance?.timeToTp1Ms) : null,
    timeToTp2Ms: sameExcursionBasis ? finiteNumber(run.performance?.timeToTp2Ms) : null,
    timeToStopMs: sameExcursionBasis ? finiteNumber(run.performance?.timeToStopMs) : null,
    mfeBeforeStopR: sameExcursionBasis ? finiteNumber(run.performance?.mfeBeforeStopR) : null,
    maeBeforeTp1R: sameExcursionBasis ? finiteNumber(run.performance?.maeBeforeTp1R) : null,
    maxFavorableExcursionBeforeExitR: run.status === "CLOSED" ? excursion.mfeR : null,
    maxAdverseExcursionBeforeExitR: run.status === "CLOSED" ? excursion.maeR : null,
    barsHeld5m: finiteNumber(run.performance?.barsHeld5m),
    minutesHeld: finiteNumber(run.performance?.minutesHeld),
    excursionSamples: finiteNumber(run.performance?.samples),
    entryOrderId: run.entryOrder?.orderId ?? null,
    entryOrderStatus: run.entryOrder?.status ?? null,
    protection: {
      stop: run.protection?.stop?.status ?? null,
      takeProfit1: run.protection?.takeProfit1?.status ?? null,
      takeProfit2: run.protection?.takeProfit2?.status ?? null,
      breakEvenStop: run.protection?.breakEvenStop?.status ?? null,
    },
    resultReason: run.result?.reason ?? null,
    exitReason: run.result?.exitReason ?? null,
    exitRole: run.result?.exitRole ?? null,
    accountingComplete,
    exitOrderIds: [...new Set([
      run.operatorCloseOrder?.orderId,
      ...Object.values(run.protection ?? {}).flatMap((order) => order && typeof order === "object" ? [order.actualOrderId, order.orderId] : []),
    ].filter(Boolean).map(String))],
    exitOrderId: run.operatorCloseOrder?.orderId
      ?? Object.values(run.protection ?? {}).find((order) => order?.actualOrderId)?.actualOrderId
      ?? null,
    updatedAt: finiteNumber(run.updatedAt),
    createdAt: finiteNumber(run.createdAt),
  };
}

export function projectExecutionRuns(runs = [], signalRecords = []) {
  const recordsBySignalId = new Map(signalRecords.map((record) => [record?.candidate?.id, record]));
  return runs
    .map((run) => projectExecutionRun(run, recordsBySignalId.get(run.signalId)))
    .filter(Boolean);
}
