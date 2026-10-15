import { createHash } from "node:crypto";
import {
  analyzeV23SignalSnapshot,
  buildV23StrategySnapshot,
  evaluateV23CandidateSnapshot,
} from "./v2-3-strategy-engine.js";

export const V24_STRATEGY_CONTRACT_VERSION = "V2_4_1_STRATEGY_CONTRACT_R1";
export const V24_STRATEGY_SNAPSHOT_METADATA_KEY = "v2_4_strategy_snapshot";
export const V24_LIVE_ADAPTER = "LIVE_DEMO";
export const V24_HISTORICAL_ADAPTER = "HISTORICAL_REPLAY";

const ADAPTERS = new Set([V24_LIVE_ADAPTER, V24_HISTORICAL_ADAPTER]);

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

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized(value))).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildV24StrategySnapshot(config, { capturedAt = Date.now() } = {}) {
  const legacySnapshot = buildV23StrategySnapshot(config, { capturedAt });
  const { fingerprint: _legacyFingerprint, capturedAt: captured, ...legacyDefinition } = legacySnapshot;
  const definition = {
    ...structuredClone(legacyDefinition),
    contractVersion: V24_STRATEGY_CONTRACT_VERSION,
  };
  return deepFreeze({
    ...definition,
    fingerprint: fingerprint(definition),
    capturedAt: captured,
  });
}

export function analyzeV24SignalSnapshot(snapshot, options) {
  const analysis = analyzeV23SignalSnapshot(snapshot, options);
  return {
    ...analysis,
    strategyContractVersion: V24_STRATEGY_CONTRACT_VERSION,
  };
}

export function evaluateV24CandidateSnapshot(snapshot, options) {
  return evaluateV23CandidateSnapshot(snapshot, options);
}

export function runV24StrategyAdapter({ adapter, snapshot, config } = {}) {
  if (!ADAPTERS.has(adapter)) throw new TypeError("V2.4.1适配器只能是LIVE_DEMO或HISTORICAL_REPLAY");
  if (!snapshot || !config) throw new TypeError("V2.4.1适配器缺少snapshot或config");
  const decisionTime = snapshot.decisionTime ?? Date.now();
  const stableSnapshot = { ...snapshot, decisionTime };
  const analysis = analyzeV24SignalSnapshot(stableSnapshot, {
    strategyConfig: config.strategy,
    costsConfig: config.costs,
  });
  const candidates = analysis.candidates.map((candidate) => evaluateV24CandidateSnapshot({
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
    contractVersion: V24_STRATEGY_CONTRACT_VERSION,
    decision: { ...analysis, candidates },
  };
}

export function v24DecisionFingerprint(result) {
  const decision = result?.decision ?? result;
  if (!decision) throw new TypeError("缺少可生成指纹的V2.4.1决策结果");
  return fingerprint(decision);
}
