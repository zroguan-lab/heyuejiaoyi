import test from "node:test";
import assert from "node:assert/strict";
import { buildCorrelationMatrix, resolveCandidateConflicts, selectPortfolioCandidates } from "../src/domain/portfolio.js";

function item(id, symbol, direction, score, strategy = "BREAKOUT") {
  return { id, symbol, direction, score, strategy, triggerTime: 1, status: "CANDIDATE" };
}

test("同币种反向候选在组合层全部拒绝", () => {
  const result = resolveCandidateConflicts([
    item("1", "BTCUSDT", "LONG", 90),
    item("2", "BTCUSDT", "SHORT", 95, "PULLBACK"),
  ]);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.rejected.every((entry) => entry.reason === "WAIT_CONFLICT"), true);
});

test("同币种同方向候选合并归因且只占一个槽位", () => {
  const result = resolveCandidateConflicts([
    item("1", "ETHUSDT", "LONG", 80),
    item("2", "ETHUSDT", "LONG", 90, "PULLBACK"),
  ]);
  assert.equal(result.eligible.length, 1);
  assert.deepEqual(result.eligible[0].attributionStrategies.sort(), ["BREAKOUT", "PULLBACK"]);
  assert.equal(result.eligible[0].id, "2");
});

test("组合选择全部达到门槛的不同标的并按质量排序", () => {
  const candidates = Array.from({ length: 7 }, (_, index) => item(String(index), `C${index}USDT`, "LONG", 70 + index));
  const result = selectPortfolioCandidates(candidates, [], { minimumScore: 70 });
  assert.equal(result.selected.length, 7);
  assert.deepEqual(result.selected.map((entry) => entry.score), [76, 75, 74, 73, 72, 71, 70]);
  assert.equal(result.selectionMode, "ALL_ELIGIBLE");
  assert.equal(result.rejected.length, 0);
});

test("组合在同分候选中降低与已选信号高度相关的重复暴露", () => {
  const candidates = [item("a", "AAAUSDT", "LONG", 90), item("b", "BBBUSDT", "LONG", 89), item("c", "CCCUSDT", "LONG", 88)];
  const correlations = { "AAAUSDT:BBBUSDT": 0.95, "AAAUSDT:CCCUSDT": 0.1 };
  const result = selectPortfolioCandidates(candidates, [], { correlations });
  assert.deepEqual(result.selected.map((entry) => entry.symbol), ["AAAUSDT", "CCCUSDT", "BBBUSDT"]);
});

test("组合只把达到最低评分的候选送入正式执行并保留拒绝原因", () => {
  const result = selectPortfolioCandidates([
    item("high", "AAAUSDT", "LONG", 76),
    item("low", "BBBUSDT", "SHORT", 69),
  ], [], { minimumScore: 70 });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["high"]);
  assert.equal(result.rejected[0].candidate.id, "low");
  assert.equal(result.rejected[0].reason, "SCORE_BELOW_MIN_CONFIDENCE");
});

test("相关性矩阵使用对齐后的最近收益序列", () => {
  const matrix = buildCorrelationMatrix({ AAAUSDT: [1, 2, 3, 4], BBBUSDT: [2, 4, 6, 8], CCCUSDT: [4, 3, 2, 1] });
  assert.ok(matrix["AAAUSDT:BBBUSDT"] > 0.99);
  assert.ok(matrix["AAAUSDT:CCCUSDT"] < -0.99);
});
