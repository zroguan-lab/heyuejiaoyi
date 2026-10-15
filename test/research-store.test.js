import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResearchStore } from "../src/infrastructure/research-store.js";
import { createManualTrade } from "../src/domain/trade-lifecycle.js";
import { V2_EXECUTION_SOURCE } from "../src/execution/execution-strategy-source.js";

test("研究数据库持久化候选、模拟交易和手动跟单且严格分账", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "signal-store-"));
  const store = new ResearchStore(path.join(directory, "research.sqlite"));
  await store.initialize();
  const candidate = {
    id: "s1", symbol: "BTCUSDT", strategy: "BREAKOUT", direction: "LONG", status: "CANDIDATE", triggerTime: 1000,
    risk: { stopLoss: 98, takeProfit1: 103, takeProfit2: 105 },
  };
  assert.equal(await store.saveCandidate(candidate), true);
  assert.equal(await store.saveCandidate(candidate), false);
  await store.markCandidate("s1", { selected: true });
  await store.saveTrade({ signalId: "s1", status: "ENTRY_PENDING", symbol: "BTCUSDT" });
  const manualTrade = createManualTrade(candidate, { id: "m1", fillPrice: 100, quantity: 0.01, feeRate: 0, createdAt: 2000 });
  const manual = await store.saveManualTrade(manualTrade, "manual");
  assert.ok(manual.id);
  assert.equal((await store.listActiveTrades()).length, 1);
  assert.equal((await store.listManualTrades()).length, 1);
  assert.equal((await store.listActiveManualTrades()).length, 1);
  await store.saveUniverseSnapshot({ provider: "binance", selectedAt: 3000, items: [{ symbol: "BTCUSDT" }] });
  await store.saveUniverseSnapshot({ provider: "binance", selectedAt: 4000, items: [{ symbol: "ETHUSDT" }] });
  const snapshots = await store.listUniverseSnapshots();
  assert.deepEqual(snapshots.map((item) => item.selectedAt), [4000, 3000]);
  assert.equal(snapshots[0].items[0].symbol, "ETHUSDT");
  const accountSnapshot = {
    environment: "TESTNET", authority: "BINANCE_TESTNET", readOnly: true, syncedAt: 5000, serverTime: 5000, clockOffsetMs: 0,
    account: { totalWalletBalance: 100 }, positionMode: "ONE_WAY", positions: [], openOrders: [],
  };
  assert.equal(await store.saveTestnetAccountSnapshot(accountSnapshot), true);
  assert.equal(await store.saveTestnetAccountSnapshot({ ...accountSnapshot, syncedAt: 6000, serverTime: 6000 }), false);
  assert.equal((await store.latestTestnetAccountSnapshot()).account.totalWalletBalance, 100);
  const executionRun = {
    id: "canary-s1", signalId: "s1", symbol: "BTCUSDT", status: "PREPARED",
    createdAt: 7000, updatedAt: 7000, plan: { quantity: "0.0012", marginEstimate: 10 },
  };
  assert.equal((await store.createExecutionRun(executionRun)).created, true);
  assert.equal((await store.createExecutionRun(executionRun)).created, false);
  const secondCandidate = { ...candidate, id: "s2", triggerTime: 2000 };
  await store.saveCandidate(secondCandidate, { selected: true });
  const secondRun = {
    id: "canary-s2", signalId: "s2", symbol: "BTCUSDT", status: "PREPARED",
    createdAt: 7500, updatedAt: 7500, plan: { quantity: "0.0012", marginEstimate: 10 },
  };
  await assert.rejects(() => store.createExecutionRun(secondRun), /已有未结束/);
  executionRun.status = "ENTRY_PENDING";
  executionRun.updatedAt = 8000;
  await store.saveExecutionRun(executionRun);
  await store.appendExecutionAudit(executionRun.id, "ENTRY_INTENT_PERSISTED", { clientOrderId: "cfs-entry" }, 8000);
  assert.equal((await store.getExecutionRun(executionRun.id)).status, "ENTRY_PENDING");
  assert.equal((await store.getExecutionRunBySignal("s1")).id, executionRun.id);
  assert.equal((await store.listActiveExecutionRuns()).length, 1);
  assert.equal((await store.listExecutionAudit(executionRun.id))[0].eventType, "ENTRY_INTENT_PERSISTED");
  assert.equal(await store.createOperatorCanarySource({ id: "operator-test-12345678", direction: "LONG", createdAt: 8500 }), true);
  assert.equal((await store.listSignals()).some((item) => item.candidate.strategy === "OPERATOR_CANARY"), false);
  executionRun.status = "CANCELED";
  executionRun.updatedAt = 9000;
  await store.saveExecutionRun(executionRun);
  assert.equal((await store.createExecutionRun(secondRun)).created, true);
  const signal = await store.getSignal("s1");
  assert.equal(signal.trade.status, "ENTRY_PENDING");
  assert.equal(signal.candidate.status, "CANDIDATE");
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("V2 影子组合独立持久化且不能污染 V1 selected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shadow-store-"));
  const store = new ResearchStore(path.join(directory, "research.sqlite"));
  await store.initialize();
  const candidate = {
    id: "shadow-s1", symbol: "ETHUSDT", strategy: "BREAKOUT", direction: "LONG", status: "CANDIDATE", triggerTime: 1_000,
    shadowV2: { strategyVersion: "MTF_1H_15M_5M_V2_SHADOW", mode: "SHADOW_ONLY", orderSubmissionAllowed: false, score: 88 },
  };
  await store.saveCandidate(candidate);
  const trade = { signalId: candidate.id, symbol: candidate.symbol, status: "ENTRY_PENDING", orderSubmissionAllowed: false };
  await store.saveShadowDecision(candidate, { selected: true, trade });
  assert.equal((await store.getSignal(candidate.id)).selected, false);
  assert.equal((await store.listActiveTrades()).length, 0);
  assert.equal((await store.listActiveShadowTrades()).length, 1);
  assert.equal((await store.listShadowSignals())[0].trade.orderSubmissionAllowed, false);
  const executable = await store.getExecutionSignal(candidate.id, V2_EXECUTION_SOURCE);
  assert.equal(executable.selected, true);
  assert.equal(executable.executionSource, V2_EXECUTION_SOURCE);
  assert.equal(executable.candidate.score, 88);
  assert.equal((await store.listExecutionSignals(V2_EXECUTION_SOURCE)).length, 1);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("V2.4.3边界源反事实账保持未入选且不会进入Demo执行列表", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "boundary-counterfactual-store-"));
  const store = new ResearchStore(path.join(directory, "research.sqlite"));
  await store.initialize();
  const candidate = {
    id: "boundary-only-s1",
    symbol: "ETHUSDT",
    strategy: "PRE_BREAKOUT",
    direction: "LONG",
    status: "CANDIDATE",
    triggerTime: 1_000,
    shadowV2: {
      strategyVersion: "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER",
      mode: "SHADOW_ONLY",
      orderSubmissionAllowed: false,
      score: 70,
    },
  };
  const trade = {
    signalId: candidate.id,
    symbol: candidate.symbol,
    status: "ENTRY_PENDING",
    counterfactual: true,
    orderSubmissionAllowed: false,
  };
  await store.saveCandidate(candidate);
  await store.saveShadowDecision(candidate, {
    selected: false,
    rejectionReason: "V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE",
    counterfactual: true,
    trade,
  });
  trade.status = "OPEN";
  await store.saveShadowTrade(trade);
  const record = await store.getShadowSignal(candidate.id);
  assert.equal(record.decision.selected, false);
  assert.equal(record.decision.counterfactual, true);
  assert.equal((await store.listActiveShadowTrades())[0].counterfactual, true);
  assert.equal((await store.listExecutionSignals(V2_EXECUTION_SOURCE)).length, 0);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("执行记录允许不同标的全量预留且只报告实际活动数量和保证金", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-capacity-"));
  const store = new ResearchStore(path.join(directory, "research.sqlite"));
  await store.initialize();
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "DOGEUSDT", "XRPUSDT"];
  for (const [index, symbol] of symbols.entries()) {
    await store.saveCandidate({
      id: `slot-${index}`,
      symbol,
      strategy: "BREAKOUT",
      direction: "LONG",
      status: "CANDIDATE",
      triggerTime: 1_000 + index,
    }, { selected: true });
  }
  for (let index = 0; index < 6; index += 1) {
    const symbol = symbols[index];
    const created = await store.createExecutionRun({
      id: `run-${index}`,
      signalId: `slot-${index}`,
      symbol,
      status: "PREPARED",
      createdAt: 2_000 + index,
      updatedAt: 2_000 + index,
      plan: { marginEstimate: 10 },
    });
    assert.equal(created.created, true);
  }
  assert.deepEqual(await store.getExecutionCapacity(), {
    activeRuns: 6,
    availableSlots: null,
    reservedMargin: 60,
    availableMargin: null,
    maxActiveRuns: null,
    maxReservedMargin: null,
    positionPolicy: "ALL_ELIGIBLE",
    activeSymbols: symbols,
  });
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("执行记录拒绝同标的并发但不设置固定总保证金上限", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-reservation-"));
  const store = new ResearchStore(path.join(directory, "research.sqlite"));
  await store.initialize();
  for (const [id, symbol] of [["a", "BTCUSDT"], ["b", "BTCUSDT"], ["c", "ETHUSDT"]]) {
    await store.saveCandidate({ id, symbol, strategy: "BREAKOUT", direction: "LONG", status: "CANDIDATE", triggerTime: 1_000 }, { selected: true });
  }
  await store.createExecutionRun({
    id: "run-a", signalId: "a", symbol: "BTCUSDT", status: "PREPARED", createdAt: 2_000, updatedAt: 2_000,
    plan: { marginEstimate: 40 },
  });
  await assert.rejects(() => store.createExecutionRun({
    id: "run-b", signalId: "b", symbol: "BTCUSDT", status: "PREPARED", createdAt: 2_001, updatedAt: 2_001,
    plan: { marginEstimate: 1 },
  }), /标的 BTCUSDT 已有未结束/);
  const created = await store.createExecutionRun({
    id: "run-c", signalId: "c", symbol: "ETHUSDT", status: "PREPARED", createdAt: 2_002, updatedAt: 2_002,
    plan: { marginEstimate: 10.00000002 },
  });
  assert.equal(created.created, true);
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("旧版全局单仓索引只在没有活动执行记录时迁移为同标的唯一", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-migration-"));
  const databasePath = path.join(directory, "research.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, strategy TEXT NOT NULL, direction TEXT NOT NULL,
      status TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE execution_runs (
      id TEXT PRIMARY KEY, signal_id TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX execution_runs_single_active_idx ON execution_runs((1))
    WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED');
  `);
  legacy.close();

  const store = new ResearchStore(databasePath);
  await store.initialize();

  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'execution_runs_%active%'").all().map((row) => row.name);
  assert.equal(indexes.includes("execution_runs_single_active_idx"), false);
  assert.equal(indexes.includes("execution_runs_one_active_symbol_idx"), true);
  assert.equal((await store.getMetadata("execution_schema_version")).value.version, 3);
  assert.equal((await store.getMetadata("execution_schema_version")).value.positionPolicy, "ALL_ELIGIBLE");
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test("旧版数据库仍有活动执行记录时拒绝多仓迁移且保留原索引", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "execution-migration-blocked-"));
  const databasePath = path.join(directory, "research.sqlite");
  const legacy = new DatabaseSync(databasePath);
  const payload = JSON.stringify({
    id: "active-run",
    signalId: "active-signal",
    symbol: "BCHUSDT",
    status: "OPEN_PROTECTED",
    createdAt: 1_000,
    updatedAt: 1_000,
    plan: { marginEstimate: 10 },
  });
  legacy.exec(`
    CREATE TABLE signals (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, strategy TEXT NOT NULL, direction TEXT NOT NULL,
      status TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE execution_runs (
      id TEXT PRIMARY KEY, signal_id TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX execution_runs_single_active_idx ON execution_runs((1))
    WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED');
  `);
  legacy.prepare(`
    INSERT INTO execution_runs(id, signal_id, symbol, status, created_at, updated_at, payload)
    VALUES('active-run', 'active-signal', 'BCHUSDT', 'OPEN_PROTECTED', 1000, 1000, ?)
  `).run(payload);
  legacy.close();

  const store = new ResearchStore(databasePath);
  await assert.rejects(() => store.initialize(), /要求所有测试网执行记录先进入终态/);
  const indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'execution_runs_%active%'").all().map((row) => row.name);
  assert.equal(indexes.includes("execution_runs_single_active_idx"), true);
  assert.equal(indexes.includes("execution_runs_one_active_symbol_idx"), false);
  store.close();
  await rm(directory, { recursive: true, force: true });
});
