import { regimeDirectionScore } from "./market-regime.js";

export const SHADOW_STRATEGY_VERSION = "PRE_MOVE_1H_15M_5M_V2_4_1_LONG_CONFIRM";
export const V2_1_CORE_TIER = "CORE";
export const V2_1_EXPLORATION_TIER = "EXPLORATION";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

export function buildShadowCostEstimate(candidate, {
  feeRate = 0.0005,
  slippageRate = 0.0002,
  spreadBps = 0,
  premium = null,
  expectedHoldingHours = 12,
  now = Date.now(),
} = {}) {
  const entry = Number(candidate?.order?.entry ?? candidate?.risk?.entry);
  const stop = Number(candidate?.risk?.stopLoss);
  const riskRate = entry > 0 ? Math.abs(entry - stop) / entry : NaN;
  const active = candidate?.order?.style === "ACTIVE_DYNAMIC";
  const feeRoundTripRate = 2 * feeRate;
  const slippageRoundTripRate = active ? 2 * slippageRate : slippageRate;
  const spreadRoundTripRate = Math.max(0, Number(spreadBps) || 0) / 10_000;
  const fundingRate = Number(premium?.lastFundingRate);
  const nextFundingTime = Number(premium?.nextFundingTime);
  const expectedEnd = now + expectedHoldingHours * 3_600_000;
  const crossesFunding = Number.isFinite(nextFundingTime) && nextFundingTime >= now && nextFundingTime <= expectedEnd;
  const fundingPayments = crossesFunding ? Math.max(1, Math.floor((expectedEnd - nextFundingTime) / (8 * 3_600_000)) + 1) : 0;
  const directionSign = candidate?.direction === "LONG" ? 1 : -1;
  const fundingRateCost = Number.isFinite(fundingRate) ? Math.max(0, directionSign * fundingRate * fundingPayments) : 0;
  const totalRate = feeRoundTripRate + slippageRoundTripRate + spreadRoundTripRate + fundingRateCost;
  return {
    modelVersion: "PRE_TRADE_COST_V1",
    riskRate: round(riskRate, 8),
    feeRoundTripRate: round(feeRoundTripRate, 8),
    slippageRoundTripRate: round(slippageRoundTripRate, 8),
    spreadRoundTripRate: round(spreadRoundTripRate, 8),
    fundingRateCost: round(fundingRateCost, 8),
    totalRate: round(totalRate, 8),
    totalCostR: riskRate > 0 ? round(totalRate / riskRate, 4) : null,
    fundingCostR: riskRate > 0 ? round(fundingRateCost / riskRate, 4) : null,
    premium: premium ? {
      markPrice: Number.isFinite(Number(premium.markPrice)) ? Number(premium.markPrice) : null,
      lastFundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
      nextFundingTime: Number.isFinite(nextFundingTime) ? nextFundingTime : null,
    } : null,
    expectedHoldingHours,
    fundingPayments,
    fundingDataAvailable: Boolean(premium && Number.isFinite(fundingRate) && Number.isFinite(nextFundingTime)),
  };
}

export function buildFixedRiskShadowPlan(candidate, {
  equity = 500,
  targetRiskPercent = 0.5,
  leverage = 10,
} = {}) {
  const entry = Number(candidate?.order?.entry ?? candidate?.risk?.entry);
  const stop = Number(candidate?.risk?.stopLoss);
  const stopRate = entry > 0 ? Math.abs(entry - stop) / entry : NaN;
  const targetRiskAmount = equity * targetRiskPercent / 100;
  const targetNotional = stopRate > 0 ? targetRiskAmount / stopRate : NaN;
  return {
    modelVersion: "FIXED_RISK_V1",
    equity: round(equity, 4),
    targetRiskPercent: round(targetRiskPercent, 4),
    targetRiskAmount: round(targetRiskAmount, 8),
    stopRate: round(stopRate, 8),
    targetNotional: round(targetNotional, 8),
    targetMargin: Number.isFinite(targetNotional) && leverage > 0 ? round(targetNotional / leverage, 8) : null,
    targetQuantity: Number.isFinite(targetNotional) && entry > 0 ? round(targetNotional / entry, 12) : null,
    leverage,
    valid: Number.isFinite(targetNotional) && targetNotional > 0,
  };
}

function locationScore(candidate, config) {
  const metrics = candidate.metrics ?? {};
  if (candidate.strategy === "BREAKOUT") {
    const distance = Number(metrics.breakoutDistanceAtr);
    const body = Number(metrics.bodyAtr);
    if (!Number.isFinite(distance) || !Number.isFinite(body)) return 0;
    return Math.round(25 * clamp(1 - (distance / (config.breakoutMaxDistanceAtr * 1.25) + body / (config.breakoutMaxBodyAtr * 1.25)) / 2, 0, 1));
  }
  const depth = Number(metrics.pullbackDepthAtr);
  const trigger = Number(metrics.triggerDistanceAtr);
  if (!Number.isFinite(depth) || !Number.isFinite(trigger)) return 0;
  return Math.round(25 * clamp(1 - (depth + trigger) / 2, 0, 1));
}

function evaluatePreMoveCandidate(candidate, { marketRegime, costEstimate, fixedRiskPlan, config, now }) {
  const hardRejectionReasons = [];
  const qualityObservations = [];
  const marketRadar = candidate.marketRadar ?? null;
  const rawExplosionScore = Number(candidate.preMove?.explosionScore);
  const rawDirectionScore = Number(candidate.preMove?.directionScore);
  const totalCostR = Number(costEstimate?.totalCostR);
  const fundingCostR = Number(costEstimate?.fundingCostR);
  const extremeCostR = Number(config.extremeCostR ?? Math.max(config.maxCostR * 1.75, 0.35));
  const extremeFundingCostR = Number(config.extremeFundingCostR ?? Math.max(config.maxFundingCostR * 2, 0.2));

  if (!marketRegime) hardRejectionReasons.push("MARKET_REGIME_UNAVAILABLE");
  if (config.radarRequired) {
    if (!marketRadar) hardRejectionReasons.push("MARKET_RADAR_UNAVAILABLE");
    else if (marketRadar.version !== config.radarModelVersion || marketRadar.selected !== true) {
      hardRejectionReasons.push("MARKET_RADAR_CONTEXT_INVALID");
    }
  }
  if (!Number.isFinite(rawExplosionScore) || !Number.isFinite(rawDirectionScore)) hardRejectionReasons.push("PRE_MOVE_SCORE_UNAVAILABLE");
  if (Number.isFinite(rawExplosionScore) && rawExplosionScore < Number(config.preMoveHardMinimumExplosionScore ?? 35)) {
    hardRejectionReasons.push("PRE_MOVE_EXPLOSION_TOO_WEAK");
  }
  if (Number.isFinite(rawDirectionScore) && rawDirectionScore < Number(config.preMoveHardMinimumDirectionScore ?? 42)) {
    hardRejectionReasons.push("PRE_MOVE_DIRECTION_TOO_WEAK");
  }
  if (candidate.preMove?.alreadyBroken === true) hardRejectionReasons.push("PRE_MOVE_ALREADY_BROKEN");
  if (marketRadar?.bias && marketRadar.bias !== "NEUTRAL" && marketRadar.bias !== candidate.direction) {
    qualityObservations.push("RADAR_DIRECTION_CONFLICT");
  }
  if (marketRadar?.marketDirection && marketRadar.marketDirection !== "MIXED" && marketRadar.marketDirection !== candidate.direction) {
    qualityObservations.push("RADAR_MARKET_CONFLICT");
  }
  if (marketRegime && marketRegime.direction !== "MIXED" && marketRegime.direction !== candidate.direction) {
    qualityObservations.push("REGIME_CONFLICT");
  }
  if (Number(candidate.preMove?.compressionRatio) > 1) qualityObservations.push("COMPRESSION_WEAKENING");
  if (Number(candidate.preMove?.volumeAcceleration) < 1) qualityObservations.push("VOLUME_NOT_YET_EXPANDING");
  if (Number.isFinite(totalCostR) && totalCostR > config.maxCostR) qualityObservations.push("COST_R_ABOVE_CORE_BUDGET");
  if (Number.isFinite(fundingCostR) && fundingCostR > config.maxFundingCostR) qualityObservations.push("FUNDING_R_ABOVE_CORE_BUDGET");

  if (!costEstimate?.fundingDataAvailable) hardRejectionReasons.push("FUNDING_DATA_UNAVAILABLE");
  if (!Number.isFinite(totalCostR)) hardRejectionReasons.push("COST_R_UNAVAILABLE");
  else if (totalCostR > extremeCostR) hardRejectionReasons.push("COST_R_EXTREME");
  if (Number.isFinite(fundingCostR) && fundingCostR > extremeFundingCostR) hardRejectionReasons.push("FUNDING_R_EXTREME");
  if (!fixedRiskPlan?.valid) hardRejectionReasons.push("INVALID_FIXED_RISK_PLAN");

  if (candidate.direction === "LONG") {
    const minimumVolumeRatio15m = Number(config.longMinimumVolumeRatio15m ?? 1);
    const minimumVolumeAcceleration = Number(config.longMinimumVolumeAcceleration ?? 1);
    const maximumCompressionRatio = Number(config.longMaximumCompressionRatio ?? 1);
    const minimumDirectionalPressure = Number(config.longMinimumDirectionalPressure ?? 0.55);
    const minimumLatestBodyAtr = Number(config.longMinimumLatestBodyAtr ?? 0.05);
    const minimumLatestCloseChangeAtr = Number(config.longMinimumLatestCloseChangeAtr ?? 0);
    const minimumLatestCloseLocation = Number(config.longMinimumLatestCloseLocation ?? 0.5);
    const volumeRatio15m = Number(marketRadar?.volumeRatio15m);
    const trigger = candidate.preMove?.triggerConfirmation ?? {};
    if (marketRadar?.bias !== "LONG") hardRejectionReasons.push("V2_4_1_LONG_RADAR_NOT_CONFIRMED");
    if (marketRadar?.marketDirection === "SHORT" || marketRegime?.direction === "SHORT") {
      hardRejectionReasons.push("V2_4_1_LONG_MARKET_DIRECTION_CONFLICT");
    }
    if (!Number.isFinite(volumeRatio15m) || volumeRatio15m < minimumVolumeRatio15m
      || !Number.isFinite(Number(candidate.preMove?.volumeAcceleration))
      || Number(candidate.preMove.volumeAcceleration) < minimumVolumeAcceleration) {
      hardRejectionReasons.push("V2_4_1_LONG_VOLUME_NOT_CONFIRMED");
    }
    if (!Number.isFinite(Number(candidate.preMove?.compressionRatio))
      || Number(candidate.preMove.compressionRatio) > maximumCompressionRatio) {
      hardRejectionReasons.push("V2_4_1_LONG_COMPRESSION_NOT_CONFIRMED");
    }
    if (!Number.isFinite(Number(candidate.preMove?.directionalPressure))
      || Number(candidate.preMove.directionalPressure) < minimumDirectionalPressure
      || !Number.isFinite(Number(trigger.latestDirectionalBodyAtr))
      || Number(trigger.latestDirectionalBodyAtr) < minimumLatestBodyAtr
      || !Number.isFinite(Number(trigger.latestDirectionalCloseChangeAtr))
      || Number(trigger.latestDirectionalCloseChangeAtr) <= minimumLatestCloseChangeAtr
      || !Number.isFinite(Number(trigger.latestCloseLocation))
      || Number(trigger.latestCloseLocation) < minimumLatestCloseLocation) {
      hardRejectionReasons.push("V2_4_1_LONG_5M_TRIGGER_NOT_CONFIRMED");
    }
  }

  const explosion = Math.round(clamp(rawExplosionScore / 100, 0, 1) * 35);
  const direction = Math.round(clamp(rawDirectionScore / 100, 0, 1) * 25);
  const regime = Math.round(regimeDirectionScore(candidate.direction, marketRegime) / 2);
  const cost = Number.isFinite(totalCostR) ? Math.round(10 * clamp(1 - totalCostR / config.maxCostR, 0, 1)) : 0;
  const liquidity = Math.round(clamp((Number(candidate.liquidityScore) || 0) / 5, 0, 1) * 10);
  const radar = Math.round(clamp((Number(marketRadar?.radarScore) || 0) / 100, 0, 1) * 10);
  const score = explosion + direction + regime + cost + liquidity + radar;
  const coreMinimumScore = Number(config.coreMinimumScore ?? config.minimumScore ?? 70);
  const explorationMinimumScore = Number(config.explorationMinimumScore ?? Math.min(coreMinimumScore, 55));
  const radarCoreEligible = !config.radarRequired || (
    marketRadar?.radarTier === "CORE"
    && marketRadar?.overextensionRisk !== "HIGH"
    && !qualityObservations.includes("RADAR_DIRECTION_CONFLICT")
    && !qualityObservations.includes("RADAR_MARKET_CONFLICT")
  );
  let experimentTier = null;
  if (hardRejectionReasons.length === 0 && score >= coreMinimumScore && radarCoreEligible) experimentTier = V2_1_CORE_TIER;
  else if (hardRejectionReasons.length === 0 && score >= explorationMinimumScore) experimentTier = V2_1_EXPLORATION_TIER;
  const rejectionReasons = [...hardRejectionReasons];
  if (hardRejectionReasons.length === 0 && !experimentTier) rejectionReasons.push("V2_4_1_SCORE_BELOW_EXPLORATION_THRESHOLD");
  return {
    strategyVersion: SHADOW_STRATEGY_VERSION,
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    score,
    scoreModel: "PRE_MOVE_V2_4_1_LONG_CONFIRM",
    eligible: experimentTier !== null,
    experimentTier,
    coreMinimumScore,
    explorationMinimumScore,
    rejectionReasons,
    hardRejectionReasons,
    qualityObservations,
    components: { explosion, direction, regime, cost, liquidity, radar },
    rawPreMoveScores: { explosion: rawExplosionScore, direction: rawDirectionScore },
    marketRadar,
    marketRegime,
    costs: costEstimate,
    fixedRiskPlan,
    edgeCalibration: "UNCALIBRATED",
    expectedNetR: null,
    evaluatedAt: now,
  };
}

export function evaluateShadowCandidate(candidate, {
  marketRegime,
  costEstimate,
  fixedRiskPlan,
  config,
  now = Date.now(),
} = {}) {
  if (!candidate || !config) throw new TypeError("V2 影子评估缺少候选或配置");
  if (!Number.isFinite(now) || now < 0) throw new TypeError("V2候选评估需要有效的now时间");
  if (candidate.strategy === "PRE_BREAKOUT") {
    return evaluatePreMoveCandidate(candidate, { marketRegime, costEstimate, fixedRiskPlan, config, now });
  }
  const hardRejectionReasons = [];
  const qualityObservations = [];
  const marketRadar = candidate.marketRadar ?? null;
  const regime = regimeDirectionScore(candidate.direction, marketRegime);
  const location = locationScore(candidate, config);
  const trend = Math.round(clamp(Number(candidate.metrics?.trendSpreadAtr) || 0, 0, 2) / 2 * 20);
  const volumeQuality = clamp((Number(candidate.metrics?.volumeRatio) || 0) / 2, 0, 1);
  const confirmation = candidate.strategy === "BREAKOUT"
    ? Math.round(volumeQuality * 15)
    : Math.round((volumeQuality * 0.5 + clamp(1 - (Number(candidate.metrics?.triggerDistanceAtr) || 0), 0, 1) * 0.5) * 15);
  const totalCostR = Number(costEstimate?.totalCostR);
  const fundingCostR = Number(costEstimate?.fundingCostR);
  const cost = Number.isFinite(totalCostR) ? Math.round(10 * clamp(1 - totalCostR / config.maxCostR, 0, 1)) : 0;
  const liquidity = Math.round(clamp((Number(candidate.liquidityScore) || 0) / 5, 0, 1) * 10);

  const breakoutDistanceAtr = Number(candidate.metrics?.breakoutDistanceAtr);
  const breakoutBodyAtr = Number(candidate.metrics?.bodyAtr);
  const pullbackDepthAtr = Number(candidate.metrics?.pullbackDepthAtr);
  const pullbackTriggerDistanceAtr = Number(candidate.metrics?.triggerDistanceAtr);
  const extremeBreakoutDistanceAtr = Number(config.breakoutExtremeDistanceAtr ?? Math.max(config.breakoutMaxDistanceAtr * 2, 1.5));
  const extremeBreakoutBodyAtr = Number(config.breakoutExtremeBodyAtr ?? Math.max(config.breakoutMaxBodyAtr * 1.5, 2));
  const extremePullbackDepthAtr = Number(config.pullbackExtremeDepthAtr ?? Math.max(config.pullbackMaxDepthAtr * 2, 1.5));
  const extremePullbackTriggerDistanceAtr = Number(config.pullbackExtremeTriggerDistanceAtr ?? Math.max(config.pullbackMaxTriggerDistanceAtr * 1.5, 1.5));
  const extremeCostR = Number(config.extremeCostR ?? Math.max(config.maxCostR * 1.75, 0.35));
  const extremeFundingCostR = Number(config.extremeFundingCostR ?? Math.max(config.maxFundingCostR * 2, 0.2));

  if (!marketRegime) hardRejectionReasons.push("MARKET_REGIME_UNAVAILABLE");
  if (config.radarRequired) {
    if (!marketRadar) hardRejectionReasons.push("MARKET_RADAR_UNAVAILABLE");
    else if (marketRadar.version !== config.radarModelVersion || marketRadar.selected !== true) {
      hardRejectionReasons.push("MARKET_RADAR_CONTEXT_INVALID");
    }
  }
  if (marketRadar?.bias && marketRadar.bias !== "NEUTRAL" && marketRadar.bias !== candidate.direction) {
    if (marketRadar.version === "MARKET_RADAR_R2_MOVERS") hardRejectionReasons.push("MOVER_DIRECTION_CONFLICT");
    else qualityObservations.push("RADAR_DIRECTION_CONFLICT");
  }
  if (marketRadar?.marketDirection && marketRadar.marketDirection !== "MIXED" && marketRadar.marketDirection !== candidate.direction) {
    qualityObservations.push("RADAR_MARKET_CONFLICT");
  }
  if (marketRadar?.overextensionRisk === "HIGH") qualityObservations.push("RADAR_OVEREXTENDED");
  if (marketRegime && marketRegime.direction !== "MIXED" && marketRegime.direction !== candidate.direction) qualityObservations.push("REGIME_CONFLICT");
  if (candidate.strategy === "BREAKOUT" && breakoutDistanceAtr > config.breakoutMaxDistanceAtr) qualityObservations.push("BREAKOUT_OVEREXTENDED");
  if (candidate.strategy === "BREAKOUT" && breakoutBodyAtr > config.breakoutMaxBodyAtr) qualityObservations.push("BREAKOUT_BODY_OVEREXTENDED");
  if (candidate.strategy === "PULLBACK" && pullbackDepthAtr > config.pullbackMaxDepthAtr) qualityObservations.push("PULLBACK_TOO_DEEP");
  if (candidate.strategy === "PULLBACK" && pullbackTriggerDistanceAtr > config.pullbackMaxTriggerDistanceAtr) qualityObservations.push("PULLBACK_TRIGGER_OVEREXTENDED");
  if (Number.isFinite(totalCostR) && totalCostR > config.maxCostR) qualityObservations.push("COST_R_ABOVE_CORE_BUDGET");
  if (Number.isFinite(fundingCostR) && fundingCostR > config.maxFundingCostR) qualityObservations.push("FUNDING_R_ABOVE_CORE_BUDGET");

  if (candidate.strategy === "BREAKOUT" && (!Number.isFinite(breakoutDistanceAtr) || !Number.isFinite(breakoutBodyAtr))) hardRejectionReasons.push("BREAKOUT_LOCATION_DATA_INVALID");
  if (candidate.strategy === "PULLBACK" && (!Number.isFinite(pullbackDepthAtr) || !Number.isFinite(pullbackTriggerDistanceAtr))) hardRejectionReasons.push("PULLBACK_LOCATION_DATA_INVALID");
  if (candidate.strategy === "BREAKOUT" && breakoutDistanceAtr > extremeBreakoutDistanceAtr) hardRejectionReasons.push("BREAKOUT_EXTREME_DISTANCE");
  if (candidate.strategy === "BREAKOUT" && breakoutBodyAtr > extremeBreakoutBodyAtr) hardRejectionReasons.push("BREAKOUT_EXTREME_BODY");
  if (candidate.strategy === "PULLBACK" && pullbackDepthAtr > extremePullbackDepthAtr) hardRejectionReasons.push("PULLBACK_EXTREME_DEPTH");
  if (candidate.strategy === "PULLBACK" && pullbackTriggerDistanceAtr > extremePullbackTriggerDistanceAtr) hardRejectionReasons.push("PULLBACK_EXTREME_TRIGGER_DISTANCE");
  if (!costEstimate?.fundingDataAvailable) hardRejectionReasons.push("FUNDING_DATA_UNAVAILABLE");
  if (!Number.isFinite(totalCostR)) hardRejectionReasons.push("COST_R_UNAVAILABLE");
  else if (totalCostR > extremeCostR) hardRejectionReasons.push("COST_R_EXTREME");
  if (Number.isFinite(fundingCostR) && fundingCostR > extremeFundingCostR) hardRejectionReasons.push("FUNDING_R_EXTREME");
  if (!fixedRiskPlan?.valid) hardRejectionReasons.push("INVALID_FIXED_RISK_PLAN");
  const score = regime + location + trend + confirmation + cost + liquidity;
  const coreMinimumScore = Number(config.coreMinimumScore ?? config.minimumScore ?? 70);
  const explorationMinimumScore = Number(config.explorationMinimumScore ?? Math.min(coreMinimumScore, 55));
  let experimentTier = null;
  const radarCoreEligible = !config.radarRequired || (
    marketRadar?.radarTier === "CORE"
    && marketRadar?.overextensionRisk !== "HIGH"
    && !qualityObservations.includes("RADAR_DIRECTION_CONFLICT")
    && !qualityObservations.includes("RADAR_MARKET_CONFLICT")
  );
  if (hardRejectionReasons.length === 0 && score >= coreMinimumScore && radarCoreEligible) experimentTier = V2_1_CORE_TIER;
  else if (hardRejectionReasons.length === 0 && score >= explorationMinimumScore) experimentTier = V2_1_EXPLORATION_TIER;
  const rejectionReasons = [...hardRejectionReasons];
  if (hardRejectionReasons.length === 0 && !experimentTier) rejectionReasons.push("V2_2_SCORE_BELOW_EXPLORATION_THRESHOLD");
  const eligible = experimentTier !== null;
  return {
    strategyVersion: SHADOW_STRATEGY_VERSION,
    mode: "SHADOW_ONLY",
    orderSubmissionAllowed: false,
    score,
    scoreModel: candidate.strategy === "BREAKOUT" ? "BREAKOUT_V2_2_MOVERS" : "PULLBACK_V2_2_MOVERS",
    eligible,
    experimentTier,
    coreMinimumScore,
    explorationMinimumScore,
    rejectionReasons,
    hardRejectionReasons,
    qualityObservations,
    components: { regime, location, trend, confirmation, cost, liquidity },
    marketRadar,
    marketRegime,
    costs: costEstimate,
    fixedRiskPlan,
    edgeCalibration: "UNCALIBRATED",
    expectedNetR: null,
    evaluatedAt: now,
  };
}

export function selectProductionShadowCandidates(candidates, activeTrades = [], {
  minimumScore = 55,
} = {}) {
  const active = activeTrades.filter((trade) => ["ENTRY_PENDING", "OPEN", "TP1_FILLED"].includes(trade.status));
  const occupied = new Set(active.map((trade) => trade.symbol));
  const ranked = [...candidates].sort((a, b) => Number(b.shadowV2?.score ?? -Infinity) - Number(a.shadowV2?.score ?? -Infinity) || a.triggerTime - b.triggerTime);
  const selected = [];
  const rejected = [];
  let totalRisk = active.reduce((sum, trade) => sum + Number(trade.shadowRiskPercent ?? 0), 0);
  for (const candidate of ranked) {
    const shadow = candidate.shadowV2;
    let reason = null;
    if (!shadow?.eligible || shadow?.orderSubmissionAllowed !== false) reason = shadow?.rejectionReasons?.[0] ?? "V2_NOT_ELIGIBLE";
    else if (Number(shadow.score) < minimumScore) reason = "V2_SCORE_BELOW_THRESHOLD";
    else if (occupied.has(candidate.symbol)) reason = "SHADOW_SYMBOL_ALREADY_ACTIVE";
    const riskPercent = Number(shadow?.fixedRiskPlan?.targetRiskPercent ?? 0);
    if (reason) {
      rejected.push({ candidate, reason });
      continue;
    }
    selected.push(candidate);
    occupied.add(candidate.symbol);
    totalRisk += riskPercent;
  }
  return {
    selected,
    rejected,
    selectionMode: "V2_4_1_PREMOVE_LONG_CONFIRMED_ALL_ELIGIBLE",
    totalRiskPercent: round(totalRisk, 4),
    fixedPositionLimit: null,
    correlationLimitEnforced: false,
    totalRiskLimitEnforced: false,
  };
}
