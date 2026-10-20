import { createHash } from "node:crypto";
import { executionFillFacts, executionExcursionFacts, ownedExitFills, observeOwnedExitFills } from "./execution-fill-facts.js";
import { acquireExecutionProcessLock } from "./entry-fact-process-lock.js";
import { EventEmitter } from "node:events";
import { BinanceApiError, TestnetWriteDisabledError } from "./binance-testnet-trading.js";
import { buildCanaryRun, buildOperatorCanaryRun, verifyConfirmation } from "./canary-plan.js";
import { formatToStep, splitFilledQuantity } from "./contract-rules.js";
import { assertExecutionSymbol } from "./execution-symbols.js";
import {
  MARKETABLE_LIMIT_IOC,
  PASSIVE_LIMIT_GTC,
  buildEntryOrderRequest,
  entryOrderExpiresAt,
  pendingEntryInvalidation,
  resolveEntryPolicy,
} from "./entry-order-policy.js";
import { assertAccountReadyForNewEntry, classifyExecutionAccountState } from "./execution-account-ownership.js";
import {
  buildMarketEventId,
  buildOrderReasons,
  normalizeOperatorCloseReason,
  reasonForExitRole,
  STRATEGY_VERSION,
} from "../domain/trade-reason.js";
import {
  createPermissionAttestation,
  ORDER_PERMISSION_METADATA_KEY,
  permissionAttestationStatus,
  probeTestnetOrderPermission,
} from "./order-permission.js";
import {
  V1_EXECUTION_SOURCE,
  assertExecutionStrategySource,
} from "./execution-strategy-source.js";
import {
  createTradeExcursionState,
  finalizeTradeExcursion,
  markTradeExcursionMilestone,
  observeTradeExcursion,
} from "../domain/trade-excursion.js";

const STORE_RUN_LOCKS = new WeakMap();

const TERMINAL_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);
const ENTRY_STATUSES = new Set(["ENTRY_SUBMITTING", "SUBMISSION_UNKNOWN", "ENTRY_PENDING", "PARTIALLY_FILLED", "ENTRY_FACT_PENDING", "ENTRY_FACT_CONFLICT"]);
const PROTECTED_STATUSES = new Set([
  "PROTECTION_PENDING", "PROTECTION_INCOMPLETE", "OPEN_PROTECTED", "TP1_FILLED", "ERROR_UNPROTECTED",
  "OPERATOR_CLOSE_SUBMITTING", "OPERATOR_CLOSE_PENDING", "OPERATOR_CLOSE_UNKNOWN", "PROTECTION_CLEANUP_PENDING",
  "ACCOUNTING_PENDING",
]);
const ACTIVE_ALGO_STATUSES = new Set(["NEW", "PENDING", "TRIGGERING"]);
const BREAK_EVEN_RETRY_BASE_MS = 30_000;
const BREAK_EVEN_RETRY_MAX_MS = 5 * 60_000;
const SUBMISSION_UNKNOWN_TIMEOUT_MS = 2 * 60_000;
const EXIT_SETTLEMENT_GRACE_MS = 30_000;
const TP_REPLACEMENT_LIMIT = 3;
const TP_RETRY_BASE_MS = 30_000;
const TP_FAILED_STATUSES = new Set(["REJECTED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH"]);
const UNDERSIZED_FILL_EXCEPTION = "ENTRY_FILL_BELOW_MINIMUM";
const UNPROTECTED_POSITION_EXCEPTION = "UNPROTECTED_POSITION_AUTO_CLOSE";
const UNSUPPORTED_LEVERAGE_EXCEPTION = "UNSUPPORTED_LEVERAGE";
const PRE_ENTRY_FAILURE_EXCEPTION = "PRE_ENTRY_CONFIGURATION_FAILED";
const UNPROTECTED_AUTO_CLOSE_REASON = "交易所未能建立有效止损保护，系统为避免无保护持仓扩大损失，立即使用仅减仓市价单平仓。";

const finiteValue = value => value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const validOrderId = value => /^[1-9][0-9]*$/.test(String(value ?? ""));
const quantitiesEqual = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, "$1?[REDACTED]")
    .replace(/((?:signature|apiKey|apiSecret|X-MBX-APIKEY)\s*[=:]\s*)[^\s&,]+/gi, "$1[REDACTED]");
}

function hashPlan(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function isTerminalOrder(status) {
  return new Set(["FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"]).has(status);
}

function isActiveAlgo(order) {
  return order && ACTIVE_ALGO_STATUSES.has(order.status);
}

function fullyFilledClosingProtection(protection, position) {
  const positionQuantity = Math.abs(Number(position?.quantity ?? position?.positionAmt ?? 0));
  if (!Number.isFinite(positionQuantity) || positionQuantity <= 0) return null;
  for (const role of ["breakEvenStop", "stop", "takeProfit2"]) {
    const order = protection?.[role];
    const filledQuantity = Math.abs(Number(order?.actualQuantity ?? 0));
    if (!Number.isFinite(filledQuantity) || filledQuantity <= 0 || filledQuantity < positionQuantity) continue;
    return {
      role,
      filledQuantity,
      orderUpdateTime: Number.isFinite(Number(order?.updateTime)) ? Number(order.updateTime) : null,
    };
  }
  return null;
}

function ensureOperatorCloseClientId(run) {
  const existing = run?.plan?.clientIds?.operatorClose;
  if (existing) return existing;
  const token = String(run?.id ?? "").replace(/^canary-/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
  if (!token) throw new Error("执行记录无法生成主动平仓订单身份");
  const clientOrderId = `cfs-${token}-close`;
  run.plan.clientIds.operatorClose = clientOrderId;
  run.planHash = hashPlan(run.plan);
  return clientOrderId;
}

function orderReason(run, role) {
  const reason = run?.plan?.orderReasons?.[role];
  if (typeof reason !== "string" || reason.trim().length < 12) throw new Error(`${role} 订单缺少可审计的一句话交易原因`);
  return reason;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function updateExecutionMetrics(run, minimumFillRatio) {
  const plannedQuantity = positiveNumber(run.plan?.quantity);
  const filledQuantity = positiveNumber(run.entryOrder?.executedQuantity);
  if (plannedQuantity === null || filledQuantity === null) return null;
  const facts = executionFillFacts(run);
  const entryPrice = facts.entryPrice;
  const leverage = positiveNumber(run.plan?.leverage);
  const fillRatio = filledQuantity / plannedQuantity;
  const actualNotional = entryPrice === null ? null : entryPrice * filledQuantity;
  const actualRiskAmount = facts.riskAmount;
  const plannedEntryPrice = positiveNumber(run.plan?.prices?.entry);
  const submittedLimitPrice = positiveNumber(run.entryExecution?.submittedLimitPrice, run.entryOrder?.price);
  const directionSign = run.plan?.direction === "SHORT" ? -1 : 1;
  const slippageBps = entryPrice !== null && plannedEntryPrice !== null
    ? directionSign * ((entryPrice - plannedEntryPrice) / plannedEntryPrice) * 10_000
    : null;
  const submittedAt = Number(run.entryExecution?.submittedAt);
  const filledAt = Number(run.entryOrder?.updateTime);
  run.executionMetrics = {
    plannedQuantity,
    filledQuantity,
    fillRatio,
    entryPrice,
    actualNotional,
    actualMarginEstimate: actualNotional !== null && leverage !== null ? actualNotional / leverage : null,
    actualRiskAmount,
    entryFactStatus: facts.status,
    entryFactSource: facts.source,
    entryFactReason: facts.reason,
    plannedEntryPrice,
    submittedLimitPrice,
    slippageBps,
    submittedAt: Number.isFinite(submittedAt) ? submittedAt : null,
    filledAt: Number.isFinite(filledAt) ? filledAt : null,
    timeToFillMs: Number.isFinite(submittedAt) && Number.isFinite(filledAt) && filledAt >= submittedAt
      ? filledAt - submittedAt
      : null,
    minimumFillRatio,
    fillAccepted: fillRatio >= minimumFillRatio,
  };
  return run.executionMetrics;
}

function excludeUndersizedStrategyFill(run, metrics) {
  if (run.sourceType !== "SIGNAL" || !metrics || metrics.fillAccepted || run.executionException === UNDERSIZED_FILL_EXCEPTION) return false;
  run.performanceEligible = false;
  run.executionException = UNDERSIZED_FILL_EXCEPTION;
  return true;
}

function entryTime(run) {
  const value = Number(run.entryOrder?.updateTime ?? run.entryExecution?.completedAt ?? run.updatedAt ?? run.createdAt);
  return Number.isFinite(value) ? value : null;
}

function ensureRunExcursion(run) {
  const facts = executionFillFacts(run);
  const entryPrice = facts.entryPrice;
  const stopLoss = Number(run.plan?.prices?.stopLoss);
  const openedAt = entryTime(run);
  if (![entryPrice, stopLoss, openedAt].every(Number.isFinite) || entryPrice <= 0 || stopLoss <= 0 || !(facts.riskAmount > 0)) return null;
  if (run.performance?.factBasis === "ACTUAL_ENTRY_V1" && run.performance.entryPrice === entryPrice) return run.performance;
  const legacy = run.performance ?? {};
  const state = createTradeExcursionState({ direction: run.plan.direction, entryPrice, stopLoss, openedAt });
  const recovered = executionExcursionFacts(run, facts);
  if (recovered.mfeR !== null) {
    Object.assign(state, { mfeR: recovered.mfeR, maeR: recovered.maeR,
      mfePrice: recovered.mfePrice, maePrice: recovered.maePrice,
      lastObservedAt: Math.max(openedAt, Number(legacy.lastObservedAt) || openedAt) });
  }
  run.performance = {
    ...state,
    factBasis: "ACTUAL_ENTRY_V1",
    observationSource: "MARK_PRICE_POLL_AND_EXIT_FILLS",
    observationCoverage: "POLL_SAMPLED_PARTIAL",
    samples: recovered.mfeR !== null ? Number(legacy.samples) : 0,
    observedPriceLow: recovered.mfeR !== null ? legacy.observedPriceLow : null,
    observedPriceHigh: recovered.mfeR !== null ? legacy.observedPriceHigh : null,
    mfePnl: recovered.mfePnl,
    maePnl: recovered.maePnl,
  };
  return run.performance;
}

function updateExcursions(run, position, observedAt) {
  const markPrice = Number(position?.markPrice);
  const performance = ensureRunExcursion(run);
  if (!performance || !Number.isFinite(markPrice) || markPrice <= 0) return;
  const updated = observeTradeExcursion(performance, { low: markPrice, high: markPrice, observedAt });
  updated.observedPriceLow = Math.min(positiveNumber(performance.observedPriceLow) ?? markPrice, markPrice);
  updated.observedPriceHigh = Math.max(positiveNumber(performance.observedPriceHigh) ?? markPrice, markPrice);
  const facts = executionFillFacts(run);
  const entryPrice = facts.entryPrice;
  const quantity = facts.quantity;
  const riskAmount = facts.riskAmount;
  if (![entryPrice, quantity].every(Number.isFinite) || entryPrice <= 0 || quantity <= 0) return;
  const directionSign = run.plan.direction === "LONG" ? 1 : -1;
  updated.mfePnl = Math.max(0, directionSign * (updated.mfePrice - entryPrice) * quantity);
  updated.maePnl = Math.min(0, directionSign * (updated.maePrice - entryPrice) * quantity);
  if (Number.isFinite(riskAmount) && riskAmount > 0) {
    updated.mfeR = updated.mfePnl / riskAmount;
    updated.maeR = Math.abs(updated.maePnl / riskAmount);
  }
  updated.samples = Number(performance.samples ?? 0) + 1;
  run.performance = updated;
}

function markRunMilestone(run, type, at, price = null) {
  let performance = ensureRunExcursion(run);
  if (!performance) return;
  if (Number.isFinite(Number(price)) && Number(price) > 0) {
    performance = observeTradeExcursion(performance, { low: Number(price), high: Number(price), observedAt: Math.max(Number(at), performance.lastObservedAt) });
    performance.samples = Number(performance.samples ?? 0) + 1;
    performance.observedPriceLow = Math.min(positiveNumber(performance.observedPriceLow) ?? Number(price), Number(price));
    performance.observedPriceHigh = Math.max(positiveNumber(performance.observedPriceHigh) ?? Number(price), Number(price));
  }
  run.performance = markTradeExcursionMilestone(performance, type, Math.max(Number(at), performance.openedAt));
}

function matchingTradeTime(result, order) {
  const ids = new Set([order?.actualOrderId, order?.orderId].filter(Boolean).map(String));
  const times = (result?.trades ?? [])
    .filter((trade) => ids.has(String(trade.orderId)))
    .map((trade) => Number(trade.time))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : Number(order?.updateTime) || null;
}

function finalizeRunExcursions(target, result, observedAt) {
  const run = { ...target, result };
  const facts = executionFillFacts(run);
  target.executionMetrics = { ...target.executionMetrics, entryPrice: facts.entryPrice,
    actualRiskAmount: facts.riskAmount, actualNotional: facts.notional,
    actualMarginEstimate: facts.notional !== null && positiveNumber(run.plan?.leverage) !== null ? facts.notional / Number(run.plan.leverage) : null,
    entryFactStatus: facts.status, entryFactSource: facts.source, entryFactReason: facts.reason };
  let performance = ensureRunExcursion(run);
  if (!performance) return;
  const exits = ownedExitFills(run, result).filter(t => Number.isFinite(Number(t.time)) && t.time !== null && t.time !== undefined);
  performance = observeOwnedExitFills(performance, run, result);
  const tp1Ids = new Set([run.protection?.takeProfit1?.actualOrderId, run.protection?.takeProfit1?.orderId].filter(Boolean).map(String));
  const tp1At = exits.find(t => tp1Ids.has(String(t.orderId)))?.time ?? null;
  if (tp1At !== null && performance.timeToTp1Ms === null) {
    const includesLaterSamples = performance.lastObservedAt > Number(tp1At);
    performance = markTradeExcursionMilestone(performance, "TP1", Math.max(Number(tp1At), performance.openedAt));
    if (includesLaterSamples) performance.maeBeforeTp1R = null;
  }
  const role = result?.exitRole;
  const roleOrder = role === "operatorClose" ? run.operatorCloseOrder : run.protection?.[role];
  const roleIds = new Set([roleOrder?.actualOrderId, roleOrder?.orderId].filter(Boolean).map(String));
  const roleTimes = exits.filter(t => roleIds.has(String(t.orderId))).map(t => Number(t.time));
  const exitAt = roleTimes.length ? Math.max(...roleTimes) : matchingTradeTime(result, roleOrder) ?? Number(observedAt);
  if (role === "takeProfit2" && performance.timeToTp2Ms === null) {
    performance = markTradeExcursionMilestone(performance, "TP2", Math.max(exitAt, performance.openedAt));
  }
  const stopExit = role === "stop" || role === "breakEvenStop";
  if (stopExit && performance.timeToStopMs === null) {
    performance = markTradeExcursionMilestone(performance, "STOP", Math.max(exitAt, performance.openedAt));
  }
  run.performance = finalizeTradeExcursion(performance, {
    closedAt: Math.max(exitAt, performance.openedAt),
    exitReason: role === "breakEvenStop" ? "BREAKEVEN_AFTER_TP1" : role === "stop" ? "STOP_LOSS" : role,
  });
  const excursion = executionExcursionFacts(run, facts);
  run.performance.mfePnl = excursion.mfePnl;
  run.performance.maePnl = excursion.maePnl;
  target.performance = run.performance;
}

export class TestnetCanaryExecutor extends EventEmitter {
  constructor({
    client,
    store,
    enabled = false,
    symbol = "BTCUSDT",
    allowedSymbols = [symbol],
    margin = 10,
    leverage = 10,
    maxNotionalOverageRate = 0.05,
    pollMs = 2_000,
    now = Date.now,
    logger = console,
    notifier = null,
    strategySource = V1_EXECUTION_SOURCE,
    activeLimitMaxBps = 10,
    pullbackEntryTtlMs = 180_000,
  } = {}) {
    super();
    if (!client) throw new Error("缺少 Binance 测试网交易客户端");
    if (!store) throw new Error("缺少执行审计存储");
    assertExecutionSymbol(symbol, "人工金丝雀标的");
    if (!Array.isArray(allowedSymbols) || allowedSymbols.length === 0) throw new Error("执行器至少需要一个标的白名单");
    this.client = client;
    this.store = store;
    this.enabled = Boolean(enabled);
    this.operatorSymbol = symbol;
    this.allowedSymbols = new Set(allowedSymbols.map((item) => assertExecutionSymbol(item, "执行白名单标的")));
    this.allowedSymbols.add(symbol);
    this.margin = margin;
    this.leverage = leverage;
    this.maxNotionalOverageRate = maxNotionalOverageRate;
    this.minimumFillRatio = Math.max(0, 1 - maxNotionalOverageRate);
    this.pollMs = pollMs;
    this.now = now;
    this.logger = logger;
    this.notifier = notifier;
    this.strategySource = assertExecutionStrategySource(strategySource);
    this.activeLimitMaxBps = Number(activeLimitMaxBps);
    if (!Number.isFinite(this.activeLimitMaxBps) || this.activeLimitMaxBps < 1 || this.activeLimitMaxBps > 100) {
      throw new TypeError("activeLimitMaxBps 必须是 1 到 100 之间的数字");
    }
    this.pullbackEntryTtlMs = Number(pullbackEntryTtlMs);
    if (!Number.isFinite(this.pullbackEntryTtlMs) || this.pullbackEntryTtlMs < 30_000 || this.pullbackEntryTtlMs > 15 * 60_000) {
      throw new TypeError("pullbackEntryTtlMs 必须是 30 秒到 15 分钟之间的毫秒数");
    }
    this.timer = null;
    let locks = STORE_RUN_LOCKS.get(store);
    if (!locks) { locks = { reconciling: new Set(), executing: new Set() }; STORE_RUN_LOCKS.set(store, locks); }
    this.reconciling = locks.reconciling;
    this.executing = locks.executing;
    this.lastReconcileAt = null;
    this.lastReconcileError = null;
  }

  assertAllowedSymbol(symbol) {
    assertExecutionSymbol(symbol);
    if (!this.allowedSymbols.has(symbol)) throw new Error(`执行器拒绝非白名单标的: ${symbol}`);
    return symbol;
  }

  allowSymbols(symbols = []) {
    if (!Array.isArray(symbols)) throw new TypeError("动态执行白名单必须是数组");
    const validated = symbols.map((symbol) => assertExecutionSymbol(symbol, "动态执行白名单标的"));
    for (const symbol of validated) this.allowedSymbols.add(symbol);
    this.client.allowSymbols?.(validated);
    return [...this.allowedSymbols];
  }

  async isEmergencyStopped() {
    return Boolean((await this.store.getMetadata("testnet_execution_emergency_stop"))?.value?.active);
  }

  async recordPermissionAttestation(attestation) {
    await this.store.setMetadata(ORDER_PERMISSION_METADATA_KEY, attestation);
    return attestation;
  }

  async verifyTradingPermission(account, { symbol, symbolInfo = null, plan = null } = {}) {
    this.assertAllowedSymbol(symbol);
    if (account.canTrade) return { allowed: true, source: "ACCOUNT_CAN_TRADE" };
    let attestation;
    if (plan) {
      await this.client.testLimitOrderPermission({
        symbol,
        side: plan.entrySide,
        quantity: plan.quantity,
       price: plan.prices.entry,
        timeInForce: resolveEntryPolicy(plan).timeInForce,
        clientOrderId: `cfs-perm-${this.now().toString(36)}`,
      });
      attestation = createPermissionAttestation({
        credentialHash: this.client.credentialFingerprint,
        symbol,
        verifiedAt: this.now(),
      });
    } else {
      attestation = await probeTestnetOrderPermission({
        client: this.client,
        symbol,
        symbolInfo,
        targetNotional: this.margin * this.leverage,
        now: this.now(),
      });
    }
    await this.recordPermissionAttestation(attestation);
    return { allowed: true, source: "ORDER_TEST_PROBE", attestation };
  }

  async permissionStatus(symbol = null) {
    const attestation = (await this.store.getMetadata(ORDER_PERMISSION_METADATA_KEY))?.value ?? null;
    const resolvedSymbol = symbol ?? attestation?.symbol ?? this.operatorSymbol;
    return permissionAttestationStatus(attestation, {
      credentialHash: this.client.credentialFingerprint,
      symbol: resolvedSymbol,
      now: this.now(),
    });
  }

  async prepare(signalId, { strategySource = this.strategySource } = {}) {
    const resolvedStrategySource = assertExecutionStrategySource(strategySource);
    if (resolvedStrategySource !== this.strategySource) throw new Error("执行请求的策略源与执行器配置不一致");
    if (await this.isEmergencyStopped()) throw new Error("执行紧急停止已启用，禁止准备新订单");
    let existing = await this.store.getExecutionRunBySignal(signalId);
    if (existing) {
      if (existing.status === "PREPARED" && existing.plan?.expiresAt <= this.now()) {
        existing = await this.reconcile(existing.id);
      }
      return { run: existing, confirmationCode: null, reused: true };
    }
    for (const activeRun of await this.store.listActiveExecutionRuns()) {
      if (activeRun.status === "PREPARED" && activeRun.plan?.expiresAt <= this.now()) {
        await this.reconcile(activeRun.id);
      }
    }
    const signalRecord = structuredClone(typeof this.store.getExecutionSignal === "function"
      ? await this.store.getExecutionSignal(signalId, resolvedStrategySource)
      : await this.store.getSignal(signalId));
    const symbol = this.assertAllowedSymbol(signalRecord?.candidate?.symbol);
    const activeRuns = await this.store.listActiveExecutionRuns();
    const [accountState, symbolInfo, leverageBrackets] = await Promise.all([
      this.client.fetchAccountState(symbol),
      this.client.fetchExchangeInfo(symbol),
      this.client.fetchLeverageBrackets(symbol),
    ]);
    assertAccountReadyForNewEntry(accountState, activeRuns, { candidateSymbol: symbol });
    const permission = await this.verifyTradingPermission(accountState, { symbol, symbolInfo });
    const prepared = buildCanaryRun({
      signalRecord,
      accountState,
      symbolInfo,
      leverageBrackets,
      margin: this.margin,
      leverage: this.leverage,
      maxNotionalOverageRate: this.maxNotionalOverageRate,
      activeLimitMaxBps: this.activeLimitMaxBps,
      pullbackEntryTtlMs: this.pullbackEntryTtlMs,
      executionPermissionVerified: permission.allowed,
      portfolioStateVerified: true,
      executionSource: resolvedStrategySource,
      now: this.now(),
    });
    const result = await this.store.createExecutionRun(prepared.run);
    if (!result.created) return { run: result.run, confirmationCode: null, reused: true };
    await this.store.appendExecutionAudit(prepared.run.id, "CANARY_PREPARED", {
      signalId,
      planHash: prepared.run.planHash,
      symbol: prepared.run.symbol,
      orderSubmissionEnabled: this.enabled,
      permissionSource: permission.source,
      strategySource: resolvedStrategySource,
    }, this.now());
    this.emit("execution", structuredClone(prepared.run));
    return { ...prepared, reused: false, sourceDecisionRecord: structuredClone(signalRecord) };
  }

  async prepareOperatorCanary(direction = "LONG") {
    if (await this.isEmergencyStopped()) throw new Error("执行紧急停止已启用，禁止准备人工金丝雀");
    for (const activeRun of await this.store.listActiveExecutionRuns()) {
      if (activeRun.status === "PREPARED" && activeRun.plan?.expiresAt <= this.now()) await this.reconcile(activeRun.id);
    }
    const activeRuns = await this.store.listActiveExecutionRuns();
    const [accountState, symbolInfo, leverageBrackets, markPrice] = await Promise.all([
      this.client.fetchAccountState(this.operatorSymbol),
      this.client.fetchExchangeInfo(this.operatorSymbol),
      this.client.fetchLeverageBrackets(this.operatorSymbol),
      this.client.fetchMarkPrice(this.operatorSymbol),
    ]);
    assertAccountReadyForNewEntry(accountState, activeRuns, { candidateSymbol: this.operatorSymbol });
    const permission = await this.verifyTradingPermission(accountState, { symbol: this.operatorSymbol, symbolInfo });
    const prepared = buildOperatorCanaryRun({
      accountState,
      symbolInfo,
      leverageBrackets,
      markPrice,
      direction,
      symbol: this.operatorSymbol,
      strategySource: this.strategySource,
      margin: this.margin,
      leverage: this.leverage,
      maxNotionalOverageRate: this.maxNotionalOverageRate,
      activeLimitMaxBps: this.activeLimitMaxBps,
      pullbackEntryTtlMs: this.pullbackEntryTtlMs,
      executionPermissionVerified: permission.allowed,
      portfolioStateVerified: true,
      now: this.now(),
    });
    await this.store.createOperatorCanarySource({
      id: prepared.run.signalId,
      direction: prepared.run.plan.direction,
      createdAt: prepared.run.createdAt,
    });
    const result = await this.store.createExecutionRun(prepared.run);
    if (!result.created) throw new Error("人工金丝雀执行记录发生意外重复");
    await this.store.appendExecutionAudit(prepared.run.id, "OPERATOR_CANARY_PREPARED", {
      planHash: prepared.run.planHash,
      symbol: prepared.run.symbol,
      direction: prepared.run.plan.direction,
      performanceEligible: false,
      orderSubmissionEnabled: this.enabled,
      permissionSource: permission.source,
    }, this.now());
    this.emit("execution", structuredClone(prepared.run));
    return { ...prepared, reused: false };
  }

  async assertFreshExecutionPreconditions(run) {
    const symbol = this.assertAllowedSymbol(run.symbol);
    if (hashPlan(run.plan) !== run.planHash) throw new Error("执行计划哈希不一致，拒绝提交");
    if (run.plan.expiresAt <= this.now()) throw new Error("执行计划已经过期");
    if (await this.isEmergencyStopped()) throw new Error("执行紧急停止已启用");
    const activeRuns = await this.store.listActiveExecutionRuns();
    const account = await this.client.fetchAccountState(symbol);
    assertAccountReadyForNewEntry(account, activeRuns, { candidateSymbol: symbol, candidateRunId: run.id });
    await this.verifyTradingPermission(account, { symbol, plan: run.plan });
    if (!Number.isFinite(account.availableBalance) || account.availableBalance < run.plan.marginEstimate) throw new Error("测试网可用余额不足");
    return account;
  }

  async ensureRunOrderReasons(run) {
    if (run?.plan?.orderReasons?.entry) return run;
    const strategySource = run.executionSource ?? run.plan?.executionSource ?? this.strategySource;
    const signalRecord = typeof this.store.getExecutionSignal === "function"
      ? await this.store.getExecutionSignal(run.signalId, strategySource)
      : await this.store.getSignal(run.signalId);
    const candidate = signalRecord?.candidate;
    if (!candidate) throw new Error(`执行记录 ${run.id} 找不到交易原因对应的策略信号`);
    run.plan.strategy = run.plan.strategy ?? candidate.strategy;
    run.plan.strategyVersion = run.plan.strategyVersion ?? candidate.strategyVersion ?? STRATEGY_VERSION;
    run.plan.score = run.plan.score ?? (Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : null);
    run.plan.marketEventId = run.plan.marketEventId ?? candidate.marketEventId ?? buildMarketEventId(candidate.triggerTime ?? run.createdAt);
    run.plan.orderReasons = buildOrderReasons({ candidate, prices: run.plan.prices });
    run.planHash = hashPlan(run.plan);
    await this.store.saveExecutionRun(run);
    await this.store.appendExecutionAudit(run.id, "ORDER_REASONS_BACKFILLED", {
      strategyVersion: run.plan.strategyVersion,
      marketEventId: run.plan.marketEventId,
      entryReason: run.plan.orderReasons.entry,
    }, this.now());
    return run;
  }

  async persist(run, eventType, payload = {}) {
    run.updatedAt = this.now();
    await this.store.saveExecutionRun(run);
    if (eventType) await this.store.appendExecutionAudit(run.id, eventType, payload, run.updatedAt);
    this.emit("execution", structuredClone(run));
    return run;
  }

  async rejectUnsupportedLeverage(run, { source = "BRACKET_PREFLIGHT", message = null } = {}) {
    const capability = run.plan?.leverageCapability ?? null;
    const requestedLeverage = Number(run.plan?.leverage);
    const maximumLeverage = Number(capability?.maximumLeverage);
    run.status = "REJECTED";
    run.performanceEligible = false;
    run.executionException = UNSUPPORTED_LEVERAGE_EXCEPTION;
    run.error = message ?? (
      Number.isFinite(maximumLeverage)
        ? `目标${requestedLeverage}倍杠杆超过${run.symbol}在计划名义价值下允许的${maximumLeverage}倍上限`
        : `${run.symbol}未返回覆盖计划名义价值的杠杆档位`
    );
    run.result = {
      reason: "LEVERAGE_UNSUPPORTED",
      filledQuantity: 0,
      requestedLeverage: Number.isFinite(requestedLeverage) ? requestedLeverage : null,
      maximumLeverage: Number.isFinite(maximumLeverage) ? maximumLeverage : null,
      source,
    };
    return await this.persist(run, "LEVERAGE_PRECHECK_REJECTED", {
      source,
      requestedLeverage: run.result.requestedLeverage,
      maximumLeverage: run.result.maximumLeverage,
      notional: capability?.notional ?? run.plan?.actualNotional ?? null,
      message: run.error,
    });
  }

  async configureAccount(run) {
    const symbol = this.assertAllowedSymbol(run.symbol);
    if (run.plan.accountChanges.marginType) {
      const outcome = await this.applyVerifiedAccountChange(run, {
        label: "逐仓模式配置",
        auditPrefix: "MARGIN_TYPE",
        apply: () => this.client.setMarginType(symbol, "ISOLATED"),
        matches: (snapshot) => snapshot?.symbolConfig?.marginType === "ISOLATED",
        acceptedError: (error) => error instanceof BinanceApiError && error.apiCode === -4046,
      });
      if (outcome.accepted) {
        await this.store.appendExecutionAudit(run.id, "MARGIN_TYPE_ALREADY_SET", { marginType: "ISOLATED" }, this.now());
      } else if (outcome.verifiedAfterUnknown) {
        await this.store.appendExecutionAudit(run.id, "MARGIN_TYPE_VERIFIED_AFTER_UNKNOWN", { marginType: "ISOLATED" }, this.now());
      } else {
        await this.store.appendExecutionAudit(run.id, "MARGIN_TYPE_SET", { marginType: "ISOLATED", retried: outcome.retried }, this.now());
      }
    }
    if (run.plan.accountChanges.leverage) {
      const targetLeverage = Number(run.plan.leverage);
      const outcome = await this.applyVerifiedAccountChange(run, {
        label: "杠杆配置",
        auditPrefix: "LEVERAGE",
        apply: () => this.client.setLeverage(symbol, targetLeverage),
        matches: (snapshot) => Number(snapshot?.symbolConfig?.leverage) === targetLeverage,
      });
      if (!outcome.verifiedAfterUnknown && Number(outcome.result?.leverage) !== targetLeverage) {
        throw new Error("杠杆配置失败: 交易所没有确认目标杠杆");
      }
      await this.store.appendExecutionAudit(
        run.id,
        outcome.verifiedAfterUnknown ? "LEVERAGE_VERIFIED_AFTER_UNKNOWN" : "LEVERAGE_SET",
        { leverage: targetLeverage, retried: outcome.retried },
        this.now(),
      );
    }
  }

  async applyVerifiedAccountChange(run, {
    label,
    auditPrefix,
    apply,
    matches,
    acceptedError = () => false,
  }) {
    const verify = async () => {
      const snapshot = await this.client.fetchAccountState(run.symbol);
      return matches(snapshot);
    };
    const execute = async ({ retried = false } = {}) => {
      try {
        return { result: await apply(), accepted: false, verifiedAfterUnknown: false, retried };
      } catch (error) {
        if (acceptedError(error)) return { result: null, accepted: true, verifiedAfterUnknown: false, retried };
        if (!(error instanceof BinanceApiError && error.apiCode === -1000)) {
          throw new Error(`${label}失败: ${errorMessage(error)}`, { cause: error });
        }
        await this.store.appendExecutionAudit(run.id, `${auditPrefix}_RESPONSE_UNKNOWN`, {
          message: errorMessage(error),
          retried,
        }, this.now());
        try {
          if (await verify()) {
            return { result: null, accepted: false, verifiedAfterUnknown: true, retried };
          }
        } catch (verificationError) {
          await this.store.appendExecutionAudit(run.id, `${auditPrefix}_VERIFICATION_FAILED`, {
            message: errorMessage(verificationError),
            retried,
          }, this.now());
        }
        if (!retried) return await execute({ retried: true });
        throw new Error(`${label}失败: ${errorMessage(error)}`, { cause: error });
      }
    };
    return await execute();
  }

  acquireProcessLock() {
    if (!this.releaseProcessLock) this.releaseProcessLock = acquireExecutionProcessLock(this.store.filePath);
  }

  async execute(runId, confirmationCode) {
    if (!this.enabled) throw new TestnetWriteDisabledError("executeCanary");
    this.acquireProcessLock();
    if (this.executing.has(runId)) throw new Error(`执行记录 ${runId} 正在提交，拒绝并发执行`);
    this.executing.add(runId);
    let run = null;
    let reconcileAfterSubmission = false;
    try {
      run = await this.store.getExecutionRun(runId);
      if (!run) throw new Error(`找不到执行记录 ${runId}`);
      if (run.status !== "PREPARED") throw new Error(`执行记录状态 ${run.status} 不允许提交`);
      if (!verifyConfirmation(confirmationCode, run)) throw new Error("最终确认码无效");
      const symbol = this.assertAllowedSymbol(run.symbol);
      await this.assertFreshExecutionPreconditions(run);
      run.confirmationUsedAt = this.now();
      run.error = null;
      const leverageCapability = run.plan?.leverageCapability;
      if (leverageCapability?.checked === true && leverageCapability.supported !== true) {
        await this.store.appendExecutionAudit(run.id, "FINAL_CONFIRMATION_ACCEPTED", { planHash: run.planHash }, this.now());
        return await this.rejectUnsupportedLeverage(run);
      }
      run.status = "CONFIGURING";
      await this.persist(run, "FINAL_CONFIRMATION_ACCEPTED", { planHash: run.planHash });
      try {
        await this.configureAccount(run);
        const entryPolicy = resolveEntryPolicy(run.plan);
        const bookTicker = entryPolicy.mode === MARKETABLE_LIMIT_IOC
          ? await this.client.fetchBookTicker(symbol)
          : null;
        const entryRequest = buildEntryOrderRequest(run.plan, bookTicker);
        run.entryExecution = {
          mode: entryRequest.mode,
          timeInForce: entryRequest.timeInForce,
          plannedPrice: entryRequest.plannedPrice,
          submittedLimitPrice: entryRequest.price,
          referencePrice: entryRequest.referencePrice,
          bidPrice: entryRequest.bidPrice ?? null,
          askPrice: entryRequest.askPrice ?? null,
          spreadBps: entryRequest.spreadBps,
          observedAdverseBps: entryRequest.observedAdverseBps,
          maxAdverseSlippageBps: entryRequest.maxAdverseSlippageBps,
          expiresAt: entryOrderExpiresAt(run.plan),
          submittedAt: null,
          completedAt: null,
          cancellationReason: null,
        };
        if (!entryRequest.accepted) {
          run.status = "CANCELED";
          run.error = null;
          run.entryExecution.completedAt = this.now();
          run.entryExecution.cancellationReason = entryRequest.reason;
          run.result = {
            reason: entryRequest.reason,
            filledQuantity: 0,
            observedAdverseBps: entryRequest.observedAdverseBps,
            maxAdverseSlippageBps: entryRequest.maxAdverseSlippageBps,
          };
          return await this.persist(run, "ENTRY_SKIPPED_SLIPPAGE_BUDGET", {
            mode: entryRequest.mode,
            plannedPrice: entryRequest.plannedPrice,
            referencePrice: entryRequest.referencePrice,
            submittedLimitPrice: entryRequest.price,
            observedAdverseBps: entryRequest.observedAdverseBps,
            maxAdverseSlippageBps: entryRequest.maxAdverseSlippageBps,
            bidPrice: entryRequest.bidPrice,
            askPrice: entryRequest.askPrice,
            spreadBps: entryRequest.spreadBps,
          });
        }
        run.status = "ENTRY_SUBMITTING";
        run.entryExecution.submittedAt = this.now();
        run.entryFactVerification = {
          status: "SUBMISSION_INTENT", checks: 0, history: [], submittedAt: this.now(),
          accountFingerprint: this.client.credentialFingerprint
            ? createHash("sha256").update(String(this.client.credentialFingerprint)).digest("hex") : null,
          ack: null, ackReceivedAt: null,
        };
        await this.persist(run, "ENTRY_INTENT_PERSISTED", {
          clientOrderId: run.plan.clientIds.entry,
          side: run.plan.entrySide,
          quantity: run.plan.quantity,
          strategy: run.plan.strategy,
          executionMode: entryRequest.mode,
          timeInForce: entryRequest.timeInForce,
          plannedPrice: run.plan.prices.entry,
          price: entryRequest.price,
          referencePrice: entryRequest.referencePrice,
          bidPrice: entryRequest.bidPrice ?? null,
          askPrice: entryRequest.askPrice ?? null,
          spreadBps: entryRequest.spreadBps,
          observedAdverseBps: entryRequest.observedAdverseBps,
          maxAdverseSlippageBps: entryRequest.maxAdverseSlippageBps,
          expiresAt: run.entryExecution.expiresAt,
          reason: orderReason(run, "entry"),
        });
        let order = await this.client.queryOrder(symbol, run.plan.clientIds.entry);
        if (!order) {
          try {
            order = await this.client.placeLimitOrder({
              symbol,
              side: run.plan.entrySide,
              quantity: run.plan.quantity,
              price: entryRequest.price,
              timeInForce: entryRequest.timeInForce,
              clientOrderId: run.plan.clientIds.entry,
            });
          } catch (error) {
            order = await this.client.queryOrder(symbol, run.plan.clientIds.entry);
            if (!order) {
              run.status = "SUBMISSION_UNKNOWN";
              run.error = errorMessage(error);
              await this.persist(run, "ENTRY_SUBMISSION_UNKNOWN", { message: run.error });
              return run;
            }
          }
        }
        run.entryOrder = order;
        run.entryFactVerification = {
          ...run.entryFactVerification, status: "ACK_PENDING", checks: 0,
          accountFingerprint: this.client.credentialFingerprint
            ? createHash("sha256").update(String(this.client.credentialFingerprint)).digest("hex") : null,
          ack: this.entryOrderSummary(order), ackReceivedAt: this.now(), history: [],
        };
        run.status = "ENTRY_PENDING";
        await this.persist(run, "ENTRY_ORDER_CONFIRMED", {
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          status: order.status,
          executedQuantity: order.executedQuantity,
          executionMode: entryRequest.mode,
          timeInForce: order.timeInForce ?? entryRequest.timeInForce,
          submittedLimitPrice: entryRequest.price,
          averagePrice: order.averagePrice,
        });
        reconcileAfterSubmission = true;
      } catch (error) {
        if (error instanceof BinanceApiError && error.apiCode === -4028 && !run.entryExecution?.submittedAt) {
          return await this.rejectUnsupportedLeverage(run, { source: "EXCHANGE_REJECTION", message: errorMessage(error) });
        }
        run.status = run.entryOrder?.executedQuantity > 0 ? "ERROR_UNPROTECTED" : "FAILED";
        run.performanceEligible = run.status === "ERROR_UNPROTECTED" ? run.performanceEligible : false;
        run.executionException = run.status === "ERROR_UNPROTECTED" ? run.executionException : PRE_ENTRY_FAILURE_EXCEPTION;
        run.error = errorMessage(error);
        run.result = run.status === "FAILED" ? { reason: "PRE_ENTRY_CONFIGURATION_FAILED", filledQuantity: 0 } : run.result;
        await this.persist(run, "EXECUTION_FAILED", { message: run.error });
        if (run.status === "ERROR_UNPROTECTED") await this.engageEmergencyStop("PROTECTION_FAILURE", run.id);
        throw error;
      }
    } finally {
      this.executing.delete(runId);
    }
    return reconcileAfterSubmission ? await this.reconcile(run.id) : run;
  }

  async reconcile(runId, { account = null } = {}) {
    this.acquireProcessLock();
    if (this.executing.has(runId)) return await this.store.getExecutionRun(runId);
    if (this.reconciling.has(runId)) return await this.store.getExecutionRun(runId);
    this.reconciling.add(runId);
    try {
      const run = await this.store.getExecutionRun(runId);
      if (!run || TERMINAL_STATUSES.has(run.status)) return run;
      if (run.status === "ACCOUNTING_PENDING" && !run.entryFactVerification) {
        const snapshot = account ?? await this.client.fetchAccountState(run.symbol);
        if (!(snapshot.positions ?? []).some(item => item.symbol === run.symbol
          && Math.abs(Number(item.quantity ?? item.positionAmt)) > 0)) return run;
        account = snapshot;
      }
      await this.ensureRunOrderReasons(run);
      this.assertAllowedSymbol(run.symbol);
      if (run.status === "PREPARED") {
        if (run.plan?.expiresAt > this.now()) return run;
        run.status = "CANCELED";
        run.error = null;
        run.result = { reason: "CONFIRMATION_EXPIRED", filledQuantity: 0 };
        return await this.persist(run, "CANARY_CONFIRMATION_EXPIRED", { expiresAt: run.plan?.expiresAt ?? null });
      }
      if (run.status === "CONFIGURING") {
        run.status = "FAILED";
        run.performanceEligible = false;
        run.executionException = PRE_ENTRY_FAILURE_EXCEPTION;
        run.error = run.error ?? "执行进程在入场意图持久化前中断";
        run.result = { reason: "PRE_ENTRY_CONFIGURATION_INTERRUPTED", filledQuantity: 0 };
        return await this.persist(run, "PRE_ENTRY_CONFIGURATION_RECOVERED", {
          reason: run.result.reason,
        });
      }
      if (ENTRY_STATUSES.has(run.status) || (run.entryExecution?.remainderPending && !run.status.startsWith("OPERATOR_CLOSE"))) return await this.reconcileEntry(run, account);
      if (PROTECTED_STATUSES.has(run.status)) return await this.reconcileProtected(run, account);
      return run;
    } finally {
      this.reconciling.delete(runId);
    }
  }

  entryOrderSummary(order) {
    if (!order) return null;
    return Object.fromEntries(["symbol", "side", "orderId", "clientOrderId", "status", "executedQuantity", "updateTime"]
      .map(key => [key, order[key] ?? null]));
  }

  async verifyEntryFacts(run, account = null) {
    const state = run.entryFactVerification ?? { status: "LEGACY_UNVERIFIED", checks: 0, history: [],
      ack: this.entryOrderSummary(run.entryOrder), ackReceivedAt: run.entryExecution?.submittedAt ?? run.createdAt,
      accountFingerprint: this.client.credentialFingerprint
        ? createHash("sha256").update(String(this.client.credentialFingerprint)).digest("hex") : null };
    const checkedAt = this.now();
    let order = null, queryFailed = false;
    try { order = await this.client.queryOrder(run.symbol, run.plan.clientIds.entry); }
    catch { queryFailed = true; }
    const snapshot = account ?? await this.client.fetchAccountState(run.symbol);
    const position = (snapshot.positions ?? []).find(item => item.symbol === run.symbol
      && Math.abs(Number(item.quantity ?? item.positionAmt)) > 0);
    const activeRuns = typeof this.store.listActiveExecutionRuns === "function" ? await this.store.listActiveExecutionRuns() : [run];
    const fingerprint = this.client.credentialFingerprint
      ? createHash("sha256").update(String(this.client.credentialFingerprint)).digest("hex") : null;
    const identityConflict = Boolean(state.accountFingerprint && state.accountFingerprint !== fingerprint)
      || (snapshot.environment && snapshot.environment !== "TESTNET")
      || (snapshot.authority && snapshot.authority !== "BINANCE_TESTNET")
      || (snapshot.positionMode && snapshot.positionMode !== "ONE_WAY");
    const signedQuantity = Number(position?.quantity ?? position?.positionAmt);
    const maximumQuantity = positiveNumber(run.plan?.quantity);
    const positionConflict = position && ((signedQuantity > 0 ? "LONG" : "SHORT") !== run.plan.direction
      || position.positionSide !== "BOTH"
      || (maximumQuantity !== null && Math.abs(signedQuantity) > maximumQuantity + Number(run.plan.rules?.stepSize ?? 0) / 2)
      || activeRuns.some(other => other.id !== run.id && other.symbol === run.symbol && !TERMINAL_STATUSES.has(other.status)));
    if (identityConflict || positionConflict) {
      state.status = "IDENTITY_CONFLICT"; state.lastCheckedAt = checkedAt;
      state.history = [...(state.history ?? []), { checkedAt, status: state.status }].slice(-32);
      run.entryFactVerification = state;
      run.status = "ENTRY_FACT_CONFLICT"; run.performanceEligible = false; run.executionException = "ENTRY_FACT_CONFLICT";
      run.error = "账户身份或仓位归属与入场意图冲突";
      run.result = { ...(run.result ?? {}), accountingComplete: false, netPnl: null, netR: null };
      await this.persist(run, "ENTRY_FACT_CONFLICT", { checkedAt, reason: identityConflict ? "ACCOUNT_IDENTITY_CHANGED" : "POSITION_OWNERSHIP_CONFLICT" });
      return { pending: true, position: null, order: null };
    }
    const identityMatches = order && order.clientOrderId === run.plan.clientIds.entry
      && order.symbol === run.symbol && order.side === run.plan.entrySide
      && validOrderId(order.orderId)
      && (!validOrderId(state.ack?.orderId) || String(order.orderId) === String(state.ack.orderId));
    let fillsConfirmed = false;
    // Protection always precedes the potentially slow trade-history request.
    if (!position && !identityMatches && !queryFailed && validOrderId(run.entryOrder?.orderId)) {
      try {
        const accounting = await this.collectRunTrades(run);
        const entryFills = accounting.trades.filter(t => String(t.orderId) === String(run.entryOrder.orderId));
        fillsConfirmed = accounting.tradesComplete && entryFills.length > 0
          && entryFills.every(t => validOrderId(t.id) && t.symbol === run.symbol && t.side === run.plan.entrySide
            && finiteValue(t.quantity) > 0 && finiteValue(t.price) > 0 && finiteValue(t.time) !== null
            && Number(t.time) >= Number(run.entryExecution?.submittedAt ?? run.createdAt))
          && quantitiesEqual(entryFills.reduce((sum, t) => sum + Number(t.quantity), 0), Number(run.entryOrder.executedQuantity));
      } catch { queryFailed = true; }
    }
    state.checks = Number(state.checks ?? 0) + 1;
    state.firstCheckedAt ??= checkedAt;
    state.lastCheckedAt = checkedAt;
    state.status = identityMatches ? "ORDER_VERIFIED" : position ? "POSITION_PRESENT_FILLS_PENDING"
      : fillsConfirmed ? "FILLS_VERIFIED" : queryFailed ? "QUERY_UNAVAILABLE" : "ABSENCE_PENDING";
    if (identityMatches || position || fillsConfirmed || queryFailed) state.missingSince = null;
    else state.missingSince ??= checkedAt;
    state.history = [...(state.history ?? []), { checkedAt, status: state.status,
      order: this.entryOrderSummary(order), positionPresent: Boolean(position), fillsConfirmed }].slice(-32);
    run.entryFactVerification = state;
    if (!identityMatches && !position && !fillsConfirmed) {
      const conflict = state.missingSince !== null && checkedAt - state.missingSince >= SUBMISSION_UNKNOWN_TIMEOUT_MS && state.checks >= 2;
      run.status = conflict ? "ENTRY_FACT_CONFLICT" : state.ack ? "ENTRY_FACT_PENDING" : "SUBMISSION_UNKNOWN";
      if (conflict) { run.performanceEligible = false; run.executionException = "ENTRY_FACT_CONFLICT"; }
      run.error = conflict ? "入场ACK与交易所订单、成交及仓位事实持续冲突" : "等待交易所入场事实核验";
      run.result = { ...(run.result ?? {}), accountingComplete: false, netPnl: null, netR: null };
      await this.persist(run, run.status, { checkedAt, queryFailed, checks: state.checks, missingSince: state.missingSince });
      return { pending: true, position: null, order: null };
    }
    if (identityMatches) run.entryOrder = order;
    await this.persist(run, "ENTRY_FACT_CHECKED", { checkedAt, status: state.status, positionPresent: Boolean(position) });
    return { pending: false, position, order: identityMatches ? order : null, snapshot };
  }

  async observeEntryFillVerification(run) {
    if (!run.entryFactVerification) return run;
    const checkedAt = this.now();
    let status = "QUERY_UNAVAILABLE", quantity = null, count = null;
    try {
      const accounting = await this.collectRunTrades(run);
      const rows = accounting.trades.filter(t => String(t.orderId) === String(run.entryOrder?.orderId));
      count = rows.length;
      const valid = rows.every(t => validOrderId(t.id) && t.symbol === run.symbol && t.side === run.plan.entrySide
        && finiteValue(t.quantity) > 0 && finiteValue(t.price) > 0 && finiteValue(t.time) !== null
        && Number(t.time) >= Number(run.entryExecution?.submittedAt ?? run.createdAt));
      quantity = valid ? rows.reduce((sum, t) => sum + Number(t.quantity), 0) : null;
      status = !valid ? "CONFLICT" : !count ? "DELAYED"
        : accounting.tradesComplete && quantitiesEqual(quantity, Number(run.entryOrder?.executedQuantity)) ? "VERIFIED" : "INCOMPLETE";
    } catch {}
    run.entryFactVerification.fills = { status, quantity, count, checkedAt };
    return await this.persist(run, "ENTRY_FILLS_CHECKED", { status, quantity, count, checkedAt });
  }

  async reconcileEntry(run, account = null) {
    const symbol = this.assertAllowedSymbol(run.symbol);
    const clientOrderId = run.plan.clientIds.entry;
    if (run.status === "SUBMISSION_UNKNOWN" && !(Number(run.entryExecution?.submittedAt) > 0) && !run.entryOrder) {
      run.status = "FAILED"; run.performanceEligible = false; run.executionException = PRE_ENTRY_FAILURE_EXCEPTION;
      run.error = "入场订单提交前配置失败";
      run.result = { reason: "PRE_ENTRY_CONFIGURATION_FAILED", filledQuantity: 0 };
      return await this.persist(run, "PRE_ENTRY_CONFIGURATION_RECOVERED", { clientOrderId, reason: run.result.reason });
    }
    const facts = await this.verifyEntryFacts(run, account);
    if (facts.pending) return run;
    let order = facts.order;
    if (facts.position) {
      run.entryExecution = { ...(run.entryExecution ?? {}), remainderPending: !order || !isTerminalOrder(order.status) };
      run.status = "PROTECTION_PENDING";
      const protectedRun = await this.ensureProtection(run, Math.abs(Number(facts.position.quantity ?? facts.position.positionAmt)),
        { stopOnly: !order || !isTerminalOrder(order.status) });
      if (!order || protectedRun.status === "ERROR_UNPROTECTED"
        || protectedRun.status.startsWith("OPERATOR_CLOSE")) {
        await this.observeEntryFillVerification(protectedRun);
        return protectedRun;
      }
    }
    if (!order) { run.status = "PROTECTION_PENDING"; return await this.reconcileProtected(run, facts.snapshot); }
    const emergencyStopped = await this.isEmergencyStopped();
    const expiresAt = entryOrderExpiresAt(run.plan);
    let invalidation = null;
    if (order.status === "NEW" && resolveEntryPolicy(run.plan).mode === PASSIVE_LIMIT_GTC) {
      const markPrice = await this.client.fetchMarkPrice(symbol);
      invalidation = pendingEntryInvalidation(run.plan, markPrice);
    }
    const cancelReason = emergencyStopped
      ? "EMERGENCY_STOP"
      : order.status === "PARTIALLY_FILLED"
        ? "PARTIAL_FILL"
        : invalidation?.reason ?? "ENTRY_EXPIRED";
    const shouldCancelNew = order.status === "NEW"
      && (this.now() >= expiresAt || emergencyStopped || Boolean(invalidation));
    if (shouldCancelNew || order.status === "PARTIALLY_FILLED") {
      try {
        order = await this.client.cancelOrder(symbol, clientOrderId);
      } catch (error) {
        const queried = await this.client.queryOrder(symbol, clientOrderId);
        if (!queried) throw error;
        order = queried;
      }
      await this.store.appendExecutionAudit(run.id, "ENTRY_REMAINDER_CANCELED", {
        status: order.status,
        executedQuantity: order.executedQuantity,
        reason: cancelReason,
        executionMode: resolveEntryPolicy(run.plan).mode,
        expiresAt,
        markPrice: invalidation?.markPrice ?? null,
        stopLoss: invalidation?.stopLoss ?? null,
      }, this.now());
    }
    run.entryOrder = order;
    run.entryExecution = { ...(run.entryExecution ?? {}), remainderPending: !isTerminalOrder(order.status) };
    const filledQuantity = Number(order.executedQuantity ?? 0);
    if (!(filledQuantity > 0) && facts.position) {
      run.entryExecution.remainderPending = true;
      run.status = "ENTRY_FACT_PENDING";
      run.error = "仓位已建立全仓止损，等待入场累计成交事实确认";
      return await this.persist(run, "ENTRY_POSITION_QUANTITY_PENDING", { positionQuantity: Math.abs(Number(facts.position.quantity ?? facts.position.positionAmt)), orderStatus: order.status });
    }
    if (filledQuantity > 0 && isTerminalOrder(order.status) && !facts.position) {
      run.status = "PROTECTION_PENDING";
      return await this.reconcileProtected(run, facts.snapshot);
    }
    if (filledQuantity > 0 && (order.status === "FILLED" || isTerminalOrder(order.status))) {
      const metrics = updateExecutionMetrics(run, this.minimumFillRatio);
      run.entryExecution = {
        ...(run.entryExecution ?? {}),
        completedAt: Number(order.updateTime) || this.now(),
        cancellationReason: order.status === "FILLED" ? null : cancelReason,
      };
      if (!facts.position) run.status = "PROTECTION_PENDING";
      run.error = null;
      await this.persist(run, "ENTRY_FILL_FINALIZED", {
        status: order.status,
        filledQuantity,
        averagePrice: order.averagePrice,
        fillRatio: metrics?.fillRatio ?? null,
        actualMarginEstimate: metrics?.actualMarginEstimate ?? null,
        plannedEntryPrice: metrics?.plannedEntryPrice ?? null,
        submittedLimitPrice: metrics?.submittedLimitPrice ?? null,
        slippageBps: metrics?.slippageBps ?? null,
        timeToFillMs: metrics?.timeToFillMs ?? null,
      });
      const protectedRun = facts.position && run.protection?.phase !== "ENTRY_REMAINDER_PENDING"
        ? run : await this.ensureProtection(run, filledQuantity);
      await this.observeEntryFillVerification(protectedRun);
      if (!excludeUndersizedStrategyFill(protectedRun, metrics)) return protectedRun;
      await this.persist(protectedRun, "EXECUTION_SAMPLE_EXCLUDED", {
        reason: UNDERSIZED_FILL_EXCEPTION,
        fillRatio: metrics.fillRatio,
        minimumFillRatio: this.minimumFillRatio,
        plannedQuantity: metrics.plannedQuantity,
        filledQuantity: metrics.filledQuantity,
      });
      if (!new Set(["OPEN_PROTECTED", "TP1_FILLED", "PROTECTION_INCOMPLETE"]).has(protectedRun.status)) return protectedRun;
      try {
        return await this.closeExecutionRun(
          protectedRun.id,
          `限价入场最终成交低于计划仓位的${Math.round(this.minimumFillRatio * 100)}%，无法形成可比较策略样本，因此受控平掉已成交部分。`,
        );
      } catch (error) {
        protectedRun.status = "PROTECTION_INCOMPLETE";
        protectedRun.error = `低成交比例仓位自动平仓失败: ${errorMessage(error)}`;
        await this.persist(protectedRun, "UNDERSIZED_FILL_CLOSE_FAILED", { message: protectedRun.error });
        await this.engageEmergencyStop("UNDERSIZED_FILL_CLOSE_FAILED", protectedRun.id);
        return protectedRun;
      }
    }
    if (isTerminalOrder(order.status)) {
      const finalCancelReason = cancelReason === "ENTRY_EXPIRED" && resolveEntryPolicy(run.plan).mode === MARKETABLE_LIMIT_IOC
        ? "IOC_NOT_FILLED"
        : cancelReason;
      run.status = "CANCELED";
      run.error = null;
      run.entryExecution = {
        ...(run.entryExecution ?? {}),
        completedAt: Number(order.updateTime) || this.now(),
        cancellationReason: finalCancelReason,
      };
      run.result = { reason: "ENTRY_NOT_FILLED", cancellationReason: finalCancelReason, filledQuantity: 0 };
      return await this.persist(run, "CANARY_CANCELED_UNFILLED", {
        orderStatus: order.status,
        cancellationReason: finalCancelReason,
        executionMode: resolveEntryPolicy(run.plan).mode,
        timeInForce: order.timeInForce ?? resolveEntryPolicy(run.plan).timeInForce,
        plannedPrice: run.plan.prices.entry,
        submittedLimitPrice: run.entryExecution?.submittedLimitPrice ?? order.price ?? null,
        referencePrice: run.entryExecution?.referencePrice ?? null,
        spreadBps: run.entryExecution?.spreadBps ?? null,
      });
    }
    run.status = order.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : "ENTRY_PENDING";
    run.error = null;
    return await this.persist(run, "ENTRY_RECONCILED", { status: order.status, executedQuantity: filledQuantity });
  }

  async ensureAlgo(run, key, place) {
    const clientAlgoId = run.plan.clientIds[key];
    let order = await this.client.queryAlgoOrder(clientAlgoId);
    if (!order) {
      await this.store.appendExecutionAudit(run.id, "PROTECTION_ORDER_INTENT_PERSISTED", {
        role: key,
        clientAlgoId,
        reason: orderReason(run, key),
      }, this.now());
      try {
        order = await place(clientAlgoId);
      } catch (error) {
        order = await this.client.queryAlgoOrder(clientAlgoId);
        if (!order) throw error;
      }
    }
    if (!isActiveAlgo(order)) throw new Error(`${key} 条件单不是活动状态: ${order?.status ?? "UNKNOWN"}`);
    const changed = run.protection[key]?.algoId !== order.algoId || run.protection[key]?.status !== order.status;
    run.protection[key] = order;
    if (changed) await this.persist(run, "PROTECTION_ORDER_CONFIRMED", {
      role: key,
      clientAlgoId,
      algoId: order.algoId,
      status: order.status,
    });
    return order;
  }

  takeProfitRecovery(run, key) {
    run.protection.tpRecovery ??= {};
    return run.protection.tpRecovery[key] ??= {
      currentClientId: run.plan.clientIds[key], ids: [run.plan.clientIds[key]], replacements: 0,
      attempted: Boolean(run.protection[key]) || (run.status === "PROTECTION_INCOMPLETE" && run.protection.phase === "INITIAL"),
      pending: false, nextAt: 0,
    };
  }

  async deferTakeProfit(run, key, state, reason) {
    // One audit per changed failure or retry window, not per reconciliation poll.
    if (state.reason !== reason || this.now() >= Number(state.nextAt ?? 0)) {
      state.reason = reason;
      state.nextAt = this.now() + Math.min(300_000, TP_RETRY_BASE_MS * (2 ** state.replacements));
      await this.persist(run, "TP_RECOVERY_DEFERRED", { role: key, clientAlgoId: state.currentClientId,
        reason, replacements: state.replacements, nextAt: state.nextAt });
    }
    return false;
  }

  async ensureTakeProfit(run, key, place) {
    const state = this.takeProfitRecovery(run, key);
    if (Number(run.protection[key]?.actualQuantity) > 0) return true;
    let order;
    try { order = await this.client.queryAlgoOrder(state.currentClientId); }
    catch { return await this.deferTakeProfit(run, key, state, "QUERY_UNKNOWN"); }
    order ??= state.terminalOrder ?? null;
    if (order) {
      order = { ...order, clientAlgoId: order.clientAlgoId ?? state.currentClientId };
      run.protection[key] = order;
      if (Number(order.actualQuantity) > 0) return true; // Includes partial/terminal fills; never replenish.
      if (order.status === "FINISHED" || order.actualOrderId) {
        return await this.deferTakeProfit(run, key, state, "FINISHED_OR_CHILD_FILL_UNRESOLVED");
      }
      if (isActiveAlgo(order)) { state.reason = null; return true; }
      if (!TP_FAILED_STATUSES.has(order.status)) return await this.deferTakeProfit(run, key, state, "ORDER_STATE_UNKNOWN");
      if (order.status !== "REJECTED" && (order.actualQuantity === null || order.actualQuantity === undefined)) {
        return await this.deferTakeProfit(run, key, state, "TERMINAL_FILL_QUANTITY_UNKNOWN");
      }
      if (state.terminalId !== state.currentClientId) {
        state.terminalId = state.currentClientId;
        return await this.deferTakeProfit(run, key, state, "TERMINAL_" + order.status);
      }
      if (this.now() < Number(state.nextAt)) return false;
      if (state.replacements >= TP_REPLACEMENT_LIMIT) return await this.deferTakeProfit(run, key, state, "RETRY_LIMIT_REACHED");
      run.protection[`tpHistory_${key}_${state.replacements}`] = { ...order, recoveryRole: key };
      state.replacements += 1;
      state.currentClientId = `${run.plan.clientIds[key].slice(0, 32)}-r${state.replacements}`;
      state.ids.push(state.currentClientId);
      state.attempted = false;
      state.pending = false;
      delete state.terminalOrder;
    } else if (state.attempted || state.pending) {
      return await this.deferTakeProfit(run, key, state, "SUBMISSION_UNKNOWN_QUERY_ONLY");
    } else if (this.now() < Number(state.nextAt)) return false;
    state.attempted = true;
    state.pending = true;
    await this.persist(run, "PROTECTION_ORDER_INTENT_PERSISTED", { role: key, clientAlgoId: state.currentClientId,
      replacements: state.replacements, reason: orderReason(run, key) });
    try {
      order = await place(state.currentClientId);
    } catch (error) {
      try { order = await this.client.queryAlgoOrder(state.currentClientId); } catch { order = null; }
      if (!order && error instanceof BinanceApiError && error.apiCode === -2021) {
        order = { status: "REJECTED", clientAlgoId: state.currentClientId, actualQuantity: 0 };
        state.terminalOrder = order;
      }
      if (!order) return await this.deferTakeProfit(run, key, state, "SUBMISSION_UNKNOWN_QUERY_ONLY");
    }
    if (!order) return await this.deferTakeProfit(run, key, state, "SUBMISSION_UNKNOWN_QUERY_ONLY");
    state.pending = false;
    run.protection[key] = { ...order, clientAlgoId: order.clientAlgoId ?? state.currentClientId };
    await this.persist(run, isActiveAlgo(order) ? "PROTECTION_ORDER_CONFIRMED" : "TP_RECOVERY_RESPONSE", {
      role: key, clientAlgoId: state.currentClientId, algoId: order.algoId, status: order.status });
    if (isActiveAlgo(order) || Number(order.actualQuantity) > 0) { state.reason = null; return true; }
    state.terminalId = state.currentClientId;
    return await this.deferTakeProfit(run, key, state, "TERMINAL_" + order.status);
  }

  async ensureProtection(run, filledQuantity, { stopOnly = false } = {}) {
    this.acquireProcessLock();
    run.protection.phase = "INITIAL";
    try {
      await this.ensureAlgo(run, "stop", (clientAlgoId) => this.client.placeStopClose({
        symbol: run.symbol,
        side: run.plan.exitSide,
        triggerPrice: run.plan.prices.stopLoss,
        clientAlgoId,
      }));
    } catch (error) {
      run.status = "ERROR_UNPROTECTED";
      run.error = errorMessage(error);
      run.performanceEligible = false;
      run.executionException = UNPROTECTED_POSITION_EXCEPTION;
      await this.persist(run, "STOP_PROTECTION_FAILED", {
        message: run.error,
        action: "AUTO_CLOSE_REDUCE_ONLY",
      });
      return await this.emergencyCloseUnprotectedRun(run, "STOP_PROTECTION_FAILED");
    }
    if (stopOnly) {
      run.status = "PARTIALLY_FILLED";
      run.protection.phase = "ENTRY_REMAINDER_PENDING";
      run.error = null;
      return await this.persist(run, "ENTRY_POSITION_STOP_PROTECTED", { filledQuantity });
    }
    let split;
    try {
      split = splitFilledQuantity(filledQuantity, {
        takeProfit1: Number(run.plan.prices.takeProfit1),
        takeProfit2: Number(run.plan.prices.takeProfit2),
        rules: run.plan.rules,
      });
    } catch (error) {
      // A quantity that cannot form TP legs still has an effective full-position
      // stop. Keep that protection while the entry facts/remainder settle.
      run.status = "PROTECTION_INCOMPLETE";
      run.protection.phase = "TP_QUANTITY_PENDING";
      run.error = errorMessage(error);
      return await this.persist(run, "TP_QUANTITY_PENDING", { filledQuantity, reason: run.error, stopActive: true });
    }
    run.protection.mode = split.mode;
    const failures = [];
    for (const key of split.mode === "TWO_TARGETS" ? ["takeProfit2", "takeProfit1"] : ["takeProfit2"]) {
      const closing = run.protection.takeProfit2;
      if (key === "takeProfit1" && (Number(closing?.actualQuantity) >= Number(filledQuantity)
        || closing?.status === "FINISHED")) {
        // A stale position snapshot must not create another TP while a full
        // close is settling; FINISHED without quantity is also not proof to resubmit.
        failures.push(key);
        const state = this.takeProfitRecovery(run, key);
        await this.deferTakeProfit(run, key, state, "CLOSING_TP_SETTLEMENT_PENDING");
        continue;
      }
      const satisfied = await this.ensureTakeProfit(run, key, (clientAlgoId) => this.client.placeTakeProfitClose({
        symbol: run.symbol,
        side: run.plan.exitSide,
        triggerPrice: run.plan.prices[key],
        clientAlgoId,
        quantity: key === "takeProfit1" ? formatToStep(split.takeProfit1Quantity, run.plan.rules.stepSize) : null,
      }));
      if (!satisfied) failures.push(key);
    }
    if (!failures.length) {
      run.status = "OPEN_PROTECTED";
      run.protection.phase = "INITIAL_COMPLETE";
      run.error = null;
      await this.persist(run, "POSITION_PROTECTED", { mode: split.mode, filledQuantity });
      return run;
    } else {
      run.status = "PROTECTION_INCOMPLETE";
      const previousError = run.error;
      run.error = failures.map(key => `${key}: ${run.protection.tpRecovery[key].reason}`).join("; ");
      if (previousError !== run.error) await this.persist(run, "TAKE_PROFIT_PROTECTION_INCOMPLETE", { message: run.error });
      return run;
    }
  }

  async emergencyCloseUnprotectedRun(run, emergencyReason = "ACTIVE_STOP_MISSING") {
    run.status = "ERROR_UNPROTECTED";
    run.performanceEligible = false;
    run.executionException = UNPROTECTED_POSITION_EXCEPTION;
    await this.persist(run, "UNPROTECTED_POSITION_CLASSIFIED", {
      reason: emergencyReason,
      performanceEligible: false,
      executionException: UNPROTECTED_POSITION_EXCEPTION,
    });
    if (!(await this.isEmergencyStopped())) await this.engageEmergencyStop(emergencyReason, run.id);
    try {
      await this.store.appendExecutionAudit(run.id, "UNPROTECTED_AUTO_CLOSE_REQUESTED", {
        reason: emergencyReason,
        closeReason: UNPROTECTED_AUTO_CLOSE_REASON,
      }, this.now());
      return await this.closeExecutionRun(run.id, UNPROTECTED_AUTO_CLOSE_REASON);
    } catch (error) {
      const latest = await this.store.getExecutionRun(run.id) ?? run;
      latest.status = latest.status?.startsWith("OPERATOR_CLOSE") ? latest.status : "ERROR_UNPROTECTED";
      latest.performanceEligible = false;
      latest.executionException = UNPROTECTED_POSITION_EXCEPTION;
      latest.error = `无保护仓位自动平仓失败: ${errorMessage(error)}`;
      await this.persist(latest, "UNPROTECTED_AUTO_CLOSE_FAILED", {
        reason: emergencyReason,
        message: latest.error,
      });
      return latest;
    }
  }

  async queryKnownProtection(run, account = null) {
    const activeByClientId = new Map((account?.openAlgoOrders ?? [])
      .map((order) => [String(order.clientAlgoId ?? ""), order]));
    const entries = await Promise.all(["stop", "takeProfit1", "takeProfit2", "breakEvenStop"].map(async (key) => {
      if (key === "takeProfit1" && run.protection.mode === "SINGLE_TARGET") return [key, null];
      if (key === "breakEvenStop" && !run.protection.breakEvenStop
        && !["BREAKEVEN_PENDING", "BREAKEVEN_ACTIVE"].includes(run.protection.phase)) return [key, null];
      const recovery = run.protection.tpRecovery?.[key];
      const clientAlgoId = recovery?.currentClientId ?? run.plan.clientIds[key];
      if (!clientAlgoId) return [key, null];
      if (recovery) {
        let current = null;
        let filled = null;
        for (const [index, id] of recovery.ids.entries()) {
          let order;
          try { order = activeByClientId.get(String(id)) ?? await this.client.queryAlgoOrder(id); }
          catch { continue; } // Per-leg UNKNOWN is handled without suppressing its sibling.
          if (!order) continue;
          const known = { ...order, clientAlgoId: order.clientAlgoId ?? id };
          if (id === clientAlgoId) current = known;
          else run.protection[`tpHistory_${key}_${index}`] = { ...known, recoveryRole: key };
          if (Number(known.actualQuantity) > 0 || known.status === "FINISHED") filled = known;
        }
        return [key, filled ?? current];
      }
      const active = activeByClientId.get(String(clientAlgoId));
      if (active) return [key, active];
      try { return [key, await this.client.queryAlgoOrder(clientAlgoId)]; }
      catch (error) {
        if (!["takeProfit1", "takeProfit2"].includes(key)) throw error;
        const state = this.takeProfitRecovery(run, key);
        state.attempted = true;
        state.pending = true;
        return [key, null];
      }
    }));
    return Object.fromEntries(entries);
  }

  async cancelAlgoIfActive(run, role, order) {
    if (!isActiveAlgo(order)) return;
    try {
      await this.client.cancelAlgoOrder(order.clientAlgoId ?? run.plan.clientIds[role]);
      await this.store.appendExecutionAudit(run.id, "PROTECTION_ORDER_CANCELED", { role }, this.now());
    } catch (error) {
      const clientAlgoId = order.clientAlgoId ?? run.plan.clientIds[role];
      let current = await this.client.queryAlgoOrder(clientAlgoId);
      if (isActiveAlgo(current) && Number(error?.apiCode) === -2011) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        current = await this.client.queryAlgoOrder(clientAlgoId);
      }
      if (isActiveAlgo(current)) throw error;
    }
  }

  async collectRunTrades(run) {
    const entryOrderIds = new Set([run.entryOrder?.orderId].filter(validOrderId).map(String));
    const exitOrders = [run.operatorCloseOrder, ...Object.values(run.protection ?? {})]
      .filter(order => order && typeof order === "object");
    // Algo IDs are not trade order IDs. Zero denotes a leg that never filled.
    const exitOrderIds = new Set(exitOrders.flatMap(order => {
      if (Object.hasOwn(order, "actualOrderId")) return validOrderId(order.actualOrderId) ? [String(order.actualOrderId)] : [];
      return validOrderId(order.orderId) ? [String(order.orderId)] : [];
    }));
    const ownedOrderIds = new Set([...entryOrderIds, ...exitOrderIds]);
    const startTime = Math.max(0, Number(run.entryExecution?.submittedAt ?? run.createdAt) - 60_000);
    const endTime = this.now();
    const unique = new Map();
    let tradesComplete = startTime >= endTime - 180 * 24 * 60 * 60_000;
    const week = 7 * 24 * 60 * 60_000 - 1;
    for (let sliceStart = startTime; sliceStart <= endTime; sliceStart += week + 1) {
      const sliceEnd = Math.min(endTime, sliceStart + week);
      let fromId = null;
      for (let page = 0; page < 1000; page++) {
        // Binance forbids combining fromId with either time bound.
        const query = fromId === null ? { startTime: sliceStart, endTime: sliceEnd, limit: 1000 } : { fromId, limit: 1000 };
        const rows = await this.client.listUserTrades(run.symbol, query);
        if (!Array.isArray(rows)) { tradesComplete = false; break; }
        for (const row of rows) {
          if (!ownedOrderIds.has(String(row.orderId))) continue;
          const time = finiteValue(row.time);
          if (time !== null && (time < sliceStart || time > sliceEnd)) continue;
          const key = row.id == null ? null : String(row.id);
          if (!key) { tradesComplete = false; continue; }
          if (unique.has(key) && JSON.stringify(unique.get(key)) !== JSON.stringify(row)) tradesComplete = false;
          else unique.set(key, row);
        }
        if (rows.length < 1000 || rows.some(row => finiteValue(row.time) !== null && Number(row.time) > sliceEnd)) break;
        const ids = rows.map(row => String(row.id ?? ""));
        if (ids.some(id => !/^[0-9]+$/.test(id))) { tradesComplete = false; break; }
        const next = (ids.reduce((max, id) => BigInt(id) > max ? BigInt(id) : max, -1n) + 1n).toString();
        if (fromId !== null && BigInt(next) <= BigInt(fromId)) { tradesComplete = false; break; }
        fromId = next;
        if (page === 999) tradesComplete = false;
      }
    }
    const trades = [...unique.values()];
    const fieldsComplete = trades.every(trade => trade.symbol === run.symbol
      && trade.side === (entryOrderIds.has(String(trade.orderId)) ? run.plan.entrySide : run.plan.exitSide)
      && finiteValue(trade.quantity) > 0 && finiteValue(trade.price) > 0
      && validOrderId(trade.id) && finiteValue(trade.time) !== null
      && Number(trade.time) >= Number(run.entryExecution?.submittedAt ?? run.createdAt) && Number(trade.time) <= endTime
      && (finiteValue(trade.quoteQuantity) === null || quantitiesEqual(Number(trade.quoteQuantity), Number(trade.quantity) * Number(trade.price)))
      && finiteValue(trade.commission) !== null
      && trade.commissionAsset === "USDT" && finiteValue(trade.realizedPnl) !== null);
    const quantities = ids => trades.filter(t => ids.has(String(t.orderId))).reduce((sum, t) => sum + (finiteValue(t.quantity) ?? 0), 0);
    const entryQuantity = quantities(entryOrderIds), exitQuantity = quantities(exitOrderIds);
    const expected = finiteValue(run.entryOrder?.executedQuantity);
    const quantityComplete = expected > 0 && quantitiesEqual(entryQuantity, expected) && quantitiesEqual(exitQuantity, expected)
      && [...ownedOrderIds].every(id => trades.some(t => String(t.orderId) === id))
      && exitOrders.every(order => {
        const id = Object.hasOwn(order, "actualOrderId") ? order.actualOrderId : order.orderId;
        const expectedExit = positiveNumber(order.actualQuantity, order.executedQuantity);
        return !validOrderId(id) || expectedExit === null || quantitiesEqual(quantities(new Set([String(id)])), expectedExit);
      });
    const entryAt = Math.min(...trades.filter(t => entryOrderIds.has(String(t.orderId))).map(t => finiteValue(t.time) ?? Infinity));
    const exitAt = Math.max(...trades.filter(t => exitOrderIds.has(String(t.orderId))).map(t => finiteValue(t.time) ?? -Infinity));
    let fundingComplete = typeof this.client.listIncomeHistory === "function" && Number.isFinite(entryAt) && Number.isFinite(exitAt) && exitAt >= entryAt
      && entryAt >= endTime - 90 * 24 * 60 * 60_000;
    const income = new Map();
    if (fundingComplete) {
      try {
        for (let page = 1; page <= 1000; page++) {
          const rows = await this.client.listIncomeHistory(run.symbol, { incomeType: "FUNDING_FEE", startTime: entryAt, endTime: exitAt, limit: 1000, page });
          if (!Array.isArray(rows)) { fundingComplete = false; break; }
          let added = 0;
          for (const item of rows) {
            if (item.symbol !== run.symbol || item.incomeType !== "FUNDING_FEE" || item.asset !== "USDT"
              || finiteValue(item.income) === null || finiteValue(item.time) === null || (item.transactionId ?? item.tranId) == null) { fundingComplete = false; continue; }
            if (item.time < entryAt || item.time > exitAt) continue;
            const key = String(item.transactionId ?? item.tranId);
            if (income.has(key) && JSON.stringify(income.get(key)) !== JSON.stringify(item)) fundingComplete = false;
            if (!income.has(key)) { income.set(key, item); added++; }
          }
          if (rows.length < 1000) break;
          if (!added || page === 1000) { fundingComplete = false; break; }
        }
      } catch {
        fundingComplete = false;
        await this.store.appendExecutionAudit(run.id, "FUNDING_ACCOUNTING_PENDING", { reason: "FUNDING_QUERY_FAILED" }, this.now());
      }
    }
    const fundingIncome = [...income.values()];
    return { trades, fundingIncome, fundingPnl: fundingComplete ? fundingIncome.reduce((sum, item) => sum + Number(item.income), 0) : null,
      fundingComplete, tradesComplete, ownedOrderIds: [...ownedOrderIds],
      accountingComplete: tradesComplete && fieldsComplete && fundingComplete && quantityComplete && entryOrderIds.size > 0 && exitOrderIds.size > 0 };
  }

  buildRunResult({ trades, fundingIncome = [], fundingPnl = null, ownedOrderIds = [], accountingComplete = false }, run) {
    const commission = trades.length > 0 && trades.every(t => finiteValue(t.commission) !== null && t.commissionAsset === "USDT")
      ? trades.reduce((sum, t) => sum + Number(t.commission), 0) : null;
    const realizedPnl = trades.length > 0 && trades.every(t => finiteValue(t.realizedPnl) !== null)
      ? trades.reduce((sum, t) => sum + Number(t.realizedPnl), 0) : null;
    accountingComplete = accountingComplete && commission !== null && realizedPnl !== null && finiteValue(fundingPnl) !== null;
    const entryOrderIds = new Set([run.entryOrder?.orderId].filter(validOrderId).map(String));
    const exitOrderIds = new Set(trades.filter(t => !entryOrderIds.has(String(t.orderId))).map(t => String(t.orderId)));
    const exitRole = ["operatorClose", "breakEvenStop", "stop", "takeProfit2", "takeProfit1"].find(role => {
      const order = role === "operatorClose" ? run.operatorCloseOrder : run.protection?.[role];
      const id = Object.hasOwn(order ?? {}, "actualOrderId") ? order.actualOrderId : order?.orderId;
      return validOrderId(id) && exitOrderIds.has(String(id));
    }) ?? null;
    return { reason: "EXCHANGE_POSITION_CLOSED", exitRole,
      exitReason: reasonForExitRole(run.plan.orderReasons, exitRole) ?? "交易所确认系统仓位已经关闭，因此结束本次Binance Demo交易。",
      commission, realizedPnl, fundingPnl, fundingIncome,
      netPnl: accountingComplete ? realizedPnl - commission + fundingPnl : null,
      netR: null, trades, ownedOrderIds, accountingComplete };
  }

  runResiduals(account, run) {
    const ordinaryIds = new Set([
      run.plan?.clientIds?.entry,
      run.plan?.clientIds?.operatorClose,
    ].filter(Boolean).map(String));
    const algoIds = new Set([
      run.plan?.clientIds?.stop,
      run.plan?.clientIds?.breakEvenStop,
      run.plan?.clientIds?.takeProfit1,
      run.plan?.clientIds?.takeProfit2,
      ...Object.values(run.protection.tpRecovery ?? {}).flatMap(state => state.ids ?? []),
    ].filter(Boolean).map(String));
    return {
      positions: (account.positions ?? []).filter((position) => position.symbol === run.symbol),
      openOrders: (account.openOrders ?? []).filter((order) => order.symbol === run.symbol && ordinaryIds.has(String(order.clientOrderId))),
      openAlgoOrders: (account.openAlgoOrders ?? []).filter((order) => order.symbol === run.symbol && algoIds.has(String(order.clientAlgoId))),
    };
  }

  async reconcileProtected(run, accountSnapshot = null) {
    const symbol = this.assertAllowedSymbol(run.symbol);
    if (run.status.startsWith("OPERATOR_CLOSE")) {
      let closeOrder = (accountSnapshot?.openOrders ?? [])
        .find((item) => item.symbol === symbol && item.clientOrderId === run.plan.clientIds.operatorClose) ?? null;
      if (!closeOrder) closeOrder = await this.client.queryOrder(symbol, run.plan.clientIds.operatorClose);
      if (closeOrder) run.operatorCloseOrder = closeOrder;
    }
    const accountPromise = accountSnapshot ? Promise.resolve(accountSnapshot) : this.client.fetchAccountState(symbol);
    const [account, protection] = await Promise.all([accountPromise, this.queryKnownProtection(run, accountSnapshot)]);
    run.exchange = account;
    run.protection = { ...run.protection, ...protection };
    const position = account.positions.find((item) => item.symbol === symbol);
    // Legacy unsettled rows require a separately authorized migration. Preserve their
    // stored state; active positions still follow the existing protection path below.
    if (!position && run.status === "ACCOUNTING_PENDING" && !run.entryFactVerification) return run;
    const entryFacts = await this.verifyEntryFacts(run, account);
    if (entryFacts.pending) return run;
    if (!position) {
      for (const [role, order] of Object.entries(run.protection)) await this.cancelAlgoIfActive(run, role, order);
      const finalAccount = await this.client.fetchAccountState(symbol);
      run.exchange = finalAccount;
      const residuals = this.runResiduals(finalAccount, run);
      if (residuals.positions.length || residuals.openOrders.length || residuals.openAlgoOrders.length) {
        run.status = "PROTECTION_CLEANUP_PENDING";
        run.error = "本执行记录的仓位已关闭，但仍有待清理订单";
        return await this.persist(run, "PROTECTION_CLEANUP_PENDING", {
          positionCount: residuals.positions.length,
          openOrderCount: residuals.openOrders.length,
          openAlgoOrderCount: residuals.openAlgoOrders.length,
        });
      }
      const accounting = await this.collectRunTrades(run);
      const result = this.buildRunResult(accounting, run);
      if (!result.accountingComplete) {
        run.status = "ACCOUNTING_PENDING";
        run.error = "仓位和订单已清理，等待交易所成交明细完成严格归属";
        run.result = result;
        return await this.persist(run, "ACCOUNTING_PENDING", {
          tradeCount: accounting.trades.length,
          ownedOrderIds: accounting.ownedOrderIds,
        });
      }
      finalizeRunExcursions(run, result, this.now());
      run.status = "CLOSED";
      run.error = null;
      run.result = result;
      return await this.persist(run, "CANARY_CLOSED", {
        commission: result.commission,
        realizedPnl: result.realizedPnl,
        fundingPnl: result.fundingPnl,
        tradeCount: accounting.trades.length,
        accountingComplete: result.accountingComplete,
      });
    }

    const executionMetrics = updateExecutionMetrics(run, this.minimumFillRatio);
    if (excludeUndersizedStrategyFill(run, executionMetrics)) {
      await this.store.appendExecutionAudit(run.id, "EXECUTION_SAMPLE_EXCLUDED", {
        reason: UNDERSIZED_FILL_EXCEPTION,
        fillRatio: executionMetrics.fillRatio,
        minimumFillRatio: this.minimumFillRatio,
        migratedActiveRun: true,
      }, this.now());
    }
    updateExcursions(run, position, this.now());

    if (run.status.startsWith("OPERATOR_CLOSE")) {
      if (!run.operatorCloseOrder) {
        run.status = "OPERATOR_CLOSE_UNKNOWN";
        run.error = "交易所暂时查不到已持久化的人工平仓订单";
      } else if (isTerminalOrder(run.operatorCloseOrder.status) && run.operatorCloseOrder.status !== "FILLED") {
        run.status = "OPEN_PROTECTED";
        run.error = `人工平仓订单未成交: ${run.operatorCloseOrder.status}`;
      } else {
        run.status = "OPERATOR_CLOSE_PENDING";
        run.error = null;
      }
      return await this.persist(run, "OPERATOR_CLOSE_RECONCILED", {
        closeStatus: run.operatorCloseOrder?.status ?? "UNKNOWN",
        remainingQuantity: Math.abs(Number(position.quantity)),
      });
    }

    const tp1 = protection.takeProfit1;
    const tp1Filled = Number(tp1?.actualQuantity ?? 0) > 0;
    if (tp1Filled && run.performance?.timeToTp1Ms === null) {
      const tp1At = Number(tp1?.updateTime) || this.now();
      markRunMilestone(run, "TP1", tp1At);
    }
    const activeStopBeforeRecovery = isActiveAlgo(protection.breakEvenStop) || isActiveAlgo(protection.stop);
    if (run.status === "ERROR_UNPROTECTED") {
      if (!activeStopBeforeRecovery) {
        const protectionWasNeverSubmitted = !protection.stop && !protection.breakEvenStop
          && !run.protection.stop && !run.protection.breakEvenStop;
        if (run.sourceType === "OPERATOR_CANARY" && protectionWasNeverSubmitted) {
          await this.store.appendExecutionAudit(run.id, "IMMEDIATE_FILL_PROTECTION_RECOVERY", {
            quantity: Math.abs(Number(position.quantity)),
          }, this.now());
          return await this.ensureProtection(run, Math.abs(Number(position.quantity)));
        }
        return await this.emergencyCloseUnprotectedRun(run, "ACTIVE_STOP_MISSING");
      }
      run.status = tp1Filled ? "TP1_FILLED" : "OPEN_PROTECTED";
      run.error = null;
      await this.persist(run, "ACTIVE_STOP_RECOVERED", { status: run.status });
    }
    const initialTPFailed = run.status === "OPEN_PROTECTED" && activeStopBeforeRecovery
      && !["BREAKEVEN_PENDING", "BREAKEVEN_ACTIVE"].includes(run.protection.phase)
      && (run.protection.mode === "SINGLE_TARGET" ? ["takeProfit2"] : ["takeProfit2", "takeProfit1"])
        .some(key => TP_FAILED_STATUSES.has(protection[key]?.status)
          && !(Number(protection[key]?.actualQuantity) > 0) && !protection[key]?.actualOrderId);
    if ((["PROTECTION_PENDING", "PROTECTION_INCOMPLETE"].includes(run.status) || initialTPFailed)
      && run.protection.phase !== "BREAKEVEN_PENDING" && !tp1Filled
      && !fullyFilledClosingProtection(protection, position)) {
      return await this.ensureProtection(run, Math.abs(Number(position.quantity)));
    }

    if (tp1Filled && !isActiveAlgo(protection.breakEvenStop)) {
      const retry = run.protection.breakEvenRetry;
      if (Number(retry?.nextAt) > this.now()) return run;
      run.protection.phase = "BREAKEVEN_PENDING";
      try {
        const quantity = formatToStep(Math.abs(Number(position.quantity)), run.plan.rules.stepSize);
        await this.ensureAlgo(run, "breakEvenStop", (clientAlgoId) => this.client.placeStopClose({
          symbol,
          side: run.plan.exitSide,
          triggerPrice: run.plan.prices.entry,
          clientAlgoId,
          quantity,
        }));
      } catch (error) {
        const attempts = Number(run.protection.breakEvenRetry?.attempts ?? 0) + 1;
        const retryDelayMs = Math.min(BREAK_EVEN_RETRY_MAX_MS, BREAK_EVEN_RETRY_BASE_MS * (2 ** (attempts - 1)));
        run.protection.breakEvenRetry = {
          attempts,
          lastFailedAt: this.now(),
          nextAt: this.now() + retryDelayMs,
          retryDelayMs,
          lastError: errorMessage(error),
        };
        run.status = "PROTECTION_INCOMPLETE";
        run.error = errorMessage(error);
        await this.persist(run, "BREAKEVEN_STOP_FAILED", {
          message: run.error,
          originalStopActive: isActiveAlgo(protection.stop),
          attempts,
          nextAt: run.protection.breakEvenRetry.nextAt,
        });
        return run;
      }
      try {
        await this.cancelAlgoIfActive(run, "stop", protection.stop);
      } catch (error) {
        await this.store.appendExecutionAudit(run.id, "ORIGINAL_STOP_CANCEL_PENDING", { message: errorMessage(error) }, this.now());
      }
      run.protection.phase = "BREAKEVEN_ACTIVE";
      delete run.protection.breakEvenRetry;
      run.status = "TP1_FILLED";
      run.error = null;
      return await this.persist(run, "STOP_MOVED_TO_BREAKEVEN", { triggerPrice: run.plan.prices.entry });
    }

    if (tp1Filled && isActiveAlgo(protection.breakEvenStop) && isActiveAlgo(protection.stop)) {
      try {
        await this.cancelAlgoIfActive(run, "stop", protection.stop);
      } catch (error) {
        await this.store.appendExecutionAudit(run.id, "ORIGINAL_STOP_CANCEL_PENDING", { message: errorMessage(error) }, this.now());
      }
    }

    // TP1 completion must not suppress recovery of the independent remaining TP2.
    // Never rebuild TP1, alter BE, or submit a TP when a closing fill is settling.
    let tp2RecoveryIncomplete = false;
    if (tp1Filled && isActiveAlgo(protection.breakEvenStop)
      && !isActiveAlgo(protection.takeProfit2) && !fullyFilledClosingProtection(protection, position)) {
      tp2RecoveryIncomplete = !(await this.ensureTakeProfit(run, "takeProfit2", clientAlgoId => this.client.placeTakeProfitClose({
        symbol, side: run.plan.exitSide, triggerPrice: run.plan.prices.takeProfit2, clientAlgoId,
      })));
    }

    const activeStop = isActiveAlgo(protection.breakEvenStop) || isActiveAlgo(protection.stop);
    if (activeStop && run.protection.exitSettlement) delete run.protection.exitSettlement;
    if (!activeStop) {
      const closingFill = fullyFilledClosingProtection(protection, position);
      const previousSettlement = run.protection.exitSettlement;
      if (closingFill || previousSettlement) {
        const checkedAt = this.now();
        const detectedAt = Number(previousSettlement?.detectedAt) || checkedAt;
        const settlement = {
          role: closingFill?.role ?? previousSettlement.role,
          filledQuantity: closingFill?.filledQuantity ?? previousSettlement.filledQuantity,
          orderUpdateTime: closingFill?.orderUpdateTime ?? previousSettlement.orderUpdateTime ?? null,
          detectedAt,
          lastCheckedAt: checkedAt,
          graceMs: EXIT_SETTLEMENT_GRACE_MS,
        };
        run.protection.exitSettlement = settlement;
        if (checkedAt - detectedAt < EXIT_SETTLEMENT_GRACE_MS) {
          run.error = null;
          return await this.persist(run, previousSettlement ? "EXIT_SETTLEMENT_RECHECK_PENDING" : "EXIT_SETTLEMENT_PENDING", {
            ...settlement,
            stalePositionQuantity: Math.abs(Number(position.quantity)),
          });
        }
        await this.store.appendExecutionAudit(run.id, "EXIT_SETTLEMENT_GRACE_EXPIRED", {
          ...settlement,
          stalePositionQuantity: Math.abs(Number(position.quantity)),
        }, checkedAt);
      }
      run.status = "ERROR_UNPROTECTED";
      run.error = "持仓存在但交易所没有活动止损单";
      run.performanceEligible = false;
      run.executionException = UNPROTECTED_POSITION_EXCEPTION;
      await this.persist(run, "ACTIVE_STOP_MISSING", {
        quantity: position.quantity,
        action: "AUTO_CLOSE_REDUCE_ONLY",
      });
      return await this.emergencyCloseUnprotectedRun(run, "ACTIVE_STOP_MISSING");
    }
    await this.observeEntryFillVerification(run);
    run.status = tp2RecoveryIncomplete ? "PROTECTION_INCOMPLETE" : tp1Filled ? "TP1_FILLED" : "OPEN_PROTECTED";
    run.error = tp2RecoveryIncomplete ? `takeProfit2: ${run.protection.tpRecovery.takeProfit2.reason}` : null;
    return await this.persist(run, "POSITION_RECONCILED", { quantity: position.quantity, status: run.status });
  }

  async closeExecutionRun(runId, reason = null) {
    this.acquireProcessLock();
    if (!this.enabled) throw new TestnetWriteDisabledError("closeExecutionRun");
    const run = await this.store.getExecutionRun(runId);
    if (!run) throw new Error(`找不到执行记录 ${runId}`);
    if (!new Set(["SIGNAL", "OPERATOR_CANARY"]).has(run.sourceType)) throw new Error(`执行来源 ${run.sourceType} 不允许主动平仓`);
    if (TERMINAL_STATUSES.has(run.status)) return run;
    await this.ensureRunOrderReasons(run);
    if (!["OPEN_PROTECTED", "TP1_FILLED", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED", "OPERATOR_CLOSE_SUBMITTING", "OPERATOR_CLOSE_PENDING", "OPERATOR_CLOSE_UNKNOWN"].includes(run.status)) {
      throw new Error(`执行记录状态 ${run.status} 尚不允许主动平仓`);
    }
    const existingReason = run.plan?.orderReasons?.operatorClose ?? null;
    const closeReason = normalizeOperatorCloseReason(reason ?? existingReason);
    if (existingReason && closeReason !== existingReason) throw new Error("主动平仓原因已经固化，不能修改");
    run.plan.orderReasons = { ...(run.plan.orderReasons ?? {}), operatorClose: closeReason };
    run.planHash = hashPlan(run.plan);
    const symbol = this.assertAllowedSymbol(run.symbol);
    const [account, activeRuns, protection] = await Promise.all([
      this.client.fetchAccountState(symbol),
      this.store.listActiveExecutionRuns(),
      this.queryKnownProtection(run),
    ]);
    if (account.environment !== "TESTNET" || account.authority !== "BINANCE_TESTNET") throw new Error("账户事实源不是 Binance Testnet");
    if (account.positionMode !== "ONE_WAY") throw new Error("测试网账户不是单向持仓");
    const knownActiveProtection = Object.values(protection).filter(isActiveAlgo);
    const knownAlgoIds = new Set((account.openAlgoOrders ?? []).map((order) => String(order.clientAlgoId ?? "")));
    const accountForClassification = {
      ...account,
      openAlgoOrders: [
        ...(account.openAlgoOrders ?? []),
        ...knownActiveProtection.filter((order) => !knownAlgoIds.has(String(order.clientAlgoId ?? ""))),
      ],
    };
    const classification = classifyExecutionAccountState(accountForClassification, activeRuns);
    const toleratedMissingTargetStop = run.status === "ERROR_UNPROTECTED";
    const blockingMissingStops = classification.missingStops.filter((item) => (
      !toleratedMissingTargetStop || item.runId !== run.id
    ));
    if (classification.unknown.length || classification.conflicts.length || blockingMissingStops.length) {
      throw new Error("测试网账户存在无法归属、冲突或缺少止损的状态，拒绝主动平仓");
    }
    const ownedPositions = classification.owned.positions.filter((item) => item.runId === run.id && item.item.symbol === symbol);
    if (ownedPositions.length > 1) throw new Error(`执行记录 ${run.id} 对应多个仓位，拒绝主动平仓`);
    const position = account.positions.find((item) => item.symbol === symbol);
    if (!position) return await this.reconcile(run.id);
    if (ownedPositions.length !== 1) throw new Error(`BCH/策略仓位未被执行记录 ${run.id} 唯一归属`);
    const quantity = formatToStep(Math.abs(Number(position.quantity)), run.plan.rules.stepSize);
    const clientOrderId = ensureOperatorCloseClientId(run);
    run.status = "OPERATOR_CLOSE_SUBMITTING";
    run.error = null;
    await this.persist(run, "OPERATOR_CLOSE_INTENT_PERSISTED", {
      clientOrderId,
      side: run.plan.exitSide,
      quantity,
      reduceOnly: true,
      sourceType: run.sourceType,
      reason: closeReason,
    });
    let order = await this.client.queryOrder(symbol, clientOrderId);
    if (!order) {
      try {
        order = await this.client.closePositionMarket({
          symbol,
          side: run.plan.exitSide,
          quantity,
          clientOrderId,
        });
      } catch (error) {
        order = await this.client.queryOrder(symbol, clientOrderId);
        if (!order) {
          run.status = "OPERATOR_CLOSE_UNKNOWN";
          run.error = errorMessage(error);
          return await this.persist(run, "OPERATOR_CLOSE_SUBMISSION_UNKNOWN", { message: run.error });
        }
      }
    }
    run.operatorCloseOrder = order;
    run.status = "OPERATOR_CLOSE_PENDING";
    await this.persist(run, "OPERATOR_CLOSE_ORDER_CONFIRMED", {
      orderId: order.orderId,
      clientOrderId: order.clientOrderId,
      status: order.status,
      executedQuantity: order.executedQuantity,
    });
    return await this.reconcile(run.id);
  }

  async closeOperatorCanary(runId, reason = null) {
    const run = await this.store.getExecutionRun(runId);
    if (!run) throw new Error(`找不到执行记录 ${runId}`);
    if (run.sourceType !== "OPERATOR_CANARY") throw new Error("只允许通过此入口主动平仓人工金丝雀记录");
    return this.closeExecutionRun(runId, reason);
  }

  async refreshClosedRunAccounting(runId) {
    this.acquireProcessLock();
    const run = await this.store.getExecutionRun(runId);
    if (!run) throw new Error(`找不到执行记录 ${runId}`);
    if (run.status !== "CLOSED") throw new Error(`执行记录状态 ${run.status} 尚未关闭`);
    const symbol = this.assertAllowedSymbol(run.symbol);
    const account = await this.client.fetchAccountState(symbol);
    const residuals = this.runResiduals(account, run);
    if (residuals.positions.length || residuals.openOrders.length || residuals.openAlgoOrders.length) {
      throw new Error("本执行记录仍有仓位或挂单，拒绝刷新关闭账目");
    }
    run.exchange = account;
    const accounting = await this.collectRunTrades(run);
    run.result = this.buildRunResult(accounting, run);
    finalizeRunExcursions(run, run.result, this.now());
    run.error = null;
    return await this.persist(run, "CANARY_ACCOUNTING_REFRESHED", {
      commission: run.result.commission,
      realizedPnl: run.result.realizedPnl,
      tradeCount: accounting.trades.length,
      accountingComplete: run.result.accountingComplete,
    });
  }

  async engageEmergencyStop(reason = "MANUAL", runId = null) {
    this.acquireProcessLock();
    const value = { active: true, reason, runId, at: this.now() };
    await this.store.setMetadata("testnet_execution_emergency_stop", value);
    if (runId) await this.store.appendExecutionAudit(runId, "EMERGENCY_STOP_ENGAGED", value, value.at);
    const activeRuns = await this.store.listActiveExecutionRuns();
    for (const run of activeRuns) {
      if (!ENTRY_STATUSES.has(run.status) || !run.plan?.clientIds?.entry) continue;
      const symbol = this.assertAllowedSymbol(run.symbol);
      const order = await this.client.queryOrder(symbol, run.plan.clientIds.entry);
      if (!order || isTerminalOrder(order.status)) continue;
      try {
        const canceled = await this.client.cancelOrder(symbol, run.plan.clientIds.entry);
        run.entryOrder = canceled;
        await this.persist(run, "EMERGENCY_ENTRY_CANCELED", { executedQuantity: canceled.executedQuantity });
        if (Number(canceled.executedQuantity) > 0) await this.ensureProtection(run, Number(canceled.executedQuantity));
        else {
          run.status = "CANCELED";
          run.result = { reason: "EMERGENCY_STOP", filledQuantity: 0 };
          await this.persist(run, "CANARY_CANCELED_UNFILLED", { reason: "EMERGENCY_STOP" });
        }
      } catch (error) {
        this.logger.error(`[execution-emergency] ${run.id}: ${errorMessage(error)}`);
      }
    }
    this.emit("emergencyStop", structuredClone(value));
    return value;
  }

  async clearEmergencyStop() {
    this.acquireProcessLock();
    const [account, activeRuns] = await Promise.all([
      this.client.fetchAccountState(this.operatorSymbol),
      this.store.listActiveExecutionRuns(),
    ]);
    const classification = classifyExecutionAccountState(account, activeRuns);
    const unsafeRuns = activeRuns.filter((run) => [
      "ENTRY_SUBMITTING",
      "ENTRY_FACT_PENDING",
      "ENTRY_FACT_CONFLICT",
      "SUBMISSION_UNKNOWN",
      "ENTRY_PENDING",
      "PARTIALLY_FILLED",
      "PROTECTION_PENDING",
      "PROTECTION_INCOMPLETE",
      "ERROR_UNPROTECTED",
    ].includes(run.status));
    if (!classification.safe || unsafeRuns.length) {
      throw new Error("仍有归属异常、无保护仓位或未结束执行记录处于不安全状态，不能解除紧急停止");
    }
    const value = { active: false, clearedAt: this.now() };
    await this.store.setMetadata("testnet_execution_emergency_stop", value);
    this.emit("emergencyStop", structuredClone(value));
    return value;
  }

  async reconcileAll() {
    const active = await this.store.listActiveExecutionRuns();
    let account = null;
    if (active.some((run) => run.status !== "PREPARED") && typeof this.client.fetchAccountOverview === "function") {
      try {
        account = await this.client.fetchAccountOverview();
        this.lastReconcileAt = this.now();
        this.lastReconcileError = null;
      } catch (error) {
        this.lastReconcileError = {
          message: errorMessage(error),
          at: this.now(),
          retryAt: Number.isFinite(error?.retryAt) ? error.retryAt : Number.isFinite(this.client.blockedUntil) ? this.client.blockedUntil : null,
        };
        this.logger.error(`[execution] 账户批量对账暂停: ${this.lastReconcileError.message}`);
        return [];
      }
    }
    const results = [];
    for (const run of active) {
      try {
        results.push(await this.reconcile(run.id, { account }));
      } catch (error) {
        this.logger.error(`[execution] ${run.id}: ${errorMessage(error)}`);
      }
    }
    return results;
  }

  async start() {
    this.acquireProcessLock();
    const active = await this.store.listActiveExecutionRuns();
    const unmanaged = active.filter((run) => run.status !== "PREPARED");
    if (!this.enabled && unmanaged.length) {
      throw new Error(`存在 ${unmanaged.length} 个未结束的测试网执行记录，写入锁关闭时拒绝启动执行协调器`);
    }
    await this.reconcileAll();
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcileAll(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.executing.size && !this.reconciling.size && this.releaseProcessLock) {
      this.releaseProcessLock();
      this.releaseProcessLock = null;
    }
  }

  async snapshot() {
    return {
      environment: "TESTNET",
      mode: this.enabled ? "CANARY_ARMED" : "CANARY_LOCKED",
      symbol: this.operatorSymbol,
      allowedSymbols: [...this.allowedSymbols],
      orderSubmissionEnabled: this.enabled,
      permissionProbe: await this.permissionStatus(),
      emergencyStop: (await this.store.getMetadata("testnet_execution_emergency_stop"))?.value ?? { active: false },
      capacity: typeof this.store.getExecutionCapacity === "function" ? await this.store.getExecutionCapacity() : null,
      reconciliation: {
        lastSuccessfulAt: this.lastReconcileAt,
        error: this.lastReconcileError,
      },
      runs: await this.store.listExecutionRuns(20),
    };
  }
}

export { ACTIVE_ALGO_STATUSES, ENTRY_STATUSES, PROTECTED_STATUSES, TERMINAL_STATUSES };
