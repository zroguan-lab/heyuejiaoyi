export const V1_EXECUTION_SOURCE = "V1_ALL_ELIGIBLE";
export const V2_EXECUTION_SOURCE = "V2_PRODUCTION";
export const V2_1_DEMO_STRATEGY_VERSION = "MTF_1H_15M_5M_V2_1_DEMO_20260930";
export const V2_2_DEMO_STRATEGY_VERSION = "MTF_1H_15M_5M_V2_2_MOVERS_DEMO_20261003";
export const V2_3_DEMO_STRATEGY_VERSION = "PRE_MOVE_1H_15M_5M_V2_3_DEMO_20261003";
export const V2_4_DEMO_STRATEGY_VERSION = "PRE_MOVE_1H_15M_5M_V2_4_COST_GATED_DEMO_20261007";
export const V2_4_SIGNAL_MODEL_VERSION = "PRE_MOVE_1H_15M_5M_V2_4";
export const V2_4_1_DEMO_STRATEGY_VERSION = "PRE_MOVE_1H_15M_5M_V2_4_1_TIERED_COST_DEMO_20261009";
export const V2_4_1_SIGNAL_MODEL_VERSION = "PRE_MOVE_1H_15M_5M_V2_4_1_LONG_CONFIRM";
export const V2_DEMO_STRATEGY_VERSION = V2_4_1_DEMO_STRATEGY_VERSION;
export const V2_4_DEMO_PROMOTION_POLICY_VERSION = "V2_4_COST_GATE_R1";
export const V2_4_1_DEMO_PROMOTION_POLICY_VERSION = "V2_4_1_TIERED_COST_GATE_R2";
export const V2_4_MAX_EXECUTION_COST_R = 0.2;
export const V2_4_1_MAX_EXECUTION_COST_R = 0.35;
export const V2_4_1_NORMAL_COST_COHORT = "NORMAL_COST";
export const V2_4_1_HIGH_COST_COHORT = "HIGH_COST_EXPLORATION";
export const PERFORMANCE_EPOCH_METADATA_KEY = "active_strategy_performance_epoch";
export const PERFORMANCE_EPOCH_HISTORY_METADATA_KEY = "strategy_performance_epoch_history";

const EXECUTION_SOURCES = new Set([V1_EXECUTION_SOURCE, V2_EXECUTION_SOURCE]);

function demoVersionForSignal(signalVersion) {
  if (signalVersion.includes("V2_1")) return V2_1_DEMO_STRATEGY_VERSION;
  if (signalVersion.includes("V2_2")) return V2_2_DEMO_STRATEGY_VERSION;
  if (signalVersion === "PRE_MOVE_1H_15M_5M_V2_3") return V2_3_DEMO_STRATEGY_VERSION;
  if (signalVersion === V2_4_SIGNAL_MODEL_VERSION) return V2_4_DEMO_STRATEGY_VERSION;
  return V2_DEMO_STRATEGY_VERSION;
}

export function assertExecutionStrategySource(value) {
  const source = String(value ?? "").trim().toUpperCase();
  if (!EXECUTION_SOURCES.has(source)) {
    throw new Error(`执行策略源只能是 ${[...EXECUTION_SOURCES].join(" 或 ")}`);
  }
  return source;
}

export function assessV2DemoPromotion(evaluation, {
  demoStrategyVersion = null,
} = {}) {
  const signalVersion = String(evaluation?.strategyVersion ?? "");
  const resolvedDemoStrategyVersion = demoStrategyVersion || demoVersionForSignal(signalVersion);
  if (![V2_4_DEMO_STRATEGY_VERSION, V2_4_1_DEMO_STRATEGY_VERSION].includes(resolvedDemoStrategyVersion)) {
    return Object.freeze({
      eligible: true,
      policyVersion: "LEGACY_DEMO_PROMOTION",
      totalCostR: Number.isFinite(Number(evaluation?.costs?.totalCostR)) ? Number(evaluation.costs.totalCostR) : null,
      normalCostR: null,
      maximumCostR: null,
      costCohort: null,
      rejectionReasons: [],
    });
  }
  const totalCostR = Number(evaluation?.costs?.totalCostR);
  const currentV2_4_1 = resolvedDemoStrategyVersion === V2_4_1_DEMO_STRATEGY_VERSION;
  const policyPrefix = currentV2_4_1 ? "V2_4_1" : "V2_4";
  const maximumCostR = currentV2_4_1 ? V2_4_1_MAX_EXECUTION_COST_R : V2_4_MAX_EXECUTION_COST_R;
  const rejectionReasons = [];
  if (!Number.isFinite(totalCostR)) rejectionReasons.push(`${policyPrefix}_EXECUTION_COST_R_UNAVAILABLE`);
  else if (totalCostR > maximumCostR) rejectionReasons.push(`${policyPrefix}_EXECUTION_COST_R_ABOVE_${currentV2_4_1 ? "0_35" : "0_20"}`);
  const costCohort = !Number.isFinite(totalCostR) || totalCostR > maximumCostR
    ? null
    : totalCostR <= V2_4_MAX_EXECUTION_COST_R
      ? V2_4_1_NORMAL_COST_COHORT
      : V2_4_1_HIGH_COST_COHORT;
  return Object.freeze({
    eligible: rejectionReasons.length === 0,
    policyVersion: currentV2_4_1
      ? V2_4_1_DEMO_PROMOTION_POLICY_VERSION
      : V2_4_DEMO_PROMOTION_POLICY_VERSION,
    totalCostR: Number.isFinite(totalCostR) ? totalCostR : null,
    normalCostR: currentV2_4_1 ? V2_4_MAX_EXECUTION_COST_R : null,
    maximumCostR,
    costCohort,
    rejectionReasons,
  });
}

export function projectV2ExecutionSignal(record) {
  if (!record) return null;
  const evaluation = record.evaluation ?? record.candidate?.shadowV2 ?? null;
  const trade = record.trade ?? null;
  const signalVersion = String(evaluation?.strategyVersion ?? "");
  const demoStrategyVersion = demoVersionForSignal(signalVersion);
  const promotionDecision = assessV2DemoPromotion(evaluation, { demoStrategyVersion });
  const researchReason = trade?.entryReason
    ?? `V2.4.1爆发前识别${evaluation?.experimentTier === "CORE" ? "核心层" : "探索层"}信号进入研究账本。`;
  const promotionDescription = promotionDecision.costCohort === V2_4_1_NORMAL_COST_COHORT
    ? "归属普通成本组"
    : promotionDecision.costCohort === V2_4_1_HIGH_COST_COHORT
      ? "归属高成本探索组"
      : "未通过当前Demo成本准入";
  const entryReason = [V2_4_DEMO_STRATEGY_VERSION, V2_4_1_DEMO_STRATEGY_VERSION].includes(demoStrategyVersion)
    ? `${String(researchReason).replace(/[。；;\s]+$/u, "")}；预估总成本${promotionDecision.totalCostR?.toFixed(4) ?? "不可用"}R，${promotionDescription}${promotionDecision.eligible ? "并通过Demo准入" : ""}。`
    : researchReason;
  return {
    selected: record.decision?.selected === true,
    recordStatus: trade?.status ?? (record.decision?.selected ? "ENTRY_PENDING" : "REJECTED"),
    candidate: record.candidate ? {
      ...record.candidate,
      score: evaluation?.score ?? record.candidate.score,
      strategyVersion: demoStrategyVersion,
      signalModelVersion: evaluation?.strategyVersion ?? null,
      experimentTier: evaluation?.experimentTier ?? record.candidate?.experimentTier ?? null,
      qualityObservations: evaluation?.qualityObservations ?? [],
      marketRadar: evaluation?.marketRadar ?? record.candidate?.marketRadar ?? null,
      costCohort: promotionDecision.costCohort,
      demoPromotion: promotionDecision,
      entryReason,
      performanceEligible: true,
      executionSource: V2_EXECUTION_SOURCE,
    } : null,
    trade: trade ? {
      ...trade,
      strategyVersion: demoStrategyVersion,
      entryReason,
      experimentTier: evaluation?.experimentTier ?? trade.experimentTier ?? null,
      qualityObservations: evaluation?.qualityObservations ?? trade.qualityObservations ?? [],
      marketRadar: evaluation?.marketRadar ?? trade.marketRadar ?? record.candidate?.marketRadar ?? null,
      costCohort: promotionDecision.costCohort,
      demoPromotion: promotionDecision,
    } : null,
    evaluation,
    decision: record.decision ?? null,
    executionSource: V2_EXECUTION_SOURCE,
    promotionMode: "EXPLICIT_DEMO_ADAPTER",
    promotionDecision,
  };
}

export function buildPerformanceEpoch({
  now = Date.now(),
  startingEquity = 500,
  strategySource = V2_EXECUTION_SOURCE,
  strategyVersion = V2_DEMO_STRATEGY_VERSION,
  signalModelVersion = null,
  radarVersion = null,
  previousEpoch = null,
} = {}) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new TypeError("绩效纪元时间无效");
  const version = String(strategyVersion ?? "").trim();
  if (!version) throw new TypeError("绩效纪元策略版本不能为空");
  const release = version === V2_4_1_DEMO_STRATEGY_VERSION
    ? "V2.4.1"
    : version === V2_4_DEMO_STRATEGY_VERSION ? "V2.4" : "V2.3";
  return Object.freeze({
    id: `${release}-${new Date(timestamp).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
    strategySource: assertExecutionStrategySource(strategySource),
    strategyVersion: version,
    signalModelVersion: signalModelVersion || null,
    radarVersion: radarVersion || null,
    startedAt: timestamp,
    startingEquity: Number(startingEquity),
    previousEpochId: previousEpoch?.id ?? null,
    reason: release === "V2.4.1"
      ? "V2.4.1分层成本执行；保留信号、方向、出场与仓位逻辑，独立重新计算Demo绩效"
      : release === "V2.4"
        ? "V2.4统一策略切换；爆发前信号与0.20R成本门控共同归属V2.4"
        : "V2.3 Pre-Move爆发前策略切换，独立重新计算Demo绩效",
  });
}

export function tradeBelongsToEpoch(trade, epoch) {
  if (!trade || !epoch) return false;
  const startedAt = Number(epoch.startedAt);
  const createdAt = Number(trade.createdAt);
  return Number.isFinite(startedAt)
    && Number.isFinite(createdAt)
    && createdAt >= startedAt
    && trade.executionSource === epoch.strategySource
    && (!epoch.strategyVersion || trade.strategyVersion === epoch.strategyVersion)
    && (!epoch.signalModelVersion || trade.signalModelVersion === epoch.signalModelVersion);
}
