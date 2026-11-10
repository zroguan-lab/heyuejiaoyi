import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { TestnetCanaryExecutor } from "../src/execution/testnet-canary-executor.js";
import { StrategyExecutionCoordinator } from "../src/application/strategy-execution-coordinator.js";
import { PERFORMANCE_EPOCH_METADATA_KEY, PERFORMANCE_EPOCH_HISTORY_METADATA_KEY, V2_DEMO_STRATEGY_VERSION,
  V2_EXECUTION_SOURCE, V2_4_3_SIGNAL_MODEL_VERSION } from "../src/execution/execution-strategy-source.js";
import { RuntimeLifecycle, assertEntryAdmission, beginMaintenance, createHandoffVerifier, drainOperations,
  lifecycleStatus, storeRunLocks, trackOperation, verifyHandoffFacts, createAccountCollector } from "../src/application/runtime-lifecycle.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const storeFixture = () => ({ listActiveExecutionRuns: async () => [], getMetadata: async () => null, close() {} });
const flat = () => ({ environment: "TESTNET", authority: "BINANCE_TESTNET", positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [], symbolConfig: [] });
const proof = (account = flat(), runs = []) => verifyHandoffFacts({ account, runs, requestStartedAt: 100, responseReceivedAt: 110, now: 120 });
const protectedFixture = () => {
  const run = { id: "r", symbol: "BTCUSDT", status: "OPEN_PROTECTED", entryOrder: { executedQuantity: 2 }, plan: {
    direction: "LONG", exitSide: "SELL", leverage: 10, quantity: 2, takeProfit1Quantity: 1, takeProfit2Quantity: 1,
    prices: { entry: "100", stopLoss: "90", takeProfit1: "110", takeProfit2: "120" },
    rules: { tickSize: 0.1, stepSize: 0.1, minQuantity: 0.1, minNotional: 1 }, clientIds: { entry: "e", stop: "sl", breakEvenStop: "be", takeProfit1: "tp1", takeProfit2: "tp2" } },
    protection: { phase: "INITIAL_COMPLETE", observations: { stop: { known: true } } } };
  const account = flat();
  account.positions = [{ symbol: "BTCUSDT", positionSide: "BOTH", quantity: 2 }];
  account.symbolConfig = [{ symbol: "BTCUSDT", leverage: 10, marginType: "ISOLATED" }];
  account.openAlgoOrders = [{ symbol: "BTCUSDT", clientAlgoId: "sl", algoId: "1", type: "STOP_MARKET", status: "NEW",
    side: "SELL", positionSide: "BOTH", closePosition: true, reduceOnly: false, quantity: 0, triggerPrice: 90 }];
  account.openAlgoOrders.push(...[1, 2].map(n => ({ symbol: "BTCUSDT", clientAlgoId: `tp${n}`, algoId: String(n + 1), type: "TAKE_PROFIT_MARKET",
    status: "NEW", side: "SELL", positionSide: "BOTH", closePosition: false, reduceOnly: true, quantity: 1, triggerPrice: 100 + n * 10 })));
  Object.assign(account.openAlgoOrders[2], { closePosition: true, quantity: 0, reduceOnly: false });
  for (const [role, index] of [["stop", 0], ["takeProfit1", 1], ["takeProfit2", 2]]) run.protection[role] = structuredClone(account.openAlgoOrders[index]);
  return { run, account };
};
const lifecycle = (store, options = {}) => new RuntimeLifecycle({ store, logger: { error() {} }, setKeepAlive: () => ({}), clearKeepAlive() {}, ...options });

test("same Store admission is synchronous and registry includes waiting work through finally", async () => {
  const store = storeFixture(), gate = deferred();
  const operation = trackOperation(store, {}, "waiting", () => gate.promise);
  assert.equal(lifecycleStatus(store).inFlight, 1);
  beginMaintenance(store);
  assert.throws(() => assertEntryAdmission(store), { code: "MAINTENANCE_PAUSED" });
  let drained = false;
  const drain = drainOperations(store).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  gate.resolve(); await operation; await drain;
  assert.equal(lifecycleStatus(store).inFlight, 0);
});

test("unknown submission and incomplete or invalid planned SL cannot pass handoff", () => {
  assert.equal(proof().safe, true);
  const { run, account } = protectedFixture();
  assert.equal(proof(account, [run]).safe, true);
  for (const bad of [null, 0, -1, 999999, "", false]) {
    const copy = structuredClone(account); copy.openAlgoOrders[0].triggerPrice = bad;
    assert.equal(proof(copy, [run]).safe, false, String(bad));
  }
  for (const status of ["SUBMISSION_UNKNOWN", "ERROR_UNPROTECTED", "ENTRY_PENDING", "PROTECTION_PENDING", "PREPARED"]) {
    assert.equal(proof(account, [{ ...run, status }]).safe, false, status);
  }
  account.openAlgoOrders[0].closePosition = "false";
  assert.equal(proof(account, [run]).safe, false);
});

test("freshness starts before collection; missing config and active leverage zero are unknown", () => {
  assert.equal(verifyHandoffFacts({ account: flat(), runs: [], requestStartedAt: 0, responseReceivedAt: 50000, now: 50000 }).safe, false);
  const { run, account } = protectedFixture();
  account.symbolConfig.push({ symbol: "ETHUSDT", leverage: 0, marginType: "CROSSED" });
  assert.equal(proof(account, [run]).safe, true);
  account.symbolConfig[0].leverage = 0;
  assert.equal(proof(account, [run]).safe, false);
  for (const bad of [null, true, "", -1, NaN]) {
    const a = flat(); a.symbolConfig = [{ symbol: "BTCUSDT", leverage: bad, marginType: "CROSSED" }];
    assert.equal(proof(a).safe, false);
  }
});

test("fresh collector rejects missing mode and raw false never becomes true", async () => {
  const responses = { "/fapi/v3/account": { availableBalance: "10" }, "/fapi/v3/positionRisk": [], "/fapi/v1/openOrders": [],
    "/fapi/v1/openAlgoOrders": [], "/fapi/v1/positionSide/dual": { dualSidePosition: false }, "/fapi/v1/symbolConfig": [] };
  const calls = [], collect = createAccountCollector({ baseUrl: "https://demo-fapi.binance.com", signedRequest: async (method, path) => { calls.push([method, path]); return responses[path]; } });
  assert.equal((await collect()).positionMode, "ONE_WAY");
  assert.equal(calls.length, 6); assert.ok(calls.every(([m]) => m === "GET"));
  responses["/fapi/v1/positionSide/dual"] = {};
  await assert.rejects(collect(), /Incomplete/);
});

test("critical state mutation during fresh fetch is refused", async () => {
  let runs = [];
  const store = { ...storeFixture(), listActiveExecutionRuns: async () => structuredClone(runs) };
  const verifier = createHandoffVerifier({ store, now: () => 100, collectAccount: async () => { runs = [{ id: "new", status: "SUBMISSION_UNKNOWN" }]; return flat(); } });
  assert.equal((await verifier()).reason, "CRITICAL_STATE_CHANGED");
});

test("shutdown drains writers before proof, closes in order and releases lock last", async () => {
  const events = [], gate = deferred(), store = storeFixture();
  store.close = () => events.push("store");
  const pending = trackOperation(store, {}, "slow writer", () => gate.promise);
  const life = lifecycle(store, { monitor: { stop: () => events.push("producer") },
    executor: { stop: async ({ releaseLock }) => { assert.equal(releaseLock, false); events.push("manager"); }, releaseProcessLock: () => events.push("lock") },
    server: { beginMaintenanceDrain: () => events.push("http-gate"), closeGracefully: async () => events.push("http") },
    verifyHandoff: async () => { events.push("proof"); return { safe: true }; }, exit: () => events.push("exit") });
  const first = life.requestShutdown();
  assert.equal(life.requestShutdown("SIGTERM"), first);
  assert.throws(() => assertEntryAdmission(store));
  await Promise.resolve(); assert.deepEqual(events, ["http-gate", "producer"]);
  gate.resolve(); await pending;
  assert.equal((await first).phase, "TERMINATED");
  assert.deepEqual(events, ["http-gate", "producer", "proof", "http", "manager", "store", "lock", "exit"]);
});

test("persistent two-signal handlers share a blocked flight, retain resources and management", async () => {
  const processLike = new EventEmitter(), store = storeFixture();
  let exited = 0, stopped = 0;
  const life = lifecycle(store, { executor: { stop() { stopped++; } }, exit() { exited++; }, verifyHandoff: async () => ({ safe: false, reason: "SUBMISSION_UNKNOWN" }) });
  life.installSignalHandlers(processLike);
  processLike.emit("SIGINT"); processLike.emit("SIGTERM");
  const first = life.flight;
  assert.equal((await first).phase, "BLOCKED");
  processLike.emit("SIGINT"); processLike.emit("SIGINT");
  const retry = life.flight;
  assert.notEqual(retry, first); await retry;
  assert.equal(processLike.listenerCount("SIGINT"), 1);
  assert.equal(exited, 0); assert.equal(stopped, 0);
  assert.equal(storeRunLocks(store).maintenance.managementPaused, false);
  assert.throws(() => assertEntryAdmission(store));
  await trackOperation(store, {}, "protection still works", async () => {});
});

test("timeout retains actual in-flight registration and lock, never forces exit", async () => {
  const store = storeFixture(), gate = deferred(); let exited = false, unlocked = false;
  const life = lifecycle(store, { deadlineMs: 10, verifyHandoff: () => gate.promise,
    executor: { releaseProcessLock() { unlocked = true; } }, exit() { exited = true; } });
  assert.equal((await life.requestShutdown()).reason, "SHUTDOWN_TIMEOUT");
  assert.equal(lifecycleStatus(store).inFlight, 1);
  assert.equal(exited, false); assert.equal(unlocked, false);
  gate.resolve({ safe: true }); await drainOperations(store);
  assert.equal(lifecycleStatus(store).inFlight, 0); assert.equal(exited, false);
});

test("irreversible close failure is PARTIAL, not terminated and not unlocked", async () => {
  const store = storeFixture(); let unlocked = false, exited = false;
  store.close = () => { throw new Error("fixture close failure"); };
  const life = lifecycle(store, { verifyHandoff: async () => ({ safe: true }),
    executor: { stop: async () => {}, releaseProcessLock: () => { unlocked = true; } },
    server: { closeGracefully: async () => {} }, exit: () => { exited = true; } });
  const result = await life.requestShutdown();
  assert.equal(result.phase, "PARTIAL"); assert.equal(result.resources.httpClosed, true);
  assert.equal(result.resources.storeClosed, false); assert.equal(unlocked, false); assert.equal(exited, false);
});

test("HTTP close reject retains protection managers; delayed timeout stays registered and updates actual late close", async () => {
  for (const delayed of [false, true]) {
    const store = storeFixture(), gate = deferred(); let managers = 0, exits = 0;
    const life = lifecycle(store, { deadlineMs: 15, verifyHandoff: async () => ({ safe: true }),
      accountMonitor: { stop() { managers++; } }, executor: { stop() { managers++; } }, exit() { exits++; },
      server: { closeGracefully: () => delayed ? gate.promise : Promise.reject(new Error("close rejected")) } });
    const result = await life.requestShutdown();
    assert.equal(result.phase, "PARTIAL"); assert.equal(managers, 0); assert.equal(exits, 0);
    assert.equal(storeRunLocks(store).maintenance.managementPaused, false);
    if (delayed) {
      assert.equal(lifecycleStatus(store).inFlight, 1); assert.equal(life.snapshot().resources.httpClosed, false);
      gate.resolve(); await drainOperations(store);
      assert.equal(life.snapshot().resources.httpClosed, true); assert.equal(life.snapshot().phase, "PARTIAL");
    }
  }
});

test("partial manager stop is audited individually, and completed ALS cannot admit detached management", async () => {
  const store = storeFixture();
  const life = lifecycle(store, { verifyHandoff: async () => ({ safe: true }), accountMonitor: { stop() {} },
    executor: { stop() { throw Error("executor stop failed"); } } });
  const result = await life.requestShutdown();
  assert.equal(result.phase, "PARTIAL"); assert.equal(result.resources.accountStopped, true);
  assert.equal(result.resources.executorStopAttempted, true); assert.equal(result.resources.executorStopped, false);
  const other = storeFixture(), gate = deferred(); let detached;
  await trackOperation(other, {}, "parent", () => {
    detached = (async () => { await gate.promise; return trackOperation(other, {}, "stale child", () => "must not execute"); })();
  });
  storeRunLocks(other).maintenance.managementPaused = true;
  const rejected = assert.rejects(detached, { code: "MAINTENANCE_PAUSED" });
  gate.resolve(); await rejected;
});

test("every bound protection is checked and missing TP/BE convergence refuses exit, single-target stays legal", () => {
  const { run, account } = protectedFixture();
  assert.equal(proof(account, [run]).safe, true);
  for (const mutate of [
    a => { a.openAlgoOrders[1].side = "BUY"; },
    a => { a.openAlgoOrders[1].reduceOnly = false; },
    a => { a.openAlgoOrders[1].quantity = 10; },
    a => { a.openAlgoOrders[1].algoId = "999"; },
    a => { a.openAlgoOrders.push(structuredClone(a.openAlgoOrders[1])); },
    a => { a.openAlgoOrders.splice(1, 1); },
  ]) {
    const copy = structuredClone(account); mutate(copy); assert.equal(proof(copy, [run]).safe, false);
  }
  const partial = structuredClone(run); partial.protection.observations.stop.known = false;
  assert.equal(proof(account, [partial]).safe, false);
  const be = structuredClone(run); be.status = "TP1_FILLED"; be.protection.phase = "BREAKEVEN_PENDING";
  assert.equal(proof(account, [be]).safe, false);
  const single = structuredClone(run), a = structuredClone(account);
  single.plan.rules.minNotional = 150; // exact existing splitFilledQuantity fallback
  single.protection.mode = "SINGLE_TARGET"; a.openAlgoOrders.splice(1, 1); delete single.protection.takeProfit1;
  assert.equal(proof(a, [single]).safe, true);
});

test("startup writer and persistent signal handlers are registered before initialization or start awaits", async () => {
  const store = storeFixture(), gate = deferred(), processLike = new EventEmitter();
  let closed = false; store.close = () => { closed = true; };
  const life = lifecycle(store, { verifyHandoff: async () => ({ safe: false, reason: "UNKNOWN" }) });
  life.installSignalHandlers(processLike);
  const startup = trackOperation(store, life, "bootstrap", () => gate.promise);
  processLike.emit("SIGINT"); processLike.emit("SIGTERM");
  await Promise.resolve(); assert.equal(closed, false); assert.ok(lifecycleStatus(store).inFlight > 0);
  gate.resolve(); await startup; await life.flight;
  assert.equal(closed, false); assert.equal(processLike.listenerCount("SIGINT"), 1);
});

test("synchronously reentrant stop joins published flight and hostile logger cannot lose blocked result", async () => {
  const store = storeFixture(); let nested, proofs = 0;
  const life = lifecycle(store, { logger: { error() { throw Error("logger fixture"); } },
    monitor: { stop() { nested = life.requestShutdown("REENTRANT"); } },
    verifyHandoff: async () => { proofs++; return { safe: false, reason: "UNKNOWN" }; } });
  const outer = life.requestShutdown("SIGINT");
  assert.equal(nested, outer); assert.equal((await outer).phase, "BLOCKED"); assert.equal(proofs, 1);
});

test("TEAM031 actual index startup signal preserves management startup and later polling without reopening entry", async () => {
  // Execute the actual index BODY in a VM; every environment, client, server,
  // Store, lock, process and timer is a fake. Never import/launch real index.
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("let activeLifecycle = null;"))
    .replace("main().catch((error) => {", "const mainFlight = main().catch((error) => {");
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) for (const stage of ["initialize", "reconcile"]) {
      const initialize = deferred(), reconcile = deferred(), enteredReconcile = deferred(), callbacks = [];
      globalThis.setInterval = callback => { const timer = { callback, unref() {} }; callbacks.push(timer); return timer; };
      globalThis.clearInterval = timer => { timer.cleared = true; };
      const processLike = new EventEmitter(); processLike.env = {};
      let exits = 0, proofs = 0, reconciles = 0, locks = 0, closes = 0, listens = 0, accountStarts = 0;
      processLike.exit = () => { exits++; };
      const existing = { id: "existing-protected", symbol: "BTCUSDT", status: "OPEN_PROTECTED" };
      class FakeStore {
        async initialize() { await initialize.promise; }
        async getMetadata(key) { return { value: key === PERFORMANCE_EPOCH_METADATA_KEY ? {
          id: "V2.4.3-fixture", startedAt: 1, strategySource: V2_EXECUTION_SOURCE,
          strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_3_SIGNAL_MODEL_VERSION,
        } : { active: false } }; }
        async listActiveExecutionRuns() { return [existing]; }
        close() { closes++; }
      }
      class FakeLifecycle extends RuntimeLifecycle {
        constructor(options) { super({ ...options, setKeepAlive: () => ({}), clearKeepAlive() {}, logger: { error() {} } }); }
      }
      class FakeMonitor extends EventEmitter {
        async initialize() {} async start() {} async stop() {} snapshot() { return { status: "IDLE" }; }
      }
      class FakeAccountMonitor extends EventEmitter { async start() { accountStarts++; } async stop() {} }
      class FakeClient { constructor({ baseUrl }) { this.baseUrl = baseUrl; this.credentialFingerprint = "fixture"; } }
      class ObservedExecutor extends TestnetCanaryExecutor {
        acquireProcessLock() { locks++; }
        async reconcileAll() { reconciles++; enteredReconcile.resolve(); if (reconciles === 1) await reconcile.promise; return []; }
      }
      const config = {
        primaryProvider: "fixture", auxiliaryProvider: "fixture", databasePath: ":memory:", marketEnvironment: "TESTNET",
        binanceBaseUrl: "https://demo-fapi.binance.com", host: "fixture", port: 0, pollMs: 1000, requestTimeoutMs: 1000,
        notifications: { windowsEnabled: false }, portfolio: { startingEquity: 500 }, costs: { activeLimitMaxBps: 10 },
        strategy: { minConfidence: 70 }, shadowV2: { strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION, explorationMinimumScore: 70 },
        marketRadar: { enabled: false }, execution: { autoExecutionEnabled: true, strategySource: V2_EXECUTION_SOURCE,
          accountReadOnlyEnabled: true, orderSubmissionEnabled: true, canarySymbol: "BTCUSDT", canaryMargin: 10,
          canaryLeverage: 10, maxNotionalOverageRate: .05, pullbackEntryTtlMs: 60000, canaryPollMs: 1000, accountPollMs: 1000 },
      };
      const result = runInNewContext(body + "\n({get lifecycle(){return activeLifecycle;},mainFlight});", {
        loadDotEnv() {}, loadConfig: () => config, createMarketDataClient: () => ({}), providerLabel: () => "fixture",
        ResearchStore: FakeStore, RuntimeLifecycle: FakeLifecycle, trackOperation, ResearchMonitor: FakeMonitor,
        WindowsNotifier: class {}, resolveExecutionAllowedSymbols: async () => ["BTCUSDT"],
        BinanceTestnetReadOnlyClient: FakeClient, TestnetAccountMonitor: FakeAccountMonitor,
        BinanceTestnetTradingClient: FakeClient, TestnetCanaryExecutor: ObservedExecutor, createAccountCollector,
        createHandoffVerifier: () => async () => { proofs++; return { safe: false, reason: "FIXTURE_ACCOUNT_UNKNOWN" }; },
        TestnetExecutionGateway: class {}, StrategyExecutionCoordinator,
        createDashboardServer: () => ({ beginMaintenanceDrain() {}, async closeGracefully() { throw Error("must not close"); } }),
        listen: async () => { listens++; }, PERFORMANCE_EPOCH_METADATA_KEY, PERFORMANCE_EPOCH_HISTORY_METADATA_KEY,
        V2_DEMO_STRATEGY_VERSION, V2_EXECUTION_SOURCE, buildPerformanceEpoch() { throw Error("must not change epoch"); },
        process: processLike, console: { error() {}, info() {} },
      });
      assert.equal(result.lifecycle.executor, null);
      if (stage === "reconcile") { initialize.resolve(); await enteredReconcile.promise; }
      processLike.emit(signal); const shutdown = result.lifecycle.flight;
      initialize.resolve(); await enteredReconcile.promise;
      processLike.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      assert.equal(result.lifecycle.flight, shutdown);
      reconcile.resolve(); await result.mainFlight;
      const blocked = await shutdown, executor = result.lifecycle.executor;
      assert.equal(blocked.phase, "BLOCKED"); assert.equal(blocked.reason, "FIXTURE_ACCOUNT_UNKNOWN");
      assert.equal(blocked.managementPaused, false); assert.equal(reconciles, 1); assert.equal(locks, 1);
      assert.equal(executor.stopped, false); assert.ok(executor.timer);
      assert.equal(result.lifecycle.coordinator.started, false);
      assert.throws(() => assertEntryAdmission(result.lifecycle.store), { code: "MAINTENANCE_PAUSED" });
      await result.lifecycle.coordinator.enqueueSignal("must-not-enter");
      assert.equal(result.lifecycle.coordinator.snapshot().queued, 0);
      executor.timer.callback(); await Promise.resolve(); await drainOperations(result.lifecycle.store);
      assert.equal(reconciles, 2); assert.equal(proofs, 1);
      assert.equal(exits, 0); assert.equal(closes, 0); assert.equal(listens, 1); assert.equal(accountStarts, 1);
      assert.equal(processLike.listenerCount("SIGINT"), 1); assert.equal(processLike.listenerCount("SIGTERM"), 1);
      assert.equal(lifecycleStatus(result.lifecycle.store).inFlight, 0);
      await executor.stop({ releaseLock: false });
      assert.equal(executor.timer, null); assert.ok(callbacks.every(timer => timer.cleared));
    }
  } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});
