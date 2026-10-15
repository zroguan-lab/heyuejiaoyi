import test from "node:test";
import assert from "node:assert/strict";
import { assessTestnetReadiness } from "../src/execution/readiness.js";

const safeGateway = {
  environment: "TESTNET",
  orderSubmissionEnabled: false,
};

test("双向模式和既有持仓会阻止进入单币测试准备阶段", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: safeGateway,
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: true },
      positionMode: "HEDGE",
      positions: [{ symbol: "DOGEUSDT" }],
      openOrders: [],
      openAlgoOrders: [],
    },
  });

  assert.equal(result.canPrepareCanary, false);
  assert.deepEqual(
    result.blockedReasons.map((item) => item.code),
    ["ONE_WAY_MODE", "NO_EXISTING_POSITIONS"],
  );
});

test("空仓单向账户可以准备单币测试但仍保持下单关闭", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: safeGateway,
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: true },
      positionMode: "ONE_WAY",
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
    },
  });

  assert.equal(result.canPrepareCanary, true);
  assert.equal(result.orderSubmissionEnabled, false);
  assert.deepEqual(result.blockedReasons, []);
});

test("账户未开放交易权限时即使空仓单向也必须阻止试单", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: safeGateway,
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: false },
      positionMode: "ONE_WAY",
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
    },
  });
  assert.equal(result.canPrepareCanary, false);
  assert.deepEqual(result.blockedReasons.map((item) => item.code), ["ACCOUNT_CAN_TRADE"]);
});

test("Demo canTrade 异常为 false 时允许当前密钥的新鲜安全探针作为权限事实", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: safeGateway,
    permissionProbe: { valid: true },
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: false },
      positionMode: "ONE_WAY",
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
    },
  });
  assert.equal(result.canPrepareCanary, true);
  assert.equal(result.tradePermissionSource, "ORDER_TEST_PROBE");
});

test("解锁金丝雀写入时就绪状态必须如实反映，但不把写入锁当作准备阻塞项", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: { environment: "TESTNET", orderSubmissionEnabled: true },
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: true },
      positionMode: "ONE_WAY",
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
    },
  });

  assert.equal(result.phase, "CANARY_ARMED");
  assert.equal(result.canPrepareCanary, true);
  assert.equal(result.orderSubmissionEnabled, true);
  assert.deepEqual(result.blockedReasons, []);
  assert.deepEqual(result.safetyLocks, [{
    code: "ORDER_LOCK_ACTIVE",
    passed: false,
      message: "策略测试网写入锁已解锁；仅允许已确认的单币执行计划",
  }]);
});

test("自动执行在canTrade异常为false时如实显示每笔信号都会重新做安全权限预检", () => {
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: {
      environment: "TESTNET",
      orderSubmissionEnabled: true,
      permissionCheckMode: "ORDER_TEST_PER_SIGNAL",
    },
    account: {
      enabled: true,
      connected: true,
      account: { canTrade: false },
      positionMode: "ONE_WAY",
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
    },
  });
  assert.equal(result.canPrepareCanary, true);
  assert.equal(result.tradePermissionSource, "ORDER_TEST_PER_SIGNAL");
  assert.deepEqual(result.blockedReasons, []);
});

test("多仓模式允许系统已归属且有止损的其他标的仓位", () => {
  const run = {
    id: "run-btc",
    symbol: "BTCUSDT",
    status: "OPEN_PROTECTED",
    entryOrder: { orderId: "entry-order", executedQuantity: 0.01 },
    plan: {
      direction: "LONG",
      exitSide: "SELL",
      leverage: 10,
      quantity: "0.01",
      clientIds: { entry: "entry", stop: "stop", breakEvenStop: "be", takeProfit1: "tp1", takeProfit2: "tp2" },
    },
  };
  const result = assessTestnetReadiness({
    credentialsConfigured: true,
    gateway: { environment: "TESTNET", orderSubmissionEnabled: true, positionPolicy: "ALL_ELIGIBLE" },
    activeRuns: [run],
    account: {
      enabled: true,
      connected: true,
      environment: "TESTNET",
      authority: "BINANCE_TESTNET",
      account: { canTrade: true },
      positionMode: "ONE_WAY",
      positions: [{ symbol: "BTCUSDT", quantity: 0.01, marginType: "isolated", leverage: 10 }],
      openOrders: [],
      openAlgoOrders: [{
        symbol: "BTCUSDT",
        clientAlgoId: "stop",
        type: "STOP_MARKET",
        status: "NEW",
        side: "SELL",
        closePosition: true,
      }],
    },
  });

  assert.equal(result.canPrepareCanary, true);
  assert.equal(result.ownership.safe, true);
  assert.deepEqual(result.blockedReasons, []);
});
