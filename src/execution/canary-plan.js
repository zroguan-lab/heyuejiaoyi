import { createHash, randomBytes } from "node:crypto";
import {
  buildCanarySizing,
  formatToStep,
  parseContractRules,
  quantizeEntryPrice,
  quantizeTriggerPrice,
} from "./contract-rules.js";
import { assertExecutionSymbol } from "./execution-symbols.js";
import { buildEntryPolicy } from "./entry-order-policy.js";
import { buildMarketEventId, buildOrderReasons, STRATEGY_VERSION } from "../domain/trade-reason.js";
import {
  V1_EXECUTION_SOURCE,
  assertExecutionStrategySource,
} from "./execution-strategy-source.js";

function digest(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function assertDirectionPrices(direction, { entryPrice, stopLoss, takeProfit1, takeProfit2 }) {
  const valid = direction === "LONG"
    ? stopLoss < entryPrice && entryPrice < takeProfit1 && takeProfit1 < takeProfit2
    : takeProfit2 < takeProfit1 && takeProfit1 < entryPrice && entryPrice < stopLoss;
  if (!valid) throw new Error("信号的入场、止损和止盈方向关系无效");
}

export function confirmationHash(code, runId) {
  return createHash("sha256").update(`${runId}:${code}`).digest("hex");
}

export function verifyConfirmation(code, run) {
  if (!run?.confirmationCodeHash || typeof code !== "string") return false;
  return confirmationHash(code, run.id) === run.confirmationCodeHash;
}

export function resolveLeverageCapability(leverageBrackets, { requestedLeverage, notional } = {}) {
  const requested = Number(requestedLeverage);
  const targetNotional = Number(notional);
  const brackets = Array.isArray(leverageBrackets?.brackets) ? leverageBrackets.brackets : [];
  if (!Number.isInteger(requested) || requested < 1) throw new TypeError("目标杠杆必须是正整数");
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) throw new TypeError("杠杆预检名义价值必须为正数");
  if (!brackets.length) {
    return {
      checked: false,
      requestedLeverage: requested,
      maximumLeverage: null,
      supported: null,
      notional: targetNotional,
      bracket: null,
    };
  }
  const matching = brackets
    .map((item) => ({
      bracket: Number(item?.bracket),
      initialLeverage: Number(item?.initialLeverage),
      notionalFloor: Number(item?.notionalFloor),
      notionalCap: Number(item?.notionalCap),
    }))
    .filter((item) => [item.initialLeverage, item.notionalFloor, item.notionalCap].every(Number.isFinite))
    .sort((left, right) => left.notionalFloor - right.notionalFloor)
    .find((item) => targetNotional >= item.notionalFloor && targetNotional <= item.notionalCap) ?? null;
  const maximumLeverage = matching && Number.isInteger(matching.initialLeverage) && matching.initialLeverage >= 1
    ? matching.initialLeverage
    : null;
  return {
    checked: true,
    requestedLeverage: requested,
    maximumLeverage,
    supported: maximumLeverage !== null && requested <= maximumLeverage,
    notional: targetNotional,
    bracket: matching,
  };
}

export function buildCanaryRun({
  signalRecord,
  accountState,
  symbolInfo,
  leverageBrackets = null,
  margin = 10,
  leverage = 10,
  maxNotionalOverageRate = 0.05,
  activeLimitMaxBps = 10,
  pullbackEntryTtlMs = 180_000,
  executionPermissionVerified = accountState?.canTrade === true,
  portfolioStateVerified = false,
  sourceType = "SIGNAL",
  executionSource = V1_EXECUTION_SOURCE,
  now = Date.now(),
} = {}) {
  const candidate = signalRecord?.candidate;
  const trade = signalRecord?.trade;
  if (!signalRecord?.selected || !candidate || !trade) throw new Error("只能准备已进入模拟组合的信号");
  const symbol = assertExecutionSymbol(candidate.symbol);
  if (trade.symbol !== symbol) throw new Error("策略候选与模拟交易的标的不一致");
  if (symbolInfo?.symbol !== symbol || accountState?.symbolConfig?.symbol !== symbol) {
    throw new Error("信号、合约规则与账户配置的标的不一致");
  }
  if (trade.status !== "ENTRY_PENDING") throw new Error("只有仍在等待入场的信号可以执行");
  if (!Number.isFinite(Number(trade.expiresAt)) || Number(trade.expiresAt) - now < 30_000) throw new Error("信号已过期或剩余有效时间不足30秒");
  if (!new Set(["LONG", "SHORT"]).has(candidate.direction)) throw new Error("信号方向无效");
  if (!new Set(["SIGNAL", "OPERATOR_CANARY"]).has(sourceType)) throw new Error("执行来源类型无效");
  const resolvedExecutionSource = sourceType === "SIGNAL" ? assertExecutionStrategySource(executionSource) : null;
  if (accountState?.environment !== "TESTNET" || accountState?.authority !== "BINANCE_TESTNET") throw new Error("账户事实源不是 Binance Testnet");
  if (!executionPermissionVerified) throw new Error("测试网账户当前不允许交易，且安全权限探针尚未通过");
  if (accountState.positionMode !== "ONE_WAY") throw new Error("测试网账户必须使用单向持仓");
  if (!portfolioStateVerified) {
    if ((accountState.positions ?? []).length) throw new Error("测试网账户已有持仓");
    if ((accountState.openOrders ?? []).length) throw new Error("测试网账户已有普通挂单");
    if ((accountState.openAlgoOrders ?? []).length) throw new Error("测试网账户已有条件挂单");
  }

  const rules = parseContractRules(symbolInfo);
  const raw = {
    entryPrice: Number(trade.entryPrice),
    stopLoss: Number(trade.stopLoss),
    takeProfit1: Number(trade.takeProfit1),
    takeProfit2: Number(trade.takeProfit2),
  };
  if (!Object.values(raw).every(Number.isFinite)) throw new Error("信号缺少有效交易价格");
  assertDirectionPrices(candidate.direction, raw);
  const prices = {
    entryPrice: quantizeEntryPrice(candidate.direction, raw.entryPrice, rules),
    stopLoss: quantizeTriggerPrice("STOP", candidate.direction, raw.stopLoss, rules),
    takeProfit1: quantizeTriggerPrice("TAKE_PROFIT", candidate.direction, raw.takeProfit1, rules),
    takeProfit2: quantizeTriggerPrice("TAKE_PROFIT", candidate.direction, raw.takeProfit2, rules),
  };
  assertDirectionPrices(candidate.direction, prices);
  const sizing = buildCanarySizing({
    entryPrice: prices.entryPrice,
    takeProfit1: prices.takeProfit1,
    takeProfit2: prices.takeProfit2,
    margin,
    leverage,
    maxNotionalOverageRate,
    rules,
  });
  const leverageCapability = resolveLeverageCapability(leverageBrackets, {
    requestedLeverage: leverage,
    notional: sizing.actualNotional,
  });
  if (!Number.isFinite(accountState.availableBalance) || accountState.availableBalance < sizing.marginEstimate) {
    throw new Error("测试网可用余额不足");
  }
  const signalId = candidate.id;
  const token = digest(signalId, 14);
  const runId = `canary-${token}`;
  const confirmationCode = randomBytes(4).toString("hex");
  const clientIds = {
    entry: `cfs-${token}-entry`,
    stop: `cfs-${token}-sl`,
    breakEvenStop: `cfs-${token}-slbe`,
    takeProfit1: `cfs-${token}-tp1`,
    takeProfit2: `cfs-${token}-tp2`,
    operatorClose: `cfs-${token}-close`,
  };
  const formattedPrices = {
    entry: formatToStep(prices.entryPrice, rules.tickSize),
    stopLoss: formatToStep(prices.stopLoss, rules.tickSize),
    takeProfit1: formatToStep(prices.takeProfit1, rules.tickSize),
    takeProfit2: formatToStep(prices.takeProfit2, rules.tickSize),
  };
  const generatedOrderReasons = buildOrderReasons({ candidate, prices: formattedPrices });
  const orderReasons = typeof candidate.entryReason === "string" && candidate.entryReason.trim()
    ? Object.freeze({ ...generatedOrderReasons, entry: candidate.entryReason.trim() })
    : generatedOrderReasons;
  const entryPolicy = buildEntryPolicy({
    strategy: candidate.strategy,
    signalExpiresAt: Number(trade.expiresAt),
    now,
    activeLimitMaxBps,
    pullbackEntryTtlMs,
  });
  const plan = {
    sourceType,
    executionSource: resolvedExecutionSource,
    symbol,
    strategy: candidate.strategy,
    strategyVersion: candidate.strategyVersion ?? STRATEGY_VERSION,
    signalModelVersion: candidate.signalModelVersion ?? null,
    experimentTier: candidate.experimentTier ?? null,
    costCohort: candidate.costCohort ?? null,
    demoPromotion: candidate.demoPromotion ? structuredClone(candidate.demoPromotion) : null,
    qualityObservations: Array.isArray(candidate.qualityObservations) ? [...candidate.qualityObservations] : [],
    marketRadar: candidate.marketRadar ? structuredClone(candidate.marketRadar) : null,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : null,
    marketEventId: candidate.marketEventId ?? buildMarketEventId(candidate.triggerTime ?? now),
    direction: candidate.direction,
    entrySide: candidate.direction === "LONG" ? "BUY" : "SELL",
    exitSide: candidate.direction === "LONG" ? "SELL" : "BUY",
    marginMode: "ISOLATED",
    positionMode: "ONE_WAY",
    leverage,
    leverageCapability,
    marginTarget: margin,
    expiresAt: Number(trade.expiresAt),
    entryPolicy,
    prices: formattedPrices,
    quantity: formatToStep(sizing.quantity, rules.stepSize),
    takeProfit1Quantity: formatToStep(sizing.takeProfit1Quantity, rules.stepSize),
    takeProfit2Quantity: formatToStep(sizing.takeProfit2Quantity, rules.stepSize),
    targetNotional: sizing.targetNotional,
    actualNotional: sizing.actualNotional,
    marginEstimate: sizing.marginEstimate,
    riskAmountEstimate: Number((Math.abs(prices.entryPrice - prices.stopLoss) * sizing.quantity).toFixed(8)),
    rules: { ...rules },
    clientIds,
    orderReasons,
    accountChanges: {
      marginType: accountState.symbolConfig?.marginType !== "ISOLATED",
      leverage: Number(accountState.symbolConfig?.leverage) !== leverage,
    },
  };
  const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const run = {
    id: runId,
    signalId,
    sourceType,
    executionSource: resolvedExecutionSource,
    performanceEligible: sourceType === "SIGNAL",
    experimentTier: candidate.experimentTier ?? null,
    costCohort: candidate.costCohort ?? null,
    symbol,
    status: "PREPARED",
    createdAt: now,
    updatedAt: now,
    planHash,
    plan,
    confirmationCodeHash: confirmationHash(confirmationCode, runId),
    confirmationUsedAt: null,
    entryExecution: null,
    entryOrder: null,
    protection: { mode: null, stop: null, takeProfit1: null, takeProfit2: null, breakEvenStop: null },
    exchange: null,
    result: null,
    error: null,
  };
  return { run, confirmationCode };
}

export function buildOperatorCanaryRun({
  accountState,
  symbolInfo,
  leverageBrackets = null,
  markPrice,
  direction = "LONG",
  symbol = "BTCUSDT",
  margin = 10,
  leverage = 10,
  maxNotionalOverageRate = 0.05,
  activeLimitMaxBps = 10,
  pullbackEntryTtlMs = 180_000,
  executionPermissionVerified = accountState?.canTrade === true,
  portfolioStateVerified = false,
  now = Date.now(),
} = {}) {
  assertExecutionSymbol(symbol, "人工金丝雀标的");
  const price = Number(markPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("人工金丝雀缺少有效标记价格");
  if (!new Set(["LONG", "SHORT"]).has(direction)) throw new Error("人工金丝雀方向只能是 LONG 或 SHORT");
  const long = direction === "LONG";
  const signalId = `operator-${now.toString(36)}-${randomBytes(3).toString("hex")}`;
  const candidate = {
    id: signalId,
    symbol,
    direction,
    strategy: "OPERATOR_CANARY",
    status: "TECHNICAL_CANARY",
    triggerTime: now,
    score: null,
    reasons: ["人工授权的 Binance Demo 技术闭环验证，不计入策略绩效"],
  };
  const trade = {
    signalId,
    symbol,
    direction,
    status: "ENTRY_PENDING",
    entryPrice: price * (long ? 1.002 : 0.998),
    stopLoss: price * (long ? 0.995 : 1.005),
    takeProfit1: price * (long ? 1.005 : 0.995),
    takeProfit2: price * (long ? 1.01 : 0.99),
    expiresAt: now + 10 * 60 * 1000,
  };
  return buildCanaryRun({
    signalRecord: { selected: true, candidate, trade },
    accountState,
    symbolInfo,
    leverageBrackets,
    margin,
    leverage,
    maxNotionalOverageRate,
    activeLimitMaxBps,
    pullbackEntryTtlMs,
    executionPermissionVerified,
    portfolioStateVerified,
    sourceType: "OPERATOR_CANARY",
    now,
  });
}
