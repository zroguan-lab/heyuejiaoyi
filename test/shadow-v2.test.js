import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFixedRiskShadowPlan,
  buildShadowCostEstimate,
  evaluateShadowCandidate,
  selectProductionShadowCandidates,
} from "../src/domain/shadow-v2.js";

const candidate = {
  id: "shadow-1",
  symbol: "BTCUSDT",
  strategy: "BREAKOUT",
  direction: "LONG",
  status: "CANDIDATE",
  triggerTime: 1_000,
  order: { entry: 100, style: "ACTIVE_DYNAMIC", expiresAt: 10_000 },
  risk: { entry: 100, stopLoss: 99, takeProfit1: 101.5, takeProfit2: 102.5 },
  metrics: { breakoutDistanceAtr: 0.1, bodyAtr: 0.1, trendSpreadAtr: 2, volumeRatio: 2 },
  liquidityScore: 5,
};

const config = {
  minimumScore: 55,
  coreMinimumScore: 70,
  explorationMinimumScore: 55,
  maxCostR: 0.25,
  maxFundingCostR: 0.1,
  extremeCostR: 0.35,
  extremeFundingCostR: 0.2,
  breakoutMaxDistanceAtr: 0.8,
  breakoutMaxBodyAtr: 1.2,
  breakoutExtremeDistanceAtr: 1.5,
  breakoutExtremeBodyAtr: 2,
  pullbackMaxDepthAtr: 0.6,
  pullbackMaxTriggerDistanceAtr: 0.8,
  pullbackExtremeDepthAtr: 1.5,
  pullbackExtremeTriggerDistanceAtr: 1.5,
};

test("V2 成本先换算成 R 且固定风险仓位不再固定保证金", () => {
  const costs = buildShadowCostEstimate(candidate, {
    feeRate: 0.0005,
    slippageRate: 0.0002,
    spreadBps: 1,
    premium: { lastFundingRate: 0.0001, nextFundingTime: 2_000 },
    expectedHoldingHours: 1,
    now: 1_000,
  });
  const plan = buildFixedRiskShadowPlan(candidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  assert.equal(costs.totalCostR, 0.16);
  assert.equal(plan.targetRiskAmount, 2.5);
  assert.equal(plan.targetMargin, 25);
});

test("V2 独立评分通过时仍硬性禁止订单提交", () => {
  const costs = buildShadowCostEstimate(candidate, {
    feeRate: 0.0002, slippageRate: 0, spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(candidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(candidate, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: costs,
    fixedRiskPlan: plan,
    config,
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.experimentTier, "CORE");
  assert.equal(evaluation.orderSubmissionAllowed, false);
  assert.equal(evaluation.expectedNetR, null);
});

test("V2.1 不用相关性或总风险预算截断不同标的Demo样本", () => {
  const shadowV2 = {
    eligible: true,
    orderSubmissionAllowed: false,
    score: 90,
    fixedRiskPlan: { targetRiskPercent: 0.5 },
  };
  const candidates = [
    { ...candidate, shadowV2 },
    { ...candidate, id: "shadow-2", symbol: "ETHUSDT", triggerTime: 2_000, shadowV2 },
  ];
  const allocation = selectProductionShadowCandidates(candidates, [{ symbol: "SOLUSDT", direction: "LONG", status: "OPEN", shadowRiskPercent: 0.5 }], {
    correlations: { "ETHUSDT:SOLUSDT": 0.9, "BTCUSDT:SOLUSDT": 0.1 },
    minimumScore: 70,
    maxEffectiveCorrelation: 0.75,
    maxCorrelatedPositions: 1,
    maxTotalRiskPercent: 1,
  });
  assert.deepEqual(allocation.selected.map((item) => item.symbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(allocation.rejected.length, 0);
  assert.equal(allocation.fixedPositionLimit, null);
  assert.equal(allocation.correlationLimitEnforced, false);
  assert.equal(allocation.totalRiskLimitEnforced, false);
});

test("V2.1 质量缺陷只扣分和记录观察，不再重复硬拒绝", () => {
  const softCandidate = {
    ...candidate,
    metrics: { breakoutDistanceAtr: 0.9, bodyAtr: 0.2, trendSpreadAtr: 1.5, volumeRatio: 1 },
  };
  const costs = buildShadowCostEstimate(softCandidate, {
    feeRate: 0.0002,
    slippageRate: 0,
    spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(softCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(softCandidate, {
    marketRegime: { direction: "MIXED", breadthAgrees: false },
    costEstimate: costs,
    fixedRiskPlan: plan,
    config,
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.experimentTier, "EXPLORATION");
  assert.equal(evaluation.hardRejectionReasons.length, 0);
  assert.equal(evaluation.qualityObservations.includes("BREAKOUT_OVEREXTENDED"), true);
  assert.equal(evaluation.rejectionReasons.includes("BREAKOUT_OVEREXTENDED"), false);
});

test("V2.1 极端追价仍由安全硬规则拒绝", () => {
  const extremeCandidate = {
    ...candidate,
    metrics: { ...candidate.metrics, breakoutDistanceAtr: 2 },
  };
  const costs = buildShadowCostEstimate(extremeCandidate, {
    feeRate: 0.0002,
    slippageRate: 0,
    spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(extremeCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(extremeCandidate, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: costs,
    fixedRiskPlan: plan,
    config,
  });
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.experimentTier, null);
  assert.equal(evaluation.hardRejectionReasons.includes("BREAKOUT_EXTREME_DISTANCE"), true);
});

test("V2.1 要求同一版雷达快照，雷达冲突只降为探索层而不篡改策略分", () => {
  const costs = buildShadowCostEstimate(candidate, {
    feeRate: 0.0002, slippageRate: 0, spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(candidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const radarConfig = { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R1" };
  const missing = evaluateShadowCandidate(candidate, {
    marketRegime: { direction: "LONG" }, costEstimate: costs, fixedRiskPlan: plan, config: radarConfig,
  });
  assert.equal(missing.hardRejectionReasons.includes("MARKET_RADAR_UNAVAILABLE"), true);

  const conflictCandidate = {
    ...candidate,
    marketRadar: {
      version: "MARKET_RADAR_R1", snapshotId: "radar-1", selected: true,
      radarTier: "CORE", radarScore: 90, bias: "SHORT", marketDirection: "MIXED", overextensionRisk: "LOW",
    },
  };
  const conflict = evaluateShadowCandidate(conflictCandidate, {
    marketRegime: { direction: "LONG" }, costEstimate: costs, fixedRiskPlan: plan, config: radarConfig,
  });
  assert.equal(conflict.score, missing.score);
  assert.equal(conflict.experimentTier, "EXPLORATION");
  assert.equal(conflict.qualityObservations.includes("RADAR_DIRECTION_CONFLICT"), true);
});

test("V2.2排行榜方向与策略方向冲突时硬拒绝，不能把领跌币当顺势多单", () => {
  const moverCandidate = {
    ...candidate,
    marketRadar: {
      version: "MARKET_RADAR_R2_MOVERS", snapshotId: "radar-r2-1", selected: true,
      radarTier: "CORE", radarScore: 88, bias: "SHORT", marketDirection: "MIXED",
      opportunitySources: ["RANK_LOSER"], return1h: -4, moverRank: 2, overextensionRisk: "LOW",
    },
  };
  const costs = buildShadowCostEstimate(moverCandidate, {
    feeRate: 0.0002, slippageRate: 0, spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(moverCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(moverCandidate, {
    marketRegime: { direction: "LONG" },
    costEstimate: costs,
    fixedRiskPlan: plan,
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R2_MOVERS" },
  });
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.hardRejectionReasons.includes("MOVER_DIRECTION_CONFLICT"), true);
});

test("V2.4.3在做多确认完整且存在独立机会来源时允许合格Pre-Move进入探索", () => {
  const preMoveCandidate = {
    ...candidate,
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 0.72,
      volumeAcceleration: 1.35,
      directionalPressure: 0.7,
      triggerConfirmation: {
        latestDirectionalBodyAtr: 0.12,
        latestDirectionalCloseChangeAtr: 0.08,
        latestCloseLocation: 0.72,
      },
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "CORE",
      radarScore: 84,
      bias: "LONG",
      marketDirection: "MIXED",
      volumeRatio15m: 1.25,
      overextensionRisk: "LOW",
      opportunitySources: ["VOLATILITY_COMPRESSION"],
    },
  };
  const costs = buildShadowCostEstimate(preMoveCandidate, {
    feeRate: 0.0002,
    slippageRate: 0,
    spreadBps: 0,
    premium: { lastFundingRate: 0, nextFundingTime: Date.now() + 3_600_000 },
  });
  const plan = buildFixedRiskShadowPlan(preMoveCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(preMoveCandidate, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: costs,
    fixedRiskPlan: plan,
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.scoreModel, "PRE_MOVE_V2_4_3_BOUNDARY_FILTER");
  assert.deepEqual(evaluation.rawPreMoveScores, { explosion: 82, direction: 76 });
  assert.equal(evaluation.hardRejectionReasons.length, 0);
});

test("V2.4.3禁止BOUNDARY_PRESSURE-only独立交易但允许与真实独立来源组合", () => {
  const base = {
    ...candidate,
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 0.72,
      volumeAcceleration: 1.35,
      directionalPressure: 0.7,
      triggerConfirmation: {
        latestDirectionalBodyAtr: 0.12,
        latestDirectionalCloseChangeAtr: 0.08,
        latestCloseLocation: 0.72,
      },
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "CORE",
      radarScore: 84,
      bias: "LONG",
      marketDirection: "MIXED",
      volumeRatio15m: 1.25,
      overextensionRisk: "LOW",
      opportunitySources: ["RETAINED", "BOUNDARY_PRESSURE"],
    },
  };
  const evaluate = (item) => evaluateShadowCandidate(item, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: { totalCostR: 0.1, fundingCostR: 0, fundingDataAvailable: true },
    fixedRiskPlan: buildFixedRiskShadowPlan(item, { equity: 500, targetRiskPercent: 0.5, leverage: 10 }),
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  const boundaryOnly = evaluate(base);
  assert.equal(boundaryOnly.eligible, false);
  assert.deepEqual(boundaryOnly.hardRejectionReasons, ["V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE"]);

  const combined = evaluate({
    ...base,
    marketRadar: { ...base.marketRadar, opportunitySources: ["BOUNDARY_PRESSURE", "VOLATILITY_COMPRESSION"] },
  });
  assert.equal(combined.eligible, true);
  assert.equal(combined.hardRejectionReasons.includes("V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE"), false);
});

test("V2.4.2仅RETAINED来源保留研究上下文但不得获得交易资格", () => {
  const retainedOnly = {
    ...candidate,
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 0.72,
      volumeAcceleration: 1.35,
      directionalPressure: 0.7,
      triggerConfirmation: {
        latestDirectionalBodyAtr: 0.12,
        latestDirectionalCloseChangeAtr: 0.08,
        latestCloseLocation: 0.72,
      },
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "CORE",
      radarScore: 84,
      bias: "LONG",
      marketDirection: "MIXED",
      volumeRatio15m: 1.25,
      overextensionRisk: "LOW",
      opportunitySources: ["RETAINED"],
    },
  };
  const evaluate = (item) => evaluateShadowCandidate(item, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: { totalCostR: 0.1, fundingCostR: 0, fundingDataAvailable: true },
    fixedRiskPlan: buildFixedRiskShadowPlan(item, { equity: 500, targetRiskPercent: 0.5, leverage: 10 }),
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  const rejected = evaluate(retainedOnly);
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.hardRejectionReasons.includes("V2_4_2_RETAINED_ONLY_NOT_TRADEABLE"), true);

  const withIndependentSource = {
    ...retainedOnly,
    marketRadar: {
      ...retainedOnly.marketRadar,
      opportunitySources: ["RETAINED", "VOLATILITY_COMPRESSION"],
    },
  };
  const accepted = evaluate(withIndependentSource);
  assert.equal(accepted.eligible, true);
  assert.equal(accepted.hardRejectionReasons.includes("V2_4_2_RETAINED_ONLY_NOT_TRADEABLE"), false);
});

test("V2.4.2成本门只影响Demo提升，高成本信号仍保留反事实研究交易", () => {
  const costlyCandidate = {
    ...candidate,
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 0.72,
      volumeAcceleration: 1.35,
      directionalPressure: 0.7,
      triggerConfirmation: {
        latestDirectionalBodyAtr: 0.12,
        latestDirectionalCloseChangeAtr: 0.08,
        latestCloseLocation: 0.72,
      },
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "CORE",
      radarScore: 84,
      bias: "LONG",
      marketDirection: "MIXED",
      volumeRatio15m: 1.25,
      overextensionRisk: "LOW",
      opportunitySources: ["VOLATILITY_COMPRESSION"],
    },
  };
  const plan = buildFixedRiskShadowPlan(costlyCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 });
  const evaluation = evaluateShadowCandidate(costlyCandidate, {
    marketRegime: { direction: "LONG", breadthAgrees: true },
    costEstimate: { totalCostR: 0.25, fundingCostR: 0, fundingDataAvailable: true },
    fixedRiskPlan: plan,
    config: { ...config, maxCostR: 0.2, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.qualityObservations.includes("COST_R_ABOVE_CORE_BUDGET"), true);
  assert.equal(evaluation.hardRejectionReasons.length, 0);
  const allocation = selectProductionShadowCandidates([{ ...costlyCandidate, shadowV2: evaluation }], [], { minimumScore: 55 });
  assert.equal(allocation.selected.length, 1);
});

test("V2.4.2保留未确认LONG研究记录但禁止进入执行选择", () => {
  const weakLong = {
    ...candidate,
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 1.08,
      volumeAcceleration: 0.8,
      directionalPressure: 0.4,
      triggerConfirmation: {
        latestDirectionalBodyAtr: -0.05,
        latestDirectionalCloseChangeAtr: -0.03,
        latestCloseLocation: 0.3,
      },
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "EXPLORATION",
      radarScore: 70,
      bias: "NEUTRAL",
      marketDirection: "MIXED",
      volumeRatio15m: 0.6,
      overextensionRisk: "LOW",
      opportunitySources: ["VOLATILITY_COMPRESSION"],
    },
  };
  const evaluation = evaluateShadowCandidate(weakLong, {
    marketRegime: { direction: "MIXED", breadthAgrees: false },
    costEstimate: { totalCostR: 0.1, fundingCostR: 0, fundingDataAvailable: true },
    fixedRiskPlan: buildFixedRiskShadowPlan(weakLong, { equity: 500, targetRiskPercent: 0.5, leverage: 10 }),
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  assert.equal(evaluation.eligible, false);
  assert.equal(evaluation.orderSubmissionAllowed, false);
  assert.equal(evaluation.hardRejectionReasons.includes("V2_4_2_LONG_RADAR_NOT_CONFIRMED"), true);
  assert.equal(evaluation.hardRejectionReasons.includes("V2_4_2_LONG_VOLUME_NOT_CONFIRMED"), true);
  assert.equal(evaluation.hardRejectionReasons.includes("V2_4_2_LONG_COMPRESSION_NOT_CONFIRMED"), true);
  assert.equal(evaluation.hardRejectionReasons.includes("V2_4_2_LONG_5M_TRIGGER_NOT_CONFIRMED"), true);
  const allocation = selectProductionShadowCandidates([{ ...weakLong, shadowV2: evaluation }], [], { minimumScore: 55 });
  assert.equal(allocation.selected.length, 0);
  assert.equal(allocation.rejected.length, 1);
});

test("V2.4.2的LONG确认闸门不改变SHORT准入", () => {
  const shortCandidate = {
    ...candidate,
    direction: "SHORT",
    action: "SELL",
    strategy: "PRE_BREAKOUT",
    preMove: {
      explosionScore: 82,
      directionScore: 76,
      compressionRatio: 1.08,
      volumeAcceleration: 0.8,
      directionalPressure: 0.4,
      alreadyBroken: false,
    },
    marketRadar: {
      version: "MARKET_RADAR_R3_PREMOVE",
      selected: true,
      radarTier: "EXPLORATION",
      radarScore: 75,
      bias: "SHORT",
      marketDirection: "MIXED",
      volumeRatio15m: 0.6,
      overextensionRisk: "LOW",
      opportunitySources: ["RANK_LOSER"],
    },
  };
  const evaluation = evaluateShadowCandidate(shortCandidate, {
    marketRegime: { direction: "MIXED", breadthAgrees: false },
    costEstimate: { totalCostR: 0.1, fundingCostR: 0, fundingDataAvailable: true },
    fixedRiskPlan: buildFixedRiskShadowPlan(shortCandidate, { equity: 500, targetRiskPercent: 0.5, leverage: 10 }),
    config: { ...config, radarRequired: true, radarModelVersion: "MARKET_RADAR_R3_PREMOVE" },
  });
  assert.equal(evaluation.eligible, true);
  assert.equal(evaluation.hardRejectionReasons.some((reason) => reason.startsWith("V2_4_2_LONG_")), false);
});
