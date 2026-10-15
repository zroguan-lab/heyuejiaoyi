import test from "node:test";
import assert from "node:assert/strict";
import {
  V1_EXECUTION_SOURCE,
  V2_3_DEMO_STRATEGY_VERSION,
  V2_4_1_DEMO_PROMOTION_POLICY_VERSION,
  V2_4_1_DEMO_STRATEGY_VERSION,
  V2_4_1_HIGH_COST_COHORT,
  V2_4_1_NORMAL_COST_COHORT,
  V2_4_1_SIGNAL_MODEL_VERSION,
  V2_4_DEMO_STRATEGY_VERSION,
  V2_DEMO_STRATEGY_VERSION,
  V2_EXECUTION_SOURCE,
  assessV2DemoPromotion,
  buildPerformanceEpoch,
  projectV2ExecutionSignal,
  tradeBelongsToEpoch,
} from "../src/execution/execution-strategy-source.js";

test("历史V2.3研究记录投影时保持原版本归属，不能伪装成当前版本", () => {
  const record = projectV2ExecutionSignal({
    candidate: { id: "v2-1", symbol: "BTCUSDT", strategy: "PRE_BREAKOUT", triggerTime: 2000, score: 70 },
    evaluation: {
      mode: "SHADOW_ONLY",
      orderSubmissionAllowed: false,
      eligible: true,
      score: 84,
      strategyVersion: "PRE_MOVE_1H_15M_5M_V2_3",
      experimentTier: "CORE",
      qualityObservations: ["REGIME_CONFLICT"],
      costs: { totalCostR: 0.18 },
    },
    decision: { selected: true },
    trade: { signalId: "v2-1", symbol: "BTCUSDT", status: "ENTRY_PENDING", portfolio: "PRODUCTION_SHADOW", orderSubmissionAllowed: false },
  });
  assert.equal(record.selected, true);
  assert.equal(record.executionSource, V2_EXECUTION_SOURCE);
  assert.equal(record.candidate.score, 84);
  assert.equal(record.candidate.strategyVersion, V2_3_DEMO_STRATEGY_VERSION);
  assert.equal(record.candidate.signalModelVersion, "PRE_MOVE_1H_15M_5M_V2_3");
  assert.equal(record.candidate.experimentTier, "CORE");
  assert.deepEqual(record.candidate.qualityObservations, ["REGIME_CONFLICT"]);
  assert.equal(record.evaluation.orderSubmissionAllowed, false);
  assert.equal(record.promotionDecision.eligible, true);
  assert.equal(record.promotionDecision.policyVersion, "LEGACY_DEMO_PROMOTION");
});

test("V2.4.1 Demo准入按0.20R普通组和0.35R探索上限分层", () => {
  const base = {
    strategyVersion: V2_4_1_SIGNAL_MODEL_VERSION,
    costs: { totalCostR: 0.2 },
  };
  const normal = assessV2DemoPromotion(base);
  assert.equal(normal.eligible, true);
  assert.equal(normal.costCohort, V2_4_1_NORMAL_COST_COHORT);
  assert.equal(normal.normalCostR, 0.2);
  assert.equal(normal.maximumCostR, 0.35);
  const exploration = assessV2DemoPromotion({ ...base, costs: { totalCostR: 0.2001 } });
  assert.equal(exploration.eligible, true);
  assert.equal(exploration.costCohort, V2_4_1_HIGH_COST_COHORT);
  assert.equal(assessV2DemoPromotion({ ...base, costs: { totalCostR: 0.35 } }).eligible, true);
  const rejected = assessV2DemoPromotion({ ...base, costs: { totalCostR: 0.3501 } });
  assert.equal(rejected.eligible, false);
  assert.equal(rejected.costCohort, null);
  assert.deepEqual(rejected.rejectionReasons, ["V2_4_1_EXECUTION_COST_R_ABOVE_0_35"]);
  assert.equal(rejected.policyVersion, V2_4_1_DEMO_PROMOTION_POLICY_VERSION);
  assert.equal(rejected.maximumCostR, 0.35);
  assert.equal(assessV2DemoPromotion({ strategyVersion: "MTF_1H_15M_5M_V2_2_MOVERS" }).eligible, true);
});

test("绩效纪元只接受同策略源、同执行版本、同信号模型且在起点之后创建的订单", () => {
  const epoch = {
    strategySource: V2_EXECUTION_SOURCE,
    strategyVersion: V2_DEMO_STRATEGY_VERSION,
    signalModelVersion: V2_4_1_SIGNAL_MODEL_VERSION,
    startedAt: 1000,
  };
  const current = { executionSource: V2_EXECUTION_SOURCE, strategyVersion: V2_DEMO_STRATEGY_VERSION, signalModelVersion: V2_4_1_SIGNAL_MODEL_VERSION, createdAt: 1000 };
  assert.equal(tradeBelongsToEpoch(current, epoch), true);
  assert.equal(tradeBelongsToEpoch({ ...current, createdAt: 999 }, epoch), false);
  assert.equal(tradeBelongsToEpoch({ ...current, executionSource: V1_EXECUTION_SOURCE }, epoch), false);
  assert.equal(tradeBelongsToEpoch({ ...current, strategyVersion: "OLD_V2" }, epoch), false);
  assert.equal(tradeBelongsToEpoch({ ...current, signalModelVersion: "PRE_MOVE_1H_15M_5M_V2_4" }, epoch), false);
});

test("V2.4.1分层成本切换创建独立绩效纪元并保留V2.4引用", () => {
  const epoch = buildPerformanceEpoch({
    now: 1_800_000_000_000,
    startingEquity: 500,
    strategyVersion: V2_DEMO_STRATEGY_VERSION,
    signalModelVersion: V2_4_1_SIGNAL_MODEL_VERSION,
    radarVersion: "MARKET_RADAR_R3_PREMOVE",
    previousEpoch: { id: "V2.4-old", strategyVersion: V2_4_DEMO_STRATEGY_VERSION },
  });
  assert.equal(V2_DEMO_STRATEGY_VERSION, V2_4_1_DEMO_STRATEGY_VERSION);
  assert.match(epoch.id, /^V2\.4\.1-/);
  assert.equal(epoch.startingEquity, 500);
  assert.equal(epoch.previousEpochId, "V2.4-old");
  assert.equal(epoch.radarVersion, "MARKET_RADAR_R3_PREMOVE");
  assert.match(epoch.reason, /分层成本/);
});
