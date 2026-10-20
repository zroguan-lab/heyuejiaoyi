import { createHash } from "node:crypto";
import { canonicalSnapshotJson, verifyDecisionSnapshot } from "../domain/decision-snapshot.js";
import { executionFillFacts } from "../execution/execution-fill-facts.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-8);
const addReason = (counts, reason) => { counts[reason] = (counts[reason] ?? 0) + 1; };

function cohort(rows) {
  const wins = rows.filter(r => r.netPnl > 0), losses = rows.filter(r => r.netPnl < 0);
  const loss = -sum(losses.map(r => r.netPnl));
  return { trades: rows.length, wins: wins.length, losses: losses.length,
    netPnl: rows.length ? sum(rows.map(r => r.netPnl)) : null,
    averageNetR: rows.length ? sum(rows.map(r => r.netR)) / rows.length : null,
    winRate: rows.length ? wins.length / rows.length : null,
    profitFactor: loss > 0 ? sum(wins.map(r => r.netPnl)) / loss : null,
    profitFactorStatus: loss > 0 ? "FINITE" : wins.length ? "NO_LOSSES_UNBOUNDED" : "UNDEFINED" };
}

function snapshotExclusion(s, protocol, cutoff, registeredAt) {
  if (!verifyDecisionSnapshot(s)) return "SNAPSHOT_HASH_OR_SCHEMA_INVALID";
  if (s.lineage.captureMode !== "FORWARD_EVENT_NO_HISTORICAL_BACKFILL"
    || (s.scope === "ENTRY_PRE_SUBMIT" && (s.environment !== "BINANCE_DEMO" || s.executionSource !== "V2_PRODUCTION"))
    || (s.scope === "SHADOW_DECISION" && s.environment !== "RESEARCH")) return "SNAPSHOT_ENVIRONMENT_OR_PROVENANCE_INVALID";
  if (!finite(s.times.captureTime) || s.times.captureTime > cutoff) return "CAPTURE_AFTER_CUTOFF";
  if (s.times.captureTime < registeredAt || !finite(s.times.triggerTime) || s.times.triggerTime < registeredAt) return "NOT_FORWARD_AFTER_REGISTRATION";
  if (s.versions.epochId !== protocol.performanceEpochId || s.versions.signalModelVersion !== protocol.signalModelVersion
    || s.versions.evaluationVersion !== protocol.signalModelVersion
    || s.versions.strategyVersion !== (s.scope === "SHADOW_DECISION" ? protocol.signalModelVersion : protocol.demoStrategyVersion)
    || s.versions.epochStrategyVersion !== protocol.demoStrategyVersion
    || s.versions.epochSignalModelVersion !== protocol.signalModelVersion
    || s.versions.epochExecutionSource !== "V2_PRODUCTION") return "VERSION_OR_EPOCH_MISMATCH";
  if (!finite(s.times.decisionTime) || s.times.decisionTime > s.times.captureTime) return "DECISION_TIME_INVALID";
  if (s.times.triggerTime > s.times.decisionTime || s.times.triggerTime > cutoff) return "TRIGGER_AFTER_DECISION_OR_CUTOFF";
  if ((s.completeness.timingViolations ?? []).length) return "SNAPSHOT_TIMING_VIOLATION";
  for (const key of ["decisionObservedTime", "observedAt", "candleClosedAt", "radarGeneratedAt", "radarDataClosedAt", "upstreamReceivedAt"]) {
    if (s.times[key] !== null && (!finite(s.times[key]) || s.times[key] > s.times.decisionTime)) return "INPUT_AFTER_DECISION";
  }
  // These are observed input times, unlike a known scheduled next funding timestamp.
  for (const time of [s.marketRegime?.decidedAt,s.marketRegime?.btc1h?.candleCloseTime,s.marketRegime?.btc4h?.candleCloseTime]) {
    if (time !== null && time !== undefined && (!finite(time) || time > s.times.decisionTime)) return "NESTED_MARKET_INPUT_AFTER_DECISION";
  }
  return null;
}

function formalOutcome(run, entry, decision, protocol, cutoff) {
  if (run.sourceType !== "SIGNAL" || run.performanceEligible === false || run.executionSource !== "V2_PRODUCTION"
    || run.plan?.strategyVersion !== protocol.demoStrategyVersion || run.plan?.signalModelVersion !== protocol.signalModelVersion) {
    return { reason: "FORMAL_SOURCE_OR_VERSION_INVALID" };
  }
  if (run.status !== "CLOSED" || run.result?.accountingComplete !== true) return { reason: "UNSETTLED_OR_INCOMPLETE_RIGHT_CENSORED" };
  if (!finite(run.updatedAt) || run.updatedAt > cutoff) return { reason: "RESULT_AFTER_CUTOFF" };
  const registeredAt=Date.parse(protocol.registeredAt),submittedAt=run.entryExecution?.submittedAt;
  if (!finite(run.createdAt) || run.createdAt<registeredAt || run.createdAt>cutoff) return { reason:"RUN_NOT_FORWARD_AFTER_REGISTRATION" };
  if (!finite(submittedAt) || submittedAt>cutoff || submittedAt<run.createdAt || submittedAt>run.updatedAt) return { reason:"LOCAL_EXECUTION_TIME_INVALID" };
  if (decision.times.captureTime>run.createdAt) return { reason:"SHADOW_SNAPSHOT_NOT_BEFORE_RUN" };
  if (!entry || entry.runId !== run.id || entry.signalId !== decision.signalId
    || !run.planHash || entry.plan.planHash !== run.planHash) return { reason: "ENTRY_PLAN_SNAPSHOT_MISSING_OR_MISMATCH" };
  if (entry.symbol !== run.symbol || decision.symbol !== run.symbol || entry.direction !== run.plan.direction
    || decision.direction !== run.plan.direction || createHash("sha256").update(JSON.stringify(run.plan)).digest("hex") !== run.planHash) {
    return { reason: "PLAN_OR_SYMBOL_DIRECTION_INTEGRITY_INVALID" };
  }
  if (!finite(run.entryExecution?.submittedAt) || entry.times.captureTime > run.entryExecution.submittedAt) return { reason: "ENTRY_SNAPSHOT_NOT_BEFORE_SUBMISSION" };
  if (entry.times.captureTime<run.createdAt || entry.times.planCreatedTime!==run.createdAt) return { reason:"ENTRY_PLAN_LOCAL_TIME_MISMATCH" };
  if (entry.times.decisionTime !== decision.times.decisionTime
    || entry.preMove?.volumeAcceleration !== decision.preMove?.volumeAcceleration) return { reason: "DECISION_ENTRY_CONTEXT_MISMATCH" };
  const trades = run.result.trades, funding = run.result.fundingIncome;
  if (!Array.isArray(trades) || !trades.length || !Array.isArray(funding)) return { reason: "FILL_OR_FUNDING_EVIDENCE_MISSING" };
  const owned = new Set((run.result.ownedOrderIds ?? []).map(String));
  if (trades.some(t => !owned.has(String(t.orderId)) || t.symbol !== run.symbol || t.id == null
    || !finite(t.time) || t.time > cutoff || !finite(t.commission) || t.commissionAsset !== "USDT"
    || !finite(t.realizedPnl) || !finite(Number(t.quantity)) || Number(t.quantity) <= 0 || !finite(Number(t.price)) || Number(t.price) <= 0)
    || new Set(trades.map(t => `${t.symbol}:${t.id}`)).size !== trades.length) return { reason: "FILL_IDENTITY_TIME_OR_COST_INVALID" };
  if (funding.some(f => f.symbol !== run.symbol || f.asset !== "USDT" || f.incomeType !== "FUNDING_FEE"
    || !finite(f.income) || !finite(f.time) || f.time > cutoff || f.transactionId == null)
    || new Set(funding.map(f => `${f.symbol}:${f.transactionId}`)).size !== funding.length) return { reason: "FUNDING_IDENTITY_TIME_INVALID" };
  const facts = executionFillFacts(run);
  if (facts.status !== "CONFIRMED" || !(facts.riskAmount > 0)) return { reason: "ACTUAL_RISK_UNKNOWN" };
  const entryQty = sum(trades.filter(t => String(t.orderId) === String(run.entryOrder?.orderId)).map(t => Number(t.quantity)));
  const exitQty = sum(trades.filter(t => t.side === run.plan.exitSide).map(t => Number(t.quantity)));
  if (!close(entryQty, facts.quantity) || !close(exitQty, facts.quantity)) return { reason: "FILL_QUANTITY_MISMATCH" };
  const commission = sum(trades.map(t => t.commission)), gross = sum(trades.map(t => t.realizedPnl));
  const grossFromPrices = (run.plan.direction === "SHORT" ? -1 : 1)
    * (sum(trades.filter(t=>t.side===run.plan.exitSide).map(t=>Number(t.quantity)*Number(t.price)))
      - sum(trades.filter(t=>String(t.orderId)===String(run.entryOrder.orderId)).map(t=>Number(t.quantity)*Number(t.price))));
  const fundingPnl = sum(funding.map(f => f.income)), net = gross - commission + fundingPnl;
  if (!close(grossFromPrices,gross) || !close(net, run.result.netPnl) || !close(commission, run.result.commission)
    || !close(gross, run.result.realizedPnl) || !close(fundingPnl, run.result.fundingPnl)) return { reason: "RAW_ACCOUNTING_MISMATCH" };
  return { row: { runId: run.id, signalId: decision.signalId, symbol: run.symbol, marketEventId: decision.lineage.marketEventId,
    volumeAcceleration: decision.preMove.volumeAcceleration, netPnl: net, netR: net / facts.riskAmount,
    initialRisk: facts.riskAmount, commission, fundingPnl,
    executionException: run.executionException ?? null,
    protectionException: (run.protection?.takeProfit2?.status === "REJECTED" || run.protection?.takeProfit1?.status === "REJECTED")
      ? "TP_REJECTED" : null } };
}

function accountingOwnership(executions) {
  // The CLI supplies one local Demo account dataset. Never namespace claims using
  // arbitrary payload labels, which could hide the same exchange fill twice.
  const byRun = new Map(), ambiguousRuns = new Set(), claims = new Map();
  const claim = (kind, symbol, id, runId) => {
    if (id === null || id === undefined || !symbol) return;
    const key = JSON.stringify([kind, symbol, String(id)]);
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key).add(runId);
  };
  for (const run of executions) {
    if (byRun.has(run.id) && canonicalSnapshotJson(byRun.get(run.id)) !== canonicalSnapshotJson(run)) ambiguousRuns.add(run.id);
    else byRun.set(run.id, run);
    claim('ORDER', run.symbol, run.entryOrder?.orderId, run.id);
    for (const id of run.result?.ownedOrderIds ?? []) claim('ORDER', run.symbol, id, run.id);
    for (const fill of run.result?.trades ?? []) {
      claim('ORDER', fill.symbol, fill.orderId, run.id);
      claim('FILL', fill.symbol, fill.id, run.id);
    }
    for (const funding of run.result?.fundingIncome ?? []) claim('FUNDING', funding.symbol, funding.transactionId, run.id);
  }
  const conflicts = new Set();
  const conflictCounts = { ORDER: 0, FILL: 0, FUNDING: 0 };
  for (const [key, owners] of claims) if (owners.size > 1) {
    conflictCounts[JSON.parse(key)[0]] += 1;
    for (const id of owners) conflicts.add(id);
  }
  return { executions: [...byRun.values()], ambiguousRuns, conflicts, conflictCounts };
}

// Research-only: this module imports no trading client and cannot submit orders or promote a strategy.
export function validateVolumeConfirmation({ snapshots = [], executions = [], protocol, cutoff = Date.now() } = {}) {
  const registeredAt = Date.parse(protocol?.registeredAt);
  if (!finite(cutoff) || !finite(registeredAt) || registeredAt > cutoff
    || protocol?.protocolId !== "TEAM006_VOLUME_GE_1_R1" || protocol.variable?.operator !== ">="
    || protocol.variable?.threshold !== 1 || protocol.variable?.semanticSource !== "candidate.preMove.volumeAcceleration"
    || protocol.orderSubmissionAllowed !== false || protocol.liveStrategyModificationAllowed !== false) {
    throw new TypeError("单变量协议或研究截止无效，禁止静默更换参数");
  }
  const protocolHash = createHash("sha256").update(canonicalSnapshotJson(protocol)).digest("hex");
  const exclusions = {}, seen = new Map(), conflicts = new Set();
  // Conflicting duplicate identities are excluded as a whole, never resolved in favor of an outcome.
  for (const s of snapshots) {
    if (!s?.snapshotId) continue;
    if (seen.has(s.snapshotId) && seen.get(s.snapshotId).contentHash !== s.contentHash) conflicts.add(s.snapshotId);
    else seen.set(s.snapshotId, s);
  }
  const valid = [];
  for (const s of seen.values()) {
    const reason = conflicts.has(s.snapshotId) ? "CONFLICTING_SNAPSHOT_ID" : snapshotExclusion(s, protocol, cutoff, registeredAt);
    if (reason) addReason(exclusions, reason); else valid.push(s);
  }
  addReasonByCount(exclusions, "SNAPSHOT_ID_MISSING", snapshots.filter(s => !s?.snapshotId).length);
  const decisions = valid.filter(s => s.scope === "SHADOW_DECISION").sort((a,b) => a.times.decisionTime-b.times.decisionTime || a.snapshotId.localeCompare(b.snapshotId));
  const unique = new Map();
  for (const s of decisions) {
    if (s.decision.eligible !== true || s.decision.counterfactual !== false) { addReason(exclusions,"BASELINE_NOT_STRATEGY_ELIGIBLE"); continue; }
    if (!finite(s.costs?.totalCostR) || s.costs.totalCostR > 0.35 || s.costs.totalCostR < 0) { addReason(exclusions,"BASELINE_DEMO_COST_NOT_CONFIRMED"); continue; }
    // One first eligible event per signal, including selected=false occupation rejections.
    if (unique.has(s.signalId)) { addReason(exclusions,"REPEATED_ELIGIBLE_SIGNAL_EVENT"); continue; }
    unique.set(s.signalId,s);
  }
  const candidates = [...unique.values()], observed = [], outcomeMissing = {}, missingVariables = [];
  const ownership = accountingOwnership(executions);
  const entryByRun = new Map(), ambiguousEntryRuns = new Set();
  for (const entry of valid.filter(s=>s.scope === "ENTRY_PRE_SUBMIT")) {
    if (entryByRun.has(entry.runId)) ambiguousEntryRuns.add(entry.runId);
    else entryByRun.set(entry.runId,entry);
  }
  for (const decision of candidates) {
    if (!finite(decision.preMove?.volumeAcceleration)) { missingVariables.push(decision.signalId); continue; }
    const runs = ownership.executions.filter(r=>r.signalId===decision.signalId);
    if (runs.length !== 1) { addReason(outcomeMissing,runs.length ? "MULTIPLE_EXECUTIONS_FOR_SIGNAL" : "NO_FORMAL_EXECUTION_OUTCOME"); continue; }
    if (ownership.ambiguousRuns.has(runs[0].id)) { addReason(outcomeMissing,"CONFLICTING_EXECUTION_RUN_ID"); continue; }
    if (ownership.conflicts.has(runs[0].id)) { addReason(outcomeMissing,"CROSS_RUN_ACCOUNTING_OWNERSHIP_CONFLICT"); continue; }
    if (ambiguousEntryRuns.has(runs[0].id)) { addReason(outcomeMissing,"AMBIGUOUS_ENTRY_SNAPSHOTS_FOR_RUN"); continue; }
    const result = formalOutcome(runs[0],entryByRun.get(runs[0].id),decision,protocol,cutoff);
    if (result.reason) addReason(outcomeMissing,result.reason); else observed.push(result.row);
  }
  const known = candidates.filter(s=>finite(s.preMove?.volumeAcceleration));
  const retained = observed.filter(r=>r.volumeAcceleration>=1), filtered = observed.filter(r=>r.volumeAcceleration<1);
  return {
    protocolId:protocol.protocolId,protocolHash,registeredAt:protocol.registeredAt,cutoff:new Date(cutoff).toISOString(),
    status:!decisions.length ? "WAITING_FOR_FORWARD_IMMUTABLE_SNAPSHOTS" : !observed.length
      ? "INSUFFICIENT_VERIFIABLE_FORWARD_OUTCOMES" : "DESCRIPTIVE_COHORT_ONLY_NOT_PROFIT_VALIDATED",
    orderSubmissionAllowed:false,liveStrategyModificationAllowed:false,promotionAllowed:false,
    population:{inputSnapshots:snapshots.length,validSnapshots:valid.length,uniqueEligibleSignals:candidates.length,
      variableKnown:known.length,variableMissing:missingVariables.length,
      candidateRetained:known.filter(s=>s.preMove.volumeAcceleration>=1).length,
      candidateFiltered:known.filter(s=>s.preMove.volumeAcceleration<1).length,
      selected:known.filter(s=>s.decision.selected===true).length,
      eligibleButNotSelected:known.filter(s=>s.decision.selected===false).length},
    exclusions,outcomeMissing,missingVariableSignalIds:missingVariables,
    accountingOwnership:{scope:"SINGLE_LOCAL_BINANCE_DEMO_ACCOUNT_DATASET",conflictingRunIds:[...ownership.conflicts].sort(),
      ambiguousRunIds:[...ownership.ambiguousRuns].sort(),conflictCounts:ownership.conflictCounts},
    conditionalFormalCohort:{scope:"MATCHED_FORMAL_EXECUTIONS_NOT_WHOLE_CANDIDATE_OR_PORTFOLIO_COUNTERFACTUAL",
      baseline:cohort(observed),retained:cohort(retained),filtered:cohort(filtered),
      executionExceptionCount:observed.filter(r=>r.executionException||r.protectionException).length,rows:observed},
    causalNetImprovement:null,statisticalSignificance:null,
    limitations:["No rejected/unfilled candidate executable paths reconstructed; missing outcomes are not zero.",
      "Formal fills reflect their prices; slippage is not deducted a second time.",
      "Actual fill outcomes cannot by themselves model portfolio, timing, opportunity and capacity effects of a new filter.",
      "Saved chronology is not a freshness guarantee; missing upstream receipt times remain unknown.",
      "Input must represent one Demo account; shared order/fill/funding claims exclude all involved runs. Funding allocations are not inferred.",
      "A fixed untouched validation window, event/time-block uncertainty and cost stress are required before promotion."]
  };
}

function addReasonByCount(counts,reason,n) { if (n) counts[reason]=(counts[reason]??0)+n; }
