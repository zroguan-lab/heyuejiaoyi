import { createHash } from "node:crypto";
import {
  PERFORMANCE_EPOCH_HISTORY_METADATA_KEY,
  PERFORMANCE_EPOCH_METADATA_KEY,
  buildPerformanceEpoch,
} from "./execution-strategy-source.js";

const RESETTABLE_STATUSES = new Set(["ACCOUNTING_PENDING", "OPERATOR_CLOSE_UNKNOWN"]);
const TERMINAL_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);
const MAX_ACCOUNT_EVIDENCE_AGE_MS = 60_000;
export const DEMO_ACCOUNT_GENERATION_METADATA_KEY = "demo_account_generation";

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readMetadata(db, key) {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : null;
}

function writeMetadata(db, key, value, now) {
  db.prepare(`
    INSERT INTO metadata(key, value, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now);
}

function assertCleanAccountEvidence(evidence) {
  if (evidence?.environment !== "TESTNET" || evidence?.authority !== "BINANCE_TESTNET") {
    throw new Error("账户重置证据必须来自 Binance Testnet 签名查询");
  }
  if (evidence.positionMode !== "ONE_WAY") throw new Error("账户重置时必须保持单向持仓模式");
  for (const [field, label] of [
    ["positions", "持仓"],
    ["openOrders", "普通挂单"],
    ["openAlgoOrders", "条件挂单"],
  ]) {
    if (!Array.isArray(evidence[field]) || evidence[field].length !== 0) {
      throw new Error(`账户重置证据仍存在${label}，拒绝开启新纪元`);
    }
  }
  if (!Number.isFinite(Number(evidence.observedAt))) throw new Error("账户重置证据缺少有效时间");
}

function resetEvidenceSummary(evidence) {
  return {
    environment: evidence.environment,
    authority: evidence.authority,
    observedAt: Number(evidence.observedAt),
    positionMode: evidence.positionMode,
    availableBalance: Number.isFinite(Number(evidence.availableBalance)) ? Number(evidence.availableBalance) : null,
    totalWalletBalance: Number.isFinite(Number(evidence.totalWalletBalance)) ? Number(evidence.totalWalletBalance) : null,
    positionCount: evidence.positions.length,
    openOrderCount: evidence.openOrders.length,
    openAlgoOrderCount: evidence.openAlgoOrders.length,
  };
}

function resetRun(run, { now, operationId, evidenceHash, previousEpochId }) {
  const previousRun = structuredClone(run);
  const previousPayloadHash = stableHash(previousRun);
  const result = run.result && typeof run.result === "object"
    ? {
        ...run.result,
        netPnl: null,
        netR: null,
        accountingComplete: false,
        reason: "ACCOUNT_RESET_SUPERSEDED",
      }
    : null;
  return {
    previousRun,
    previousPayloadHash,
    nextRun: {
      ...run,
      status: "FAILED",
      updatedAt: now,
      performanceEligible: false,
      failureClass: "ACCOUNT_RESET_SUPERSEDED",
      result,
      accountResetReconciliation: {
        operationId,
        evidenceHash,
        previousEpochId,
        previousStatus: run.status,
        previousPayloadHash,
        reconciledAt: now,
        accountingComplete: false,
        netPnl: null,
        netR: null,
      },
    },
  };
}

export function rotateDemoAccountEpoch(db, {
  expectedEpochId,
  operationId,
  accountEvidence,
  now = Date.now(),
} = {}) {
  if (!db) throw new TypeError("缺少数据库连接");
  if (!expectedEpochId || !operationId) throw new TypeError("缺少 expectedEpochId 或 operationId");
  if (!Number.isFinite(Number(now)) || Number(now) <= 0) throw new TypeError("纪元切换时间无效");
  assertCleanAccountEvidence(accountEvidence);
  const resetAt = Number(now);
  const evidence = resetEvidenceSummary(accountEvidence);
  if (evidence.observedAt > resetAt) throw new Error("账户重置证据来自未来时间");
  if (resetAt - evidence.observedAt > MAX_ACCOUNT_EVIDENCE_AGE_MS) throw new Error("账户重置证据已经过期");
  const evidenceHash = stableHash(evidence);

  db.exec("BEGIN IMMEDIATE");
  try {
    const existingGeneration = readMetadata(db, DEMO_ACCOUNT_GENERATION_METADATA_KEY);
    const currentEpoch = readMetadata(db, PERFORMANCE_EPOCH_METADATA_KEY);
    if (existingGeneration?.operationId === operationId) {
      if (existingGeneration.previousEpochId !== expectedEpochId) {
        throw new Error("相同账户重置操作ID指向不同旧纪元");
      }
      if (currentEpoch?.id !== existingGeneration.activeEpochId) {
        throw new Error("账户重置操作已存在但活动纪元发生漂移");
      }
      if (existingGeneration.evidenceHash !== evidenceHash) {
        throw new Error("相同账户重置操作ID对应的账户证据发生变化");
      }
      db.exec("COMMIT");
      return { applied: false, idempotent: true, epoch: currentEpoch, reconciledRuns: [] };
    }
    if (currentEpoch?.id !== expectedEpochId) {
      throw new Error(`活动纪元已变化，预期 ${expectedEpochId}，实际 ${currentEpoch?.id ?? "不存在"}`);
    }

    const rows = db.prepare(`
      SELECT id, status, payload FROM execution_runs
      WHERE status NOT IN ('CLOSED', 'CANCELED', 'REJECTED', 'FAILED')
      ORDER BY created_at, id
    `).all();
    const unsupported = rows.filter((row) => !RESETTABLE_STATUSES.has(row.status));
    if (unsupported.length) {
      throw new Error(`存在不能按账户重置终态化的执行记录: ${unsupported.map((row) => `${row.id}:${row.status}`).join(", ")}`);
    }

    const history = readMetadata(db, PERFORMANCE_EPOCH_HISTORY_METADATA_KEY);
    const archivedEpoch = {
      ...currentEpoch,
      endedAt: resetAt,
      endReason: "DEMO_ACCOUNT_RESET",
      resetOperationId: operationId,
      resetEvidenceHash: evidenceHash,
    };
    const deduplicatedHistory = (Array.isArray(history) ? history : []).filter((epoch) => epoch?.id !== currentEpoch.id);
    writeMetadata(db, PERFORMANCE_EPOCH_HISTORY_METADATA_KEY, [...deduplicatedHistory, archivedEpoch].slice(-50), resetAt);

    const reconciledRuns = [];
    for (const row of rows) {
      const run = JSON.parse(row.payload);
      if (run.id !== row.id || run.status !== row.status) throw new Error(`执行记录 ${row.id} 列值与payload不一致`);
      const reset = resetRun(run, {
        now: resetAt,
        operationId,
        evidenceHash,
        previousEpochId: currentEpoch.id,
      });
      const updated = db.prepare("UPDATE execution_runs SET status = ?, updated_at = ?, payload = ? WHERE id = ? AND status = ?")
        .run("FAILED", resetAt, JSON.stringify(reset.nextRun), row.id, row.status);
      if (updated.changes !== 1) throw new Error(`执行记录 ${row.id} 并发变化，拒绝切换纪元`);
      db.prepare("INSERT INTO execution_audit(run_id, event_type, created_at, payload) VALUES(?, ?, ?, ?)")
        .run(row.id, "ACCOUNT_RESET_RECONCILED", resetAt, JSON.stringify({
          operationId,
          evidenceHash,
          previousEpochId: currentEpoch.id,
          previousStatus: row.status,
          previousPayloadHash: reset.previousPayloadHash,
          previousRun: reset.previousRun,
          outcome: "FAILED_ACCOUNT_RESET_SUPERSEDED",
          accountingComplete: false,
          netPnl: null,
          netR: null,
        }));
      reconciledRuns.push({ id: row.id, symbol: run.symbol, previousStatus: row.status });
    }

    const baseEpoch = buildPerformanceEpoch({
      now: resetAt,
      startingEquity: currentEpoch.startingEquity,
      strategySource: currentEpoch.strategySource,
      strategyVersion: currentEpoch.strategyVersion,
      signalModelVersion: currentEpoch.signalModelVersion,
      radarVersion: currentEpoch.radarVersion,
      previousEpoch: currentEpoch,
    });
    const newEpoch = {
      ...baseEpoch,
      id: `${baseEpoch.id}-${String(resetAt).slice(-3)}`,
      resetMode: "DEMO_ACCOUNT_RESET_NEW_EPOCH",
      resetOperationId: operationId,
      resetEvidenceHash: evidenceHash,
      accountBaseline: evidence,
      reason: "Binance Demo账户重置后的新前向绩效纪元；策略、Score、准入、止盈止损、仓位、杠杆与成本规则均未改变",
    };
    const generation = {
      operationId,
      previousEpochId: currentEpoch.id,
      activeEpochId: newEpoch.id,
      resetAt,
      evidenceHash,
      accountBaseline: evidence,
    };
    writeMetadata(db, PERFORMANCE_EPOCH_METADATA_KEY, newEpoch, resetAt);
    writeMetadata(db, DEMO_ACCOUNT_GENERATION_METADATA_KEY, generation, resetAt);
    writeMetadata(db, "testnet_execution_emergency_stop", {
      active: false,
      clearedAt: resetAt,
      clearReason: "ACCOUNT_RESET_RECONCILED",
      operationId,
      evidenceHash,
    }, resetAt);
    db.exec("COMMIT");
    return { applied: true, idempotent: false, epoch: newEpoch, reconciledRuns, evidenceHash };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export { MAX_ACCOUNT_EVIDENCE_AGE_MS, RESETTABLE_STATUSES, TERMINAL_STATUSES };
