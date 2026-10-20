// Offline read-only audit: no Store.initialize, environment loading, HTTP or writes.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { projectExecutionRun } from "../../src/execution/execution-run-projection.js";
import { buildStrategyPerformance } from "../../src/presentation/strategy-performance.js";

const db = new DatabaseSync(fileURLToPath(new URL("../../data/research.sqlite", import.meta.url)), { readOnly: true });
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-8);
try {
  db.exec("BEGIN");
  const epoch = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value);
  const all = db.prepare("SELECT payload FROM execution_runs ORDER BY created_at").all().map((row) => JSON.parse(row.payload));
  const runs = all.filter((run) => run.createdAt >= epoch.startedAt
    && run.sourceType === "SIGNAL" && run.performanceEligible !== false
    && (run.executionSource ?? run.plan.executionSource) === epoch.strategySource
    && run.plan.strategyVersion === epoch.strategyVersion && run.plan.signalModelVersion === epoch.signalModelVersion);
  const rows = runs.map((run) => {
    const fills = (run.result?.trades ?? []).filter((fill) => String(fill.orderId) === String(run.entryOrder?.orderId)
      && fill.symbol === run.symbol && fill.side === run.plan.entrySide);
    const quantity = fills.reduce((sum, fill) => sum + Number(fill.quantity), 0);
    const quote = fills.reduce((sum, fill) => sum + Number(fill.quantity) * Number(fill.price), 0);
    const confirmed = quantity > 0 && close(quantity, Number(run.entryOrder?.executedQuantity));
    const entry = confirmed ? quote / quantity : null;
    const risk = confirmed ? Math.abs(entry - Number(run.plan.prices.stopLoss)) * quantity : null;
    const net = typeof run.result?.netPnl === "number" ? run.result.netPnl : null;
    const netR = confirmed && risk > 0 && net !== null ? net / risk : null;
    const projected = projectExecutionRun(run);
    return {
      id: run.id, symbol: run.symbol, status: run.status, entryOrderId: run.entryOrder?.orderId ?? null,
      quantity: confirmed ? quantity : null, independentEntry: entry, independentRisk: risk, independentNetR: netR,
      projectedEntry: projected.entryPrice, projectedRisk: projected.actualRisk, projectedNetR: projected.netR,
      rawNetPnl: net, projectedNetPnl: projected.netPnl,
      entryFactStatus: projected.entryFactStatus, excursionCoverage: projected.excursionCoverage,
      mfeR: projected.mfeR, maeR: projected.maeR,
      matches: confirmed ? close(projected.entryPrice, entry) && close(projected.actualRisk, risk) && close(projected.netR, netR)
        && close(projected.netPnl, net) : projected.actualRisk === null && projected.netR === null,
    };
  });
  const closed = runs.filter((run) => run.status === "CLOSED" && run.result?.accountingComplete === true);
  const funds = Object.fromEntries(["realizedPnl", "commission", "fundingPnl", "netPnl"].map((key) => [key,
    closed.reduce((sum, run) => sum + Number(run.result[key] ?? 0), 0)]));
  const projected = runs.map((run) => projectExecutionRun(run));
  const report = buildStrategyPerformance(projected, { startingEquity: epoch.startingEquity });
  const digest = createHash("sha256").update(JSON.stringify(all.map((run) => [run.id, run.result?.netPnl,
    run.result?.realizedPnl, run.result?.commission, run.result?.fundingPnl]))).digest("hex");
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), scope: "LOCAL_SAVED_FILLS_NOT_EXCHANGE_RECONFIRMATION",
    rawRecords: all.length, epoch: epoch.id, included: runs.length, separated: all.length - runs.length,
    funds, rawFundsDigest: digest, matches: rows.every((row) => row.matches), rows,
    performance: { finalized: report.finalizedTradeCount, totalNetPnl: report.totalNetPnl, averageNetR: report.averageNetR,
      coverage: report.coverage, evidenceProgress: report.evidenceProgress,
      excursion: report.researchAttribution.excursion.coverage,
      sourceGroups: report.researchAttribution.opportunitySources.combinations.map((group) => ({
        combination: group.combination, trades: group.trades, status: group.sampleStatus, coverage: group.coverage,
      })) },
  }, null, 2));
  if (rows.some((row) => !row.matches)) process.exitCode = 1;
} finally {
  db.exec("ROLLBACK");
  db.close();
}
