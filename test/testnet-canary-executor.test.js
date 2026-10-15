import test from "node:test";
import assert from "node:assert/strict";
import { TestnetCanaryExecutor } from "../src/execution/testnet-canary-executor.js";
import { BinanceApiError, TestnetWriteDisabledError } from "../src/execution/binance-testnet-trading.js";

function symbolInfo(symbol = "BTCUSDT") {
  if (symbol !== "BTCUSDT") {
    return {
      symbol, quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000", tickSize: "0.000001" },
        { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000000", stepSize: "1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    };
  }
  return {
    symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "100", maxPrice: "1000000", tickSize: "0.10" },
      { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000", stepSize: "0.0001" },
      { filterType: "MIN_NOTIONAL", notional: "50" },
    ],
  };
}

function signalRecord(now, { symbol = "BTCUSDT", direction = "LONG", strategy = "BREAKOUT" } = {}) {
  const alt = symbol !== "BTCUSDT";
  return {
    selected: true,
    candidate: { id: alt ? "ake-signal-exec" : "btc-signal-exec", symbol, direction, strategy },
    trade: {
      signalId: alt ? "ake-signal-exec" : "btc-signal-exec", symbol, direction, status: "ENTRY_PENDING",
      entryPrice: alt ? 0.0296641 : 85_000,
      stopLoss: alt ? 0.030395 : 84_000,
      takeProfit1: alt ? 0.02856775 : 87_000,
      takeProfit2: alt ? 0.02783685 : 89_000,
      expiresAt: now + 120_000,
    },
  };
}

class MemoryStore {
  constructor(signal) {
    this.signal = signal;
    this.runs = new Map();
    this.audit = [];
    this.metadata = new Map();
  }
  async getSignal(signalId) {
    const signal = structuredClone(this.signal);
    signal.candidate.id = signalId;
    signal.trade.signalId = signalId;
    return signal;
  }
  async getExecutionRunBySignal(signalId) { return structuredClone([...this.runs.values()].find((run) => run.signalId === signalId) ?? null); }
  async createExecutionRun(run) {
    const existing = [...this.runs.values()].find((item) => item.signalId === run.signalId);
    if (existing) return { created: false, run: structuredClone(existing) };
    this.runs.set(run.id, structuredClone(run));
    return { created: true, run: structuredClone(run) };
  }
  async saveExecutionRun(run) { this.runs.set(run.id, structuredClone(run)); return run; }
  async getExecutionRun(id) { return structuredClone(this.runs.get(id) ?? null); }
  async listExecutionRuns() { return structuredClone([...this.runs.values()]); }
  async listActiveExecutionRuns() { return structuredClone([...this.runs.values()].filter((run) => !["CLOSED", "CANCELED", "REJECTED", "FAILED"].includes(run.status))); }
  async appendExecutionAudit(runId, eventType, payload, createdAt) { this.audit.push({ runId, eventType, payload, createdAt }); }
  async getMetadata(key) { return this.metadata.has(key) ? { value: structuredClone(this.metadata.get(key)) } : null; }
  async setMetadata(key, value) { this.metadata.set(key, structuredClone(value)); }
}

class FakeTradingClient {
  constructor() {
    this.account = {
      environment: "TESTNET", authority: "BINANCE_TESTNET", canTrade: true, availableBalance: 100,
      positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [],
      symbolConfig: { symbol: "BTCUSDT", marginType: "CROSSED", leverage: 20 },
    };
    this.order = null;
    this.algos = new Map();
    this.calls = { placeEntry: 0, cancelEntry: 0, placeAlgo: [], cancelAlgo: [], leverage: [], marginType: [], sequence: [], accountOverview: 0 };
    this.credentialFingerprint = "fake-credential-hash";
    this.failEntryUnknown = false;
    this.fillEntryImmediately = false;
    this.failStop = false;
    this.failBreakEven = false;
    this.marginTypeUnknownOnce = false;
    this.leverageUnknownOnce = false;
    this.cancelUnknownOnce = false;
    this.delayedCanceledAlgo = null;
    this.delayedCanceledQueries = 0;
    this.hideAlgoTrades = false;
    this.externalTrades = [];
    this.bookTicker = { symbol: "BTCUSDT", bidPrice: 84_999, askPrice: 85_000, spreadBps: 0.117647 };
    this.markPrice = 85_000;
    this.maximumLeverage = 125;
  }
  async fetchAccountState(symbol = "BTCUSDT") {
    return structuredClone({ ...this.account, symbolConfig: { ...this.account.symbolConfig, symbol } });
  }
  async fetchAccountOverview() {
    this.calls.accountOverview += 1;
    return structuredClone({ ...this.account, symbolConfig: null });
  }
  async fetchExchangeInfo(symbol = "BTCUSDT") { return symbolInfo(symbol); }
  async fetchLeverageBrackets(symbol = "BTCUSDT") {
    return {
      symbol,
      brackets: [{
        bracket: 1,
        initialLeverage: this.maximumLeverage,
        notionalFloor: 0,
        notionalCap: 1_000_000_000,
        maintMarginRatio: 0.004,
        cum: 0,
      }],
    };
  }
  async fetchMarkPrice() { return this.markPrice; }
  async fetchBookTicker(symbol = "BTCUSDT") {
    if (symbol !== "BTCUSDT") return { symbol, bidPrice: 0.029665, askPrice: 0.029666, spreadBps: 0.337 };
    return structuredClone({ ...this.bookTicker, symbol });
  }
  async testLimitOrderPermission() { this.calls.permissionTests = (this.calls.permissionTests ?? 0) + 1; return { accepted: true }; }
  async queryOrder(_symbol, clientOrderId) {
    return structuredClone(clientOrderId?.includes("-close") ? (this.closeOrder ?? null) : this.order);
  }
  async placeLimitOrder({ symbol, side, quantity, price, clientOrderId, timeInForce = "IOC" }) {
    this.calls.placeEntry += 1;
    this.calls.lastEntryRequest = { symbol, side, quantity, price, clientOrderId, timeInForce };
    if (this.failEntryUnknown) throw new Error("socket timeout");
    this.order = {
      symbol, side, originalQuantity: Number(quantity), executedQuantity: this.fillEntryImmediately ? Number(quantity) : 0,
      price: Number(price), averagePrice: this.fillEntryImmediately ? Number(price) : 0,
      clientOrderId, orderId: "1", status: this.fillEntryImmediately ? "FILLED" : "NEW", timeInForce,
    };
    if (this.fillEntryImmediately) this.account.positions = [{ symbol, quantity: Number(quantity), positionSide: "BOTH" }];
    return structuredClone(this.order);
  }
  async cancelOrder() {
    this.calls.cancelEntry += 1;
    this.order = { ...this.order, status: "CANCELED" };
    return structuredClone(this.order);
  }
  async closePositionMarket({ symbol, side, quantity, clientOrderId }) {
    this.calls.closeMarket = (this.calls.closeMarket ?? 0) + 1;
    this.closeOrder = {
      symbol, side, originalQuantity: Number(quantity), executedQuantity: Number(quantity), averagePrice: 85_000,
      clientOrderId, orderId: "close-1", status: "FILLED", type: "MARKET", reduceOnly: true,
    };
    this.account.positions = [];
    return structuredClone(this.closeOrder);
  }
  async queryAlgoOrder(clientAlgoId) {
    if (this.delayedCanceledAlgo === clientAlgoId) {
      this.delayedCanceledQueries += 1;
      if (this.delayedCanceledQueries >= 2) {
        const current = this.algos.get(clientAlgoId);
        if (current) this.algos.set(clientAlgoId, { ...current, status: "EXPIRED" });
        this.delayedCanceledAlgo = null;
      }
    }
    return structuredClone(this.algos.get(clientAlgoId) ?? null);
  }
  async placeStopClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    this.calls.placeAlgo.push({ role: "stop", clientAlgoId, quantity });
    this.calls.sequence.push(`place:${clientAlgoId}`);
    if (this.failStop || (this.failBreakEven && clientAlgoId.endsWith("-slbe"))) throw new Error("stop rejected");
    const order = {
      symbol, side, triggerPrice: Number(triggerPrice), clientAlgoId, algoId: String(this.algos.size + 1), status: "NEW",
      type: "STOP_MARKET", closePosition: quantity === null, quantity: quantity === null ? null : Number(quantity), reduceOnly: true,
    };
    this.algos.set(clientAlgoId, order);
    return structuredClone(order);
  }
  async placeTakeProfitClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    this.calls.placeAlgo.push({ role: quantity === null ? "tp2" : "tp1", clientAlgoId, quantity });
    const order = { symbol, side, triggerPrice: Number(triggerPrice), clientAlgoId, algoId: String(this.algos.size + 1), status: "NEW", type: "TAKE_PROFIT_MARKET", closePosition: quantity === null, quantity: quantity === null ? null : Number(quantity), reduceOnly: true };
    this.algos.set(clientAlgoId, order);
    return structuredClone(order);
  }
  async cancelAlgoOrder(clientAlgoId) {
    this.calls.cancelAlgo.push(clientAlgoId);
    this.calls.sequence.push(`cancel:${clientAlgoId}`);
    if (this.cancelUnknownOnce) {
      this.cancelUnknownOnce = false;
      this.delayedCanceledAlgo = clientAlgoId;
      this.delayedCanceledQueries = 0;
      const error = new Error("Unknown order sent");
      error.apiCode = -2011;
      throw error;
    }
    const order = this.algos.get(clientAlgoId);
    if (order) this.algos.set(clientAlgoId, { ...order, status: "CANCELED" });
    return { code: 200 };
  }
  async setMarginType(_symbol, value) {
    this.calls.marginType.push(value);
    this.account.symbolConfig.marginType = value;
    if (this.marginTypeUnknownOnce) {
      this.marginTypeUnknownOnce = false;
      throw new BinanceApiError({ status: 400, code: -1000, message: "unknown" });
    }
    return { code: 200 };
  }
  async setLeverage(_symbol, value) {
    this.calls.leverage.push(value);
    this.account.symbolConfig.leverage = value;
    if (this.leverageUnknownOnce) {
      this.leverageUnknownOnce = false;
      throw new BinanceApiError({ status: 400, code: -1000, message: "unknown" });
    }
    return { leverage: value };
  }
  async listUserTrades() {
    const rows = [{ id: "t1", orderId: this.order?.orderId, commission: 0.04, realizedPnl: 0, time: 9_000_000 }];
    if (this.closeOrder) rows.push({ id: "t2", orderId: this.closeOrder.orderId, commission: 0.04, realizedPnl: -0.02, time: 9_000_100 });
    for (const algo of this.algos.values()) {
      if (this.hideAlgoTrades) continue;
      if (algo.actualOrderId) rows.push({ id: `t-${algo.actualOrderId}`, orderId: algo.actualOrderId, commission: 0.04, realizedPnl: 1.2, time: 9_000_200 });
    }
    return [...rows, ...this.externalTrades];
  }
}

function protectedRun(id, symbol, direction = "LONG") {
  const exitSide = direction === "LONG" ? "SELL" : "BUY";
  const clientIds = {
    entry: `${id}-entry`,
    stop: `${id}-sl`,
    breakEvenStop: `${id}-slbe`,
    takeProfit1: `${id}-tp1`,
    takeProfit2: `${id}-tp2`,
    operatorClose: null,
  };
  return {
    id,
    signalId: `${id}-signal`,
    sourceType: "SIGNAL",
    symbol,
    status: "OPEN_PROTECTED",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    entryOrder: { symbol, orderId: `${id}-entry-order`, clientOrderId: clientIds.entry, executedQuantity: 1, status: "FILLED" },
    plan: { direction, exitSide, clientIds, rules: { stepSize: 0.001 }, prices: { entry: "100" } },
    protection: { mode: "TWO_TARGETS", stop: null, takeProfit1: null, takeProfit2: null, breakEvenStop: null },
    exchange: null,
    result: null,
    error: null,
  };
}

function algoFor(run, role, overrides = {}) {
  const stop = role === "stop" || role === "breakEvenStop";
  return {
    symbol: run.symbol,
    side: run.plan.exitSide,
    clientAlgoId: run.plan.clientIds[role],
    algoId: `${run.id}-${role}-order`,
    status: "NEW",
    type: stop ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
    closePosition: role !== "takeProfit1",
    reduceOnly: true,
    ...overrides,
  };
}

test("默认锁定时可以生成只读计划但不能提交订单", async () => {
  let clock = 1_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  assert.equal(prepared.run.status, "PREPARED");
  assert.equal(client.calls.placeEntry, 0);
  await assert.rejects(() => executor.execute(prepared.run.id, prepared.confirmationCode), TestnetWriteDisabledError);
  assert.equal(client.calls.placeEntry, 0);
});

test("执行器可随雷达增量扩展非 BTC 真实策略白名单", async () => {
  const clock = 1_200_000;
  const store = new MemoryStore(signalRecord(clock, { symbol: "AKEUSDT", direction: "SHORT" }));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  executor.allowSymbols(["AKEUSDT"]);

  const prepared = await executor.prepare("ake-signal-exec");

  assert.equal(prepared.run.symbol, "AKEUSDT");
  assert.equal(prepared.run.plan.entrySide, "SELL");
  assert.equal(client.calls.placeEntry, 0);
});

test("其他标的仓位已归属且有止损时可继续准备并提交新标的", async () => {
  const clock = 1_300_000;
  const store = new MemoryStore(signalRecord(clock, { symbol: "AKEUSDT", direction: "SHORT" }));
  const existing = protectedRun("btc-existing", "BTCUSDT", "LONG");
  store.runs.set(existing.id, structuredClone(existing));
  const client = new FakeTradingClient();
  const existingStop = algoFor(existing, "stop");
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.01 }];
  client.account.openAlgoOrders = [existingStop];
  client.algos.set(existingStop.clientAlgoId, existingStop);
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    now: () => clock,
    allowedSymbols: ["BTCUSDT", "AKEUSDT"],
  });

  const prepared = await executor.prepare("ake-signal-exec");
  const submitted = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(prepared.run.symbol, "AKEUSDT");
  assert.equal(submitted.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.equal((await store.getExecutionRun(existing.id)).status, "OPEN_PROTECTED");
});

test("突破信号使用盘口可成交 IOC 限价并固化滑点上限审计", async () => {
  const clock = 1_400_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, activeLimitMaxBps: 10 });

  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(run.entryExecution.mode, "MARKETABLE_LIMIT_IOC");
  assert.equal(client.calls.lastEntryRequest.timeInForce, "IOC");
  assert.equal(Number(client.calls.lastEntryRequest.price), 85_085);
  const intent = store.audit.find((event) => event.eventType === "ENTRY_INTENT_PERSISTED");
  assert.equal(intent.payload.plannedPrice, "85000.0");
  assert.equal(intent.payload.executionMode, "MARKETABLE_LIMIT_IOC");
  assert.equal(intent.payload.referencePrice, 85_000);
});

test("突破盘口超过滑点预算时不提交订单并记录明确原因", async () => {
  const clock = 1_425_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.bookTicker = { symbol: "BTCUSDT", bidPrice: 85_099, askPrice: 85_100, spreadBps: 0.1175 };
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, activeLimitMaxBps: 10 });

  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET");
  assert.equal(client.calls.placeEntry, 0);
  assert.ok(store.audit.some((event) => event.eventType === "ENTRY_SKIPPED_SLIPPAGE_BUDGET"));
});

test("回调信号使用短时 GTC 限价，结构失效时立即撤单", async () => {
  let clock = 1_450_000;
  const record = signalRecord(clock, { strategy: "PULLBACK" });
  record.trade.expiresAt = clock + 10 * 60_000;
  const store = new MemoryStore(record);
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, pullbackEntryTtlMs: 180_000 });

  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(run.plan.entryPolicy.mode, "PASSIVE_LIMIT_GTC");
  assert.equal(run.plan.entryPolicy.expiresAt, clock + 180_000);
  assert.equal(client.calls.lastEntryRequest.timeInForce, "GTC");
  assert.equal(Number(client.calls.lastEntryRequest.price), 85_000);

  client.markPrice = 83_999;
  clock += 15_000;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.cancellationReason, "SETUP_INVALIDATED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.placeAlgo.length, 0);
});

test("Demo canTrade=false 时准备和执行前都以不进撮合的测试单复核权限", async () => {
  let clock = 1_500_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.account.canTrade = false;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  assert.equal(prepared.run.status, "PREPARED");
  assert.equal(client.calls.permissionTests, 1);
  await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(client.calls.permissionTests, 2);
  assert.equal(client.calls.placeEntry, 1);
  const permission = await executor.permissionStatus();
  assert.equal(permission.valid, true);
});

test("人工金丝雀与策略绩效隔离并可在保护后幂等主动平仓", async () => {
  let clock = 1_700_000;
  const store = new MemoryStore(signalRecord(clock));
  store.createOperatorCanarySource = async () => true;
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepareOperatorCanary("LONG");
  assert.equal(prepared.run.sourceType, "OPERATOR_CANARY");
  assert.equal(prepared.run.performanceEligible, false);
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.closeOperatorCanary(run.id, "操作员确认Demo技术闭环已经完成，因此主动平仓结束测试。");
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.reason, "EXCHANGE_POSITION_CLOSED");
  assert.equal(run.result.exitRole, "operatorClose");
  assert.equal(run.result.exitReason, "操作员确认Demo技术闭环已经完成，因此主动平仓结束测试。");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.result.trades.length, 2);
  const repeated = await executor.closeOperatorCanary(run.id);
  assert.equal(repeated.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("真实策略 run 可持久化唯一 reduceOnly 意图后幂等主动平仓并严格归属成交", async () => {
  let clock = 1_750_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", marginType: "ISOLATED" }];
  await assert.rejects(() => executor.closeExecutionRun(run.id), /主动平仓原因/);
  assert.equal(client.calls.closeMarket ?? 0, 0);
  run = await executor.closeExecutionRun(run.id, "策略测试已完成且需要验证主动退出链路，因此平掉当前Demo仓位。");
  assert.equal(run.status, "CLOSED");
  assert.match(run.plan.clientIds.operatorClose, /^cfs-[A-Za-z0-9_-]+-close$/);
  assert.equal(run.operatorCloseOrder.reduceOnly, true);
  assert.equal(run.result.accountingComplete, true);
  assert.deepEqual(run.result.ownedOrderIds, ["1", "close-1"]);
  assert.deepEqual(run.result.trades.map((trade) => trade.orderId), ["1", "close-1"]);
  assert.equal(client.calls.closeMarket, 1);
  assert.ok(store.audit.some((event) => event.eventType === "OPERATOR_CLOSE_INTENT_PERSISTED"));
  assert.equal(store.audit.find((event) => event.eventType === "OPERATOR_CLOSE_INTENT_PERSISTED").payload.reason,
    "策略测试已完成且需要验证主动退出链路，因此平掉当前Demo仓位。");
  const repeated = await executor.closeExecutionRun(run.id);
  assert.equal(repeated.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("平仓后交易所自动终止保护单时容忍一次 -2011 撤单竞态并完成结算", async () => {
  let clock = 1_760_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.cancelUnknownOnce = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", marginType: "ISOLATED" }];
  run = await executor.closeExecutionRun(run.id, "策略测试已完成且需要验证保护单清理，因此平掉当前Demo仓位。");
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.accountingComplete, true);
  assert.equal(client.calls.closeMarket, 1);
  assert.ok(client.delayedCanceledQueries >= 2);
});

test("策略主动平仓在仓位无法唯一归属或缺少止损时拒绝写入", async () => {
  const clock = 1_775_000;
  const run = protectedRun("unsafe-close", "BTCUSDT");
  const store = new MemoryStore(signalRecord(clock));
  store.runs.set(run.id, structuredClone(run));
  const client = new FakeTradingClient();
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 1, positionSide: "BOTH", marginType: "ISOLATED" }];
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  await assert.rejects(() => executor.closeExecutionRun(run.id, "账户归属检查实验需要尝试主动退出，因此请求平掉当前Demo仓位。"), /无法归属、冲突或缺少止损/);
  assert.equal(client.calls.closeMarket ?? 0, 0);
});

test("入场限价首次响应直接成交时立即建立保护单而不是误报无保护", async () => {
  let clock = 1_800_000;
  const store = new MemoryStore(signalRecord(clock));
  store.createOperatorCanarySource = async () => true;
  const client = new FakeTradingClient();
  client.fillEntryImmediately = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepareOperatorCanary("LONG");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.equal(run.protection.stop.status, "NEW");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")), null);
});

test("完整闭环只提交一次入场单，成交后先建止损，再建止盈，平仓后清理兄弟单", async () => {
  let clock = 2_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.deepEqual(client.calls.marginType, ["ISOLATED"]);
  assert.deepEqual(client.calls.leverage, [10]);

  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.deepEqual(client.calls.placeAlgo.map((item) => item.role), ["stop", "tp2", "tp1"]);
  assert.match(store.audit.find((event) => event.eventType === "ENTRY_INTENT_PERSISTED").payload.reason, /因此开仓做多/);
  assert.equal(store.audit.filter((event) => event.eventType === "PROTECTION_ORDER_INTENT_PERSISTED").length, 3);
  assert.equal(client.calls.placeEntry, 1);

  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", markPrice: 85_500 }];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.ok(run.performance.mfePnl > 0);
  assert.equal(run.performance.maePnl, 0);
  assert.equal(client.calls.placeEntry, 1);

  const tp2Id = run.plan.clientIds.takeProfit2;
  client.algos.set(tp2Id, { ...client.algos.get(tp2Id), status: "FINISHED", actualQuantity: 0.0012, actualOrderId: "tp2-order" });
  client.account.positions = [];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.netPnl, 1.1199999999999999);
  assert.equal(run.result.accountingComplete, true);
  assert.equal(run.result.exitRole, "takeProfit2");
  assert.match(run.result.exitReason, /平掉剩余仓位/);
  assert.deepEqual(run.result.trades.map((trade) => trade.orderId), ["1", "tp2-order"]);
  assert.equal(run.performance.modelVersion, "TRADE_EXCURSION_R1");
  assert.equal(run.performance.mfeR, 4);
  assert.equal(run.performance.maeR, 0);
  assert.equal(run.performance.mfePrice, 89_000);
  assert.ok(run.performance.timeToTp2Ms > 0);
  assert.equal(run.performance.maxFavorableExcursionBeforeExitR, 4);
  assert.equal(run.performance.maxAdverseExcursionBeforeExitR, 0);
  assert.ok(client.calls.cancelAlgo.length >= 2);
});

test("低于95%的部分成交立即撤余单、建立保护、排除绩效并受控平仓", async () => {
  let clock = 3_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "PARTIALLY_FILLED", executedQuantity: 0.0007, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0007, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "ENTRY_FILL_BELOW_MINIMUM");
  assert.ok(run.executionMetrics.fillRatio < 0.95);
  assert.equal(run.protection.mode, "SINGLE_TARGET");
  assert.deepEqual(client.calls.placeAlgo.map((item) => item.role), ["stop", "tp2"]);
  assert.equal(client.calls.closeMarket, 1);
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
});

test("未成交限价到期后撤单并结束，不会建立保护单", async () => {
  let clock = 3_500_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  clock = run.plan.expiresAt + 1;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_NOT_FILLED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.placeAlgo.length, 0);
});

test("TP1 成交后撤销原止损并把剩余仓位止损移动到保本", async () => {
  let clock = 3_700_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0006, positionSide: "BOTH" }];
  const tp1Id = run.plan.clientIds.takeProfit1;
  client.algos.set(tp1Id, { ...client.algos.get(tp1Id), status: "FINISHED", actualQuantity: 0.0006, actualPrice: 87_000 });
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "TP1_FILLED");
  assert.equal(run.protection.breakEvenStop.triggerPrice, 85_000);
  assert.equal(run.protection.breakEvenStop.closePosition, false);
  assert.equal(run.protection.breakEvenStop.quantity, 0.0006);
  assert.ok(client.calls.cancelAlgo.includes(run.plan.clientIds.stop));
  assert.equal(client.calls.placeAlgo.at(-1).clientAlgoId, run.plan.clientIds.breakEvenStop);
  assert.ok(
    client.calls.sequence.indexOf(`place:${run.plan.clientIds.breakEvenStop}`)
      < client.calls.sequence.indexOf(`cancel:${run.plan.clientIds.stop}`),
    "必须先确认保本止损，再撤销原止损",
  );
});

test("保本止损创建失败时保留原止损，不产生无保护窗口", async () => {
  let clock = 3_800_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0006, positionSide: "BOTH" }];
  const tp1Id = run.plan.clientIds.takeProfit1;
  client.algos.set(tp1Id, { ...client.algos.get(tp1Id), status: "FINISHED", actualQuantity: 0.0006, actualPrice: 87_000 });
  client.failBreakEven = true;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "PROTECTION_INCOMPLETE");
  assert.equal(client.algos.get(run.plan.clientIds.stop).status, "NEW");
  assert.equal(client.calls.cancelAlgo.includes(run.plan.clientIds.stop), false);
  const failedAttempts = client.calls.placeAlgo.filter((item) => item.clientAlgoId === run.plan.clientIds.breakEvenStop).length;
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.placeAlgo.filter((item) => item.clientAlgoId === run.plan.clientIds.breakEvenStop).length, failedAttempts);
  assert.equal(store.audit.filter((event) => event.eventType === "BREAKEVEN_STOP_FAILED").length, 1);

  run = await executor.closeExecutionRun(run.id, "V1切换至V2前需要结束现有Demo仓位，因此在原止损仍有效时主动平仓。");
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("进程重启后只按客户端订单号恢复，不会再次提交入场单", async () => {
  let clock = 3_900_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const firstExecutor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await firstExecutor.prepare("btc-signal-exec");
  const pending = await firstExecutor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(pending.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  const restartedExecutor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const recovered = await restartedExecutor.reconcileAll();
  assert.equal(recovered[0].status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
});

test("入场请求超时且交易所查不到订单时保持未知状态且绝不盲目重试", async () => {
  let clock = 4_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.failEntryUnknown = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  assert.equal(client.calls.placeEntry, 1);
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  assert.equal(client.calls.placeEntry, 1);
  clock += 120_001;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_SUBMISSION_NOT_FOUND");
  assert.equal(client.calls.placeEntry, 1);
});

test("杠杆档位不支持10倍时预检终止且不修改账户或提交订单", async () => {
  const clock = 4_100_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.maximumLeverage = 5;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "REJECTED");
  assert.equal(run.executionException, "UNSUPPORTED_LEVERAGE");
  assert.equal(run.performanceEligible, false);
  assert.equal(client.calls.leverage.length, 0);
  assert.equal(client.calls.marginType.length, 0);
  assert.equal(client.calls.placeEntry, 0);
  assert.equal(store.audit.some((event) => event.eventType === "LEVERAGE_PRECHECK_REJECTED"), true);
});

test("Testnet配置返回-1000时先核验实际状态而不是丢弃信号", async () => {
  const clock = 4_125_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.marginTypeUnknownOnce = true;
  client.leverageUnknownOnce = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.equal(client.calls.marginType.length, 1);
  assert.equal(client.calls.leverage.length, 1);
  assert.equal(store.audit.some((event) => event.eventType === "MARGIN_TYPE_VERIFIED_AFTER_UNKNOWN"), true);
  assert.equal(store.audit.some((event) => event.eventType === "LEVERAGE_VERIFIED_AFTER_UNKNOWN"), true);
});

test("恢复时的配置中或无提交时间未知记录收敛为入场前失败", async () => {
  const clock = 4_150_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const configuring = structuredClone(prepared.run);
  configuring.status = "CONFIGURING";
  await store.saveExecutionRun(configuring);
  let run = await executor.reconcile(configuring.id);
  assert.equal(run.status, "FAILED");
  assert.equal(run.result.reason, "PRE_ENTRY_CONFIGURATION_INTERRUPTED");

  const secondStore = new MemoryStore(signalRecord(clock));
  const secondExecutor = new TestnetCanaryExecutor({ client, store: secondStore, enabled: true, now: () => clock });
  const secondPrepared = await secondExecutor.prepare("btc-signal-exec");
  const unknown = structuredClone(secondPrepared.run);
  unknown.status = "SUBMISSION_UNKNOWN";
  unknown.entryExecution = null;
  await secondStore.saveExecutionRun(unknown);
  run = await secondExecutor.reconcile(unknown.id);
  assert.equal(run.status, "FAILED");
  assert.equal(run.result.reason, "PRE_ENTRY_CONFIGURATION_FAILED");
  assert.equal(client.calls.placeEntry, 0);
});

test("紧急停止后延迟出现的未知入场单会在恢复查询时立即撤销", async () => {
  let clock = 4_200_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.failEntryUnknown = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  await executor.engageEmergencyStop("MANUAL");
  client.order = {
    symbol: "BTCUSDT", side: "BUY", originalQuantity: 0.0012, executedQuantity: 0,
    price: 85_000, averagePrice: 0, clientOrderId: run.plan.clientIds.entry, orderId: "late-1", status: "NEW",
  };
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_NOT_FILLED");
});

test("过期待确认计划自动取消并释放唯一执行槽", async () => {
  let clock = 4_400_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  const first = await executor.prepare("btc-signal-exec");
  await assert.rejects(() => executor.prepare("btc-signal-second"), /已有未结束/);
  clock = first.run.plan.expiresAt + 1;
  store.signal.trade.expiresAt = clock + 120_000;
  const second = await executor.prepare("btc-signal-second");
  assert.equal((await store.getExecutionRun(first.run.id)).status, "CANCELED");
  assert.equal(second.run.status, "PREPARED");
});

test("交易所返回非活动止损时冻结新订单并自动仅减仓平仓", async () => {
  let clock = 4_600_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.algos.set(run.plan.clientIds.stop, { ...client.algos.get(run.plan.clientIds.stop), status: "CANCELED" });
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "UNPROTECTED_POSITION_AUTO_CLOSE");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, true);
});

test("止损已全量成交但仓位快照滞后时等待结算且不误触发紧急停止", async () => {
  let clock = 4_800_000;
  const store = new MemoryStore(signalRecord(clock));
  const run = protectedRun("btc-stop-settlement", "BTCUSDT", "LONG");
  store.runs.set(run.id, structuredClone(run));
  const client = new FakeTradingClient();
  client.order = structuredClone(run.entryOrder);
  const stop = algoFor(run, "stop", {
    status: "FINISHED",
    actualQuantity: 1,
    actualOrderId: "btc-stop-fill",
    updateTime: clock - 1_000,
  });
  const takeProfit1 = algoFor(run, "takeProfit1");
  const takeProfit2 = algoFor(run, "takeProfit2", { status: "EXPIRED" });
  for (const algo of [stop, takeProfit1, takeProfit2]) client.algos.set(algo.clientAlgoId, algo);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 1, positionSide: "BOTH" }];
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });

  let result = await executor.reconcile(run.id);

  assert.equal(result.status, "OPEN_PROTECTED");
  assert.equal(client.calls.closeMarket ?? 0, 0);
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"), null);
  assert.equal(store.audit.at(-1).eventType, "EXIT_SETTLEMENT_PENDING");
  assert.equal(result.protection.exitSettlement.role, "stop");

  client.account.positions = [];
  clock += 15_000;
  result = await executor.reconcile(run.id);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.result.exitRole, "stop");
  assert.equal(result.performanceEligible, undefined);
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"), null);
});

test("止损创建失败会冻结新订单、排除绩效并自动仅减仓平仓", async () => {
  let clock = 5_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, logger: { error() {} } });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.failStop = true;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "UNPROTECTED_POSITION_AUTO_CLOSE");
  assert.equal(run.result.exitRole, "operatorClose");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, true);
  await assert.rejects(() => executor.prepare("another-signal"), /紧急停止/);
  await executor.clearEmergencyStop();
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, false);
});

test("存在未结束交易时关闭写入锁会拒绝启动，避免留下无人管理的仓位", async () => {
  let clock = 6_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const armed = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await armed.prepare("btc-signal-exec");
  await armed.execute(prepared.run.id, prepared.confirmationCode);
  const locked = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  await assert.rejects(() => locked.start(), /未结束的测试网执行记录/);
});

test("一笔自然平仓只清理自己的保护单且不等待其他标的清空", async () => {
  const store = new MemoryStore(signalRecord(7_000_000));
  const closed = protectedRun("btc-run", "BTCUSDT", "LONG");
  const sibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(closed.id, structuredClone(closed));
  store.runs.set(sibling.id, structuredClone(sibling));
  const client = new FakeTradingClient();
  const closedStop = algoFor(closed, "stop");
  const closedTp1 = algoFor(closed, "takeProfit1");
  const closedTp2 = algoFor(closed, "takeProfit2", {
    status: "FINISHED",
    actualQuantity: 1,
    actualOrderId: "btc-run-exit-order",
  });
  const siblingStop = algoFor(sibling, "stop");
  for (const algo of [closedStop, closedTp1, closedTp2, siblingStop]) client.algos.set(algo.clientAlgoId, algo);
  client.order = { orderId: closed.entryOrder.orderId };
  client.account.positions = [{ symbol: "ETHUSDT", quantity: -1 }];
  client.account.openAlgoOrders = [siblingStop];
  client.externalTrades = [{ id: "manual", orderId: "manual-order", commission: 50, realizedPnl: 999, time: 9_000_300 }];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_000_000,
  });

  const result = await executor.reconcile(closed.id);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.result.accountingComplete, true);
  assert.equal(result.result.trades.some((trade) => trade.orderId === "manual-order"), false);
  assert.ok(result.result.netPnl < 10);
  assert.equal((await store.getExecutionRun(sibling.id)).status, "OPEN_PROTECTED");
  assert.ok(client.calls.cancelAlgo.includes(closed.plan.clientIds.stop));
  assert.ok(client.calls.cancelAlgo.includes(closed.plan.clientIds.takeProfit1));
  assert.equal(client.calls.cancelAlgo.includes(sibling.plan.clientIds.stop), false);
});

test("一笔完成TP1只移动自己的止损且不触碰兄弟仓位保护", async () => {
  const store = new MemoryStore(signalRecord(7_250_000));
  const btc = protectedRun("btc-run", "BTCUSDT", "LONG");
  const eth = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(btc.id, structuredClone(btc));
  store.runs.set(eth.id, structuredClone(eth));
  const client = new FakeTradingClient();
  const btcStop = algoFor(btc, "stop");
  const btcTp1 = algoFor(btc, "takeProfit1", { status: "FINISHED", actualQuantity: 0.5, actualOrderId: "btc-tp1-order" });
  const btcTp2 = algoFor(btc, "takeProfit2");
  const ethStop = algoFor(eth, "stop");
  for (const algo of [btcStop, btcTp1, btcTp2, ethStop]) client.algos.set(algo.clientAlgoId, algo);
  client.account.positions = [
    { symbol: "BTCUSDT", quantity: 0.5 },
    { symbol: "ETHUSDT", quantity: -1 },
  ];
  client.account.openAlgoOrders = [btcStop, btcTp2, ethStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_250_000,
  });

  const result = await executor.reconcile(btc.id);

  assert.equal(result.status, "TP1_FILLED");
  assert.ok(client.calls.cancelAlgo.includes(btc.plan.clientIds.stop));
  assert.equal(client.calls.cancelAlgo.includes(eth.plan.clientIds.stop), false);
  assert.equal((await store.getExecutionRun(eth.id)).status, "OPEN_PROTECTED");
});

test("全局紧急停止只撤销等待入场单并保留兄弟仓位保护", async () => {
  const store = new MemoryStore(signalRecord(7_400_000));
  const protectedSibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  const pending = protectedRun("btc-pending", "BTCUSDT", "LONG");
  pending.status = "ENTRY_PENDING";
  pending.entryOrder = {
    symbol: "BTCUSDT",
    orderId: "pending-order",
    clientOrderId: pending.plan.clientIds.entry,
    executedQuantity: 0,
    status: "NEW",
  };
  store.runs.set(protectedSibling.id, structuredClone(protectedSibling));
  store.runs.set(pending.id, structuredClone(pending));
  const client = new FakeTradingClient();
  client.order = structuredClone(pending.entryOrder);
  const siblingStop = algoFor(protectedSibling, "stop");
  client.algos.set(siblingStop.clientAlgoId, siblingStop);
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_400_000,
  });

  await executor.engageEmergencyStop("MANUAL");

  assert.equal((await store.getExecutionRun(pending.id)).status, "CANCELED");
  assert.equal((await store.getExecutionRun(protectedSibling.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.cancelAlgo.length, 0);
  assert.equal(client.algos.get(siblingStop.clientAlgoId).status, "NEW");
});

test("紧急停止可在所有现有仓位均已归属且受保护时解除", async () => {
  const store = new MemoryStore(signalRecord(7_500_000));
  const sibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(sibling.id, structuredClone(sibling));
  store.metadata.set("testnet_execution_emergency_stop", { active: true, reason: "MANUAL" });
  const client = new FakeTradingClient();
  const siblingStop = algoFor(sibling, "stop");
  client.account.positions = [{ symbol: "ETHUSDT", quantity: -1 }];
  client.account.openAlgoOrders = [siblingStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_500_000,
  });

  const result = await executor.clearEmergencyStop();

  assert.equal(result.active, false);
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, false);
});

test("仓位已关闭但成交明细尚未到达时保持对账中并在后续轮询完成", async () => {
  const clock = 8_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  run = await executor.reconcile(run.id);
  const tp2Id = run.plan.clientIds.takeProfit2;
  client.algos.set(tp2Id, { ...client.algos.get(tp2Id), status: "FINISHED", actualQuantity: 0.0012, actualOrderId: "delayed-exit" });
  client.account.positions = [];
  client.hideAlgoTrades = true;

  run = await executor.reconcile(run.id);
  assert.equal(run.status, "ACCOUNTING_PENDING");
  assert.equal(run.result.accountingComplete, false);
  assert.equal(run.result.netPnl, null);

  client.hideAlgoTrades = false;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.accountingComplete, true);
});

test("重启恢复会逐笔对账多个受保护仓位且不会重复提交入场", async () => {
  const store = new MemoryStore(signalRecord(8_500_000));
  const btc = protectedRun("btc-run", "BTCUSDT", "LONG");
  const eth = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(btc.id, structuredClone(btc));
  store.runs.set(eth.id, structuredClone(eth));
  const client = new FakeTradingClient();
  const btcStop = algoFor(btc, "stop");
  const ethStop = algoFor(eth, "stop");
  client.algos.set(btcStop.clientAlgoId, btcStop);
  client.algos.set(ethStop.clientAlgoId, ethStop);
  client.account.positions = [
    { symbol: "BTCUSDT", quantity: 1 },
    { symbol: "ETHUSDT", quantity: -1 },
  ];
  client.account.openAlgoOrders = [btcStop, ethStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 8_500_000,
  });

  await executor.start();
  executor.stop();

  assert.equal((await store.getExecutionRun(btc.id)).status, "OPEN_PROTECTED");
  assert.equal((await store.getExecutionRun(eth.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.placeEntry, 0);
  assert.equal(client.calls.placeAlgo.length, 0);
  assert.equal(client.calls.accountOverview, 1);
});
