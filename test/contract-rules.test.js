import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCanarySizing,
  ceilToStep,
  floorToStep,
  parseContractRules,
  quantizeEntryPrice,
  quantizeTriggerPrice,
  splitFilledQuantity,
} from "../src/execution/contract-rules.js";

const rules = parseContractRules({
  symbol: "BTCUSDT",
  status: "TRADING",
  contractType: "PERPETUAL",
  filters: [
    { filterType: "PRICE_FILTER", minPrice: "100", maxPrice: "1000000", tickSize: "0.10" },
    { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000", stepSize: "0.0001" },
    { filterType: "MIN_NOTIONAL", notional: "50" },
  ],
});

test("合约规则按 tickSize 和 stepSize 进行方向安全的量化", () => {
  assert.equal(floorToStep(0.00129999, 0.0001), 0.0012);
  assert.equal(ceilToStep(0.00120001, 0.0001), 0.0013);
  assert.equal(quantizeEntryPrice("LONG", 80_000.09, rules), 80_000);
  assert.equal(quantizeEntryPrice("SHORT", 80_000.01, rules), 80_000.1);
  assert.equal(quantizeTriggerPrice("STOP", "LONG", 79_000.01, rules), 79_000.1);
  assert.equal(quantizeTriggerPrice("STOP", "SHORT", 81_000.09, rules), 81_000);
});

test("合约规则接受监控宇宙中的非 BTC USDT 永续标的", () => {
  const altRules = parseContractRules({
    symbol: "AKEUSDT", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000", tickSize: "0.000001" },
      { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000000", stepSize: "1" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  });
  assert.equal(altRules.symbol, "AKEUSDT");
  assert.equal(altRules.tickSize, 0.000001);
  assert.equal(altRules.stepSize, 1);
});

test("执行标的允许 Binance 已上市的单字符代号 USDT 永续合约", () => {
  const singleCharacterRules = parseContractRules({
    symbol: "QUSDT", quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000", tickSize: "0.000001" },
      { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000000", stepSize: "1" },
      { filterType: "MIN_NOTIONAL", notional: "5" },
    ],
  });
  assert.equal(singleCharacterRules.symbol, "QUSDT");
});

test("10U 10倍 BTC 仓位会在5%容差内满足两级止盈最小名义价值", () => {
  const sizing = buildCanarySizing({
    entryPrice: 85_000,
    takeProfit1: 87_000,
    takeProfit2: 89_000,
    margin: 10,
    leverage: 10,
    rules,
  });
  assert.equal(sizing.quantity, 0.0012);
  assert.equal(sizing.takeProfit1Quantity, 0.0006);
  assert.equal(sizing.takeProfit2Quantity, 0.0006);
  assert.equal(sizing.actualNotional, 102);
  assert.equal(sizing.marginEstimate, 10.2);
});

test("部分成交不足以安全拆成两份时降级为单一止盈但仍保留全仓止损", () => {
  assert.deepEqual(splitFilledQuantity(0.0012, { takeProfit1: 87_000, takeProfit2: 89_000, rules }), {
    mode: "TWO_TARGETS", takeProfit1Quantity: 0.0006, takeProfit2Quantity: 0.0006,
  });
  assert.deepEqual(splitFilledQuantity(0.0007, { takeProfit1: 87_000, takeProfit2: 89_000, rules }), {
    mode: "SINGLE_TARGET", takeProfit1Quantity: 0, takeProfit2Quantity: 0.0007,
  });
});
