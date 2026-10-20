import { createHash } from "node:crypto";

export const DECISION_SNAPSHOT_SCHEMA_VERSION = 2;
const SUPPORTED_DECISION_SNAPSHOT_SCHEMA_VERSIONS = new Set([1, DECISION_SNAPSHOT_SCHEMA_VERSION]);
export const DECISION_SNAPSHOT_SCOPES = Object.freeze(["SHADOW_DECISION", "ENTRY_PRE_SUBMIT"]);

const number = (v) => v === null || v === undefined || v === "" || typeof v === "boolean"
  ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const text = (v) => typeof v === "string" ? v : null;
const boolean = (v) => typeof v === "boolean" ? v : null;
const strings = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
// Research-only plan fields must not inherit the legacy converter's Number([]) / Number(" ") behaviour.
const strictNumber = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : null;
};
const fields = (source, names, convert = number) => Object.fromEntries(names.split(" ").map((key) => [key, convert(source?.[key])]));
const PRE_MOVE_NUMBERS = "explosionScore directionScore compressionRatio volumeAcceleration boundary boundaryDistanceAtr rangeHigh rangeLow rangeWidthAtr rangePosition directionalPressure atr15 atr5";
const TRIGGER_NUMBERS = "netMoveAtr advancingCloseRatio bodyPressure latestDirectionalBodyAtr latestDirectionalCloseChangeAtr latestCloseLocation";
const COMPONENT_NUMBERS = "compression volumeAcceleration boundaryProximity rangeTightness trend rangePosition directionalPressure relativeStrength radarAgreement";
const RADAR_NUMBERS = "schemaRevision generatedAt moverDataClosedAt radarScore radarRank moverRank previousMoverRank rankVelocity rankPersistence return15m return1h return4h relativeStrengthBtc1h relativeStrengthEth1h relativeStrengthMarket1h volumeRatio15m volumeBuildRatio compressionRatio nearestBoundaryAtr rangePosition structureWidthAtr liquidityRank";
const COST_NUMBERS = "riskRate feeRoundTripRate slippageRoundTripRate spreadRoundTripRate fundingRateCost totalRate totalCostR fundingCostR expectedHoldingHours fundingPayments";
const NUMERIC_KEYS = new Set(`${PRE_MOVE_NUMBERS} ${TRIGGER_NUMBERS} ${COMPONENT_NUMBERS} ${RADAR_NUMBERS} ${COST_NUMBERS} schemaVersion candidateScore evaluationScore executionScore epochStartedAt captureTime decisionTime decisionObservedTime observedAt triggerTime candleClosedAt radarGeneratedAt radarDataClosedAt upstreamReceivedAt planCreatedTime decidedAt trendSpreadAtr candleCloseTime total long short neutral longRatio shortRatio atrPercent percentile markPrice lastFundingRate nextFundingTime entry stopLoss takeProfit1 takeProfit2 stopPercent riskReward1 riskReward2 riskPerTradePercent expiresAt expiryBars equity targetRiskPercent targetRiskAmount stopRate targetNotional targetMargin targetQuantity quantity takeProfit1Quantity takeProfit2Quantity leverage riskAmountEstimate`.split(" "));
const BOOLEAN_KEYS = new Set("alreadyBroken selected retentionOnly boundaryPressureOnly breadthAgrees valid fundingDataAvailable counterfactual eligible receivedByDecision freshnessValidated riskOrderEntryConsistent priceGeometryValid orderFormatValid ttlValid sizingValid complete".split(" "));
const ARRAY_KEYS = new Set("opportunitySources independentOpportunitySources independentTradeOpportunitySources tags reasons rejectionReasons hardRejectionReasons qualityObservations missingFields timingViolations missingInputs invalidInputs".split(" "));

export function canonicalSnapshotJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalSnapshotJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(canonicalSnapshotJson(value)).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Every nested object is reconstructed from an explicit whitelist. Never spread input records.
export function buildDecisionSnapshot({
  candidate = {}, evaluation = candidate?.shadowV2 ?? {}, decision = {}, scope = "SHADOW_DECISION",
  runId = null, executionSource = null, epoch = null, recordedAt = Date.now(),
  candidateScore, executionScore = null, planHash = null, plan = null, planCreatedAt = null,
  environment = null, snapshotId = null,
} = {}) {
  if (!DECISION_SNAPSHOT_SCOPES.includes(scope)) throw new TypeError("快照scope无效");
  if (!text(candidate?.id)) throw new TypeError("快照缺少signalId");
  if (scope === "ENTRY_PRE_SUBMIT" && !text(runId)) throw new TypeError("执行前快照缺少runId");
  const captureTime = number(recordedAt);
  if (captureTime === null || captureTime < 0) throw new TypeError("快照采集时间无效");
  const p = candidate.preMove;
  const r = evaluation?.marketRadar ?? candidate.marketRadar;
  const m = evaluation?.marketRegime;
  const e = epoch?.value ?? epoch;
  const times = {
    captureTime,
    decisionTime: number(decision.decidedAt),
    decisionObservedTime: number(evaluation?.evaluatedAt),
    observedAt: number(candidate.observedAt),
    triggerTime: number(candidate.triggerTime),
    candleClosedAt: number(candidate.candleClosedAt ?? candidate.closeTime),
    radarGeneratedAt: number(r?.generatedAt),
    radarDataClosedAt: number(r?.moverDataClosedAt),
    upstreamReceivedAt: number(candidate.receivedAt ?? candidate.upstreamReceivedAt),
    planCreatedTime: number(planCreatedAt),
  };
  const scores = {
    // Projected execution candidates overwrite score. They must supply an explicit original score or null.
    candidateScore: candidateScore !== undefined ? number(candidateScore)
      : candidate.executionSource ? null : number(candidate.score),
    evaluationScore: number(evaluation?.score),
    executionScore: number(executionScore),
  };
  const versions = {
    strategyVersion: text(plan?.strategyVersion ?? candidate.strategyVersion ?? evaluation?.strategyVersion),
    signalModelVersion: text(plan?.signalModelVersion ?? candidate.signalModelVersion ?? p?.modelVersion ?? evaluation?.strategyVersion),
    evaluationVersion: text(evaluation?.strategyVersion),
    radarVersion: text(r?.version),
    epochId: text(e?.id),
    epochStartedAt: number(e?.startedAt),
    epochStrategyVersion: text(e?.strategyVersion),
    epochSignalModelVersion: text(e?.signalModelVersion),
    epochExecutionSource: text(e?.strategySource),
  };
  const researchPlan = buildResearchPlan({ candidate, evaluation, decisionTime: times.decisionTime });
  const body = {
    schemaVersion: DECISION_SNAPSHOT_SCHEMA_VERSION,
    scope, signalId: candidate.id, runId: text(runId),
    symbol: text(candidate.symbol), strategy: text(candidate.strategy), direction: text(candidate.direction),
    executionSource: text(executionSource), environment: text(environment) ?? (scope === "SHADOW_DECISION" ? "RESEARCH" : null),
    versions, times, scores,
    preMove: p ? {
      modelVersion: text(p.modelVersion), ...fields(p, PRE_MOVE_NUMBERS), alreadyBroken: boolean(p.alreadyBroken),
      triggerConfirmation: fields(p.triggerConfirmation, TRIGGER_NUMBERS),
      components: fields(p.components, COMPONENT_NUMBERS),
    } : null,
    radar: r ? {
      ...fields(r, RADAR_NUMBERS), ...fields(r, "version snapshotId marketDirection radarTier bias overextensionRisk", text),
      ...fields(r, "selected retentionOnly boundaryPressureOnly", boolean),
      ...fields(r, "opportunitySources independentOpportunitySources independentTradeOpportunitySources tags reasons", strings),
    } : null,
    marketRegime: m ? {
      ...fields(m, "version direction", text), decidedAt: number(m.decidedAt), breadthAgrees: boolean(m.breadthAgrees),
      btc4h: trend(m.btc4h), btc1h: trend(m.btc1h),
      breadth: { direction: text(m.breadth?.direction), ...fields(m.breadth, "total long short neutral longRatio shortRatio") },
      volatility: { ...fields(m.volatility, "atrPercent percentile"), regime: text(m.volatility?.regime) },
    } : null,
    costs: evaluation?.costs ? {
      modelVersion: text(evaluation.costs.modelVersion), ...fields(evaluation.costs, COST_NUMBERS),
      premium: evaluation.costs.premium ? fields(evaluation.costs.premium, "markPrice lastFundingRate nextFundingTime") : null,
      fundingDataAvailable: boolean(evaluation.costs.fundingDataAvailable),
    } : null,
    decision: {
      selected: boolean(decision.selected), rejectionReason: text(decision.rejectionReason), counterfactual: boolean(decision.counterfactual),
      experimentTier: text(decision.experimentTier ?? evaluation?.experimentTier), eligible: boolean(evaluation?.eligible),
      ...fields(evaluation, "rejectionReasons hardRejectionReasons qualityObservations", strings),
    },
    // Observation only: this is the candidate/evaluation plan at decision time, not an exchange order or fill.
    researchPlan,
    plan: plan ? {
      planHash: text(planHash), ...fields(plan, "strategyVersion signalModelVersion direction", text),
      prices: fields(plan.prices, "entry stopLoss takeProfit1 takeProfit2"),
      ...fields(plan, "quantity takeProfit1Quantity takeProfit2Quantity leverage riskAmountEstimate"),
    } : { planHash: text(planHash) },
    lineage: {
      candidateId: text(candidate.id), radarSnapshotId: text(r?.snapshotId),
      sourceType: text(candidate.sourceType), marketEventId: text(candidate.marketEventId),
      candidateScoreSource: candidateScore !== undefined ? "EXPLICIT_ORIGINAL_OR_NULL" : candidate.executionSource ? "PROJECTED_ORIGINAL_UNAVAILABLE" : "CANDIDATE_AT_CAPTURE",
      captureMode: "FORWARD_EVENT_NO_HISTORICAL_BACKFILL",
    },
  };
  const missingFields = [];
  for (const [key, value] of Object.entries(times)) if (value === null) missingFields.push(`times.${key}`);
  for (const [key, value] of Object.entries(scores)) if (value === null) missingFields.push(`scores.${key}`);
  for (const [key, value] of Object.entries(versions)) if (value === null) missingFields.push(`versions.${key}`);
  if (body.preMove?.volumeAcceleration == null) missingFields.push("preMove.volumeAcceleration");
  const decisionTime = times.decisionTime;
  const violations = [];
  for (const key of ["decisionObservedTime", "observedAt", "radarGeneratedAt", "radarDataClosedAt", "upstreamReceivedAt", "candleClosedAt"]) {
    if (decisionTime !== null && times[key] !== null && times[key] > decisionTime) violations.push(`${key}_AFTER_DECISION`);
  }
  // These are already stored source timestamps, not scheduled future events (e.g. next funding).
  for (const [path, value] of [
    ["marketRegime.decidedAt", body.marketRegime?.decidedAt],
    ["marketRegime.btc1h.candleCloseTime", body.marketRegime?.btc1h.candleCloseTime],
    ["marketRegime.btc4h.candleCloseTime", body.marketRegime?.btc4h.candleCloseTime],
  ]) {
    if (value === null || value === undefined) missingFields.push(path);
    else if (decisionTime !== null && value > decisionTime) violations.push(`${path}_AFTER_DECISION`);
  }
  if (decisionTime !== null && decisionTime > captureTime) violations.push("DECISION_AFTER_CAPTURE");
  if (times.planCreatedTime !== null && times.planCreatedTime > captureTime) violations.push("PLAN_AFTER_CAPTURE");
  body.completeness = {
    missingFields, missingReasons: Object.fromEntries(missingFields.map((key) => [key, "NOT_PROVIDED_OR_INVALID_AT_CAPTURE"])),
    timingViolations: violations,
    receivedByDecision: decisionTime === null || times.upstreamReceivedAt === null ? null : times.upstreamReceivedAt <= decisionTime,
    // Receipt evidence is independent of candle closure. No freshness promise is inferred.
    freshnessValidated: false,
  };
  const identity = [DECISION_SNAPSHOT_SCHEMA_VERSION, scope, candidate.id, text(runId), times.decisionTime];
  body.snapshotId = text(snapshotId) ?? `decision-${digest(identity)}`;
  return freeze({ ...body, contentHash: digest(body) });
}

function buildResearchPlan({ candidate, evaluation, decisionTime }) {
  const riskSource = candidate?.risk;
  const orderSource = candidate?.order;
  const fixedRiskSource = evaluation?.fixedRiskPlan;
  const risk = {
    valid: boolean(riskSource?.valid),
    entry: strictNumber(riskSource?.entry),
    stopLoss: strictNumber(riskSource?.stopLoss),
    takeProfit1: strictNumber(riskSource?.takeProfit1),
    takeProfit2: strictNumber(riskSource?.takeProfit2),
    stopPercent: strictNumber(riskSource?.stopPercent),
    riskReward1: strictNumber(riskSource?.riskReward1),
    riskReward2: strictNumber(riskSource?.riskReward2),
    riskPerTradePercent: strictNumber(riskSource?.riskPerTradePercent),
  };
  const order = {
    type: text(orderSource?.type), style: text(orderSource?.style), entry: strictNumber(orderSource?.entry),
    expiresAt: strictNumber(orderSource?.expiresAt), expiryBars: strictNumber(orderSource?.expiryBars),
  };
  const fixedRiskPlan = {
    modelVersion: text(fixedRiskSource?.modelVersion),
    equity: strictNumber(fixedRiskSource?.equity),
    targetRiskPercent: strictNumber(fixedRiskSource?.targetRiskPercent),
    targetRiskAmount: strictNumber(fixedRiskSource?.targetRiskAmount),
    stopRate: strictNumber(fixedRiskSource?.stopRate),
    targetNotional: strictNumber(fixedRiskSource?.targetNotional),
    targetMargin: strictNumber(fixedRiskSource?.targetMargin),
    targetQuantity: strictNumber(fixedRiskSource?.targetQuantity),
    leverage: strictNumber(fixedRiskSource?.leverage), valid: boolean(fixedRiskSource?.valid),
  };
  const direction = text(candidate?.direction);
  const riskOrderEntryConsistent = risk.entry === null || order.entry === null ? null
    : approximatelyEqual(risk.entry, order.entry);
  const entry = order.entry ?? risk.entry;
  const priceGeometryValid = direction !== "LONG" && direction !== "SHORT" ? null
    : [entry, risk.stopLoss, risk.takeProfit1, risk.takeProfit2].some((v) => v === null || v <= 0) ? false
      : direction === "LONG"
        ? risk.stopLoss < entry && entry < risk.takeProfit1 && risk.takeProfit1 <= risk.takeProfit2
        : risk.takeProfit2 <= risk.takeProfit1 && risk.takeProfit1 < entry && entry < risk.stopLoss;
  const orderFormatValid = order.type === null || order.style === null ? null
    : order.type === "LIMIT" && ["ACTIVE_DYNAMIC", "PASSIVE_RETEST"].includes(order.style);
  const ttlValid = order.expiresAt === null || order.expiryBars === null || decisionTime === null ? null
    : order.expiresAt >= 0 && order.expiryBars > 0 && order.expiresAt > decisionTime;
  const sizingValues = [fixedRiskPlan.equity, fixedRiskPlan.targetRiskPercent, fixedRiskPlan.targetRiskAmount,
    fixedRiskPlan.stopRate, fixedRiskPlan.targetNotional, fixedRiskPlan.targetMargin,
    fixedRiskPlan.targetQuantity, fixedRiskPlan.leverage];
  const sizingEntry = order.entry ?? risk.entry;
  const sizingValid = sizingValues.some((v) => v === null) || sizingEntry === null || risk.stopLoss === null
    || fixedRiskPlan.valid === null ? null
    : fixedRiskPlan.valid === true && sizingValues.every((v) => v > 0)
      && fixedRiskPlanNumericallyCoherent(fixedRiskPlan, sizingEntry, risk.stopLoss);
  const missingInputs = [];
  for (const [prefix, record] of [["risk", risk], ["order", order], ["fixedRiskPlan", fixedRiskPlan]]) {
    for (const [key, value] of Object.entries(record)) if (value === null) missingInputs.push(`${prefix}.${key}`);
  }
  if (direction === null) missingInputs.push("direction");
  if (decisionTime === null) missingInputs.push("decisionTime");
  const invalidInputs = [];
  if (direction !== null && direction !== "LONG" && direction !== "SHORT") invalidInputs.push("direction");
  if (risk.valid === false) invalidInputs.push("risk.valid");
  if (riskOrderEntryConsistent === false) invalidInputs.push("consistency.riskOrderEntryConsistent");
  if (priceGeometryValid === false) invalidInputs.push("consistency.priceGeometryValid");
  if (orderFormatValid === false) invalidInputs.push("consistency.orderFormatValid");
  if (ttlValid === false) invalidInputs.push("consistency.ttlValid");
  if (sizingValid === false) invalidInputs.push("consistency.sizingValid");
  const complete = missingInputs.length === 0 && invalidInputs.length === 0
    && risk.valid === true && riskOrderEntryConsistent === true && priceGeometryValid === true
    && orderFormatValid === true && ttlValid === true && sizingValid === true;
  return {
    modelVersion: "IMMUTABLE_SHADOW_RESEARCH_PLAN_V1",
    source: "CANDIDATE_RISK_ORDER_FIXED_RISK_AT_DECISION",
    direction, risk, order, fixedRiskPlan,
    consistency: { riskOrderEntryConsistent, priceGeometryValid, orderFormatValid, ttlValid, sizingValid },
    completeness: { complete, missingInputs, invalidInputs },
  };
}

function approximatelyEqual(a, b, relativeTolerance = 1e-9) {
  return Math.abs(a - b) <= Math.max(1e-12, Math.max(Math.abs(a), Math.abs(b)) * relativeTolerance);
}

// The source plan rounds inputs to 4 decimals and derived values to 8/12 decimals after
// computing with unrounded inputs. Validate compatible intervals instead of recomputing
// from already-rounded stopRate/equity and creating false inconsistencies.
function fixedRiskPlanNumericallyCoherent(plan, entry, stopLoss) {
  if (!(entry > 0) || !(plan.leverage > 0)) return false;
  const stopRate = Math.abs(entry - stopLoss) / entry;
  if (!(stopRate > 0) || !withinRoundedValue(plan.stopRate, stopRate, 8)) return false;
  const [equityLow, equityHigh] = sourceInterval(plan.equity, 4);
  const [percentLow, percentHigh] = sourceInterval(plan.targetRiskPercent, 4);
  const riskAmountLow = Math.max(0, equityLow) * Math.max(0, percentLow) / 100;
  const riskAmountHigh = equityHigh * percentHigh / 100;
  const notionalLow = riskAmountLow / stopRate;
  const notionalHigh = riskAmountHigh / stopRate;
  return roundedIntervalsOverlap(plan.targetRiskAmount, 8, riskAmountLow, riskAmountHigh)
    && roundedIntervalsOverlap(plan.targetNotional, 8, notionalLow, notionalHigh)
    && roundedIntervalsOverlap(plan.targetMargin, 8,
      notionalLow / plan.leverage, notionalHigh / plan.leverage)
    && roundedIntervalsOverlap(plan.targetQuantity, 12,
      notionalLow / entry, notionalHigh / entry);
}

function sourceInterval(value, digits) {
  const halfUnit = 0.5 * 10 ** -digits;
  return [value - halfUnit, value + halfUnit];
}

function withinRoundedValue(actual, sourceValue, digits) {
  const halfUnit = 0.5 * 10 ** -digits;
  return Math.abs(actual - sourceValue) <= halfUnit + Number.EPSILON * Math.max(1, Math.abs(sourceValue));
}

function roundedIntervalsOverlap(actual, digits, sourceLow, sourceHigh) {
  const [actualLow, actualHigh] = sourceInterval(actual, digits);
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(sourceLow), Math.abs(sourceHigh));
  return actualHigh + epsilon >= sourceLow && actualLow - epsilon <= sourceHigh;
}

function trend(value) {
  return { ...fields(value, "direction reason", text), valid: boolean(value?.valid), ...fields(value, "trendSpreadAtr candleCloseTime") };
}

// A schema template also rejects injected fields even when an attacker recomputes the hash.
export function verifyDecisionSnapshot(snapshot) {
  try {
    const { contentHash, ...body } = snapshot;
    if (!SUPPORTED_DECISION_SNAPSHOT_SCHEMA_VERSIONS.has(body.schemaVersion) || !DECISION_SNAPSHOT_SCOPES.includes(body.scope)
      || !text(body.snapshotId) || !text(body.signalId) || number(body.times?.captureTime) === null
      || (body.scope === "ENTRY_PRE_SUBMIT" && !text(body.runId))) return false;
    if (contentHash !== digest(body)) return false;
    const legacyIdentity = [body.scope, body.signalId, text(body.runId), number(body.times?.decisionTime)];
    const currentIdentity = [body.schemaVersion, body.scope, body.signalId, text(body.runId), number(body.times?.decisionTime)];
    const expectedGeneratedId = `decision-${digest(body.schemaVersion === 1 ? legacyIdentity : currentIdentity)}`;
    if (/^decision-[a-f0-9]{64}$/.test(body.snapshotId) && body.snapshotId !== expectedGeneratedId) return false;
    const template = buildDecisionSnapshot({ candidate: { id: "template", preMove: {}, marketRadar: {} }, evaluation: { marketRegime: {}, costs: {} }, decision: {}, recordedAt: 0 });
    const copy = structuredClone(template);
    if (body.schemaVersion === 1) {
      copy.schemaVersion = 1;
      delete copy.researchPlan;
    }
    // Nullable objects have the same fixed whitelist when present.
    for (const key of ["preMove", "radar", "marketRegime", "costs"]) {
      if (snapshot[key] === null) copy[key] = null;
      else if (!snapshot[key] || typeof snapshot[key] !== "object" || Array.isArray(snapshot[key])) return false;
    }
    if (snapshot.costs?.premium != null) copy.costs.premium = fields({}, "markPrice lastFundingRate nextFundingTime");
    copy.plan = snapshot.plan && Object.keys(snapshot.plan).length === 1 ? { planHash: null }
      : buildDecisionSnapshot({ candidate: { id: "template" }, plan: {}, recordedAt: 0 }).plan;
    // Missing-field reasons have dynamic keys, constrained to the reported paths.
    copy.completeness.missingFields = snapshot.completeness?.missingFields;
    copy.completeness.missingReasons = snapshot.completeness?.missingReasons;
    if (!Array.isArray(snapshot.completeness?.missingFields)
      || snapshot.completeness.missingFields.some((x) => !/^(?:(times|scores|versions|preMove)\.[A-Za-z]+|marketRegime\.(?:decidedAt|btc(?:1h|4h)\.candleCloseTime))$/.test(x))
      || Object.keys(snapshot.completeness.missingReasons ?? {}).sort().join() !== [...snapshot.completeness.missingFields].sort().join()
      || Object.values(snapshot.completeness.missingReasons).some((v) => v !== "NOT_PROVIDED_OR_INVALID_AT_CAPTURE")) return false;
    // Null template leaves accept only scalar/null; object branches are checked recursively.
    return whitelistShape(snapshot, copy);
  } catch { return false; }
}

function whitelistShape(value, template, key = "", parent = "") {
  if (value === null) return template === null || typeof template !== "object";
  if (ARRAY_KEYS.has(key)) return Array.isArray(value) && value.every((v) => typeof v === "string");
  if (template === null || typeof template !== "object") {
    if (parent === "missingReasons") return value === "NOT_PROVIDED_OR_INVALID_AT_CAPTURE";
    if (NUMERIC_KEYS.has(key)) return typeof value === "number" && Number.isFinite(value);
    if (BOOLEAN_KEYS.has(key)) return typeof value === "boolean";
    return typeof value === "string";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length === Object.keys(template).length
    && Object.keys(template).every((k) => Object.hasOwn(value, k) && whitelistShape(value[k], template[k], k, key));
}
