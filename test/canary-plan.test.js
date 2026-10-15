import test from "node:test";
import assert from "node:assert/strict";
import { buildCanaryRun, verifyConfirmation } from "../src/execution/canary-plan.js";
import { V2_EXECUTION_SOURCE } from "../src/execution/execution-strategy-source.js";

const now = 1_000_000;
const signalRecord = {
  selected: true,
  candidate: {
    id: "btc-signal-1", symbol: "BTCUSDT", direction: "LONG", strategy: "BREAKOUT",
  },
  trade: {
    signalId: "btc-signal-1", symbol: "BTCUSDT", direction: "LONG", status: "ENTRY_PENDING",
    entryPrice: 85_000.09, stopLoss: 84_000.01, takeProfit1: 87_000.09, takeProfit2: 89_000.09,
    expiresAt: now + 120_000,
  },
};
const accountState = {
  environment: "TESTNET", authority: "BINANCE_TESTNET", canTrade: true, availableBalance: 100,
  positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [],
  symbolConfig: { symbol: "BTCUSDT", marginType: "CROSSED", leverage: 20 },
};
const symbolInfo = {
  symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL",
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "100", maxPrice: "1000000", tickSize: "0.10" },
    { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000", stepSize: "0.0001" },
    { filterType: "MIN_NOTIONAL", notional: "50" },
  ],
};

test("执行预检生成 BTC 单币、逐仓10倍、可确认且不可变的订单计划", () => {
  const { run, confirmationCode } = buildCanaryRun({
    signalRecord,
    accountState,
    symbolInfo,
    leverageBrackets: { brackets: [{ bracket: 1, initialLeverage: 125, notionalFloor: 0, notionalCap: 1_000_000 }] },
    now,
  });
  assert.equal(run.status, "PREPARED");
  assert.equal(run.plan.symbol, "BTCUSDT");
  assert.equal(run.plan.marginMode, "ISOLATED");
  assert.equal(run.plan.leverage, 10);
  assert.equal(run.plan.leverageCapability.supported, true);
  assert.equal(run.plan.leverageCapability.maximumLeverage, 125);
  assert.equal(run.plan.quantity, "0.0012");
  assert.equal(run.plan.accountChanges.marginType, true);
  assert.equal(run.plan.accountChanges.leverage, true);
  assert.match(run.plan.clientIds.entry, /^cfs-[a-f0-9]+-entry$/);
  assert.match(run.plan.orderReasons.entry, /1小时趋势与结构方向一致/);
  assert.match(run.plan.orderReasons.stop, /全仓止损/);
  assert.match(run.plan.orderReasons.takeProfit1, /部分止盈/);
  assert.equal(run.plan.strategyVersion, "MTF_1H_15M_5M_V1");
  assert.match(run.plan.marketEventId, /^market-/);
  assert.ok(verifyConfirmation(confirmationCode, run));
  assert.equal(verifyConfirmation("wrong", run), false);
});

test("执行计划固化实际名义价值所属档位的杠杆能力", () => {
  const { run } = buildCanaryRun({
    signalRecord,
    accountState,
    symbolInfo,
    leverageBrackets: { brackets: [{ bracket: 1, initialLeverage: 5, notionalFloor: 0, notionalCap: 1_000_000 }] },
    now,
  });
  assert.equal(run.plan.leverageCapability.checked, true);
  assert.equal(run.plan.leverageCapability.supported, false);
  assert.equal(run.plan.leverageCapability.requestedLeverage, 10);
});

test("执行预检使用真实信号标的生成非 BTC 单币计划", () => {
  const altSignal = {
    selected: true,
    candidate: { id: "ake-signal-1", symbol: "AKEUSDT", direction: "SHORT", strategy: "BREAKOUT" },
    trade: {
      signalId: "ake-signal-1", symbol: "AKEUSDT", direction: "SHORT", status: "ENTRY_PENDING",
      entryPrice: 0.0296641, stopLoss: 0.030395, takeProfit1: 0.02856775, takeProfit2: 0.02783685,
      expiresAt: now + 120_000,
    },
  };
  const altAccount = {
    ...accountState,
    symbolConfig: { symbol: "AKEUSDT", marginType: "CROSSED", leverage: 20 },
  };
  const altInfo = {
    symbol: "AKEUSDT", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000", tickSize: "0.000001" },
      { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000000", stepSize: "1" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  };

  const { run } = buildCanaryRun({ signalRecord: altSignal, accountState: altAccount, symbolInfo: altInfo, now });

  assert.equal(run.symbol, "AKEUSDT");
  assert.equal(run.plan.symbol, "AKEUSDT");
  assert.equal(run.plan.entrySide, "SELL");
  assert.equal(run.plan.exitSide, "BUY");
  assert.equal(run.plan.marginTarget, 10);
  assert.equal(run.plan.leverage, 10);
  assert.ok(run.plan.actualNotional >= 95 && run.plan.actualNotional <= 105);
});

test("V2 Demo 计划把执行策略源固化到计划哈希与执行记录", () => {
  const v2Signal = structuredClone(signalRecord);
  v2Signal.candidate.strategyVersion = "MTF_1H_15M_5M_V2_1_DEMO_20260930";
  v2Signal.candidate.signalModelVersion = "MTF_1H_15M_5M_V2_1_DUAL_TIER";
  v2Signal.candidate.experimentTier = "CORE";
  v2Signal.candidate.costCohort = "HIGH_COST_EXPLORATION";
  v2Signal.candidate.demoPromotion = { policyVersion: "V2_4_1_TIERED_COST_GATE_R2", totalCostR: 0.28, costCohort: "HIGH_COST_EXPLORATION" };
  v2Signal.candidate.qualityObservations = ["REGIME_CONFLICT"];
  v2Signal.candidate.score = 82;
  v2Signal.candidate.entryReason = "市场雷达将BTC列为核心层，V2.1评分82分且通过硬规则，因此在Binance Demo开多。";
  v2Signal.candidate.marketRadar = { version: "MARKET_RADAR_R1", snapshotId: "radar-1", selected: true, radarTier: "CORE", radarScore: 88 };
  const { run } = buildCanaryRun({
    signalRecord: v2Signal,
    accountState,
    symbolInfo,
    executionSource: V2_EXECUTION_SOURCE,
    now,
  });
  assert.equal(run.executionSource, V2_EXECUTION_SOURCE);
  assert.equal(run.plan.executionSource, V2_EXECUTION_SOURCE);
  assert.equal(run.plan.strategyVersion, "MTF_1H_15M_5M_V2_1_DEMO_20260930");
  assert.equal(run.plan.signalModelVersion, "MTF_1H_15M_5M_V2_1_DUAL_TIER");
  assert.equal(run.plan.experimentTier, "CORE");
  assert.equal(run.experimentTier, "CORE");
  assert.equal(run.plan.costCohort, "HIGH_COST_EXPLORATION");
  assert.equal(run.costCohort, "HIGH_COST_EXPLORATION");
  assert.equal(run.plan.demoPromotion.totalCostR, 0.28);
  assert.deepEqual(run.plan.qualityObservations, ["REGIME_CONFLICT"]);
  assert.equal(run.plan.score, 82);
  assert.equal(run.plan.orderReasons.entry, v2Signal.candidate.entryReason);
  assert.equal(run.plan.marketRadar.snapshotId, "radar-1");
});

test("预检拒绝旧仓位、挂单、双向模式和过期信号", () => {
  assert.throws(() => buildCanaryRun({ signalRecord, accountState: { ...accountState, positions: [{ symbol: "BTCUSDT" }] }, symbolInfo, now }), /已有持仓/);
  assert.throws(() => buildCanaryRun({ signalRecord, accountState: { ...accountState, openAlgoOrders: [{ symbol: "BTCUSDT" }] }, symbolInfo, now }), /条件挂单/);
  assert.throws(() => buildCanaryRun({ signalRecord, accountState: { ...accountState, positionMode: "HEDGE" }, symbolInfo, now }), /单向持仓/);
  assert.throws(() => buildCanaryRun({
    signalRecord: { ...signalRecord, trade: { ...signalRecord.trade, expiresAt: now + 10_000 } }, accountState, symbolInfo, now,
  }), /有效时间不足/);
});
