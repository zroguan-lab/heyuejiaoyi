import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDashboardServer, listen } from "../src/http/server.js";

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
    plan: { direction: "LONG", entrySide: "BUY", exitSide: "SELL", quantity: "0.001", leverage: 10, marginMode: "ISOLATED", marginTarget: 10, prices: { entry: "100000" } },
    entryOrder: { orderId: "entry-1", executedQuantity: 0.001, updateTime: entryTime },
    result: {
      commission: 0.08, realizedPnl: 0.2, netPnl: 0.12, accountingComplete: true,
      trades: [
        { side: "BUY", price: 100_000, quantity: 0.001, quoteQuantity: 100, time: entryTime },
        { side: "SELL", price: 100_200, quantity: 0.001, quoteQuantity: 100.2, time: exitTime },
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
    account: { canTrade: true },
    positionMode: "ONE_WAY",
    positions: [],
    openOrders: [],
    openAlgoOrders: [],
  });
  const executionGateway = {
    snapshot: () => ({
      environment: "TESTNET",
      mode: "READ_ONLY",
      orderSubmissionEnabled: false,
      cancelEnabled: false,
      emergencyStopAvailable: false,
    }),
  };
  const server = createDashboardServer({ monitor, accountMonitor, executionGateway, store, config, logger: { error() {} } });
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
