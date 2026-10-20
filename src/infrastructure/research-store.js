import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isExecutionSymbol } from "../execution/execution-symbols.js";
import { buildDecisionSnapshot, verifyDecisionSnapshot } from "../domain/decision-snapshot.js";
import {
  V1_EXECUTION_SOURCE,
  V2_EXECUTION_SOURCE,
  assertExecutionStrategySource,
  projectV2ExecutionSignal,
} from "../execution/execution-strategy-source.js";

function executionMargin(run) {
  const value = Number(run?.plan?.marginEstimate);
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("执行记录缺少有效的保证金预估");
  return value;
}

function parsePayload(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload);
  return { ...payload, selected: Boolean(row.selected), recordStatus: row.status };
}

export class ResearchStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
  }

  async initialize() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS signals_status_idx ON signals(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS signals_symbol_idx ON signals(symbol, updated_at DESC);
      CREATE TABLE IF NOT EXISTS manual_trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        fill_price REAL NOT NULL,
        quantity REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'OPEN',
        updated_at INTEGER,
        payload TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );
      CREATE INDEX IF NOT EXISTS manual_signal_idx ON manual_trades(signal_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS universe_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        selected_at INTEGER NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS universe_snapshots_time_idx ON universe_snapshots(selected_at DESC);
      CREATE TABLE IF NOT EXISTS testnet_account_snapshots (
        synced_at INTEGER PRIMARY KEY,
        state_hash TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS testnet_account_snapshots_time_idx ON testnet_account_snapshots(synced_at DESC);
      CREATE TABLE IF NOT EXISTS execution_runs (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL UNIQUE,
        symbol TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );
      CREATE INDEX IF NOT EXISTS execution_runs_status_idx ON execution_runs(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS execution_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES execution_runs(id)
      );
      CREATE INDEX IF NOT EXISTS execution_audit_run_idx ON execution_audit(run_id, created_at, id);
      CREATE TABLE IF NOT EXISTS shadow_signals (
        signal_id TEXT PRIMARY KEY,
        strategy_version TEXT NOT NULL,
        status TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );
      CREATE INDEX IF NOT EXISTS shadow_signals_status_idx ON shadow_signals(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS decision_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('SHADOW_DECISION', 'ENTRY_PRE_SUBMIT')),
        signal_id TEXT NOT NULL,
        run_id TEXT,
        captured_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS decision_snapshots_scope_time_idx ON decision_snapshots(scope, captured_at, snapshot_id);
      CREATE UNIQUE INDEX IF NOT EXISTS decision_snapshots_one_entry_per_run_idx
      ON decision_snapshots(run_id) WHERE scope = 'ENTRY_PRE_SUBMIT';
      CREATE TRIGGER IF NOT EXISTS decision_snapshots_no_update
      BEFORE UPDATE ON decision_snapshots BEGIN SELECT RAISE(ABORT, 'decision snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS decision_snapshots_no_delete
      BEFORE DELETE ON decision_snapshots BEGIN SELECT RAISE(ABORT, 'decision snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS decision_snapshots_no_replace
      BEFORE INSERT ON decision_snapshots WHEN EXISTS(SELECT 1 FROM decision_snapshots WHERE snapshot_id=NEW.snapshot_id)
      BEGIN SELECT RAISE(ABORT, 'decision snapshot id already exists'); END;
    `);
    const manualColumns = new Set(this.db.prepare("PRAGMA table_info(manual_trades)").all().map((column) => column.name));
    if (!manualColumns.has("status")) this.db.exec("ALTER TABLE manual_trades ADD COLUMN status TEXT NOT NULL DEFAULT 'OPEN'");
    if (!manualColumns.has("updated_at")) this.db.exec("ALTER TABLE manual_trades ADD COLUMN updated_at INTEGER");
    if (!manualColumns.has("payload")) this.db.exec("ALTER TABLE manual_trades ADD COLUMN payload TEXT");
    const legacySingleActiveIndex = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'execution_runs_single_active_idx'").get();
    if (legacySingleActiveIndex) {
      const activeCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM execution_runs
        WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED')
      `).get()?.count ?? 0);
      if (activeCount > 0) throw new Error("多仓数据库迁移要求所有测试网执行记录先进入终态");
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP INDEX execution_runs_single_active_idx;
        CREATE UNIQUE INDEX IF NOT EXISTS execution_runs_one_active_symbol_idx
        ON execution_runs(symbol)
        WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED');
        COMMIT;
      `);
    } else {
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS execution_runs_one_active_symbol_idx
        ON execution_runs(symbol)
        WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED');
      `);
    }
    this.db.prepare(`
      INSERT INTO metadata(key, value, updated_at) VALUES('execution_schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ version: 3, activeScope: "SYMBOL", positionPolicy: "ALL_ELIGIBLE" }), Date.now());
    this.db.prepare(`
      INSERT INTO metadata(key, value, updated_at) VALUES('shadow_schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ version: 2, mode: "V2_1_DUAL_TIER", orderSubmissionAllowed: false, fixedPositionLimit: null }), Date.now());
  }

  ensureReady() {
    if (!this.db) throw new Error("ResearchStore 尚未初始化");
  }

  async saveCandidate(candidate, { selected = false, rejectionReason = null } = {}) {
    this.ensureReady();
    const existing = this.db.prepare("SELECT payload, selected, status FROM signals WHERE id = ?").get(candidate.id);
    if (existing) return false;
    const now = Date.now();
    const payload = { candidate, trade: null, rejectionReason };
    this.db.prepare(`
      INSERT INTO signals(id, symbol, strategy, direction, status, selected, created_at, updated_at, payload)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(candidate.id, candidate.symbol, candidate.strategy, candidate.direction, selected ? "ENTRY_PENDING" : "CANDIDATE", selected ? 1 : 0, candidate.triggerTime, now, JSON.stringify(payload));
    return true;
  }

  async markCandidate(candidateId, { selected, rejectionReason = null }) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM signals WHERE id = ?").get(candidateId);
    if (!row) return false;
    const payload = JSON.parse(row.payload);
    payload.rejectionReason = rejectionReason;
    this.db.prepare("UPDATE signals SET selected = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?")
      .run(selected ? 1 : 0, selected ? "ENTRY_PENDING" : "REJECTED", Date.now(), JSON.stringify(payload), candidateId);
    return true;
  }

  async saveTrade(trade, candidate = null) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM signals WHERE id = ?").get(trade.signalId);
    if (!row) throw new Error(`找不到信号 ${trade.signalId}`);
    const payload = JSON.parse(row.payload);
    if (candidate) payload.candidate = candidate;
    payload.trade = trade;
    payload.rejectionReason = null;
    this.db.prepare("UPDATE signals SET selected = 1, status = ?, updated_at = ?, payload = ? WHERE id = ?")
      .run(trade.status, Date.now(), JSON.stringify(payload), trade.signalId);
  }

  async listActiveTrades() {
    this.ensureReady();
    const rows = this.db.prepare("SELECT payload FROM signals WHERE selected = 1 AND status IN ('ENTRY_PENDING','OPEN','TP1_FILLED') ORDER BY created_at").all();
    return rows.map((row) => JSON.parse(row.payload).trade).filter(Boolean);
  }

  async listSignals(limit = 100, { selectedOnly = false } = {}) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const sql = selectedOnly
      ? "SELECT * FROM signals WHERE selected = 1 AND strategy <> 'OPERATOR_CANARY' ORDER BY updated_at DESC LIMIT ?"
      : "SELECT * FROM signals WHERE strategy <> 'OPERATOR_CANARY' ORDER BY updated_at DESC LIMIT ?";
    return this.db.prepare(sql).all(safeLimit).map(parsePayload);
  }

  async createOperatorCanarySource({ id, direction, createdAt = Date.now() } = {}) {
    this.ensureReady();
    if (!/^operator-[a-z0-9-]{8,40}$/.test(String(id ?? ""))) throw new TypeError("人工金丝雀来源 ID 无效");
    if (!new Set(["LONG", "SHORT"]).has(direction)) throw new TypeError("人工金丝雀方向无效");
    if (!Number.isFinite(createdAt)) throw new TypeError("人工金丝雀时间无效");
    const candidate = {
      id,
      symbol: "BTCUSDT",
      strategy: "OPERATOR_CANARY",
      direction,
      status: "TECHNICAL_CANARY",
      triggerTime: createdAt,
      performanceEligible: false,
    };
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO signals(id, symbol, strategy, direction, status, selected, created_at, updated_at, payload)
      VALUES(?, 'BTCUSDT', 'OPERATOR_CANARY', ?, 'TECHNICAL_CANARY', 0, ?, ?, ?)
    `).run(id, direction, createdAt, createdAt, JSON.stringify({ candidate, trade: null, rejectionReason: null, operatorCanary: true }));
    return result.changes === 1;
  }

  async getSignal(signalId) {
    this.ensureReady();
    return parsePayload(this.db.prepare("SELECT * FROM signals WHERE id = ?").get(signalId));
  }

  async getShadowSignal(signalId) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM shadow_signals WHERE signal_id = ?").get(signalId);
    return row ? JSON.parse(row.payload) : null;
  }

  async getExecutionSignal(signalId, strategySource = V1_EXECUTION_SOURCE) {
    const source = assertExecutionStrategySource(strategySource);
    if (source === V1_EXECUTION_SOURCE) return await this.getSignal(signalId);
    if (source === V2_EXECUTION_SOURCE) return projectV2ExecutionSignal(await this.getShadowSignal(signalId));
    return null;
  }

  async saveShadowDecision(candidate, { selected = false, rejectionReason = null, trade = null, counterfactual = false, decidedAt = Date.now() } = {}) {
    this.ensureReady();
    const evaluation = candidate?.shadowV2;
    if (!candidate?.id || evaluation?.mode !== "SHADOW_ONLY" || evaluation?.orderSubmissionAllowed !== false) {
      throw new TypeError("V2 影子记录必须明确禁止订单提交");
    }
    const status = trade?.status ?? (selected ? "ENTRY_PENDING" : "REJECTED");
    // Capture is this persistence attempt, never a supplied historical decision timestamp.
    const now = Date.now();
    const payload = {
      candidate,
      evaluation,
      decision: {
        selected,
        rejectionReason,
        counterfactual: Boolean(counterfactual),
        experimentTier: evaluation.experimentTier ?? null,
        decidedAt,
      },
      trade,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const epochRow = this.db.prepare("SELECT value FROM metadata WHERE key = 'active_strategy_performance_epoch'").get();
      const snapshot = buildDecisionSnapshot({
        candidate, evaluation, decision: payload.decision, scope: "SHADOW_DECISION", recordedAt: now,
        epoch: epochRow ? JSON.parse(epochRow.value) : null,
      });
      this.insertDecisionSnapshot(snapshot);
      this.db.prepare(`
      INSERT INTO shadow_signals(signal_id, strategy_version, status, selected, created_at, updated_at, payload)
      VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signal_id) DO UPDATE SET
        status = excluded.status,
        selected = excluded.selected,
        updated_at = excluded.updated_at,
        payload = excluded.payload
      `).run(candidate.id, evaluation.strategyVersion, status, selected ? 1 : 0, candidate.triggerTime, now, JSON.stringify(payload));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return payload;
  }

  // Synchronous internal operation: callers can include this insert in their own transaction.
  insertDecisionSnapshot(snapshot) {
    this.ensureReady();
    if (!verifyDecisionSnapshot(snapshot)) throw new TypeError("决策快照schema/hash校验失败");
    const previous = this.db.prepare("SELECT content_hash, payload FROM decision_snapshots WHERE snapshot_id = ?").get(snapshot.snapshotId);
    if (previous) {
      const stored = JSON.parse(previous.payload);
      if (!verifyDecisionSnapshot(stored) || stored.contentHash !== previous.content_hash || stored.contentHash !== snapshot.contentHash) {
        throw new Error("决策快照ID冲突或内容损坏，禁止覆盖");
      }
      return stored;
    }
    this.db.prepare(`INSERT INTO decision_snapshots(snapshot_id, scope, signal_id, run_id, captured_at, content_hash, payload)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(snapshot.snapshotId, snapshot.scope, snapshot.signalId,
      snapshot.runId, snapshot.times.captureTime, snapshot.contentHash, JSON.stringify(snapshot));
    return snapshot;
  }

  async appendDecisionSnapshot(snapshot) {
    this.ensureReady();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.insertDecisionSnapshot(snapshot);
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getDecisionSnapshot(snapshotId) {
    this.ensureReady();
    const row = this.db.prepare("SELECT content_hash, payload FROM decision_snapshots WHERE snapshot_id = ?").get(snapshotId);
    if (!row) return null;
    const snapshot = JSON.parse(row.payload);
    if (!verifyDecisionSnapshot(snapshot) || snapshot.contentHash !== row.content_hash) throw new Error("决策快照完整性校验失败");
    return snapshot;
  }

  async listDecisionSnapshots({ scope = null, since = null, until = null, limit = 1000 } = {}) {
    this.ensureReady();
    const clauses = [], values = [];
    if (scope !== null) { clauses.push("scope = ?"); values.push(scope); }
    if (since !== null) {
      if (!Number.isFinite(since)) throw new TypeError("快照since无效");
      clauses.push("captured_at >= ?"); values.push(since);
    }
    if (until !== null) {
      if (!Number.isFinite(until)) throw new TypeError("快照until无效");
      clauses.push("captured_at <= ?"); values.push(until);
    }
    values.push(Math.min(Math.max(Math.trunc(Number(limit)) || 1000, 1), 10000));
    return this.db.prepare(`SELECT snapshot_id FROM decision_snapshots${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY captured_at, snapshot_id LIMIT ?`).all(...values).map((row) => {
      // Read and validate synchronously so no mutable input can race an awaited callback.
      const stored = this.db.prepare("SELECT content_hash, payload FROM decision_snapshots WHERE snapshot_id = ?").get(row.snapshot_id);
      const snapshot = JSON.parse(stored.payload);
      if (!verifyDecisionSnapshot(snapshot) || stored.content_hash !== snapshot.contentHash) throw new Error("决策快照完整性校验失败");
      return snapshot;
    });
  }

  async saveShadowTrade(trade) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM shadow_signals WHERE signal_id = ?").get(trade?.signalId);
    if (!row) throw new Error(`找不到 V2 影子信号 ${trade?.signalId}`);
    const payload = JSON.parse(row.payload);
    payload.trade = trade;
    const selected = payload.decision?.selected === true;
    payload.decision = {
      ...(payload.decision ?? {}),
      selected,
      rejectionReason: selected ? null : payload.decision?.rejectionReason ?? "COUNTERFACTUAL_RESEARCH",
    };
    this.db.prepare("UPDATE shadow_signals SET selected = ?, status = ?, updated_at = ?, payload = ? WHERE signal_id = ?")
      .run(selected ? 1 : 0, trade.status, Date.now(), JSON.stringify(payload), trade.signalId);
    return trade;
  }

  async listShadowSignals(limit = 1000, { selectedOnly = false } = {}) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 10_000);
    const sql = selectedOnly
      ? "SELECT payload FROM shadow_signals WHERE selected = 1 ORDER BY updated_at DESC LIMIT ?"
      : "SELECT payload FROM shadow_signals ORDER BY updated_at DESC LIMIT ?";
    return this.db.prepare(sql).all(safeLimit)
      .map((row) => JSON.parse(row.payload));
  }

  async listExecutionSignals(strategySource = V1_EXECUTION_SOURCE, limit = 200) {
    const source = assertExecutionStrategySource(strategySource);
    if (source === V1_EXECUTION_SOURCE) return await this.listSignals(limit, { selectedOnly: true });
    return (await this.listShadowSignals(limit, { selectedOnly: true })).map(projectV2ExecutionSignal);
  }

  async listActiveShadowTrades() {
    this.ensureReady();
    return this.db.prepare(`
      SELECT payload FROM shadow_signals
      WHERE status IN ('ENTRY_PENDING','OPEN','TP1_FILLED')
      ORDER BY created_at
    `).all().map((row) => JSON.parse(row.payload).trade).filter(Boolean);
  }

  async saveManualTrade(manualTrade, note = "") {
    this.ensureReady();
    const createdAt = new Date(manualTrade.createdAt).getTime();
    const updatedAt = new Date(manualTrade.updatedAt).getTime();
    const safeNote = String(note).slice(0, 500);
    this.db.prepare(`
      INSERT INTO manual_trades(id, signal_id, fill_price, quantity, note, status, updated_at, payload, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload = excluded.payload, note = excluded.note
    `).run(manualTrade.id, manualTrade.signalId, manualTrade.entryPrice, manualTrade.quantity, safeNote, manualTrade.status, updatedAt, JSON.stringify(manualTrade), createdAt);
    return { ...manualTrade, note: safeNote };
  }

  async listManualTrades(limit = 100) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db.prepare("SELECT * FROM manual_trades ORDER BY created_at DESC LIMIT ?").all(safeLimit).map((row) => {
      const trade = row.payload ? JSON.parse(row.payload) : null;
      return { id: row.id, signalId: row.signal_id, fillPrice: row.fill_price, quantity: row.quantity, note: row.note, status: row.status, createdAt: row.created_at, trade };
    });
  }

  async listActiveManualTrades() {
    this.ensureReady();
    return this.db.prepare("SELECT payload, note FROM manual_trades WHERE status IN ('OPEN','TP1_FILLED') ORDER BY created_at").all()
      .map((row) => ({ trade: row.payload ? JSON.parse(row.payload) : null, note: row.note }))
      .filter((item) => item.trade);
  }

  async setMetadata(key, value) {
    this.ensureReady();
    this.db.prepare(`
      INSERT INTO metadata(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  async getMetadata(key) {
    this.ensureReady();
    const row = this.db.prepare("SELECT value, updated_at AS updatedAt FROM metadata WHERE key = ?").get(key);
    return row ? { value: JSON.parse(row.value), updatedAt: row.updatedAt } : null;
  }

  async saveUniverseSnapshot({ provider, selectedAt = Date.now(), items }) {
    this.ensureReady();
    if (!provider || !Number.isFinite(selectedAt) || !Array.isArray(items)) throw new TypeError("标的池快照格式不正确");
    this.db.prepare(`
      INSERT INTO universe_snapshots(provider, selected_at, payload) VALUES(?, ?, ?)
      ON CONFLICT(selected_at) DO UPDATE SET provider = excluded.provider, payload = excluded.payload
    `).run(provider, selectedAt, JSON.stringify(items));
    return { provider, selectedAt, items };
  }

  async listUniverseSnapshots(limit = 52) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 52, 1), 520);
    return this.db.prepare("SELECT provider, selected_at AS selectedAt, payload FROM universe_snapshots ORDER BY selected_at DESC LIMIT ?")
      .all(safeLimit)
      .map((row) => ({ provider: row.provider, selectedAt: row.selectedAt, items: JSON.parse(row.payload) }));
  }

  async saveTestnetAccountSnapshot(snapshot) {
    this.ensureReady();
    if (snapshot?.environment !== "TESTNET" || snapshot?.authority !== "BINANCE_TESTNET" || !Number.isFinite(snapshot?.syncedAt)) {
      throw new TypeError("测试网账户快照格式不正确");
    }
    const canonical = JSON.stringify({ ...snapshot, syncedAt: 0, serverTime: 0, clockOffsetMs: 0 });
    const stateHash = createHash("sha256").update(canonical).digest("hex");
    const previous = this.db.prepare("SELECT state_hash AS stateHash FROM testnet_account_snapshots ORDER BY synced_at DESC LIMIT 1").get();
    if (previous?.stateHash === stateHash) return false;
    this.db.prepare("INSERT OR REPLACE INTO testnet_account_snapshots(synced_at, state_hash, payload) VALUES(?, ?, ?)")
      .run(snapshot.syncedAt, stateHash, JSON.stringify(snapshot));
    return true;
  }

  async latestTestnetAccountSnapshot() {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM testnet_account_snapshots ORDER BY synced_at DESC LIMIT 1").get();
    return row ? JSON.parse(row.payload) : null;
  }

  async createExecutionRun(run) {
    this.ensureReady();
    if (!run?.id || !run?.signalId || !isExecutionSymbol(run?.symbol) || !run?.status) {
      throw new TypeError("执行记录格式不正确");
    }
    const createdAt = Number(run.createdAt);
    const updatedAt = Number(run.updatedAt ?? run.createdAt);
    if (![createdAt, updatedAt].every(Number.isFinite)) throw new TypeError("执行记录时间无效");
    const reservedMargin = executionMargin(run);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT payload FROM execution_runs WHERE signal_id = ?").get(run.signalId);
      if (existing) {
        this.db.exec("COMMIT");
        return { created: false, run: JSON.parse(existing.payload) };
      }
      const activeRuns = this.db.prepare(`
        SELECT id, symbol, payload FROM execution_runs
        WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED')
        ORDER BY created_at
      `).all().map((row) => ({ ...row, run: JSON.parse(row.payload) }));
      const sameSymbol = activeRuns.find((item) => item.symbol === run.symbol);
      if (sameSymbol) throw new Error(`标的 ${run.symbol} 已有未结束的测试网执行记录 ${sameSymbol.id}`);
      this.db.prepare(`
        INSERT INTO execution_runs(id, signal_id, symbol, status, created_at, updated_at, payload)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.signalId, run.symbol, run.status, createdAt, updatedAt, JSON.stringify(run));
      this.db.exec("COMMIT");
      return { created: true, run };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getExecutionCapacity() {
    const activeRuns = await this.listActiveExecutionRuns();
    const reservedMargin = activeRuns.reduce((sum, run) => sum + executionMargin(run), 0);
    return {
      activeRuns: activeRuns.length,
      availableSlots: null,
      reservedMargin,
      availableMargin: null,
      maxActiveRuns: null,
      maxReservedMargin: null,
      positionPolicy: "ALL_ELIGIBLE",
      activeSymbols: activeRuns.map((run) => run.symbol),
    };
  }

  async saveExecutionRun(run) {
    this.ensureReady();
    if (!run?.id || !run?.status || !Number.isFinite(Number(run.updatedAt))) throw new TypeError("执行记录格式不正确");
    const result = this.db.prepare("UPDATE execution_runs SET status = ?, updated_at = ?, payload = ? WHERE id = ?")
      .run(run.status, Number(run.updatedAt), JSON.stringify(run), run.id);
    if (result.changes !== 1) throw new Error(`找不到执行记录 ${run.id}`);
    return run;
  }

  async getExecutionRun(runId) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM execution_runs WHERE id = ?").get(runId);
    return row ? JSON.parse(row.payload) : null;
  }

  async getExecutionRunBySignal(signalId) {
    this.ensureReady();
    const row = this.db.prepare("SELECT payload FROM execution_runs WHERE signal_id = ?").get(signalId);
    return row ? JSON.parse(row.payload) : null;
  }

  async listExecutionRuns(limit = 100) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db.prepare("SELECT payload FROM execution_runs ORDER BY updated_at DESC LIMIT ?").all(safeLimit)
      .map((row) => JSON.parse(row.payload));
  }

  async listActiveExecutionRuns() {
    this.ensureReady();
    return this.db.prepare(`
      SELECT payload FROM execution_runs
      WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED')
      ORDER BY created_at
    `).all().map((row) => JSON.parse(row.payload));
  }

  async appendExecutionAudit(runId, eventType, payload = {}, createdAt = Date.now()) {
    this.ensureReady();
    if (!runId || !eventType || !Number.isFinite(createdAt)) throw new TypeError("执行审计格式不正确");
    this.db.prepare("INSERT INTO execution_audit(run_id, event_type, created_at, payload) VALUES(?, ?, ?, ?)")
      .run(runId, eventType, createdAt, JSON.stringify(payload));
    return { runId, eventType, createdAt, payload };
  }

  async listExecutionAudit(runId, limit = 500) {
    this.ensureReady();
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    return this.db.prepare(`
      SELECT event_type AS eventType, created_at AS createdAt, payload
      FROM execution_audit WHERE run_id = ? ORDER BY created_at, id LIMIT ?
    `).all(runId, safeLimit).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
