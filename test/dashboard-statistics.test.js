import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Real dashboard source, inert DOM/event adapters. Never contacts the running service.
async function dashboard() {
  const nodes = new Map();
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: "", innerHTML: "", style: {}, addEventListener() {}, querySelectorAll: () => [] });
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    document, window: {}, console, Intl, Date,
    fetch: () => new Promise(() => {}),
    EventSource: class { addEventListener() {} },
    setInterval() {},
  });
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  new vm.Script(`${source}\nglobalThis.renderTest = { renderResearchAttribution, renderExperimentPerformance, renderDemoTrades };`).runInContext(context);
  return { nodes, render: context.renderTest };
}

test("dashboard keeps absent excursion ratios and times unknown, while preserving genuine zero", async () => {
  const { nodes, render } = await dashboard();
  render.renderResearchAttribution({ researchAttribution: { excursion: {
    closedTrades: 2, stopTrades: 1, stopMfeBelow0_2RRatio: null,
    stopMfeAbove0_5RRatio: 0, medianTimeToMfeMs: null, medianTimeToStopMs: 0,
    coverage: { mfeR: { total: 2, valid: 1, missing: 1, coverage: 0.5 } },
  } } });
  const html = nodes.get("#excursion-research-summary").innerHTML;
  assert.match(html, /止损前 MFE &lt; 0.2R<\/span><strong>—/);
  assert.match(html, /止损前 MFE &gt; 0.5R<\/span><strong>0.0%/);
  assert.match(html, /到 MFE 中位时间<\/span><strong>—/);
  assert.match(html, /到止损中位时间<\/span><strong>0.0 分钟/);
  assert.match(nodes.get("#excursion-research-note").textContent, /1\/2 有效 · 缺失 1 · 50.0%/);
});

test("dashboard reports incomplete R evidence after reaching sample target instead of asking for zero trades", async () => {
  const { nodes, render } = await dashboard();
  render.renderExperimentPerformance({
    sampleProgress: { target: 100, finalized: 100, remaining: 0, completionPercent: 100 },
    coverage: { netR: { total: 100, valid: 1, missing: 99, coverage: 0.01 } },
    validationGate: { eligible: false, checks: { completeNetR: false, completeNetPnl: true } },
  });
  const label = nodes.get("#sample-validation-status").textContent;
  assert.match(label, /净R证据不完整/);
  assert.match(label, /缺失 99/);
  assert.doesNotMatch(label, /还需 0/);
  assert.equal(nodes.get("#sample-progress-bar").style.width, "100%");
});

test("dashboard source attribution labels missing denominators and non-additive group drawdown", async () => {
  const { nodes, render } = await dashboard();
  render.renderResearchAttribution({ researchAttribution: { opportunitySources: { combinations: [{
    combination: "RANK_VELOCITY", trades: 10, sampleStatus: "INCOMPLETE_METRICS", winRate: null,
    avgNetR: null, profitFactor: null, groupMaxDrawdownR: null,
    coverage: { netR: { total: 10, valid: 0, missing: 10, coverage: 0 } },
  }] } } });
  const html = nodes.get("#source-combination-summary").innerHTML;
  assert.match(html, /胜率 —/);
  assert.match(html, /0\/10 有效 · 缺失 10/);
  assert.match(html, /组内独立最大回撤 —/);
  assert.match(html, /不可相加为组合贡献/);
});

test("dashboard trade detail exposes unknown actual risk without inventing net R or excursion", async () => {
  const { nodes, render } = await dashboard();
  render.renderDemoTrades([{
    id: "unknown-fill", symbol: "BTCUSDT", direction: "LONG", status: "CLOSED",
    entryFactStatus: "UNKNOWN", entryFactReason: "ENTRY_AGGREGATE_QUOTE_MISSING_OR_CONFLICT",
    actualRisk: null, netR: null, mfeR: null, maeR: null,
    excursionCoverage: "UNKNOWN", excursionReason: "ACTUAL_ENTRY_RISK_UNKNOWN",
  }]);
  const html = nodes.get("#demo-trades-body").innerHTML;
  assert.match(html, /初始实际风险未知/);
  assert.match(html, /路径覆盖 UNKNOWN/);
  assert.doesNotMatch(html, /净结果 .*0\.000R/);
});
