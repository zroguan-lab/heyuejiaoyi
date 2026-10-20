// TEAM-008 research-only ledger. SELECT only; no Store initialization, env, network or orders.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canonicalSnapshotJson, verifyDecisionSnapshot } from "../../src/domain/decision-snapshot.js";

const protocol = JSON.parse(readFileSync(new URL("./TEAM-008-long-radar-volume-protocol.json", import.meta.url), "utf8"));
const registeredAt = Date.parse(protocol.registeredAt);
const observedAt = Date.now();
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const count = (rows, predicate) => rows.filter(predicate).length;
const tally = (rows, selector) => {
  const result = {};
  for (const row of rows) {
    const values = selector(row);
    for (const value of Array.isArray(values) ? values : [values]) {
      const key = value ?? "<MISSING>";
      result[key] = (result[key] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};

function invalidReason(snapshot) {
  if (!verifyDecisionSnapshot(snapshot)) return "HASH_OR_SCHEMA_INVALID";
  if (snapshot.scope !== "SHADOW_DECISION" || snapshot.environment !== "RESEARCH") return "SCOPE_OR_ENVIRONMENT_INVALID";
  if (snapshot.direction !== protocol.direction) return "OTHER_DIRECTION";
  if (snapshot.lineage?.captureMode !== "FORWARD_EVENT_NO_HISTORICAL_BACKFILL") return "PROVENANCE_INVALID";
  const versions = snapshot.versions ?? {};
  if (versions.epochId !== protocol.performanceEpochId
    || versions.strategyVersion !== protocol.signalModelVersion
    || versions.signalModelVersion !== protocol.signalModelVersion
    || versions.evaluationVersion !== protocol.signalModelVersion
    || versions.epochStrategyVersion !== protocol.demoStrategyVersion
    || versions.epochSignalModelVersion !== protocol.signalModelVersion
    || versions.epochExecutionSource !== "V2_PRODUCTION") return "VERSION_OR_EPOCH_MISMATCH";
  const times = snapshot.times ?? {};
  if (!finite(times.captureTime) || times.captureTime > observedAt) return "CAPTURE_TIME_INVALID";
  if (!finite(times.decisionTime) || times.decisionTime > times.captureTime) return "DECISION_TIME_INVALID";
  if (!finite(times.triggerTime) || times.triggerTime > times.decisionTime) return "TRIGGER_TIME_INVALID";
  if ((snapshot.completeness?.timingViolations ?? []).length) return "RECORDED_TIMING_VIOLATION";
  for (const key of ["decisionObservedTime", "observedAt", "candleClosedAt", "radarGeneratedAt", "radarDataClosedAt", "upstreamReceivedAt"]) {
    const value = times[key];
    if (value !== null && (!finite(value) || value > times.decisionTime)) return "INPUT_AFTER_DECISION";
  }
  for (const value of [snapshot.marketRegime?.decidedAt, snapshot.marketRegime?.btc1h?.candleCloseTime, snapshot.marketRegime?.btc4h?.candleCloseTime]) {
    if (value !== null && value !== undefined && (!finite(value) || value > times.decisionTime)) return "NESTED_INPUT_AFTER_DECISION";
  }
  return null;
}

function classify(snapshot) {
  const hard = snapshot.decision?.hardRejectionReasons ?? [];
  const otherHard = hard.filter((reason) => reason !== "V2_4_2_LONG_VOLUME_NOT_CONFIRMED");
  const radarVolume = snapshot.radar?.volumeRatio15m;
  const acceleration = snapshot.preMove?.volumeAcceleration;
  const score = snapshot.scores?.evaluationScore;
  const baselineVolumePass = finite(radarVolume) && radarVolume >= protocol.variable.threshold;
  const accelerationFrozenPass = finite(acceleration) && acceleration >= 1;
  const scorePass = finite(score) && score >= 55;
  const compositeReasonPresent = hard.includes("V2_4_2_LONG_VOLUME_NOT_CONFIRMED");
  const targetOnlyDifference = !baselineVolumePass && finite(radarVolume)
    && accelerationFrozenPass && compositeReasonPresent && otherHard.length === 0 && scorePass
    && snapshot.decision?.eligible === false;
  const immutablePlanComplete = ["entry", "stopLoss", "takeProfit1", "takeProfit2"]
    .every((key) => finite(snapshot.plan?.prices?.[key]));
  return {
    snapshotId: snapshot.snapshotId,
    signalId: snapshot.signalId,
    symbol: snapshot.symbol,
    marketEventId: snapshot.lineage?.marketEventId ?? null,
    captureTime: snapshot.times.captureTime,
    captureTimeIso: new Date(snapshot.times.captureTime).toISOString(),
    cohort: snapshot.times.captureTime < registeredAt ? "SEED_PRE_REGISTRATION" : "FORWARD_CONFIRMATORY",
    radarVolumeRatio15m: radarVolume ?? null,
    frozenVolumeAcceleration: acceleration ?? null,
    evaluationScore: score ?? null,
    baselineEligible: snapshot.decision?.eligible ?? null,
    baselineSelected: snapshot.decision?.selected ?? null,
    hardRejectionReasons: hard,
    otherHardRejectionReasons: otherHard,
    baselineVolumePass,
    accelerationFrozenPass,
    scorePass,
    targetOnlyDifference,
    immutablePlanComplete,
    immutablePlanStatus: immutablePlanComplete ? "AVAILABLE" : "MISSING_FROM_SHADOW_SNAPSHOT"
  };
}

if (protocol.variable?.semanticSource !== "snapshot.radar.volumeRatio15m"
  || protocol.variable?.operator !== ">=" || protocol.variable?.threshold !== 1
  || protocol.orderSubmissionAllowed !== false || protocol.liveStrategyModificationAllowed !== false
  || protocol.promotionAllowed !== false || !protocol.frozen?.includes("preMove.volumeAcceleration")) {
  throw new TypeError("TEAM-008 单变量协议无效或冻结项缺失");
}

const db = new DatabaseSync(fileURLToPath(new URL("../../data/research.sqlite", import.meta.url)), { readOnly: true });
try {
  db.exec("BEGIN");
  const raw = db.prepare(`
    SELECT snapshot_id, captured_at, content_hash, payload
    FROM decision_snapshots
    WHERE scope='SHADOW_DECISION' AND captured_at<=?
    ORDER BY captured_at, snapshot_id
  `).all(observedAt);
  const parsed = raw.map((row) => ({ row, snapshot: JSON.parse(row.payload) }));
  const rowEnvelopeInvalid = parsed.filter(({ row, snapshot }) => row.snapshot_id !== snapshot.snapshotId
    || row.content_hash !== snapshot.contentHash || row.captured_at !== snapshot.times?.captureTime).length;
  const exclusions = tally(parsed.map(({ snapshot }) => ({ snapshot, reason: invalidReason(snapshot) })), ({ reason }) => reason ?? "VALID_LONG");
  const validLong = parsed.map(({ snapshot }) => snapshot).filter((snapshot) => invalidReason(snapshot) === null);
  const classified = validLong.map(classify);
  const seed = classified.filter((row) => row.cohort === "SEED_PRE_REGISTRATION");
  const forward = classified.filter((row) => row.cohort === "FORWARD_CONFIRMATORY");
  const effective = classified.filter((row) => row.targetOnlyDifference);
  const status = rowEnvelopeInvalid > 0 ? "INVALID_STORAGE_ENVELOPE"
    : !forward.length ? "WAITING_FOR_FORWARD_DATA"
      : !effective.some((row) => row.cohort === "FORWARD_CONFIRMATORY") ? "WAITING_FOR_EFFECTIVE_FORWARD_DIFFERENCES"
        : effective.some((row) => !row.immutablePlanComplete) ? "INSUFFICIENT_EXECUTABLE_PATHS"
          : "PIPELINE_READY_FOR_PATH_MATCHING";
  const result = {
    taskId: "TEAM-008",
    protocolId: protocol.protocolId,
    protocolHash: createHash("sha256").update(canonicalSnapshotJson(protocol)).digest("hex"),
    registeredAt: protocol.registeredAt,
    observedAt: new Date(observedAt).toISOString(),
    status,
    permissions: { orderSubmissionAllowed: false, liveStrategyModificationAllowed: false, promotionAllowed: false },
    storageEnvelopeInvalid: rowEnvelopeInvalid,
    population: {
      allShadowSnapshots: raw.length,
      validExactLong: classified.length,
      seedPreRegistration: seed.length,
      forwardConfirmatory: forward.length,
      baselineEligible: count(classified, (row) => row.baselineEligible === true),
      radarVolumeBelowOne: count(classified, (row) => finite(row.radarVolumeRatio15m) && row.radarVolumeRatio15m < 1),
      frozenAccelerationPass: count(classified, (row) => row.accelerationFrozenPass),
      targetOnlyDifferences: effective.length,
      targetOnlySeed: count(effective, (row) => row.cohort === "SEED_PRE_REGISTRATION"),
      targetOnlyForward: count(effective, (row) => row.cohort === "FORWARD_CONFIRMATORY"),
      immutablePlanCompleteAmongDifferences: count(effective, (row) => row.immutablePlanComplete)
    },
    exclusions,
    baselineHardRejections: tally(validLong, (snapshot) => snapshot.decision?.hardRejectionReasons ?? []),
    effectiveDifferenceRows: effective,
    outcomeGate: {
      executableCounterfactualRows: effective.filter((row) => row.immutablePlanComplete).length,
      result: effective.every((row) => row.immutablePlanComplete) && effective.length
        ? "PLAN_AVAILABLE_PATH_DATA_STILL_REQUIRED"
        : "BLOCKED_MISSING_IMMUTABLE_ENTRY_SL_TP",
      mutableSignalsAreNotAcceptedAsImmutablePlans: true,
      pnl: null,
      netR: null,
      mfe: null,
      mae: null
    },
    limitations: [
      "Pre-registration seed rows validate the pipeline only and cannot confirm profitability.",
      "The existing LONG volume rejection code is composite; this ledger freezes preMove.volumeAcceleration and changes only radar.volumeRatio15m.",
      "An eligibility difference is not an executed order or a realized trade outcome.",
      "SHADOW_DECISION snapshots without immutable entry/SL/TP cannot support counterfactual PnL, MFE or MAE.",
      "Mutable signals, current prices and formal fills from other signals are not substituted for missing immutable plans.",
      "Portfolio occupancy and exchange execution feasibility remain separate downstream questions."
    ]
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.exec("ROLLBACK");
  db.close();
}
