import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  assessAutomaticExecutionSignal,
  StrategyExecutionCoordinator,
} from "../src/application/strategy-execution-coordinator.js";
import {
  V2_4_2_SIGNAL_MODEL_VERSION,
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
    return { run, confirmationCode: "CONFIRM", reused: false };
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
  for (const status of ["SUBMISSION_UNKNOWN", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED"]) {
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

test("显式切换到 V2.4.2 后只执行纪元内的 V2.4.2 入选信号且忽略旧版本和V1事件", async () => {
  const now = 6_000_000;
  const v1 = signal("v1-new", now, { symbol: "BTCUSDT", triggerTime: now });
  const v2 = signal("v2-new", now, { symbol: "ETHUSDT", triggerTime: now, score: 82 });
  v2.executionSource = V2_EXECUTION_SOURCE;
  v2.evaluation = {
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    eligible: true,
    score: 82,
    strategyVersion: V2_4_2_SIGNAL_MODEL_VERSION,
    experimentTier: "CORE",
    costs: { totalCostR: 0.1 },
  };
  v2.candidate.strategyVersion = V2_DEMO_STRATEGY_VERSION;
  v2.candidate.executionSource = V2_EXECUTION_SOURCE;
  v2.candidate.experimentTier = "CORE";
  v2.trade.portfolio = "V2_4_2_PREMOVE";
  v2.trade.orderSubmissionAllowed = false;
  const old = structuredClone(v2);
  old.candidate.id = "v2-old";
  old.trade.signalId = "v2-old";
  old.candidate.triggerTime = now - 10_000;
  old.evaluation.strategyVersion = "PRE_MOVE_1H_15M_5M_V2_3";
  old.trade.portfolio = "V2_3_PREMOVE";
  const monitor = new EventEmitter();
  const store = new MemoryStore([v1], [], [v2, old]);
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
  assert.equal(coordinator.snapshot().positionPolicy, "V2_4_2_PREMOVE_RETAINED_FILTER_ALL_ELIGIBLE");
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
  assert.equal(assessment.reason, "V2_4_2_SIGNAL_MODEL_REQUIRED");
});

test("V2.4.2沿用0.20R至0.35R探索组且拒绝超过0.35R", () => {
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
    strategyVersion: V2_4_2_SIGNAL_MODEL_VERSION,
    experimentTier: "EXPLORATION",
    costs: { totalCostR: 0.2001 },
  };
  record.trade.portfolio = "V2_4_2_PREMOVE";
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
  assert.equal(rejected.reason, "V2_4_2_EXECUTION_COST_R_ABOVE_0_35");
});

test("V2 Demo 准入拒绝缺少当前市场雷达版本的旧信号", () => {
  const now = 8_000_000;
  const record = signal("v2-radar", now, { score: 80 });
  record.executionSource = V2_EXECUTION_SOURCE;
  record.evaluation = {
    mode: "SHADOW_ONLY", orderSubmissionAllowed: false, eligible: true, score: 80,
    strategyVersion: V2_4_2_SIGNAL_MODEL_VERSION, experimentTier: "CORE", costs: { totalCostR: 0.1 },
  };
  record.trade.portfolio = "V2_4_2_PREMOVE";
  record.trade.orderSubmissionAllowed = false;
  const options = {
    now, minimumScore: 55, strategySource: V2_EXECUTION_SOURCE,
    epochStartedAt: now - 1, requiredRadarVersion: "MARKET_RADAR_R1",
  };
  assert.equal(assessAutomaticExecutionSignal(record, options).reason, "MARKET_RADAR_CONTEXT_INVALID");
  record.evaluation.marketRadar = { version: "MARKET_RADAR_R1", selected: true, snapshotId: "radar-1" };
  assert.equal(assessAutomaticExecutionSignal(record, options).eligible, true);
});
