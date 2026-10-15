import test from "node:test";
import assert from "node:assert/strict";
import { buildShadowPerformance } from "../src/presentation/shadow-performance.js";

test("影子组合独立统计净R、PF、回撤且少于100笔不能晋级", () => {
  const performance = buildShadowPerformance([
    { trade: { status: "CLOSED", closedAt: "2026-01-01T00:00:00Z", pnl: { net: 5, netR: 1 } } },
    { trade: { status: "CLOSED", closedAt: "2026-01-02T00:00:00Z", pnl: { net: -2, netR: -0.4 } } },
  ], { startingEquity: 500 });
  assert.equal(performance.totalNetPnl, 3);
  assert.equal(performance.averageNetR, 0.3);
  assert.equal(performance.profitFactor, 2.5);
  assert.equal(performance.promotionGate.eligible, false);
  assert.equal(performance.portfolio, "V2_4_1_PREMOVE");
  assert.equal(performance.sampleType, "FORWARD_DEMO_RESEARCH");
  assert.equal(performance.promotionGate.checks.minimumSamples, false);
});
