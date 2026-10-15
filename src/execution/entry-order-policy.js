import { ceilToStep, floorToStep, formatToStep } from "./contract-rules.js";

export const MARKETABLE_LIMIT_IOC = "MARKETABLE_LIMIT_IOC";
export const PASSIVE_LIMIT_GTC = "PASSIVE_LIMIT_GTC";
export const LEGACY_LIMIT_IOC = "LEGACY_LIMIT_IOC";

const SUPPORTED_TIME_IN_FORCE = new Set(["IOC", "GTC"]);

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${label} 必须是正数`);
  return number;
}

function boundedNumber(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new TypeError(`${label} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  return number;
}

export function buildEntryPolicy({
  strategy,
  signalExpiresAt,
  now = Date.now(),
  activeLimitMaxBps = 10,
  pullbackEntryTtlMs = 180_000,
} = {}) {
  const expiresAt = positiveNumber(signalExpiresAt, "信号过期时间");
  if (strategy === "PULLBACK") {
    const ttlMs = boundedNumber(pullbackEntryTtlMs, "回调限价等待时间", { min: 30_000, max: 15 * 60_000 });
    return Object.freeze({
      mode: PASSIVE_LIMIT_GTC,
      timeInForce: "GTC",
      priceSource: "SIGNAL_ENTRY",
      maxAdverseSlippageBps: null,
      expiresAt: Math.min(expiresAt, now + ttlMs),
    });
  }
  if (!new Set(["BREAKOUT", "PRE_BREAKOUT", "OPERATOR_CANARY"]).has(strategy)) {
    throw new Error(`不支持的入场执行策略: ${strategy ?? "UNKNOWN"}`);
  }
  return Object.freeze({
    mode: MARKETABLE_LIMIT_IOC,
    timeInForce: "IOC",
    priceSource: "BINANCE_DEMO_BOOK_TICKER",
    maxAdverseSlippageBps: boundedNumber(activeLimitMaxBps, "突破最大不利滑点", { min: 1, max: 100 }),
    expiresAt,
  });
}

export function resolveEntryPolicy(plan) {
  const policy = plan?.entryPolicy;
  if (!policy) {
    return {
      mode: LEGACY_LIMIT_IOC,
      timeInForce: "IOC",
      priceSource: "LEGACY_PLAN_PRICE",
      maxAdverseSlippageBps: null,
      expiresAt: Number(plan?.expiresAt),
    };
  }
  if (!new Set([MARKETABLE_LIMIT_IOC, PASSIVE_LIMIT_GTC]).has(policy.mode)) {
    throw new Error(`未知入场执行模式: ${policy.mode ?? "UNKNOWN"}`);
  }
  if (!SUPPORTED_TIME_IN_FORCE.has(policy.timeInForce)) throw new Error(`不支持的订单有效方式: ${policy.timeInForce}`);
  return policy;
}

export function entryOrderExpiresAt(plan) {
  const policyExpiry = Number(resolveEntryPolicy(plan).expiresAt);
  const planExpiry = Number(plan?.expiresAt);
  if (Number.isFinite(policyExpiry) && policyExpiry > 0) return policyExpiry;
  return planExpiry;
}

export function buildEntryOrderRequest(plan, bookTicker = null) {
  const policy = resolveEntryPolicy(plan);
  const plannedPrice = positiveNumber(plan?.prices?.entry, "计划入场价");
  const tickSize = positiveNumber(plan?.rules?.tickSize, "价格步进");
  if (policy.mode !== MARKETABLE_LIMIT_IOC) {
    return {
      accepted: true,
      mode: policy.mode,
      timeInForce: policy.timeInForce,
      price: formatToStep(plannedPrice, tickSize),
      plannedPrice,
      referencePrice: null,
      spreadBps: null,
      observedAdverseBps: 0,
      maxAdverseSlippageBps: null,
    };
  }

  const bidPrice = positiveNumber(bookTicker?.bidPrice, "买一价");
  const askPrice = positiveNumber(bookTicker?.askPrice, "卖一价");
  if (bidPrice > askPrice) throw new Error("Binance Demo 盘口买一价高于卖一价");
  const maxBps = boundedNumber(policy.maxAdverseSlippageBps, "突破最大不利滑点", { min: 1, max: 100 });
  const mid = (bidPrice + askPrice) / 2;
  const spreadBps = ((askPrice - bidPrice) / mid) * 10_000;
  const isBuy = plan.entrySide === "BUY";
  if (!isBuy && plan.entrySide !== "SELL") throw new Error(`无效入场方向: ${plan.entrySide ?? "UNKNOWN"}`);
  const referencePrice = isBuy ? askPrice : bidPrice;
  const observedAdverseBps = isBuy
    ? ((referencePrice - plannedPrice) / plannedPrice) * 10_000
    : ((plannedPrice - referencePrice) / plannedPrice) * 10_000;
  const limitPrice = isBuy
    ? floorToStep(plannedPrice * (1 + maxBps / 10_000), tickSize)
    : ceilToStep(plannedPrice * (1 - maxBps / 10_000), tickSize);
  const marketable = isBuy ? limitPrice >= askPrice : limitPrice <= bidPrice;
  if (!marketable) {
    return {
      accepted: false,
      reason: "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET",
      mode: policy.mode,
      timeInForce: policy.timeInForce,
      price: formatToStep(limitPrice, tickSize),
      plannedPrice,
      referencePrice,
      bidPrice,
      askPrice,
      spreadBps,
      observedAdverseBps,
      maxAdverseSlippageBps: maxBps,
    };
  }
  return {
    accepted: true,
    mode: policy.mode,
    timeInForce: policy.timeInForce,
    price: formatToStep(limitPrice, tickSize),
    plannedPrice,
    referencePrice,
    bidPrice,
    askPrice,
    spreadBps,
    observedAdverseBps,
    maxAdverseSlippageBps: maxBps,
  };
}

export function pendingEntryInvalidation(plan, markPrice) {
  const policy = resolveEntryPolicy(plan);
  if (policy.mode !== PASSIVE_LIMIT_GTC) return null;
  const mark = positiveNumber(markPrice, "标记价格");
  const stopLoss = positiveNumber(plan?.prices?.stopLoss, "止损价");
  const invalidated = plan.direction === "LONG" ? mark <= stopLoss : mark >= stopLoss;
  return invalidated ? { reason: "SETUP_INVALIDATED", markPrice: mark, stopLoss } : null;
}
