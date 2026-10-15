import test from "node:test";
import assert from "node:assert/strict";
import { advanceTrade, advanceTradeTimeline, applyFundingEvents, createManualTrade, createSimulatedTrade } from "../src/domain/trade-lifecycle.js";

function candidate(overrides = {}) {
  return {
    id: "signal-1",
    symbol: "BTCUSDT",
    strategy: "BREAKOUT",
    direction: "LONG",
    status: "CANDIDATE",
    triggerTime: 1_000,
    order: { entry: 100, expiresAt: 20_000 },
    risk: { entry: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 105 },
    ...overrides,
  };
}

test("固定10U保证金和10倍杠杆产生100U名义仓位", () => {
  const trade = createSimulatedTrade(candidate(), { margin: 10, leverage: 10, feeRate: 0 });
  assert.equal(trade.notional, 100);
  assert.equal(trade.quantity, 1);
  assert.equal(trade.riskAmount, 2);
});

test("未触及限价且到期的订单记为未成交而不是亏损", () => {
  const trade = createSimulatedTrade(candidate(), { feeRate: 0, slippageRate: 0.001 });
  const result = advanceTrade(trade, [{ openTime: 20_000, closeTime: 21_000, open: 101, high: 102, low: 100.5, close: 101 }]);
  assert.equal(result.status, "EXPIRED");
  assert.equal(result.exitReason, "ENTRY_NOT_FILLED");
  assert.equal(result.pnl.net, 0);
  assert.equal(result.costs.slippage, 0);
});

test("滑点只在实际成交后计入，且按名义成交额计算", () => {
  const trade = createSimulatedTrade(candidate(), { feeRate: 0, slippageRate: 0.001 });
  const result = advanceTrade(trade, [{ openTime: 2_000, closeTime: 3_000, open: 100, high: 101, low: 99, close: 100 }]);
  assert.equal(result.status, "OPEN");
  assert.equal(result.costs.slippage, 0.1);
});

test("同根K线同时触及止损止盈时按止损优先", () => {
  const trade = createSimulatedTrade(candidate(), { feeRate: 0 });
  const result = advanceTrade(trade, [{ openTime: 2_000, closeTime: 3_000, open: 100, high: 104, low: 97, close: 101 }]);
  assert.equal(result.status, "CLOSED");
  assert.equal(result.exitReason, "AMBIGUOUS_STOP_FIRST");
  assert.equal(result.pnl.netR, -1);
});

test("TP1平半仓后剩余仓位移动到保本并可完成TP2", () => {
  const trade = createSimulatedTrade(candidate(), { feeRate: 0 });
  const afterTp1 = advanceTrade(trade, [{ openTime: 2_000, closeTime: 3_000, open: 100, high: 103.5, low: 99, close: 103 }]);
  assert.equal(afterTp1.status, "TP1_FILLED");
  assert.equal(afterTp1.currentStop, 100);
  assert.equal(afterTp1.remainingFraction, 0.5);
  const completed = advanceTrade(afterTp1, [{ openTime: 4_000, closeTime: 5_000, open: 103, high: 105.5, low: 102, close: 105 }]);
  assert.equal(completed.status, "CLOSED");
  assert.equal(completed.exitReason, "TAKE_PROFIT_2");
  assert.equal(completed.pnl.netR, 2);
});

test("手动跟单使用实际成交价和数量独立计算结果", () => {
  const trade = createManualTrade(candidate(), { id: "manual-1", fillPrice: 101, quantity: 0.2, feeRate: 0, createdAt: 1000 });
  assert.equal(trade.manual, true);
  assert.equal(trade.notional, 20.2);
  assert.ok(Math.abs(trade.riskAmount - 0.6) < 1e-10);
  const result = advanceTrade(trade, [{ openTime: 2_000, closeTime: 3_000, open: 101, high: 101.5, low: 97.5, close: 98 }]);
  assert.equal(result.exitReason, "STOP_LOSS");
  assert.equal(result.pnl.netR, -1);
});

test("资金费率按方向、剩余仓位和标记价格计入净成本且不会重复", () => {
  const pending = createSimulatedTrade(candidate(), { feeRate: 0 });
  const opened = advanceTrade(pending, [{ openTime: 2_000, closeTime: 3_000, open: 100, high: 101, low: 99, close: 100 }]);
  const charged = applyFundingEvents(opened, [{ fundingTime: 4_000, rate: 0.001, markPrice: 100 }]);
  assert.equal(charged.costs.funding, 0.1);
  const duplicate = applyFundingEvents(charged, [{ fundingTime: 4_000, rate: 0.001, markPrice: 100 }]);
  assert.equal(duplicate.costs.funding, 0.1);
  const closed = advanceTradeTimeline(duplicate, [{ openTime: 5_000, closeTime: 6_000, open: 100, high: 101, low: 97, close: 98 }]);
  assert.equal(closed.pnl.net, -2.1);
});
