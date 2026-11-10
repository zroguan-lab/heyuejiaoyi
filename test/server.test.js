import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDashboardServer, listen } from "../src/http/server.js";

test("TEAM031 slow HTTP business drains before close while SSE ends without close-event cycle", async t => {
  let release, entered, reads = 0;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const monitor = new EventEmitter(); monitor.snapshot = () => ({ status: "IDLE" });
  const store = { listSignals: async () => { reads++; entered(); await gate; return []; } };
  const config = { marketEnvironment: "TESTNET", portfolio: { startingEquity: 500 }, execution: {}, host: "127.0.0.1", port: 0 };
  const server = createDashboardServer({ monitor, store, config, logger: { error() {} } });
  const address = await listen(server, config), base = `http://127.0.0.1:${address.port}`;
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const events = await fetch(`${base}/api/events`), reader = events.body.getReader(); await reader.read();
  const pending = fetch(`${base}/api/signals`); await ready;
  server.beginMaintenanceDrain();
  let closed = false; const closing = server.closeGracefully().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.execution.effectiveOrderSubmissionEnabled, false); assert.equal(reads, 1);
  assert.equal((await fetch(`${base}/api/scan`, { method: "POST" })).status, 503);
  release(); assert.equal((await pending).status, 200);
  await closing; assert.equal(closed, true);
  while (!(await reader.read()).done) { /* consume SSE close */ }
});

test("研究API返回组合状态并允许记录手动跟单但不会暴露执行能力", async () => {
  const entryTime = Date.parse("2026-09-29T01:00:00Z");
  const exitTime = Date.parse("2026-09-29T02:00:00Z");
  const monitor = new EventEmitter();
  monitor.snapshot = () => ({ symbols: ["BTCUSDT"], universeSize: 1, latest: [], errors: {}, status: "IDLE" });
  monitor.scanAll = async () => ({ skipped: false });
  const manual = [];
  const candidate = { id: "s1", symbol: "BTCUSDT", strategy: "BREAKOUT", direction: "LONG", risk: { stopLoss: 98, takeProfit1: 103, takeProfit2: 105 } };
  const executionRuns = [{
    id: "run-1", signalId: "s1", sourceType: "SIGNAL", performanceEligible: true,
    symbol: "BTCUSDT", status: "CLOSED", updatedAt: exitTime + 100,
    plan: { direction: "LONG", entrySide: "BUY", exitSide: "SELL", quantity: "0.001", leverage: 10, marginMode: "ISOLATED", marginTarget: 10, prices: { entry: "100000", stopLoss: "99000" } },
    entryOrder: { orderId: "entry-1", executedQuantity: 0.001, updateTime: entryTime },
    operatorCloseOrder: { orderId: "exit-1" },
    result: {
      commission: 0.08, realizedPnl: 0.2, fundingPnl: 0, netPnl: 0.12, accountingComplete: true,
      trades: [
        { orderId: "entry-1", symbol: "BTCUSDT", side: "BUY", price: 100_000, quantity: 0.001, quoteQuantity: 100, time: entryTime },
        { orderId: "exit-1", symbol: "BTCUSDT", side: "SELL", price: 100_200, quantity: 0.001, quoteQuantity: 100.2, time: exitTime },
      ],
    },
  }, {
    id: "run-excluded", signalId: "s1", sourceType: "SIGNAL", performanceEligible: false,
    executionException: "UNPROTECTED_POSITION_AUTO_CLOSE", error: "止损建立失败后已自动退出",
    symbol: "BTCUSDT", status: "CLOSED", updatedAt: exitTime + 200,
    plan: { direction: "LONG", entrySide: "BUY", exitSide: "SELL", quantity: "0.001", leverage: 10, marginMode: "ISOLATED", marginTarget: 10, prices: { entry: "100000" } },
    entryOrder: { orderId: "entry-excluded", executedQuantity: 0.001, updateTime: entryTime + 100 },
    result: { commission: 0.08, realizedPnl: -0.2, netPnl: -0.28, accountingComplete: true, trades: [] },
  }, {
    id: "run-technical", signalId: "operator-1", sourceType: "OPERATOR_CANARY", performanceEligible: false,
    symbol: "BTCUSDT", status: "CLOSED", updatedAt: 3_200,
    plan: { sourceType: "OPERATOR_CANARY", direction: "LONG", entrySide: "BUY", exitSide: "SELL", quantity: "0.001", prices: { entry: "100000" } },
  }];
  const store = {
    activeRuns: [],
    async listActiveExecutionRuns() { return this.activeRuns; },
    async listSignals() { return [{ selected: true, candidate }]; },
    async listManualTrades() { return manual; },
    async getSignal() { return { selected: true, candidate }; },
    async saveManualTrade(trade, note) { const item = { ...trade, note }; manual.push(item); return item; },
    async listUniverseSnapshots() { return [{ provider: "binance", selectedAt: 1000, items: [{ symbol: "BTCUSDT" }] }]; },
    async listExecutionRuns() { return executionRuns; },
  };
  const config = {
    primaryProvider: "binance", auxiliaryProvider: "hyperliquid", symbols: ["BTCUSDT"], intervals: {}, pollMs: 30_000,
    strategy: {}, universe: {}, portfolio: { startingEquity: 500 }, costs: { fallbackFeeRate: 0.0005 }, host: "127.0.0.1", port: 0,
    marketEnvironment: "TESTNET", execution: { credentialsConfigured: true, accountReadOnlyEnabled: true, orderSubmissionEnabled: false },
  };
  const accountMonitor = new EventEmitter();
  accountMonitor.snapshot = () => ({
    enabled: true,
    connected: true,
    environment: "TESTNET",
    mode: "READ_ONLY",
    authority: "BINANCE_TESTNET",
    account: { canTrade: true },
    positionMode: "ONE_WAY",
    positions: [],
    openOrders: [],
    openAlgoOrders: [],
  });
  let submissionEnabled = false;
  const executionGateway = {
    snapshot: () => ({
      environment: "TESTNET",
      mode: "READ_ONLY",
      orderSubmissionEnabled: submissionEnabled,
      cancelEnabled: false,
      emergencyStopAvailable: false,
    }),
  };
  const canaryExecutor = new EventEmitter();
  let executionRuntime = { known: true, active: false, generation: 0 };
  canaryExecutor.runtimeStatus = () => structuredClone(executionRuntime);
  canaryExecutor.snapshot = async () => ({});
  const server = createDashboardServer({ monitor, accountMonitor, executionGateway, canaryExecutor, store, config, logger: { error() {} } });
  await listen(server, config);
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const signalsResponse = await fetch(`${origin}/api/signals`);
    const signals = await signalsResponse.json();
    assert.equal(signalsResponse.status, 200);
    assert.equal(signals.mode, "RESEARCH_SIGNAL_ONLY");
    assert.equal(signals.executionEnabled, undefined);
    assert.equal(signals.execution.readiness.canPrepareCanary, true);
    assert.equal(signals.execution.readiness.orderSubmissionEnabled, false);
    assert.equal(signals.demoTrades.length, 2);
    assert.equal(signals.demoTrades[0].sourceType, "SIGNAL");
    assert.equal(signals.demoTrades[0].strategy, "BREAKOUT");
    assert.equal(signals.demoTrades[0].notional, 100);
    assert.equal(signals.demoTrades[0].netPnl, 0.12);
    assert.equal(signals.demoTrades[0].entryFactStatus, "CONFIRMED");
    assert.equal(signals.demoTrades[0].actualRisk, 1);
    assert.equal(signals.demoTrades[0].netR, 0.12);
    assert.equal(signals.demoTrades[0].mfeR, null);
    assert.equal(signals.demoTrades[0].excursionCoverage, "UNKNOWN");
    assert.equal(signals.demoTrades[1].performanceEligible, false);
    assert.equal(signals.demoTrades[1].executionException, "UNPROTECTED_POSITION_AUTO_CLOSE");
    assert.equal(signals.demoTrades[1].error, "止损建立失败后已自动退出");
    assert.equal(signals.strategyPerformance.startingEquity, 500);
    assert.equal(signals.strategyPerformance.currentEquity, 500.12);
    assert.equal(signals.strategyPerformance.finalizedTradeCount, 1);
    assert.equal(signals.strategyPerformance.accountingBasis, "CLOSED_NET_PNL");
    assert.equal(signals.strategyPerformance.sampleProgress.target, 100);
    assert.equal(signals.strategyPerformance.sampleProgress.finalized, 1);
    assert.equal(signals.strategyPerformance.segments.length, 6);
    assert.equal(signals.strategyPerformance.tiers.length, 2);
    assert.equal(signals.strategyExecutionSummary.finalized, 1);
    assert.equal(signals.strategyExecutionSummary.excluded, 1);
    assert.equal(signals.strategyExecutionSummary.excludedNetPnl, -0.28);
    assert.equal(signals.portfolio.length, 0);
    assert.equal(signals.history, undefined);
    assert.equal(signals.manualTrades, undefined);
    assert.equal(signals.executionRuns, undefined);

    const executionResponse = await fetch(`${origin}/api/execution/status`);
    const execution = await executionResponse.json();
    assert.equal(executionResponse.status, 200);
    assert.equal(execution.gateway.orderSubmissionEnabled, false);
    assert.equal(execution.safetyHold.active, false);
    assert.equal(execution.account.mode, "READ_ONLY");

    submissionEnabled = true;
    executionRuntime = { known: true, active: true, generation: 1 };
    const faultHealth = await (await fetch(`${origin}/api/health`)).json();
    assert.equal(faultHealth.execution.effectiveOrderSubmissionEnabled, false);
    assert.equal(faultHealth.execution.readiness.canPrepareCanary, false);
    assert.ok(faultHealth.execution.readiness.blockedReasons.some(reason => reason.code === "EXECUTION_RUNTIME_READY"));
    executionRuntime = { known: false };
    const unknownRuntime = await (await fetch(`${origin}/api/execution/status`)).json();
    assert.equal(unknownRuntime.effectiveOrderSubmissionEnabled, false);
    executionRuntime = { known: true, active: false, generation: 1 };
    for (const status of ["ENTRY_FACT_PENDING", "ENTRY_FACT_CONFLICT", "OPERATOR_CLOSE_UNKNOWN", "SUBMISSION_UNKNOWN", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED", "ENTRY_PENDING", "PARTIALLY_FILLED", "OPEN_PROTECTED", "TP1_FILLED"]) {
      store.activeRuns = [{ id: "matrix", status }];
      const state = await (await fetch(`${origin}/api/execution/status`)).json();
      const blocked = !["ENTRY_PENDING", "PARTIALLY_FILLED", "OPEN_PROTECTED", "TP1_FILLED"].includes(status);
      assert.equal(state.safetyHold.active, blocked, status);
      assert.equal(state.effectiveOrderSubmissionEnabled, !blocked, status);
    }
    store.activeRuns = [];
    submissionEnabled = false;

    const runsResponse = await fetch(`${origin}/api/execution/runs`);
    assert.equal(runsResponse.status, 200);
    assert.deepEqual((await runsResponse.json()).items, executionRuns);

    const orderResponse = await fetch(`${origin}/api/execution/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "BTCUSDT", side: "BUY" }),
    });
    assert.equal(orderResponse.status, 404);

    const manualResponse = await fetch(`${origin}/api/manual-trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signalId: "s1", fillPrice: 100, quantity: 0.01, note: "test" }),
    });
    assert.equal(manualResponse.status, 201);
    assert.equal(manual.length, 1);

    const invalidManualResponse = await fetch(`${origin}/api/manual-trades`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signalId: "s1", fillPrice: 100, quantity: 0 }),
    });
    assert.equal(invalidManualResponse.status, 400);

    const universeResponse = await fetch(`${origin}/api/universe-history?limit=1`);
    const universe = await universeResponse.json();
    assert.equal(universeResponse.status, 200);
    assert.equal(universe.items[0].items[0].symbol, "BTCUSDT");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
