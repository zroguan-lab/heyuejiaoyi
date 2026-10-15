import { createHash } from "node:crypto";
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

const TERMINAL_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);
const ENTRY_STATUSES = new Set(["ENTRY_SUBMITTING", "SUBMISSION_UNKNOWN", "ENTRY_PENDING", "PARTIALLY_FILLED"]);
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
const UNDERSIZED_FILL_EXCEPTION = "ENTRY_FILL_BELOW_MINIMUM";
const UNPROTECTED_POSITION_EXCEPTION = "UNPROTECTED_POSITION_AUTO_CLOSE";
const UNSUPPORTED_LEVERAGE_EXCEPTION = "UNSUPPORTED_LEVERAGE";
const PRE_ENTRY_FAILURE_EXCEPTION = "PRE_ENTRY_CONFIGURATION_FAILED";
const UNPROTECTED_AUTO_CLOSE_REASON = "交易所未能建立有效止损保护，系统为避免无保护持仓扩大损失，立即使用仅减仓市价单平仓。";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  const entryPrice = positiveNumber(run.entryOrder?.averagePrice, run.entryOrder?.price, run.plan?.prices?.entry);
  const stopLoss = positiveNumber(run.plan?.prices?.stopLoss);
  const leverage = positiveNumber(run.plan?.leverage);
  const fillRatio = filledQuantity / plannedQuantity;
  const actualNotional = entryPrice === null ? null : entryPrice * filledQuantity;
  const actualRiskAmount = entryPrice === null || stopLoss === null
    ? null
    : Math.abs(entryPrice - stopLoss) * filledQuantity;
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
  const entryPrice = positiveNumber(run.entryOrder?.averagePrice, run.entryOrder?.price, run.plan?.prices?.entry);
  const stopLoss = Number(run.plan?.prices?.stopLoss);
  const openedAt = entryTime(run);
  if (![entryPrice, stopLoss, openedAt].every(Number.isFinite) || entryPrice <= 0 || stopLoss <= 0) return null;
  if (run.performance?.modelVersion === "TRADE_EXCURSION_R1") return run.performance;
  const legacy = run.performance ?? {};
  const state = createTradeExcursionState({ direction: run.plan.direction, entryPrice, stopLoss, openedAt });
  const legacyMfeR = Math.max(0, Number(legacy.mfeR) || 0);
  const legacyMaeR = Math.abs(Number(legacy.maeR) || 0);
  state.mfeR = legacyMfeR;
  state.maeR = legacyMaeR;
  state.mfePrice = run.plan.direction === "LONG"
    ? entryPrice + legacyMfeR * state.initialRiskPrice
    : entryPrice - legacyMfeR * state.initialRiskPrice;
  state.maePrice = run.plan.direction === "LONG"
    ? entryPrice - legacyMaeR * state.initialRiskPrice
    : entryPrice + legacyMaeR * state.initialRiskPrice;
  run.performance = {
    ...legacy,
    ...state,
    samples: Number(legacy.samples ?? 0),
    mfePnl: Number(legacy.mfePnl ?? 0),
    maePnl: Number(legacy.maePnl ?? 0),
  };
  return run.performance;
}

function updateExcursions(run, position, observedAt) {
  const markPrice = Number(position?.markPrice);
  const performance = ensureRunExcursion(run);
  if (!performance || !Number.isFinite(markPrice) || markPrice <= 0) return;
  const updated = observeTradeExcursion(performance, { low: markPrice, high: markPrice, observedAt });
  const entryPrice = positiveNumber(run.entryOrder?.averagePrice, run.entryOrder?.price, run.plan?.prices?.entry);
  const quantity = Number(run.entryOrder?.executedQuantity ?? run.plan?.quantity);
  const riskAmount = Number(run.executionMetrics?.actualRiskAmount ?? run.plan?.riskAmountEstimate);
  if (![entryPrice, quantity].every(Number.isFinite) || entryPrice <= 0 || quantity <= 0) return;
  const directionSign = run.plan.direction === "LONG" ? 1 : -1;
  const excursionPnl = directionSign * (markPrice - entryPrice) * quantity;
  updated.mfePnl = Math.max(Number(performance.mfePnl ?? 0), excursionPnl);
  updated.maePnl = Math.min(Number(performance.maePnl ?? 0), excursionPnl);
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

function matchingTradePrice(result, order, fallback) {
  const ids = new Set([order?.actualOrderId, order?.orderId].filter(Boolean).map(String));
  const match = (result?.trades ?? []).find((trade) => ids.has(String(trade.orderId)) && Number(trade.price) > 0);
  return Number(match?.price) || Number(fallback) || null;
}

function finalizeRunExcursions(run, result, observedAt) {
  let performance = ensureRunExcursion(run);
  if (!performance) return;
  const tp1At = matchingTradeTime(result, run.protection?.takeProfit1);
  if (tp1At !== null && performance.timeToTp1Ms === null) {
    markRunMilestone(run, "TP1", tp1At, matchingTradePrice(result, run.protection?.takeProfit1, run.plan.prices.takeProfit1));
    performance = run.performance;
  }
  const role = result?.exitRole;
  const roleOrder = role === "operatorClose" ? run.operatorCloseOrder : run.protection?.[role];
  const exitAt = matchingTradeTime(result, roleOrder) ?? Number(observedAt);
  const fallbackPrice = role === "takeProfit2" ? run.plan.prices.takeProfit2
    : role === "takeProfit1" ? run.plan.prices.takeProfit1
      : role === "breakEvenStop" ? run.plan.prices.entry
        : role === "stop" ? run.plan.prices.stopLoss : null;
  const exitPrice = matchingTradePrice(result, roleOrder, fallbackPrice);
  if (Number.isFinite(exitPrice) && exitPrice > 0) {
    performance = observeTradeExcursion(performance, {
      low: exitPrice,
      high: exitPrice,
      observedAt: Math.max(exitAt, performance.lastObservedAt),
    });
  }
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
    this.reconciling = new Set();
    this.executing = new Set();
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
    const signalRecord = typeof this.store.getExecutionSignal === "function"
      ? await this.store.getExecutionSignal(signalId, resolvedStrategySource)
      : await this.store.getSignal(signalId);
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
    return { ...prepared, reused: false };
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

  async execute(runId, confirmationCode) {
    if (!this.enabled) throw new TestnetWriteDisabledError("executeCanary");
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
        run.status = order.status === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : order.status === "FILLED" ? "PROTECTION_PENDING" : "ENTRY_PENDING";
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
    if (this.executing.has(runId)) return await this.store.getExecutionRun(runId);
    if (this.reconciling.has(runId)) return await this.store.getExecutionRun(runId);
    this.reconciling.add(runId);
    try {
      const run = await this.store.getExecutionRun(runId);
      if (!run || TERMINAL_STATUSES.has(run.status)) return run;
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
      if (ENTRY_STATUSES.has(run.status)) return await this.reconcileEntry(run, account);
      if (PROTECTED_STATUSES.has(run.status)) return await this.reconcileProtected(run, account);
      return run;
    } finally {
      this.reconciling.delete(runId);
    }
  }

  async reconcileEntry(run, account = null) {
    const symbol = this.assertAllowedSymbol(run.symbol);
    const clientOrderId = run.plan.clientIds.entry;
    let order = (account?.openOrders ?? []).find((item) => item.symbol === symbol && item.clientOrderId === clientOrderId) ?? null;
    if (!order) order = await this.client.queryOrder(symbol, clientOrderId);
    if (!order) {
      if (run.status === "SUBMISSION_UNKNOWN") {
        const submittedAt = Number(run.entryExecution?.submittedAt);
        if (!Number.isFinite(submittedAt) || submittedAt <= 0) {
          run.status = "FAILED";
          run.performanceEligible = false;
          run.executionException = PRE_ENTRY_FAILURE_EXCEPTION;
          run.error = run.error ?? "入场订单提交前配置失败";
          run.result = { reason: "PRE_ENTRY_CONFIGURATION_FAILED", filledQuantity: 0 };
          return await this.persist(run, "PRE_ENTRY_CONFIGURATION_RECOVERED", {
            reason: run.result.reason,
            clientOrderId,
          });
        }
        if (this.now() - submittedAt < SUBMISSION_UNKNOWN_TIMEOUT_MS) return run;
        const snapshot = account ?? await this.client.fetchAccountState(symbol);
        const position = (snapshot.positions ?? []).find((item) => (
          item.symbol === symbol && Math.abs(Number(item.quantity ?? item.positionAmt ?? 0)) > 0
        ));
        const matchingOpenOrder = (snapshot.openOrders ?? []).find((item) => (
          item.symbol === symbol && item.clientOrderId === clientOrderId
        ));
        if (position || matchingOpenOrder) return run;
        run.status = "CANCELED";
        run.performanceEligible = false;
        run.error = null;
        run.entryExecution = {
          ...(run.entryExecution ?? {}),
          completedAt: this.now(),
          cancellationReason: "ENTRY_SUBMISSION_NOT_FOUND",
        };
        run.result = { reason: "ENTRY_SUBMISSION_NOT_FOUND", filledQuantity: 0 };
        return await this.persist(run, "ENTRY_SUBMISSION_ABSENCE_CONFIRMED", {
          clientOrderId,
          submittedAt,
          timeoutMs: SUBMISSION_UNKNOWN_TIMEOUT_MS,
        });
      }
      run.status = "SUBMISSION_UNKNOWN";
      run.error = "交易所暂时查不到已持久化的入场订单";
      return await this.persist(run, "ENTRY_ORDER_NOT_FOUND", { clientOrderId });
    }
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
    const filledQuantity = Number(order.executedQuantity ?? 0);
    if (filledQuantity > 0 && (order.status === "FILLED" || isTerminalOrder(order.status))) {
      const metrics = updateExecutionMetrics(run, this.minimumFillRatio);
      run.entryExecution = {
        ...(run.entryExecution ?? {}),
        completedAt: Number(order.updateTime) || this.now(),
        cancellationReason: order.status === "FILLED" ? null : cancelReason,
      };
      run.status = "PROTECTION_PENDING";
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
      const protectedRun = await this.ensureProtection(run, filledQuantity);
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
    run.protection[key] = order;
    await this.persist(run, "PROTECTION_ORDER_CONFIRMED", {
      role: key,
      clientAlgoId,
      algoId: order.algoId,
      status: order.status,
    });
    return order;
  }

  async ensureProtection(run, filledQuantity) {
    const numericPrices = {
      takeProfit1: Number(run.plan.prices.takeProfit1),
      takeProfit2: Number(run.plan.prices.takeProfit2),
    };
    const split = splitFilledQuantity(filledQuantity, { ...numericPrices, rules: run.plan.rules });
    run.protection.mode = split.mode;
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
    try {
      await this.ensureAlgo(run, "takeProfit2", (clientAlgoId) => this.client.placeTakeProfitClose({
        symbol: run.symbol,
        side: run.plan.exitSide,
        triggerPrice: run.plan.prices.takeProfit2,
        clientAlgoId,
      }));
      if (split.mode === "TWO_TARGETS") {
        const quantity = formatToStep(split.takeProfit1Quantity, run.plan.rules.stepSize);
        await this.ensureAlgo(run, "takeProfit1", (clientAlgoId) => this.client.placeTakeProfitClose({
          symbol: run.symbol,
          side: run.plan.exitSide,
          triggerPrice: run.plan.prices.takeProfit1,
          clientAlgoId,
          quantity,
        }));
      }
      run.status = "OPEN_PROTECTED";
      run.protection.phase = "INITIAL_COMPLETE";
      run.error = null;
      await this.persist(run, "POSITION_PROTECTED", { mode: split.mode, filledQuantity });
      return run;
    } catch (error) {
      run.status = "PROTECTION_INCOMPLETE";
      run.error = errorMessage(error);
      await this.persist(run, "TAKE_PROFIT_PROTECTION_INCOMPLETE", { message: run.error });
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
      const clientAlgoId = run.plan.clientIds[key];
      if (!clientAlgoId) return [key, null];
      const active = activeByClientId.get(String(clientAlgoId));
      if (active) return [key, active];
      return [key, await this.client.queryAlgoOrder(clientAlgoId)];
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
    const rows = await this.client.listUserTrades(run.symbol, { startTime: Math.max(0, run.createdAt - 60_000) });
    const entryOrderIds = new Set([run.entryOrder?.orderId].filter(Boolean).map(String));
    const exitOrderIds = new Set([
      run.operatorCloseOrder?.orderId,
      ...Object.values(run.protection ?? {}).flatMap((order) => {
        if (!order || typeof order !== "object") return [];
        return [order.actualOrderId, order.orderId].filter(Boolean);
      }),
    ].filter(Boolean).map(String));
    const ownedOrderIds = new Set([...entryOrderIds, ...exitOrderIds]);
    const trades = rows.filter((trade) => ownedOrderIds.has(String(trade.orderId)));
    let incomeRows = [];
    let fundingComplete = true;
    if (typeof this.client.listIncomeHistory === "function") {
      try {
        incomeRows = await this.client.listIncomeHistory(run.symbol, {
          incomeType: "FUNDING_FEE",
          startTime: Math.max(0, run.createdAt - 60_000),
          endTime: this.now(),
        });
      } catch (error) {
        fundingComplete = false;
        await this.store.appendExecutionAudit(run.id, "FUNDING_ACCOUNTING_PENDING", { message: errorMessage(error) }, this.now());
      }
    }
    const fundingPnl = incomeRows.reduce((sum, item) => sum + (Number(item.income) || 0), 0);
    const tradedOrderIds = new Set(trades.map((trade) => String(trade.orderId)));
    return {
      trades,
      fundingIncome: incomeRows,
      fundingPnl,
      fundingComplete,
      ownedOrderIds: [...ownedOrderIds],
      accountingComplete: fundingComplete && entryOrderIds.size > 0
        && exitOrderIds.size > 0
        && [...entryOrderIds].every((orderId) => tradedOrderIds.has(orderId))
        && [...exitOrderIds].every((orderId) => tradedOrderIds.has(orderId)),
    };
  }

  buildRunResult({ trades, fundingIncome = [], fundingPnl = 0, ownedOrderIds = [], accountingComplete = false }, run) {
    const commission = trades.reduce((sum, item) => sum + (item.commission ?? 0), 0);
    const realizedPnl = trades.reduce((sum, item) => sum + (item.realizedPnl ?? 0), 0);
    const entryOrderIds = new Set([run.entryOrder?.orderId].filter(Boolean).map(String));
    const exitOrderIds = new Set(trades
      .filter((trade) => !entryOrderIds.has(String(trade.orderId)))
      .map((trade) => String(trade.orderId)));
    const roleOrderIds = {
      stop: run.protection?.stop?.actualOrderId ?? run.protection?.stop?.orderId,
      breakEvenStop: run.protection?.breakEvenStop?.actualOrderId ?? run.protection?.breakEvenStop?.orderId,
      takeProfit1: run.protection?.takeProfit1?.actualOrderId ?? run.protection?.takeProfit1?.orderId,
      takeProfit2: run.protection?.takeProfit2?.actualOrderId ?? run.protection?.takeProfit2?.orderId,
      operatorClose: run.operatorCloseOrder?.orderId,
    };
    const exitRole = ["operatorClose", "breakEvenStop", "stop", "takeProfit2", "takeProfit1"]
      .find((role) => roleOrderIds[role] && exitOrderIds.has(String(roleOrderIds[role]))) ?? null;
    return {
      reason: "EXCHANGE_POSITION_CLOSED",
      exitRole,
      exitReason: reasonForExitRole(run.plan.orderReasons, exitRole)
        ?? "交易所确认系统仓位已经关闭，因此结束本次Binance Demo交易。",
      commission,
      realizedPnl,
      fundingPnl,
      fundingIncome,
      netPnl: accountingComplete ? realizedPnl - commission + fundingPnl : null,
      trades,
      ownedOrderIds,
      accountingComplete,
    };
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
    if (!position) {
      for (const [role, order] of Object.entries(protection)) await this.cancelAlgoIfActive(run, role, order);
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
      markRunMilestone(run, "TP1", tp1At, run.plan.prices.takeProfit1);
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
    if (["PROTECTION_PENDING", "PROTECTION_INCOMPLETE"].includes(run.status)
      && run.protection.phase !== "BREAKEVEN_PENDING" && !tp1Filled) {
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
    run.status = tp1Filled ? "TP1_FILLED" : "OPEN_PROTECTED";
    run.error = null;
    return await this.persist(run, "POSITION_RECONCILED", { quantity: position.quantity, status: run.status });
  }

  async closeExecutionRun(runId, reason = null) {
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
    const [account, activeRuns] = await Promise.all([
      this.client.fetchAccountState(this.operatorSymbol),
      this.store.listActiveExecutionRuns(),
    ]);
    const classification = classifyExecutionAccountState(account, activeRuns);
    const unsafeRuns = activeRuns.filter((run) => [
      "ENTRY_SUBMITTING",
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
