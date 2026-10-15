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
  assert.equal(performance.portfolio, "V2_4_3_PREMOVE");
  assert.equal(performance.sampleType, "FORWARD_DEMO_RESEARCH");
  assert.equal(performance.promotionGate.checks.minimumSamples, false);
});

test("BOUNDARY_PRESSURE-only反事实交易不污染主组合统计", () => {
  const performance = buildShadowPerformance([
    { decision: { selected: true }, trade: { status: "CLOSED", pnl: { net: 2, netR: 0.5 } } },
    {
      decision: { selected: false, counterfactual: true },
      trade: {
        status: "CLOSED",
        counterfactual: true,
        pnl: { net: -4, netR: -1 },
        marketRadar: { opportunitySources: ["BOUNDARY_PRESSURE"] },
        mfeR: 0.1,
        maeR: 1,
      },
    },
  ]);
  assert.equal(performance.closedTradeCount, 1);
  assert.equal(performance.totalNetPnl, 2);
  assert.equal(performance.researchAttribution.counterfactualBoundaryOnly.closedTrades, 1);
  assert.equal(performance.researchAttribution.counterfactualBoundaryOnly.opportunitySources.combinations[0].combination, "BOUNDARY_PRESSURE");
});
