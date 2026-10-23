import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { ResearchStore } from "../src/infrastructure/research-store.js";
import { verifyDecisionSnapshot } from "../src/domain/decision-snapshot.js";
import {
  assessAutomaticExecutionSignal,
  StrategyExecutionCoordinator,
} from "../src/application/strategy-execution-coordinator.js";
import {
  V2_4_3_SIGNAL_MODEL_VERSION,
  V2_DEMO_STRATEGY_VERSION,
  V2_EXECUTION_SOURCE,
} from "../src/execution/execution-strategy-source.js";

function signal(id, now, overrides = {}) {
  const symbol = overrides.symbol ?? "AKEUSDT";
  const status = overrides.status ?? "ENTRY_PENDING";
  return {
    selected: overrides.selected ?? true,
    candidate: {
      id,
      symbol,
      direction: "SHORT",
      strategy: overrides.strategy ?? "BREAKOUT",
      score: overrides.score ?? 75,
      triggerTime: overrides.triggerTime ?? now,
      performanceEligible: overrides.performanceEligible,
    },
    trade: {
      signalId: id,
      symbol,
      direction: "SHORT",
      status,
      expiresAt: overrides.expiresAt ?? now + 120_000,
    },
  };
}

class MemoryStore {
  constructor(records = [], activeRuns = [], v2Records = []) {
    this.records = new Map(records.map((record) => [record.candidate.id, structuredClone(record)]));
    this.v2Records = new Map(v2Records.map((record) => [record.candidate.id, structuredClone(record)]));
    this.activeRuns = activeRuns;
    this.audit = [];
    this.snapshots = new Map();
    this.metadata = new Map();
  }
  async getSignal(id) { return structuredClone(this.records.get(id) ?? null); }
  async getExecutionSignal(id, source) {
    return structuredClone((source === V2_EXECUTION_SOURCE ? this.v2Records : this.records).get(id) ?? null);
  }
  async getExecutionRunBySignal(id) { return structuredClone(this.activeRuns.find((run) => run.signalId === id) ?? null); }
  async listActiveExecutionRuns() { return structuredClone(this.activeRuns); }
  async getExecutionCapacity() {
    return { availableSlots: Math.max(0, 5 - this.activeRuns.length), activeRuns: this.activeRuns.length };
  }
  async listSignals() { return structuredClone([...this.records.values()]); }
  async listExecutionSignals(source) {
    return structuredClone([...(source === V2_EXECUTION_SOURCE ? this.v2Records : this.records).values()]);
  }
  async appendExecutionAudit(runId, eventType, payload, createdAt) { this.audit.push({ runId, eventType, payload, createdAt }); }
  async appendDecisionSnapshot(snapshot) { this.snapshots.set(snapshot.snapshotId, structuredClone(snapshot)); return structuredClone(snapshot); }
  async getDecisionSnapshot(id) { return structuredClone(this.snapshots.get(id) ?? null); }
  async getMetadata(key) { return this.metadata.has(key) ? { value: structuredClone(this.metadata.get(key)) } : null; }
}

class FakeExecutor extends EventEmitter {
  constructor(store) {
    super();
    this.enabled = true;
    this.store = store;
    this.prepared = [];
    this.executed = [];
  }
  async prepare(signalId, { strategySource } = {}) {
    this.prepared.push(signalId);
    const record = await this.store.getExecutionSignal(signalId, strategySource);
    const run = { id: `run-${signalId}`, signalId, symbol: record.candidate.symbol, status: "PREPARED" };
    this.store.activeRuns.push(run);
    return { run, confirmationCode: "CONFIRM", reused: false, sourceDecisionRecord: structuredClone(record) };
  }
  async execute(runId, confirmationCode) {
    this.executed.push({ runId, confirmationCode });
    const current = this.store.activeRuns.find((run) => run.id === runId);
    const run = { ...current, status: "ENTRY_PENDING" };
    this.store.activeRuns = this.store.activeRuns.map((item) => item.id === runId ? run : item);
    return run;
  }
}

class FlakyPrepareExecutor extends FakeExecutor {
  constructor(store) {
    super(store);
    this.prepareAttempts = 0;
  }
  async prepare(signalId, options = {}) {
    this.prepareAttempts += 1;
    if (this.prepareAttempts === 1) throw new Error("Binance Testnet 连接失败: timeout");
    return await super.prepare(signalId, options);
  }
}

test("自动执行资格只接受新鲜的模拟组合等待入场信号", () => {
  const now = 1_000_000;
  assert.equal(assessAutomaticExecutionSignal(signal("ok", now), { now }).eligible, true);
  assert.equal(assessAutomaticExecutionSignal(signal("open", now, { status: "OPEN" }), { now }).reason, "TRADE_OPEN");
  assert.equal(assessAutomaticExecutionSignal(signal("expired", now, { expiresAt: now + 29_999 }), { now }).reason, "SIGNAL_EXPIRED");
  assert.equal(assessAutomaticExecutionSignal(signal("rejected", now, { selected: false }), { now }).reason, "NOT_SELECTED");
  assert.equal(assessAutomaticExecutionSignal(signal("operator", now, { strategy: "OPERATOR_CANARY" }), { now }).reason, "NOT_STRATEGY_SIGNAL");
  assert.equal(assessAutomaticExecutionSignal(signal("low-score", now, { score: 69 }), { now, minimumScore: 70 }).reason, "SCORE_BELOW_MIN_CONFIDENCE");
});

test("启动时按分数顺序提交全部合格信号且每个信号只提交一次", async () => {
  const now = 2_000_000;
  const low = signal("ake-low", now, { score: 72 });
  const high = signal("celr-high", now, { symbol: "CELRUSDT", score: 88 });
  const monitor = new EventEmitter();
  const store = new MemoryStore([low, high]);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, now: () => now });

  await coordinator.start();
  await coordinator.drain();

  assert.deepEqual(executor.prepared, ["celr-high", "ake-low"]);
  assert.deepEqual(executor.executed, [
    { runId: "run-celr-high", confirmationCode: "CONFIRM" },
    { runId: "run-ake-low", confirmationCode: "CONFIRM" },
  ]);
  assert.equal(store.audit[0].eventType, "AUTO_EXECUTION_SELECTED");
  assert.equal(store.audit[0].payload.symbol, "CELRUSDT");
  assert.equal(coordinator.snapshot().lastDecision.status, "SUBMITTED");
  coordinator.stop();
});

test("Demo准备遇到瞬时网络超时后会在信号有效期内自动重试", async () => {
  const now = 2_200_000;
  const record = signal("retry-network", now, { symbol: "1000PEPEUSDT", score: 80, expiresAt: now + 120_000 });
  const monitor = new EventEmitter();
  const store = new MemoryStore([record]);
  const executor = new FlakyPrepareExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({
    monitor,
    executor,
    store,
    enabled: true,
    recoverySweepMs: 20,
    now: () => now,
    logger: { error() {} },
  });

  await coordinator.start();
  assert.equal(coordinator.snapshot().lastDecision.status, "RETRY_PENDING");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await coordinator.drain();

  assert.equal(executor.prepareAttempts, 2);
  assert.deepEqual(executor.prepared, ["retry-network"]);
  assert.deepEqual(executor.executed, [{ runId: "run-retry-network", confirmationCode: "CONFIRM" }]);
  assert.notEqual(coordinator.snapshot().lastDecision.status, "RETRY_PENDING");
  coordinator.stop();
});

test("自动执行不设置固定持仓笔数上限", async () => {
  const now = 2_500_000;
  const records = Array.from({ length: 7 }, (_, index) => signal(`signal-${index}`, now, {
    symbol: `COIN${index}USDT`,
    score: 70 + index,
  }));
  const monitor = new EventEmitter();
  const store = new MemoryStore(records);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, minimumScore: 70, now: () => now });

  await coordinator.start();
  await coordinator.drain();

  assert.equal(executor.executed.length, 7);
  assert.equal(store.activeRuns.length, 7);
  assert.equal(coordinator.snapshot().positionPolicy, "ALL_ELIGIBLE");
  coordinator.stop();
});

test("同标的已有执行时推迟新信号，结束后只重新选择仍有效的信号", async () => {
  const now = 3_000_000;
  const next = signal("btc-next", now, { symbol: "BTCUSDT", score: 80 });
  const monitor = new EventEmitter();
  const store = new MemoryStore([next], [{ id: "run-current", signalId: "old", symbol: "BTCUSDT", status: "OPEN_PROTECTED" }]);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, now: () => now });

  await coordinator.start();
  monitor.emit("portfolioSignal", { candidate: next.candidate, trade: next.trade });
  await coordinator.drain();
  assert.equal(executor.executed.length, 0);

  store.activeRuns = [];
  executor.emit("execution", { id: "run-current", status: "CLOSED" });
  await coordinator.drain();
  assert.deepEqual(executor.prepared, ["btc-next"]);
  assert.equal(executor.executed.length, 1);
  coordinator.stop();
});

test("其他标的已有受保护仓位时仍可执行新的不同标的信号", async () => {
  const now = 3_500_000;
  const next = signal("ake-next", now, { symbol: "AKEUSDT", score: 80 });
  const monitor = new EventEmitter();
  const store = new MemoryStore([next], [{ id: "run-current", signalId: "old", symbol: "BTCUSDT", status: "OPEN_PROTECTED" }]);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, now: () => now });

  await coordinator.start();
  await coordinator.drain();

  assert.deepEqual(executor.prepared, ["ake-next"]);
  assert.equal(store.activeRuns.length, 2);
  assert.deepEqual(store.activeRuns.map((run) => run.symbol), ["BTCUSDT", "AKEUSDT"]);
  coordinator.stop();
});

test("存在提交结果未知或无保护异常时协调器全局暂停新入场", async () => {
  const now = 3_700_000;
  const next = signal("eth-next", now, { symbol: "ETHUSDT", score: 80 });
  for (const status of ["SUBMISSION_UNKNOWN", "ENTRY_FACT_CONFLICT", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED"]) {
    const monitor = new EventEmitter();
    const store = new MemoryStore([next], [{ id: `run-${status}`, signalId: "old", symbol: "BTCUSDT", status }]);
    const executor = new FakeExecutor(store);
    const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, now: () => now });
    await coordinator.start();
    await coordinator.drain();
    assert.equal(executor.prepared.length, 0);
    assert.equal(coordinator.snapshot().lastDecision.reason, "EXECUTION_SAFETY_HOLD");
    coordinator.stop();
  }
});

test("关闭自动执行时不会订阅或准备交易", async () => {
  const now = 4_000_000;
  const record = signal("disabled", now);
  const monitor = new EventEmitter();
  const store = new MemoryStore([record]);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: false, now: () => now });

  await coordinator.start();
  monitor.emit("portfolioSignal", { candidate: record.candidate, trade: record.trade });
  await coordinator.drain();
  assert.equal(executor.prepared.length, 0);
  assert.equal(coordinator.snapshot().status, "DISABLED");
});

test("V2 shadowSignal 事件永远不会进入 Demo 自动下单协调器", async () => {
  const now = 5_000_000;
  const monitor = new EventEmitter();
  const store = new MemoryStore([]);
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({ monitor, executor, store, enabled: true, now: () => now });
  await coordinator.start();
  monitor.emit("shadowSignal", {
    candidate: { id: "v2-shadow", symbol: "BTCUSDT", shadowV2: { orderSubmissionAllowed: false } },
    trade: { signalId: "v2-shadow", status: "ENTRY_PENDING", orderSubmissionAllowed: false },
  });
  await coordinator.drain();
  assert.deepEqual(executor.prepared, []);
  assert.deepEqual(executor.executed, []);
  coordinator.stop();
});

test("显式切换到 V2.4.3 后只执行纪元内的 V2.4.3 入选信号且忽略旧版本和V1事件", async () => {
  const now = 6_000_000;
  const v1 = signal("v1-new", now, { symbol: "BTCUSDT", triggerTime: now });
  const v2 = signal("v2-new", now, { symbol: "ETHUSDT", triggerTime: now, score: 82 });
  v2.executionSource = V2_EXECUTION_SOURCE;
  v2.evaluation = {
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    eligible: true,
    score: 82,
    strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION,
    experimentTier: "CORE",
    costs: { totalCostR: 0.1 },
  };
  v2.candidate.strategyVersion = V2_DEMO_STRATEGY_VERSION;
  v2.candidate.executionSource = V2_EXECUTION_SOURCE;
  v2.candidate.experimentTier = "CORE";
  v2.trade.portfolio = "V2_4_3_PREMOVE";
  v2.trade.orderSubmissionAllowed = false;
  const old = structuredClone(v2);
  old.candidate.id = "v2-old";
  old.trade.signalId = "v2-old";
  old.candidate.triggerTime = now - 10_000;
  old.evaluation.strategyVersion = "PRE_MOVE_1H_15M_5M_V2_3";
  old.trade.portfolio = "V2_3_PREMOVE";
  const monitor = new EventEmitter();
  const store = new MemoryStore([v1], [], [v2, old]);
  store.metadata.set("active_strategy_performance_epoch", { id: "fixture-v2-epoch", startedAt: now - 1_000,
    strategySource: V2_EXECUTION_SOURCE, strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_3_SIGNAL_MODEL_VERSION });
  const executor = new FakeExecutor(store);
  const coordinator = new StrategyExecutionCoordinator({
    monitor,
    executor,
    store,
    enabled: true,
    strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1_000,
    now: () => now,
  });

  await coordinator.start();
  await coordinator.drain();
  assert.deepEqual(executor.prepared, ["v2-new"]);
  monitor.emit("portfolioSignal", { candidate: v1.candidate, trade: v1.trade });
  await coordinator.drain();
  assert.deepEqual(executor.prepared, ["v2-new"]);
  assert.equal(coordinator.snapshot().strategySource, V2_EXECUTION_SOURCE);
  assert.equal(coordinator.snapshot().positionPolicy, "V2_4_3_PREMOVE_BOUNDARY_FILTER_ALL_ELIGIBLE");
  coordinator.stop();
});

test("旧V2.1探索层即使达到55分也不能再由Demo适配器执行", () => {
  const now = 7_000_000;
  const record = signal("v2-exploration", now, { score: 61 });
  record.executionSource = V2_EXECUTION_SOURCE;
  record.evaluation = {
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    eligible: true,
    score: 61,
    strategyVersion: "MTF_1H_15M_5M_V2_1_DUAL_TIER",
    experimentTier: "EXPLORATION",
  };
  record.candidate.executionSource = V2_EXECUTION_SOURCE;
  record.candidate.experimentTier = "EXPLORATION";
  record.trade.portfolio = "V2_1_DUAL_TIER";
  record.trade.orderSubmissionAllowed = false;
  const assessment = assessAutomaticExecutionSignal(record, {
    now,
    minimumScore: 55,
    strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1,
  });
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.reason, "V2_4_3_SIGNAL_MODEL_REQUIRED");
});

test("V2.4.3沿用0.20R至0.35R探索组且拒绝超过0.35R", () => {
  const now = 7_500_000;
  const record = signal("v2-costly", now, { score: 75 });
  record.executionSource = V2_EXECUTION_SOURCE;
  record.candidate.strategyVersion = V2_DEMO_STRATEGY_VERSION;
  record.candidate.executionSource = V2_EXECUTION_SOURCE;
  record.candidate.experimentTier = "EXPLORATION";
  record.evaluation = {
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    eligible: true,
    score: 75,
    strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION,
    experimentTier: "EXPLORATION",
    costs: { totalCostR: 0.2001 },
  };
  record.trade.portfolio = "V2_4_3_PREMOVE";
  record.trade.orderSubmissionAllowed = false;
  const assessment = assessAutomaticExecutionSignal(record, {
    now,
    minimumScore: 55,
    strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1,
  });
  assert.equal(record.selected, true);
  assert.equal(record.trade.status, "ENTRY_PENDING");
  assert.equal(assessment.eligible, true);
  assert.equal(assessment.promotionDecision.costCohort, "HIGH_COST_EXPLORATION");

  record.evaluation.costs.totalCostR = 0.3501;
  const rejected = assessAutomaticExecutionSignal(record, {
    now,
    minimumScore: 55,
    strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1,
  });
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.reason, "V2_4_3_EXECUTION_COST_R_ABOVE_0_35");
});

test("V2 Demo 准入拒绝缺少当前市场雷达版本的旧信号", () => {
  const now = 8_000_000;
  const record = signal("v2-radar", now, { score: 80 });
  record.executionSource = V2_EXECUTION_SOURCE;
  record.evaluation = {
    mode: "SHADOW_ONLY", orderSubmissionAllowed: false, eligible: true, score: 80,
    strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION, experimentTier: "CORE", costs: { totalCostR: 0.1 },
  };
  record.trade.portfolio = "V2_4_3_PREMOVE";
  record.trade.orderSubmissionAllowed = false;
  const options = {
    now, minimumScore: 55, strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1, requiredRadarVersion: "MARKET_RADAR_R1",
  };
  assert.equal(assessAutomaticExecutionSignal(record, options).reason, "MARKET_RADAR_CONTEXT_INVALID");
  record.evaluation.marketRadar = { version: "MARKET_RADAR_R1", selected: true, snapshotId: "radar-1" };
  assert.equal(assessAutomaticExecutionSignal(record, options).eligible, true);
});

test("执行前快照写入并读回后才提交，且不改变既有准入与执行请求", async () => {
  const now = 9_000_000;
  const record = signal("snapshot-ok", now, { score: 80 });
  record.candidate.preMove = { volumeAcceleration: 1.25, boundaryDistanceAtr: 0.4 };
  const store = new MemoryStore([record]);
  const executor = new FakeExecutor(store);
  const execute = executor.execute.bind(executor);
  executor.execute = async (...args) => {
    assert.equal(store.snapshots.size, 1);
    assert.equal(store.audit.at(-1).eventType, "ENTRY_DECISION_SNAPSHOT_SAVED");
    assert.equal(verifyDecisionSnapshot([...store.snapshots.values()][0]), true);
    return execute(...args);
  };
  const coordinator = new StrategyExecutionCoordinator({ monitor: new EventEmitter(), executor, store, enabled: true, now: () => now });
  await coordinator.trySignal("snapshot-ok", "TEST");
  const snapshot = [...store.snapshots.values()][0];
  assert.equal(snapshot.scope, "ENTRY_PRE_SUBMIT");
  assert.equal(snapshot.preMove.volumeAcceleration, 1.25);
  assert.equal(snapshot.scores.executionScore, 80);
  assert.equal(snapshot.versions.epochId, null);
  assert.deepEqual(executor.executed, [{ runId: "run-snapshot-ok", confirmationCode: "CONFIRM" }]);
  assert.equal(JSON.stringify(snapshot).includes("CONFIRM"), false);
});

test("写快照失败或读回被篡改时均不执行，也不事后补造入场证据", async () => {
  for (const mode of ["WRITE_FAIL", "READBACK_CORRUPT", "SOURCE_MISSING"]) {
    const now = 10_000_000;
    const store = new MemoryStore([signal(`snapshot-${mode}`, now)]);
    const executor = new FakeExecutor(store);
    if (mode === "WRITE_FAIL") store.appendDecisionSnapshot = async () => { throw new Error("fixture storage unavailable"); };
    if (mode === "READBACK_CORRUPT") store.getDecisionSnapshot = async () => ({ contentHash: "tampered" });
    if (mode === "SOURCE_MISSING") {
      const prepare = executor.prepare.bind(executor);
      executor.prepare = async (...args) => { const prepared = await prepare(...args); delete prepared.sourceDecisionRecord; return prepared; };
    }
    const coordinator = new StrategyExecutionCoordinator({ monitor: new EventEmitter(), executor, store, enabled: true,
      now: () => now, logger: { error() {} } });
    const result = await coordinator.trySignal(`snapshot-${mode}`, "TEST");
    assert.equal(result.status, "EVIDENCE_BLOCKED");
    assert.equal(result.reason, "ENTRY_SNAPSHOT_NOT_PERSISTED");
    assert.equal(executor.executed.length, 0);
    assert.equal(store.audit.at(-1).eventType, "ENTRY_SNAPSHOT_FAILED");
    // A persisted plan with missing pre-submit evidence is not silently resumed or backfilled.
    await coordinator.trySignal(`snapshot-${mode}`, "RETRY");
    assert.equal(executor.executed.length, 0);
    assert.equal(coordinator.lastDecision.reason, "ALREADY_RECORDED");
  }
});

test("执行快照使用prepare实际依据，不用较早的协调器记录冒充，源对象后续变化不污染快照", async () => {
  const now = 11_000_000;
  const record = signal("snapshot-actual-source", now);
  record.candidate.preMove = { volumeAcceleration: 0.5 };
  const store = new MemoryStore([record]);
  const executor = new FakeExecutor(store);
  const prepare = executor.prepare.bind(executor);
  let actual;
  executor.prepare = async (...args) => {
    const changed = store.records.get("snapshot-actual-source");
    changed.candidate.preMove.volumeAcceleration = 1.7;
    changed.candidate.score = 81;
    const prepared = await prepare(...args);
    actual = prepared.sourceDecisionRecord;
    return prepared;
  };
  const coordinator = new StrategyExecutionCoordinator({ monitor: new EventEmitter(), executor, store, enabled: true, now: () => now });
  await coordinator.trySignal("snapshot-actual-source", "TEST");
  actual.candidate.preMove.volumeAcceleration = 99;
  const snapshot = [...store.snapshots.values()][0];
  assert.equal(snapshot.preMove.volumeAcceleration, 1.7);
  assert.equal(snapshot.scores.executionScore, 81);
  assert.equal(store.audit.find(a => a.eventType === "AUTO_EXECUTION_SELECTED").payload.score, 81);
  assert.equal(store.audit.find(a => a.eventType === "AUTO_EXECUTION_SELECTED").payload.assessmentScore, 75);
  assert.equal(verifyDecisionSnapshot(snapshot), true);
});

test("V2准备期间纪元切换或纪元缺失时不把错误纪元写进入场证据，也不提交", async () => {
  for (const mode of ["EPOCH_CHANGED", "EPOCH_MISSING"]) {
    const now = 12_000_000;
    const record = signal(`epoch-${mode}`, now, { score: 80 });
    record.executionSource = V2_EXECUTION_SOURCE;
    record.candidate.executionSource = V2_EXECUTION_SOURCE;
    record.candidate.strategyVersion = V2_DEMO_STRATEGY_VERSION;
    record.candidate.signalModelVersion = V2_4_3_SIGNAL_MODEL_VERSION;
    record.evaluation = { strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION, mode: "SHADOW_ONLY", eligible: true,
      orderSubmissionAllowed: false, score: 80, experimentTier: "CORE", costs: { totalCostR: 0.1 } };
    record.trade.portfolio = "V2_4_3_PREMOVE"; record.trade.orderSubmissionAllowed = false;
    const store = new MemoryStore([], [], [record]);
    store.metadata.set("active_strategy_performance_epoch", { id: "before", startedAt: now - 1000,
      strategySource: V2_EXECUTION_SOURCE, strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_3_SIGNAL_MODEL_VERSION });
    const executor = new FakeExecutor(store), prepare = executor.prepare.bind(executor);
    executor.prepare = async (...args) => {
      const prepared = await prepare(...args);
      if (mode === "EPOCH_MISSING") store.metadata.clear();
      else store.metadata.get("active_strategy_performance_epoch").id = "after";
      return prepared;
    };
    const coordinator = new StrategyExecutionCoordinator({ monitor: new EventEmitter(), executor, store, enabled: true,
      strategySource: V2_EXECUTION_SOURCE, epochStartedAt: now - 1000, now: () => now, logger: { error() {} } });
    const result = await coordinator.trySignal(`epoch-${mode}`, "TEST");
    assert.equal(result.status, "EVIDENCE_BLOCKED"); assert.equal(executor.executed.length, 0);
    assert.equal(store.snapshots.size, 0);
    assert.equal(store.audit.at(-1).payload.orderSubmitted, false);
  }
});

async function realStoreFixture() {
  const store = new ResearchStore(":memory:");
  await store.initialize();
  const decidedAt = Date.now(), epoch = { id: "integration-epoch", startedAt: decidedAt - 2000,
    strategySource: V2_EXECUTION_SOURCE, strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_3_SIGNAL_MODEL_VERSION };
  await store.setMetadata("active_strategy_performance_epoch", epoch);
  const candidate = { id: "integrated-signal", symbol: "BTCUSDT", strategy: "PRE_BREAKOUT", direction: "LONG",
    score: 61, triggerTime: decidedAt - 1000, observedAt: decidedAt - 500, receivedAt: decidedAt - 400,
    strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION, entryReason: "隔离集成信号，验证快照先于提交。",
    preMove: { modelVersion: V2_4_3_SIGNAL_MODEL_VERSION, volumeAcceleration: 1.2 },
    shadowV2: { strategyVersion: V2_4_3_SIGNAL_MODEL_VERSION, mode: "SHADOW_ONLY", orderSubmissionAllowed: false,
      eligible: true, experimentTier: "CORE", score: 80, evaluatedAt: decidedAt - 100, costs: { totalCostR: 0.1 } } };
  const trade = { signalId: candidate.id, symbol: candidate.symbol, direction: "LONG", status: "ENTRY_PENDING",
    portfolio: "V2_4_3_PREMOVE", orderSubmissionAllowed: false, expiresAt: decidedAt + 120_000 };
  await store.saveCandidate(candidate);
  await store.saveShadowDecision(candidate, { selected: true, decidedAt, trade });
  const rejected = { ...structuredClone(candidate), id: "integrated-rejected", symbol: "ETHUSDT" };
  await store.saveCandidate(rejected);
  await store.saveShadowDecision(rejected, { selected: false, rejectionReason: "SYMBOL_ACTIVE", decidedAt });
  const now = Date.now();
  const executor = new EventEmitter();
  executor.enabled = true;
  executor.executed = [];
  executor.prepare = async (id, { strategySource }) => {
    const sourceDecisionRecord = await store.getExecutionSignal(id, strategySource);
    const plan = { strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_3_SIGNAL_MODEL_VERSION,
      direction: "LONG", marginEstimate: 10, prices: { entry: 100, stopLoss: 99, takeProfit1: 101.5, takeProfit2: 102.5 } };
    const run = { id: "integration-run", signalId: id, symbol: sourceDecisionRecord.candidate.symbol, status: "PREPARED",
      createdAt: now, updatedAt: now, plan, planHash: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
    await store.createExecutionRun(run);
    return { run, reused: false, confirmationCode: "FIXTURE_ONLY", sourceDecisionRecord };
  };
  executor.execute = async (id) => {
    const snapshots = await store.listDecisionSnapshots({ scope: "ENTRY_PRE_SUBMIT" });
    assert.equal(snapshots.length, 1);
    assert.equal(verifyDecisionSnapshot(snapshots[0]), true);
    const run = await store.getExecutionRun(id);
    assert.equal(snapshots[0].plan.planHash, run.planHash);
    assert.equal((await store.listExecutionAudit(id)).at(-1).eventType, "ENTRY_DECISION_SNAPSHOT_SAVED");
    executor.executed.push(id);
    run.status = "ENTRY_PENDING";
    await store.saveExecutionRun(run);
    return run;
  };
  const coordinator = new StrategyExecutionCoordinator({ monitor: new EventEmitter(), executor, store, enabled: true,
    strategySource: V2_EXECUTION_SOURCE, epochStartedAt: epoch.startedAt, now: () => now, logger: { error() {} } });
  return { store, executor, coordinator, candidate, trade };
}

test("真实内存Store—协调器集成：入选/拒绝皆冻结，执行前落库读回，三类分数和版本不混写", async () => {
  const f = await realStoreFixture();
  try {
    const result = await f.coordinator.trySignal(f.candidate.id, "INTEGRATION");
    assert.equal(result.status, "SUBMITTED");
    assert.deepEqual(f.executor.executed, ["integration-run"]);
    const snapshots = await f.store.listDecisionSnapshots();
    assert.equal(snapshots.length, 3);
    const original = snapshots.find(s => s.scope === "SHADOW_DECISION" && s.signalId === f.candidate.id);
    const rejected = snapshots.find(s => s.signalId === "integrated-rejected");
    const entry = snapshots.find(s => s.scope === "ENTRY_PRE_SUBMIT");
    assert.equal(rejected.decision.selected, false);
    assert.equal(rejected.decision.rejectionReason, "SYMBOL_ACTIVE");
    assert.equal(original.scores.candidateScore, 61);
    assert.equal(original.scores.evaluationScore, 80);
    assert.equal(entry.scores.candidateScore, null);
    assert.equal(entry.scores.evaluationScore, 80);
    assert.equal(entry.scores.executionScore, 80);
    assert.equal(entry.versions.epochId, "integration-epoch");
    assert.equal(entry.versions.strategyVersion, V2_DEMO_STRATEGY_VERSION);
    assert.equal(entry.versions.signalModelVersion, V2_4_3_SIGNAL_MODEL_VERSION);
    assert.ok(original.times.captureTime <= entry.times.planCreatedTime);
    assert.equal(entry.completeness.timingViolations.length, 0);
    await f.store.saveShadowTrade({ ...f.trade, status: "CLOSED" });
    f.candidate.preMove.volumeAcceleration = 99;
    assert.equal((await f.store.getDecisionSnapshot(entry.snapshotId)).preMove.volumeAcceleration, 1.2);
    assert.throws(() => f.store.db.prepare("UPDATE decision_snapshots SET payload='{}'").run(), /immutable/);
    assert.equal(JSON.stringify(snapshots).includes("FIXTURE_ONLY"), false);
    await f.coordinator.trySignal(f.candidate.id, "RETRY");
    assert.equal(f.executor.executed.length, 1);
  } finally { f.store.close(); }
});

test("真实内存Store—协调器集成：数据库拒绝入场快照时不执行，计划不事后补造且原决策不受损", async () => {
  const f = await realStoreFixture();
  try {
    f.store.db.exec(`CREATE TRIGGER fixture_reject_entry BEFORE INSERT ON decision_snapshots
      WHEN NEW.scope='ENTRY_PRE_SUBMIT' BEGIN SELECT RAISE(ABORT, 'fixture entry unavailable'); END;`);
    const result = await f.coordinator.trySignal(f.candidate.id, "INTEGRATION");
    assert.equal(result.status, "EVIDENCE_BLOCKED");
    assert.equal(f.executor.executed.length, 0);
    assert.equal((await f.store.getExecutionRun("integration-run")).status, "PREPARED");
    assert.equal((await f.store.listDecisionSnapshots()).length, 2);
    assert.equal((await f.store.listExecutionAudit("integration-run")).at(-1).payload.orderSubmitted, false);
    f.store.db.exec("DROP TRIGGER fixture_reject_entry");
    await f.coordinator.trySignal(f.candidate.id, "RETRY");
    assert.equal(f.coordinator.lastDecision.reason, "ALREADY_RECORDED");
    assert.equal((await f.store.listDecisionSnapshots({ scope: "ENTRY_PRE_SUBMIT" })).length, 0);
    assert.equal(f.executor.executed.length, 0);
  } finally { f.store.close(); }
});
