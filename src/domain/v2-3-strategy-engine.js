import { createHash } from "node:crypto";
import { MARKET_RADAR_SCHEMA_REVISION, MARKET_RADAR_VERSION } from "./market-radar.js";
import { analyzePreMove, PRE_MOVE_SIGNAL_VERSION } from "./pre-move-strategy.js";
import {
  buildFixedRiskShadowPlan,
  buildShadowCostEstimate,
  evaluateShadowCandidate,
  SHADOW_STRATEGY_VERSION,
} from "./shadow-v2.js";

export const V23_STRATEGY_CONTRACT_VERSION = "V2_3_STRATEGY_CONTRACT_R1";
export const V23_STRATEGY_SNAPSHOT_METADATA_KEY = "v2_3_strategy_snapshot";
export const V23_LIVE_ADAPTER = "LIVE_DEMO";
export const V23_HISTORICAL_ADAPTER = "HISTORICAL_REPLAY";

const ADAPTERS = new Set([V23_LIVE_ADAPTER, V23_HISTORICAL_ADAPTER]);

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, normalized(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(normalized(value));
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertDecisionTime(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0) throw new TypeError("V2.3快照缺少有效decisionTime");
  return time;
}

function assertClosedSeries(name, candles, decisionTime) {
  if (!Array.isArray(candles)) throw new TypeError(`V2.3快照缺少${name}K线`);
  let previousCloseTime = -Infinity;
  for (const candle of candles) {
    const closeTime = Number(candle?.closeTime);
    if (!Number.isFinite(closeTime)) throw new TypeError(`V2.3 ${name}K线缺少有效closeTime`);
    if (closeTime > decisionTime) throw new Error(`V2_3_LOOKAHEAD_DETECTED: ${name}K线 ${closeTime} 晚于决策时间 ${decisionTime}`);
    if (closeTime <= previousCloseTime) throw new Error(`V2_3_TIME_ORDER_INVALID: ${name}K线未严格按收盘时间升序`);
    previousCloseTime = closeTime;
  }
}

function optionalTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertRadarTime(radar, decisionTime) {
  if (!radar) return;
  for (const [name, value] of [
    ["generatedAt", radar.generatedAt],
    ["moverDataClosedAt", radar.moverDataClosedAt],
  ]) {
    const time = optionalTime(value);
    if (time !== null && time > decisionTime) {
      throw new Error(`V2_3_LOOKAHEAD_DETECTED: radar.${name} ${time} 晚于决策时间 ${decisionTime}`);
    }
  }
}

function snapshotDefinition(config) {
  if (!config?.strategy || !config?.shadowV2 || !config?.marketRadar) {
    throw new TypeError("V2.3策略快照需要完整的strategy、shadowV2和marketRadar配置");
  }
  return {
    contractVersion: V23_STRATEGY_CONTRACT_VERSION,
    signalModelVersion: PRE_MOVE_SIGNAL_VERSION,
    evaluationModelVersion: SHADOW_STRATEGY_VERSION,
    radarModelVersion: config.marketRadar.modelVersion ?? MARKET_RADAR_VERSION,
    radarSchemaRevision: MARKET_RADAR_SCHEMA_REVISION,
    timeSemantics: {
      candlePolicy: "CLOSED_CANDLES_ONLY",
      decisionInterval: config.intervals?.trigger ?? "5m",
      trendInterval: config.intervals?.trend ?? "1h",
      setupInterval: config.intervals?.setup ?? "15m",
      pathInterval: config.intervals?.path ?? "1m",
      futureDataPolicy: "REJECT",
    },
    parameters: {
      strategy: safeClone(config.strategy),
      evaluation: safeClone(config.shadowV2),
      radar: safeClone(config.marketRadar),
      universe: safeClone(config.universe),
      portfolio: safeClone(config.portfolio),
      costs: safeClone(config.costs),
    },
    runtimePolicy: {
      executionStrategySource: config.execution?.strategySource ?? null,
      positionPolicy: config.execution?.positionPolicy ?? null,
      autoExecutionEnabled: Boolean(config.execution?.autoExecutionEnabled),
      orderSubmissionEnabled: Boolean(config.execution?.orderSubmissionEnabled),
    },
  };
}

export function buildV23StrategySnapshot(config, { capturedAt = Date.now() } = {}) {
  const definition = snapshotDefinition(config);
  const snapshot = {
    ...definition,
    fingerprint: fingerprint(definition),
    capturedAt: new Date(assertDecisionTime(capturedAt)).toISOString(),
  };
  return deepFreeze(snapshot);
}

export function analyzeV23SignalSnapshot({
  symbol,
  hourly,
  fifteen,
  five,
  radar = null,
  universeItem = null,
  universeIndex = -1,
  universeSize = 0,
  primarySource = null,
  auxiliaryCheck = null,
  decisionTime = Date.now(),
} = {}, {
  strategyConfig,
  costsConfig = {},
} = {}) {
  if (!strategyConfig) throw new TypeError("V2.3信号快照缺少strategyConfig");
  const time = assertDecisionTime(decisionTime);
  assertClosedSeries("1h", hourly, time);
  assertClosedSeries("15m", fifteen, time);
  assertClosedSeries("5m", five, time);
  assertRadarTime(radar, time);

  const analysis = analyzePreMove({
    symbol,
    hourly,
    fifteen,
    five,
    radar,
    config: strategyConfig,
    now: time,
  });
  const count = Number(universeSize);
  const rankIndex = Number(universeIndex);
  analysis.candidates = analysis.candidates.map((candidate) => {
    const entry = Number(candidate.order?.entry);
    const riskRate = entry > 0 ? Math.abs(entry - candidate.risk.stopLoss) / entry : NaN;
    const estimatedRoundTripRate = 2 * (
      Number(costsConfig.fallbackFeeRate ?? 0.0005)
      + Number(costsConfig.fallbackSlippageRate ?? 0.0002)
    );
    return {
      ...candidate,
      estimatedCostR: riskRate > 0 ? estimatedRoundTripRate / riskRate : Infinity,
      liquidityScore: rankIndex >= 0 && count > 1 ? 5 * (1 - rankIndex / (count - 1)) : 0,
      liquidity: universeItem ? {
        quoteVolume24h: universeItem.quoteVolume24h ?? null,
        spreadBps: universeItem.spreadBps ?? null,
        universeRank: rankIndex + 1,
      } : null,
      marketRadar: radar,
      primarySource,
      auxiliaryCheck,
    };
  });
  if (auxiliaryCheck !== null) analysis.auxiliary = auxiliaryCheck;
  analysis.source = primarySource;
  analysis.strategyContractVersion = V23_STRATEGY_CONTRACT_VERSION;
  analysis.decisionTime = time;
  return analysis;
}

export function evaluateV23CandidateSnapshot({
  candidate,
  marketRegime,
  premium = null,
  equity = 500,
  decisionTime = Date.now(),
} = {}, {
  shadowConfig,
  marketRadarConfig = {},
  costsConfig = {},
  portfolioConfig = {},
} = {}) {
  if (!candidate || !shadowConfig) throw new TypeError("V2.3候选评估缺少candidate或shadowConfig");
  const time = assertDecisionTime(decisionTime);
  assertRadarTime(candidate.marketRadar, time);
  const costEstimate = buildShadowCostEstimate(candidate, {
    feeRate: costsConfig.fallbackFeeRate ?? 0.0005,
    slippageRate: costsConfig.fallbackSlippageRate ?? 0.0002,
    spreadBps: candidate.liquidity?.spreadBps ?? candidate.metrics?.spreadBps ?? 0,
    premium,
    expectedHoldingHours: shadowConfig.expectedHoldingHours,
    now: time,
  });
  const fixedRiskPlan = buildFixedRiskShadowPlan(candidate, {
    equity,
    targetRiskPercent: shadowConfig.targetRiskPercent,
    leverage: portfolioConfig.leverage ?? 10,
  });
  return {
    ...candidate,
    shadowV2: evaluateShadowCandidate(candidate, {
      marketRegime,
      costEstimate,
      fixedRiskPlan,
      config: {
        ...shadowConfig,
        radarRequired: Boolean(marketRadarConfig.enabled && marketRadarConfig.requiredForV2),
        radarModelVersion: marketRadarConfig.modelVersion ?? null,
      },
      now: time,
    }),
  };
}

export function runV23StrategyAdapter({ adapter, snapshot, config } = {}) {
  if (!ADAPTERS.has(adapter)) throw new TypeError("V2.3适配器只能是LIVE_DEMO或HISTORICAL_REPLAY");
  if (!snapshot || !config) throw new TypeError("V2.3适配器缺少snapshot或config");
  const decisionTime = snapshot.decisionTime ?? Date.now();
  const stableSnapshot = { ...snapshot, decisionTime };
  const analysis = analyzeV23SignalSnapshot(stableSnapshot, {
    strategyConfig: config.strategy,
    costsConfig: config.costs,
  });
  const candidates = analysis.candidates.map((candidate) => evaluateV23CandidateSnapshot({
    candidate,
    marketRegime: stableSnapshot.marketRegime,
    premium: stableSnapshot.premium ?? null,
    equity: stableSnapshot.equity ?? config.portfolio.startingEquity,
    decisionTime,
  }, {
    shadowConfig: config.shadowV2,
    marketRadarConfig: config.marketRadar,
    costsConfig: config.costs,
    portfolioConfig: config.portfolio,
  }));
  return {
    adapter,
    contractVersion: V23_STRATEGY_CONTRACT_VERSION,
    decision: { ...analysis, candidates },
  };
}

export function v23DecisionFingerprint(result) {
  const decision = result?.decision ?? result;
  if (!decision) throw new TypeError("缺少可生成指纹的V2.3决策结果");
  return fingerprint(decision);
}
