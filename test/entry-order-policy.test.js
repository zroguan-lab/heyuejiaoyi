import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKETABLE_LIMIT_IOC,
  buildEntryOrderRequest,
  buildEntryPolicy,
  entryOrderExpiresAt,
  pendingEntryInvalidation,
  resolveEntryPolicy,
} from "../src/execution/entry-order-policy.js";

function plan({ direction = "LONG", strategy = "BREAKOUT", entry = "100.00", stopLoss = "98.00", policy = null } = {}) {
  return {
    strategy,
    direction,
    entrySide: direction === "LONG" ? "BUY" : "SELL",
    expiresAt: 1_000_000,
    entryPolicy: policy,
    prices: { entry, stopLoss },
    rules: { tickSize: 0.01 },
  };
}

test("突破入场以计划价为硬滑点边界而不是无上限追价", () => {
  const entryPolicy = buildEntryPolicy({ strategy: "BREAKOUT", signalExpiresAt: 1_000_000, now: 100, activeLimitMaxBps: 10 });
  const accepted = buildEntryOrderRequest(plan({ policy: entryPolicy }), { bidPrice: 100.04, askPrice: 100.05 });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.timeInForce, "IOC");
  assert.equal(accepted.price, "100.10");

  const rejected = buildEntryOrderRequest(plan({ policy: entryPolicy }), { bidPrice: 100.11, askPrice: 100.12 });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET");
});

test("V2.3爆发前布局使用受滑点约束的IOC限价", () => {
  const entryPolicy = buildEntryPolicy({ strategy: "PRE_BREAKOUT", signalExpiresAt: 1_000_000, now: 100, activeLimitMaxBps: 10 });
  assert.equal(entryPolicy.mode, MARKETABLE_LIMIT_IOC);
  assert.equal(entryPolicy.timeInForce, "IOC");
  assert.equal(entryPolicy.maxAdverseSlippageBps, 10);
});

test("做空突破使用计划价下方的滑点边界", () => {
  const entryPolicy = buildEntryPolicy({ strategy: "BREAKOUT", signalExpiresAt: 1_000_000, now: 100, activeLimitMaxBps: 10 });
  const accepted = buildEntryOrderRequest(plan({ direction: "SHORT", entry: "100.00", stopLoss: "102.00", policy: entryPolicy }), {
    bidPrice: 99.95,
    askPrice: 99.96,
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.price, "99.90");
});

test("回调入场使用三分钟 GTC 且价格穿过止损即失效", () => {
  const entryPolicy = buildEntryPolicy({
    strategy: "PULLBACK",
    signalExpiresAt: 1_000_000,
    now: 100_000,
    pullbackEntryTtlMs: 180_000,
  });
  const pullbackPlan = plan({ strategy: "PULLBACK", policy: entryPolicy });
  const request = buildEntryOrderRequest(pullbackPlan);
  assert.equal(request.timeInForce, "GTC");
  assert.equal(request.price, "100.00");
  assert.equal(entryOrderExpiresAt(pullbackPlan), 280_000);
  assert.equal(pendingEntryInvalidation(pullbackPlan, 99), null);
  assert.deepEqual(pendingEntryInvalidation(pullbackPlan, 98), { reason: "SETUP_INVALIDATED", markPrice: 98, stopLoss: 98 });
});

test("旧执行计划没有新策略字段时保持原 IOC 语义", () => {
  const legacyPlan = plan();
  delete legacyPlan.entryPolicy;
  assert.equal(resolveEntryPolicy(legacyPlan).mode, "LEGACY_LIMIT_IOC");
  assert.equal(buildEntryOrderRequest(legacyPlan).timeInForce, "IOC");
});
