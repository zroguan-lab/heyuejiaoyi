import assert from "node:assert/strict";
import test from "node:test";
import { validateCloseRecovery, validateCloseTarget } from "../scripts/close-live-strategy-run.js";

function fixture() {
  const run = {
    id: "canary-abc",
    symbol: "BCHUSDT",
    sourceType: "SIGNAL",
    performanceEligible: true,
    status: "OPEN_PROTECTED",
    entryOrder: { orderId: "entry-1" },
    plan: {
      direction: "SHORT",
      rules: { stepSize: 0.001 },
      clientIds: { stop: "cfs-abc-sl", breakEvenStop: "cfs-abc-slbe", operatorClose: null },
    },
  };
  const account = {
    environment: "TESTNET",
    authority: "BINANCE_TESTNET",
    positionMode: "ONE_WAY",
    positions: [{ symbol: "BCHUSDT", quantity: -0.324, marginType: "ISOLATED" }],
    openOrders: [],
    openAlgoOrders: [{
      symbol: "BCHUSDT", clientAlgoId: "cfs-abc-sl", type: "STOP_MARKET",
      closePosition: true, status: "NEW",
    }],
  };
  return { run, account };
}

test("一次性受控平仓只接受已确认的 Demo 策略仓位和活动全量止损", () => {
  const input = fixture();
  const result = validateCloseTarget({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.324 });
  assert.equal(result.signedQuantity, -0.324);
  assert.equal(result.activeStopClientAlgoId, "cfs-abc-sl");
  input.run.status = "PROTECTION_INCOMPLETE";
  const recoverable = validateCloseTarget({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.324 });
  assert.equal(recoverable.status, "PROTECTION_INCOMPLETE");
});

test("数量、方向或保护不一致时一次性平仓在提交前失败", () => {
  const input = fixture();
  assert.throws(() => validateCloseTarget({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.5 }), /数量/);
  input.account.positions[0].quantity = 0.324;
  assert.throws(() => validateCloseTarget({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.324 }), /空头/);
  input.account.positions[0].quantity = -0.324;
  input.account.openAlgoOrders = [];
  assert.throws(() => validateCloseTarget({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.324 }), /活动全量止损/);
});

test("已成交唯一 reduceOnly 平仓单且仓位归零时只进入恢复对账", () => {
  const input = fixture();
  input.run.status = "OPERATOR_CLOSE_PENDING";
  input.run.plan.exitSide = "BUY";
  input.run.plan.clientIds.operatorClose = "cfs-abc-close";
  input.run.operatorCloseOrder = {
    orderId: "close-1", clientOrderId: "cfs-abc-close", side: "BUY", status: "FILLED",
    executedQuantity: 0.324, reduceOnly: true,
  };
  input.account.positions = [];
  input.account.openAlgoOrders = [];
  const result = validateCloseRecovery({ ...input, expectedSymbol: "BCHUSDT", expectedDirection: "SHORT", expectedQuantity: 0.324 });
  assert.equal(result.recovering, true);
  assert.equal(result.closeOrderId, "close-1");
});
