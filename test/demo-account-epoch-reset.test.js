import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { rotateDemoAccountEpoch } from "../src/execution/demo-account-epoch-reset.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE execution_runs(id TEXT PRIMARY KEY, signal_id TEXT, symbol TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, payload TEXT);
    CREATE TABLE execution_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, event_type TEXT, created_at INTEGER, payload TEXT);
  `);
  const epoch = {
    id: "V2.4.3-old",
    strategySource: "V2_PRODUCTION",
    strategyVersion: "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER_DEMO_20261015",
    signalModelVersion: "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER",
    radarVersion: "MARKET_RADAR_R3_PREMOVE",
    startedAt: 100,
    startingEquity: 500,
  };
  db.prepare("INSERT INTO metadata VALUES(?,?,?)").run("active_strategy_performance_epoch", JSON.stringify(epoch), 100);
  db.prepare("INSERT INTO metadata VALUES(?,?,?)").run("strategy_performance_epoch_history", JSON.stringify([]), 100);
  for (const [id, symbol, status] of [["r1", "CHZUSDT", "ACCOUNTING_PENDING"], ["r2", "AUSDT", "OPERATOR_CLOSE_UNKNOWN"]]) {
    const run = { id, signalId: `s-${id}`, symbol, status, createdAt: 200, updatedAt: 300, performanceEligible: true, result: { netPnl: 9, netR: 1, accountingComplete: false } };
    db.prepare("INSERT INTO execution_runs VALUES(?,?,?,?,?,?,?)").run(id, run.signalId, symbol, status, 200, 300, JSON.stringify(run));
  }
  return db;
}

const evidence = {
  environment: "TESTNET",
  authority: "BINANCE_TESTNET",
  observedAt: 900,
  positionMode: "ONE_WAY",
  availableBalance: 5000,
  totalWalletBalance: 5000,
  positions: [],
  openOrders: [],
  openAlgoOrders: [],
};

test("账户重置原子封存旧纪元、终态化遗留执行并开启同策略新纪元", () => {
  const db = fixture();
  const result = rotateDemoAccountEpoch(db, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 });
  assert.equal(result.applied, true);
  assert.equal(result.reconciledRuns.length, 2);
  const active = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value);
  assert.equal(active.previousEpochId, "V2.4.3-old");
  assert.equal(active.resetMode, "DEMO_ACCOUNT_RESET_NEW_EPOCH");
  assert.equal(active.strategyVersion, "PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER_DEMO_20261015");
  assert.equal(active.startingEquity, 500);
  const runs = db.prepare("SELECT status,payload FROM execution_runs ORDER BY id").all();
  assert.deepEqual(runs.map((row) => row.status), ["FAILED", "FAILED"]);
  for (const row of runs) {
    const run = JSON.parse(row.payload);
    assert.equal(run.performanceEligible, false);
    assert.equal(run.result.netPnl, null);
    assert.equal(run.result.netR, null);
    assert.equal(run.result.accountingComplete, false);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_audit WHERE event_type='ACCOUNT_RESET_RECONCILED'").get().count, 2);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='testnet_execution_emergency_stop'").get().value).active, false);
  db.close();
});

test("相同操作ID幂等，不重复封存或追加审计", () => {
  const db = fixture();
  rotateDemoAccountEpoch(db, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 });
  const again = rotateDemoAccountEpoch(db, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1100 });
  assert.equal(again.applied, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM execution_audit").get().count, 2);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='strategy_performance_epoch_history'").get().value).length, 1);
  db.close();
});

test("相同操作ID遇到纪元漂移或不同证据时失败关闭", () => {
  const db = fixture();
  rotateDemoAccountEpoch(db, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 });
  const epoch = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value);
  db.prepare("UPDATE metadata SET value=? WHERE key='active_strategy_performance_epoch'").run(JSON.stringify({ ...epoch, id: "drifted" }));
  assert.throws(() => rotateDemoAccountEpoch(db, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 }), /纪元发生漂移/);
  db.prepare("UPDATE metadata SET value=? WHERE key='active_strategy_performance_epoch'").run(JSON.stringify(epoch));
  assert.throws(() => rotateDemoAccountEpoch(db, {
    expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: { ...evidence, availableBalance: 4999 }, now: 1000,
  }), /账户证据发生变化/);
  db.close();
});

test("账户不干净、活动纪元变化或未知活动状态时失败关闭且不产生部分写入", () => {
  const dirty = fixture();
  assert.throws(() => rotateDemoAccountEpoch(dirty, {
    expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: { ...evidence, positions: [{ symbol: "BTCUSDT" }] }, now: 1000,
  }), /仍存在持仓/);
  assert.equal(dirty.prepare("SELECT COUNT(*) AS count FROM execution_audit").get().count, 0);
  assert.throws(() => rotateDemoAccountEpoch(dirty, { expectedEpochId: "other", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 }), /活动纪元已变化/);
  dirty.prepare("UPDATE execution_runs SET status='OPEN_PROTECTED', payload=json_set(payload, '$.status', 'OPEN_PROTECTED') WHERE id='r1'").run();
  assert.throws(() => rotateDemoAccountEpoch(dirty, { expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: evidence, now: 1000 }), /不能按账户重置终态化/);
  assert.equal(JSON.parse(dirty.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value).id, "V2.4.3-old");
  dirty.close();
});

test("未来或过期的账户证据不能开启新纪元", () => {
  const db = fixture();
  assert.throws(() => rotateDemoAccountEpoch(db, {
    expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: { ...evidence, observedAt: 1001 }, now: 1000,
  }), /未来时间/);
  assert.throws(() => rotateDemoAccountEpoch(db, {
    expectedEpochId: "V2.4.3-old", operationId: "TEAM-012", accountEvidence: { ...evidence, observedAt: 1 }, now: 70002,
  }), /已经过期/);
  db.close();
});
