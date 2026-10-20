import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildDecisionSnapshot, verifyDecisionSnapshot, canonicalSnapshotJson } from "../src/domain/decision-snapshot.js";
import { buildFixedRiskShadowPlan } from "../src/domain/shadow-v2.js";

function input() {
  return {
    candidate: {
      id: "signal-1", symbol: "BTCUSDT", strategy: "PRE_BREAKOUT", direction: "SHORT", score: 71,
      triggerTime: 80, observedAt: 90, receivedAt: 95, candleClosedAt: 79,
      risk: { valid: true, entry: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5,
        stopPercent: 1, riskReward1: 1.5, riskReward2: 2.5, riskPerTradePercent: 0.5 },
      order: { type: "LIMIT", style: "ACTIVE_DYNAMIC", entry: 100, expiresAt: 680, expiryBars: 2 },
      preMove: { volumeAcceleration: 1.2, boundaryDistanceAtr: -0.2, explosionScore: 76, directionScore: 62 },
      marketRadar: { generatedAt: 88, moverDataClosedAt: 79, nearestBoundaryAtr: 0.3,
        volumeRatio15m: 0.8, volumeBuildRatio: 1.4, opportunitySources: ["RETAINED", "VOLATILITY_COMPRESSION"] },
      confirmationCode: "SECRET", account: { balance: 999 }, result: { netPnl: 42 },
    },
    evaluation: { score: 60, strategyVersion: "V2_TEST", eligible: true,
      fixedRiskPlan: { modelVersion: "FIXED_RISK_V1", equity: 500, targetRiskPercent: 0.5,
        targetRiskAmount: 2.5, stopRate: 0.01, targetNotional: 250, targetMargin: 25,
        targetQuantity: 2.5, leverage: 10, valid: true },
      costs: { totalCostR: 0.2, fundingDataAvailable: true, account: { secret: "SECRET" } },
      marketRegime: { version: "REGIME1", direction: "SHORT", btc1h: { candleCloseTime: 79 },
        breadth: { total: 5, short: 4, shortRatio: 0.8 }, volatility: { percentile: 0.5 } } },
    decision: { selected: false, rejectionReason: "FILTER", decidedAt: 100 },
    recordedAt: 110, epoch: { id: "epoch-1", startedAt: 50 }, executionScore: 58,
  };
}

// Frozen with the schema-V1 builder before TEAM-009. These are literals, not downgraded V2 output.
function legacyV1Fixture(kind = "shadow") {
  const entry = kind === "entry";
  const signalId = entry ? "legacy-entry-1" : "legacy-shadow-1";
  const missingFields = entry
    ? ["times.decisionObservedTime", "times.radarGeneratedAt", "times.radarDataClosedAt", "scores.candidateScore",
      "versions.radarVersion", "versions.epochStrategyVersion", "versions.epochSignalModelVersion", "versions.epochExecutionSource"]
    : ["times.decisionObservedTime", "times.radarGeneratedAt", "times.radarDataClosedAt", "times.planCreatedTime",
      "versions.radarVersion", "versions.epochStrategyVersion", "versions.epochSignalModelVersion", "versions.epochExecutionSource"];
  const body = {
    schemaVersion: 1, scope: entry ? "ENTRY_PRE_SUBMIT" : "SHADOW_DECISION", signalId,
    runId: entry ? "legacy-run-1" : null, symbol: "BTCUSDT", strategy: "PRE_BREAKOUT", direction: "SHORT",
    executionSource: null, environment: entry ? null : "RESEARCH",
    versions: { strategyVersion: "V2_TEST", signalModelVersion: entry ? "MODEL_TEST" : "V2_TEST",
      evaluationVersion: "V2_TEST", radarVersion: null, epochId: "epoch-1", epochStartedAt: 50,
      epochStrategyVersion: null, epochSignalModelVersion: null, epochExecutionSource: null },
    times: { captureTime: 110, decisionTime: 100, decisionObservedTime: null, observedAt: 90, triggerTime: 80,
      candleClosedAt: 79, radarGeneratedAt: null, radarDataClosedAt: null, upstreamReceivedAt: 95,
      planCreatedTime: entry ? 105 : null },
    scores: { candidateScore: entry ? null : 71, evaluationScore: 60, executionScore: 58 },
    preMove: { modelVersion: null, explosionScore: null, directionScore: null, compressionRatio: null,
      volumeAcceleration: 1.2, boundary: null, boundaryDistanceAtr: -0.2, rangeHigh: null, rangeLow: null,
      rangeWidthAtr: null, rangePosition: null, directionalPressure: null, atr15: null, atr5: null,
      alreadyBroken: null,
      triggerConfirmation: { netMoveAtr: null, advancingCloseRatio: null, bodyPressure: null,
        latestDirectionalBodyAtr: null, latestDirectionalCloseChangeAtr: null, latestCloseLocation: null },
      components: { compression: null, volumeAcceleration: null, boundaryProximity: null, rangeTightness: null,
        trend: null, rangePosition: null, directionalPressure: null, relativeStrength: null, radarAgreement: null } },
    radar: null,
    marketRegime: { version: "REGIME1", direction: "SHORT", decidedAt: 99, breadthAgrees: null,
      btc4h: { direction: null, reason: null, valid: null, trendSpreadAtr: null, candleCloseTime: 79 },
      btc1h: { direction: null, reason: null, valid: null, trendSpreadAtr: null, candleCloseTime: 79 },
      breadth: { direction: null, total: 5, long: null, short: 4, neutral: null, longRatio: null, shortRatio: 0.8 },
      volatility: { atrPercent: null, percentile: 0.5, regime: null } },
    costs: { modelVersion: null, riskRate: null, feeRoundTripRate: null, slippageRoundTripRate: null,
      spreadRoundTripRate: null, fundingRateCost: null, totalRate: null, totalCostR: 0.2, fundingCostR: null,
      expectedHoldingHours: null, fundingPayments: null, premium: null, fundingDataAvailable: true },
    decision: { selected: false, rejectionReason: "FILTER", counterfactual: null, experimentTier: null,
      eligible: true, rejectionReasons: null, hardRejectionReasons: null, qualityObservations: null },
    plan: entry ? { planHash: "legacy-plan-hash", strategyVersion: "V2_TEST", signalModelVersion: "MODEL_TEST",
      direction: "SHORT", prices: { entry: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5 },
      quantity: 2, takeProfit1Quantity: 1, takeProfit2Quantity: 1, leverage: 10, riskAmountEstimate: 2 }
      : { planHash: null },
    lineage: { candidateId: signalId, radarSnapshotId: null, sourceType: null, marketEventId: null,
      candidateScoreSource: entry ? "PROJECTED_ORIGINAL_UNAVAILABLE" : "CANDIDATE_AT_CAPTURE",
      captureMode: "FORWARD_EVENT_NO_HISTORICAL_BACKFILL" },
    completeness: { missingFields,
      missingReasons: Object.fromEntries(missingFields.map((key) => [key, "NOT_PROVIDED_OR_INVALID_AT_CAPTURE"])),
      timingViolations: [], receivedByDecision: true, freshnessValidated: false },
    snapshotId: entry ? "decision-0543f94b3338c2afa7219e90a407d8884dd5cfb8a91b5e63e96bd9d8bc86c386"
      : "decision-6c3d91807504feb5c636734faa6ad9471b570ecb0d5ea92df99bd8ccafb6d440",
  };
  return { ...body, contentHash: entry ? "bc5c053b3cd2846665dc3cffdb8035a86b7b921ff3e44c75cfe13c1744fff678"
    : "02a9cd77763bea435387b7b2d5cd41c7b6b3eb2acc90b48301bea94d45a0369b" };
}

function rehash(snapshot) {
  const { contentHash, ...body } = snapshot;
  snapshot.contentHash = createHash("sha256").update(canonicalSnapshotJson(body)).digest("hex");
  return snapshot;
}

test("快照单列三种评分/两种边界/三种量能，白名单去除账户、结果与凭据", () => {
  const args = input();
  const s = buildDecisionSnapshot(args);
  assert.equal(verifyDecisionSnapshot(s), true);
  assert.deepEqual(s.scores, { candidateScore: 71, evaluationScore: 60, executionScore: 58 });
  assert.equal(s.preMove.boundaryDistanceAtr, -0.2);
  assert.equal(s.radar.nearestBoundaryAtr, 0.3);
  assert.equal(s.preMove.volumeAcceleration, 1.2);
  assert.equal(s.radar.volumeRatio15m, 0.8);
  assert.equal(s.radar.volumeBuildRatio, 1.4);
  assert.deepEqual(s.radar.opportunitySources, ["RETAINED", "VOLATILITY_COMPRESSION"]);
  assert.equal(s.marketRegime.breadth.shortRatio, 0.8);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.researchPlan.completeness.complete, true);
  assert.equal(s.researchPlan.consistency.riskOrderEntryConsistent, true);
  assert.equal(s.researchPlan.consistency.priceGeometryValid, true);
  assert.equal(s.researchPlan.order.expiresAt, 680);
  assert.equal(s.researchPlan.fixedRiskPlan.targetRiskAmount, 2.5);
  assert.equal(JSON.stringify(s).includes("SECRET"), false);
  assert.equal(Object.hasOwn(s, "result"), false);
  args.candidate.preMove.volumeAcceleration = 99;
  assert.equal(s.preMove.volumeAcceleration, 1.2);
  assert.throws(() => { s.preMove.volumeAcceleration = 2; }, TypeError);
  assert.deepEqual(buildDecisionSnapshot(input()), s);
});

test("修改前固化的V1 SHADOW与ENTRY原对象和原hash可直接验证", () => {
  const shadow = legacyV1Fixture("shadow");
  const entry = legacyV1Fixture("entry");
  assert.equal(verifyDecisionSnapshot(shadow), true);
  assert.equal(verifyDecisionSnapshot(entry), true);
  assert.equal(Object.hasOwn(shadow, "researchPlan"), false);
  assert.deepEqual(entry.plan, {
    planHash: "legacy-plan-hash", strategyVersion: "V2_TEST", signalModelVersion: "MODEL_TEST", direction: "SHORT",
    prices: { entry: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5 }, quantity: 2,
    takeProfit1Quantity: 1, takeProfit2Quantity: 1, leverage: 10, riskAmountEstimate: 2,
  });
  shadow.preMove.volumeAcceleration = 2;
  assert.equal(verifyDecisionSnapshot(shadow), false);
  const legacyCustomId = legacyV1Fixture("shadow");
  legacyCustomId.snapshotId = "decision-custom-v1";
  assert.equal(verifyDecisionSnapshot(rehash(legacyCustomId)), true);
});

test("V1/V2版本边界严格，重算hash也不能跨版本删插researchPlan", () => {
  const current = structuredClone(buildDecisionSnapshot(input()));
  const researchPlan = structuredClone(current.researchPlan);
  delete current.researchPlan;
  current.schemaVersion = 1;
  assert.equal(verifyDecisionSnapshot(rehash(current)), false);

  const legacy = legacyV1Fixture("shadow");
  legacy.researchPlan = researchPlan;
  assert.equal(verifyDecisionSnapshot(rehash(legacy)), false);

  const missing = structuredClone(buildDecisionSnapshot(input()));
  delete missing.researchPlan;
  assert.equal(verifyDecisionSnapshot(rehash(missing)), false);

  const unknown = structuredClone(buildDecisionSnapshot(input()));
  unknown.schemaVersion = 999;
  assert.equal(verifyDecisionSnapshot(rehash(unknown)), false);
});

test("研究计划严格区分缺失与显式零，不把空白/数组/对象/布尔转成零", () => {
  const args = input();
  args.candidate.risk.entry = " ";
  args.candidate.risk.stopLoss = [];
  args.candidate.risk.takeProfit1 = {};
  args.candidate.risk.takeProfit2 = false;
  args.candidate.order.entry = "";
  args.candidate.order.expiresAt = [];
  args.evaluation.fixedRiskPlan.targetQuantity = {};
  const missing = buildDecisionSnapshot(args);
  assert.deepEqual([missing.researchPlan.risk.entry, missing.researchPlan.risk.stopLoss,
    missing.researchPlan.risk.takeProfit1, missing.researchPlan.risk.takeProfit2,
    missing.researchPlan.order.entry, missing.researchPlan.order.expiresAt,
    missing.researchPlan.fixedRiskPlan.targetQuantity], [null, null, null, null, null, null, null]);
  assert.equal(missing.researchPlan.completeness.complete, false);
  assert.ok(missing.researchPlan.completeness.missingInputs.includes("risk.entry"));

  const explicitZeroArgs = input();
  explicitZeroArgs.candidate.risk.entry = 0;
  explicitZeroArgs.candidate.order.entry = 0;
  const explicitZero = buildDecisionSnapshot(explicitZeroArgs);
  assert.equal(explicitZero.researchPlan.risk.entry, 0);
  assert.equal(explicitZero.researchPlan.consistency.priceGeometryValid, false);
  assert.equal(explicitZero.researchPlan.completeness.complete, false);
});

test("研究计划分别保留risk/order入场，异常几何、过期TTL与仓位只记证据不抛错", () => {
  const mismatchArgs = input();
  mismatchArgs.candidate.order.entry = 101;
  mismatchArgs.evaluation.fixedRiskPlan.stopRate = 0.01980198;
  const mismatch = buildDecisionSnapshot(mismatchArgs);
  assert.equal(mismatch.researchPlan.risk.entry, 100);
  assert.equal(mismatch.researchPlan.order.entry, 101);
  assert.equal(mismatch.researchPlan.fixedRiskPlan.stopRate, 0.01980198);
  assert.equal(mismatch.researchPlan.consistency.riskOrderEntryConsistent, false);
  assert.equal(mismatch.researchPlan.completeness.complete, false);

  const oneSidedArgs = input();
  delete oneSidedArgs.candidate.order.entry;
  assert.equal(buildDecisionSnapshot(oneSidedArgs).researchPlan.consistency.riskOrderEntryConsistent, null);

  const invalidArgs = input();
  invalidArgs.candidate.risk.stopLoss = 100;
  invalidArgs.candidate.order.expiresAt = 99;
  invalidArgs.evaluation.fixedRiskPlan.targetQuantity = -1;
  const invalid = buildDecisionSnapshot(invalidArgs);
  assert.deepEqual(invalid.researchPlan.consistency,
    { riskOrderEntryConsistent: true, priceGeometryValid: false, orderFormatValid: true, ttlValid: false, sizingValid: false });
  assert.equal(invalid.researchPlan.completeness.complete, false);
});

test("已知无效风险、未知TTL、未知订单格式与数学矛盾均不得标记完整", () => {
  const invalidRiskArgs = input();
  invalidRiskArgs.candidate.risk.valid = false;
  const invalidRisk = buildDecisionSnapshot(invalidRiskArgs);
  assert.equal(invalidRisk.researchPlan.completeness.complete, false);
  assert.ok(invalidRisk.researchPlan.completeness.invalidInputs.includes("risk.valid"));

  const unknownTimeArgs = input();
  delete unknownTimeArgs.decision.decidedAt;
  const unknownTime = buildDecisionSnapshot(unknownTimeArgs);
  assert.equal(unknownTime.researchPlan.consistency.ttlValid, null);
  assert.equal(unknownTime.researchPlan.completeness.complete, false);
  assert.ok(unknownTime.researchPlan.completeness.missingInputs.includes("decisionTime"));

  const unknownOrderArgs = input();
  unknownOrderArgs.candidate.order.type = "NONSENSE";
  unknownOrderArgs.candidate.order.style = "UNKNOWN";
  const unknownOrder = buildDecisionSnapshot(unknownOrderArgs);
  assert.equal(unknownOrder.researchPlan.consistency.orderFormatValid, false);
  assert.equal(unknownOrder.researchPlan.completeness.complete, false);

  const contradictorySizingArgs = input();
  contradictorySizingArgs.evaluation.fixedRiskPlan.targetRiskAmount = 999;
  const contradictorySizing = buildDecisionSnapshot(contradictorySizingArgs);
  assert.equal(contradictorySizing.researchPlan.consistency.sizingValid, false);
  assert.equal(contradictorySizing.researchPlan.completeness.complete, false);
});

test("研究仓位一致性兼容上游先计算后分字段舍入，不误拒真实纯函数输出", () => {
  for (const options of [
    { equity: 500, targetRiskPercent: 0.5, leverage: 10 },
    { equity: 492.19858835, targetRiskPercent: 0.500049, leverage: 10 },
  ]) {
    const args = input();
    args.candidate.direction = "LONG";
    args.candidate.risk = { ...args.candidate.risk, entry: 100, stopLoss: 99.87654321,
      takeProfit1: 100.2, takeProfit2: 100.4 };
    args.candidate.order.entry = 100;
    args.evaluation.fixedRiskPlan = buildFixedRiskShadowPlan(args.candidate, options);
    const snapshot = buildDecisionSnapshot(args);
    assert.equal(snapshot.researchPlan.fixedRiskPlan.valid, true);
    assert.equal(snapshot.researchPlan.consistency.sizingValid, true);
    assert.equal(snapshot.researchPlan.completeness.complete, true);
  }
});

test("研究计划深复制并冻结快照，但不冻结或回写调用者输入", () => {
  const args = input();
  const snapshot = buildDecisionSnapshot(args);
  const hash = snapshot.contentHash;
  assert.equal(Object.isFrozen(args.candidate), false);
  assert.equal(Object.isFrozen(args.candidate.risk), false);
  args.candidate.risk.entry = 999;
  args.candidate.order.entry = 999;
  args.evaluation.fixedRiskPlan.targetQuantity = 999;
  assert.equal(snapshot.researchPlan.risk.entry, 100);
  assert.equal(snapshot.researchPlan.order.entry, 100);
  assert.equal(snapshot.researchPlan.fixedRiskPlan.targetQuantity, 2.5);
  assert.equal(snapshot.contentHash, hash);
  assert.throws(() => { snapshot.researchPlan.risk.entry = 999; }, TypeError);
});

test("researchPlan递归白名单拒绝凭据、未知字段和错误scalar", () => {
  for (const mutate of [
    (s) => { s.researchPlan.account = { balance: 1 }; },
    (s) => { s.researchPlan.risk.confirmationCode = "SECRET"; },
    (s) => { s.researchPlan.order.result = { pnl: 1 }; },
    (s) => { s.researchPlan.fixedRiskPlan.targetQuantity = {}; },
    (s) => { s.researchPlan.fixedRiskPlan.targetMargin = Infinity; },
    (s) => { s.researchPlan.consistency.ttlValid = "true"; },
  ]) {
    const snapshot = structuredClone(buildDecisionSnapshot(input()));
    mutate(snapshot);
    assert.equal(verifyDecisionSnapshot(rehash(snapshot)), false);
  }
});

test("缺失时间/epoch保持null；K线已关闭不能证明已收到；未来接收明确失败", () => {
  const args = input();
  delete args.candidate.receivedAt;
  delete args.candidate.observedAt;
  delete args.epoch;
  const s = buildDecisionSnapshot(args);
  assert.equal(s.times.upstreamReceivedAt, null);
  assert.equal(s.times.observedAt, null);
  assert.equal(s.versions.epochId, null);
  assert.equal(s.completeness.receivedByDecision, null);
  assert.equal(s.completeness.freshnessValidated, false);
  assert.ok(s.completeness.missingReasons["times.upstreamReceivedAt"]);
  args.candidate.receivedAt = 101;
  const future = buildDecisionSnapshot(args);
  assert.equal(future.completeness.receivedByDecision, false);
  assert.ok(future.completeness.timingViolations.includes("upstreamReceivedAt_AFTER_DECISION"));
});

test("执行快照分开采集/决策/计划时间，不把投影评分认作原始评分", () => {
  const args = input();
  args.candidate.executionSource = "V2_PRODUCTION";
  const executionPlan = { strategyVersion: "EXECUTION_V1", signalModelVersion: "SIGNAL_V1", direction: "SHORT",
    prices: { entry: "100", stopLoss: "101", takeProfit1: "98.5", takeProfit2: "97.5" },
    quantity: "2", takeProfit1Quantity: "1", takeProfit2Quantity: "1", leverage: "10",
    riskAmountEstimate: "2", confirmationCode: "SECRET" };
  const s = buildDecisionSnapshot({ ...args, scope: "ENTRY_PRE_SUBMIT", runId: "run-1", planHash: "hash-1",
    planCreatedAt: 105, plan: executionPlan });
  assert.equal(s.scores.candidateScore, null);
  assert.equal(s.times.captureTime, 110);
  assert.equal(s.times.decisionTime, 100);
  assert.equal(s.times.planCreatedTime, 105);
  assert.equal(s.plan.prices.entry, 100);
  assert.equal(s.plan.planHash, "hash-1");
  assert.deepEqual(s.plan, { planHash: "hash-1", strategyVersion: "EXECUTION_V1", signalModelVersion: "SIGNAL_V1",
    direction: "SHORT", prices: { entry: 100, stopLoss: 101, takeProfit1: 98.5, takeProfit2: 97.5 },
    quantity: 2, takeProfit1Quantity: 1, takeProfit2Quantity: 1, leverage: 10, riskAmountEstimate: 2 });
  assert.equal(s.researchPlan.source, "CANDIDATE_RISK_ORDER_FIXED_RISK_AT_DECISION");
  assert.equal(s.researchPlan.risk.entry, 100);
  assert.equal(s.researchPlan.fixedRiskPlan.targetQuantity, 2.5);
  assert.equal(s.decision.selected, false);
  assert.equal(s.decision.eligible, true);
  assert.equal(verifyDecisionSnapshot(s), true);
  assert.throws(() => buildDecisionSnapshot({ ...args, scope: "ENTRY_PRE_SUBMIT" }), /runId/);
});

test("损坏hash或重算hash后注入非白名单字段仍拒绝", () => {
  const s = structuredClone(buildDecisionSnapshot(input()));
  s.preMove.volumeAcceleration = 99;
  assert.equal(verifyDecisionSnapshot(s), false);
  s.account = { secret: "PRIVATE" };
  const { contentHash, ...body } = s;
  s.contentHash = createHash("sha256").update(canonicalSnapshotJson(body)).digest("hex");
  assert.equal(verifyDecisionSnapshot(s), false);
});

test("即使重算hash，嵌套对象、额外字段、非有限数与错误scalar类型也不能通过schema", () => {
  for (const mutate of [
    (s) => { s.scores.candidateScore = { secret: "PRIVATE" }; },
    (s) => { s.preMove.account = { balance: 1 }; },
    (s) => { s.preMove.volumeAcceleration = Infinity; },
    (s) => { s.preMove.volumeAcceleration = NaN; },
    (s) => { s.scores.candidateScore = "71"; },
  ]) {
    const s = structuredClone(buildDecisionSnapshot(input()));
    mutate(s);
    const { contentHash, ...body } = s;
    s.contentHash = createHash("sha256").update(canonicalSnapshotJson(body)).digest("hex");
    assert.equal(verifyDecisionSnapshot(s), false);
  }
});

test("市场环境嵌套未来时间标记泄漏，缺失未知，funding计划未来时间不算泄漏", () => {
  const args = input();
  args.evaluation.marketRegime = { decidedAt: 101, btc1h: { candleCloseTime: 102 }, btc4h: { candleCloseTime: 103 } };
  args.evaluation.costs.premium = { nextFundingTime: 10000 };
  const s = buildDecisionSnapshot(args);
  assert.equal(verifyDecisionSnapshot(s), true);
  for (const path of ["marketRegime.decidedAt", "marketRegime.btc1h.candleCloseTime", "marketRegime.btc4h.candleCloseTime"]) {
    assert.ok(s.completeness.timingViolations.includes(`${path}_AFTER_DECISION`));
  }
  assert.equal(s.marketRegime.decidedAt, 101);
  assert.equal(s.marketRegime.btc1h.candleCloseTime, 102);
  assert.equal(s.marketRegime.btc4h.candleCloseTime, 103);
  assert.equal(s.costs.premium.nextFundingTime, 10000);
  assert.equal(s.completeness.timingViolations.some((v) => v.includes("Funding")), false);
  args.evaluation.marketRegime = {};
  const unknown = buildDecisionSnapshot(args);
  assert.equal(verifyDecisionSnapshot(unknown), true);
  assert.equal(unknown.marketRegime.decidedAt, null);
  assert.equal(unknown.marketRegime.btc1h.candleCloseTime, null);
  assert.equal(unknown.marketRegime.btc4h.candleCloseTime, null);
  for (const path of ["marketRegime.decidedAt", "marketRegime.btc1h.candleCloseTime", "marketRegime.btc4h.candleCloseTime"]) {
    assert.equal(unknown.completeness.missingReasons[path], "NOT_PROVIDED_OR_INVALID_AT_CAPTURE");
  }
  assert.equal(unknown.completeness.timingViolations.length, 0);
});
