import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPlan } from "../src/domain/risk.js";
import { strategyConfig } from "./helpers.js";

test("多头风控给出低于入场的止损与两级止盈", () => {
  const plan = buildRiskPlan({ direction: "LONG", entry: 100, atr: 1, recentHigh: 102, recentLow: 99, config: strategyConfig });
  assert.equal(plan.valid, true);
  assert.equal(plan.stopLoss, 98.5);
  assert.equal(plan.takeProfit1, 102.25);
  assert.equal(plan.takeProfit2, 103.75);
  assert.equal(plan.stopPercent, 1.5);
});

test("空头风控方向正确", () => {
  const plan = buildRiskPlan({ direction: "SHORT", entry: 100, atr: 1, recentHigh: 101, recentLow: 98, config: strategyConfig });
  assert.equal(plan.valid, true);
  assert.ok(plan.stopLoss > plan.entry);
  assert.ok(plan.takeProfit1 < plan.entry);
  assert.ok(plan.takeProfit2 < plan.takeProfit1);
});

test("波动导致止损过宽时拒绝信号", () => {
  const plan = buildRiskPlan({ direction: "LONG", entry: 100, atr: 10, recentHigh: 110, recentLow: 90, config: strategyConfig });
  assert.equal(plan.valid, false);
  assert.match(plan.reason, /超过风控上限/);
});
