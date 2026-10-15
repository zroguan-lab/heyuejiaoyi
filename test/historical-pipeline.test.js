import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBackfillCheckpoint,
  classifyValidationResult,
  pipelineStageArguments,
} from "../scripts/continue-historical-pipeline.js";

const checkpoint = (overrides = {}) => ({
  status: "RUNNING",
  successfulSymbols: 52,
  failedSymbols: 0,
  plan: { selection: Array.from({ length: 100 }, (_, index) => ({ symbol: `S${index}` })) },
  ...overrides,
});

test("历史流水线只在主回填100%且零失败后接棒", () => {
  assert.deepEqual(classifyBackfillCheckpoint(checkpoint(), { verifyProcess: false }), {
    state: "WAITING", reason: null, successful: 52, total: 100, failed: 0,
  });
  assert.deepEqual(classifyBackfillCheckpoint(checkpoint({ status: "COMPLETED", successfulSymbols: 100 }), { verifyProcess: false }), {
    state: "READY", reason: null, successful: 100, total: 100, failed: 0,
  });
});

test("历史流水线拒绝失败或伪完成的主回填", () => {
  assert.equal(classifyBackfillCheckpoint(checkpoint({ status: "PAUSED_WITH_FAILURES", failedSymbols: 1 }), { verifyProcess: false }).state, "BLOCKED");
  assert.equal(classifyBackfillCheckpoint(checkpoint({ status: "COMPLETED", successfulSymbols: 99 }), { verifyProcess: false }).reason, "BACKFILL_COMPLETED_INCOMPLETE");
  assert.equal(classifyBackfillCheckpoint(null, { verifyProcess: false }).reason, "BACKFILL_CHECKPOINT_MISSING");
});

test("历史流水线直接启动Node入口而不依赖Windows npm.cmd", () => {
  assert.deepEqual(pipelineStageArguments("CATCHUP"), [
    "--env-file-if-exists=.env.public",
    "--use-env-proxy",
    "--disable-warning=ExperimentalWarning",
    "scripts/catchup-historical-universe.js",
  ]);
  assert.deepEqual(pipelineStageArguments("STRICT_SINGLE_POINT_REPLAY"), [
    "--env-file-if-exists=.env",
    "--disable-warning=ExperimentalWarning",
    "scripts/replay-v2-3-history.js",
    "--points=1",
  ]);
  assert.equal(pipelineStageArguments("STRICT_VALIDATION", { validationPoints: 40 }).at(-1), "--points=40");
  assert.throws(() => pipelineStageArguments("UNKNOWN"), /PIPELINE_STAGE_UNKNOWN/);
});

test("严格验证被数据覆盖阻断时不能把流水线标成完成", () => {
  assert.deepEqual(classifyValidationResult({
    status: "BLOCKED",
    blocker: "POINT_IN_TIME_FACT_COVERAGE_INCOMPLETE",
    pointInTimeCoverage: { ready: false, eligibleDecisionPoints: 18 },
  }), {
    state: "WAITING",
    status: "WAITING_FOR_POINT_IN_TIME_COVERAGE",
    blocker: "POINT_IN_TIME_FACT_COVERAGE_INCOMPLETE",
    pointInTimeCoverage: { ready: false, eligibleDecisionPoints: 18 },
  });
  assert.deepEqual(classifyValidationResult({
    promotionGate: { passed: false },
    pointInTimeCoverage: { ready: true, eligibleDecisionPoints: 20, requestedDecisionPoints: 20 },
  }), {
    state: "READY",
    status: "VALIDATION_COMPLETED",
    blocker: null,
    pointInTimeCoverage: { ready: true, eligibleDecisionPoints: 20, requestedDecisionPoints: 20 },
  });
  assert.equal(classifyValidationResult({}).state, "FAILED");
});
