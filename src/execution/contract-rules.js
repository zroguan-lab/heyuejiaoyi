import { assertExecutionSymbol } from "./execution-symbols.js";

function decimalPlaces(value) {
  const text = String(value);
  if (/e-/i.test(text)) return Number(text.split(/e-/i)[1]);
  const fraction = text.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}

function quantize(value, step, mode) {
  if (![value, step].every(Number.isFinite) || value < 0 || step <= 0) throw new TypeError("量化参数无效");
  const digits = decimalPlaces(step);
  const factor = 10 ** digits;
  const stepUnits = Math.round(step * factor);
  const valueUnits = value * factor;
  const units = mode === "ceil"
    ? Math.ceil((valueUnits - 1e-8) / stepUnits) * stepUnits
    : Math.floor((valueUnits + 1e-8) / stepUnits) * stepUnits;
  return Number((units / factor).toFixed(digits));
}

export function floorToStep(value, step) { return quantize(value, step, "floor"); }
export function ceilToStep(value, step) { return quantize(value, step, "ceil"); }

export function formatToStep(value, step) {
  return Number(value).toFixed(decimalPlaces(step));
}

export function parseContractRules(symbolInfo) {
  const symbol = assertExecutionSymbol(symbolInfo?.symbol, "合约规则标的");
  if (symbolInfo.status !== "TRADING" || symbolInfo.contractType !== "PERPETUAL" || (symbolInfo.quoteAsset && symbolInfo.quoteAsset !== "USDT")) {
    throw new Error(`${symbol} USDT 永续合约当前不可交易`);
  }
  const filters = new Map((symbolInfo.filters ?? []).map((item) => [item.filterType, item]));
  const price = filters.get("PRICE_FILTER");
  const lot = filters.get("LOT_SIZE");
  const notional = filters.get("MIN_NOTIONAL");
  const values = {
    symbol,
    tickSize: Number(price?.tickSize),
    minPrice: Number(price?.minPrice),
    maxPrice: Number(price?.maxPrice),
    stepSize: Number(lot?.stepSize),
    minQuantity: Number(lot?.minQty),
    maxQuantity: Number(lot?.maxQty),
    minNotional: Number(notional?.notional),
  };
  if (![values.tickSize, values.minPrice, values.maxPrice, values.stepSize, values.minQuantity, values.maxQuantity, values.minNotional]
    .every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`${symbol} 合约精度规则不完整`);
  }
  return Object.freeze(values);
}

export function quantizeEntryPrice(direction, price, rules) {
  const rounded = direction === "LONG" ? floorToStep(price, rules.tickSize) : ceilToStep(price, rules.tickSize);
  if (rounded < rules.minPrice || rounded > rules.maxPrice) throw new Error("限价超出交易所价格范围");
  return rounded;
}

export function quantizeTriggerPrice(kind, direction, price, rules) {
  const saferMode = kind === "STOP"
    ? (direction === "LONG" ? "ceil" : "floor")
    : (direction === "LONG" ? "floor" : "ceil");
  const rounded = quantize(price, rules.tickSize, saferMode);
  if (rounded < rules.minPrice || rounded > rules.maxPrice) throw new Error("触发价超出交易所价格范围");
  return rounded;
}

export function buildCanarySizing({ entryPrice, takeProfit1, takeProfit2, margin, leverage, maxNotionalOverageRate = 0.05, rules }) {
  if (![entryPrice, takeProfit1, takeProfit2, margin, leverage].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError("仓位计算参数无效");
  }
  const targetNotional = margin * leverage;
  let quantity = floorToStep(targetNotional / entryPrice, rules.stepSize);
  const minTp1 = ceilToStep(Math.max(rules.minQuantity, rules.minNotional / takeProfit1), rules.stepSize);
  const minTp2 = ceilToStep(Math.max(rules.minQuantity, rules.minNotional / takeProfit2), rules.stepSize);
  const minimumSplitQuantity = ceilToStep(minTp1 + minTp2, rules.stepSize);
  quantity = Math.max(quantity, minimumSplitQuantity, rules.minQuantity);
  const notional = Number((quantity * entryPrice).toFixed(8));
  if (quantity > rules.maxQuantity) throw new Error("计算数量超过交易所上限");
  if (notional < rules.minNotional) throw new Error("名义价值低于交易所最小值");
  if (notional < targetNotional * (1 - maxNotionalOverageRate)) {
    throw new Error(`合约步进导致名义价值只有 ${notional.toFixed(2)} USDT，低于允许下浮范围`);
  }
  if (notional > targetNotional * (1 + maxNotionalOverageRate)) {
    throw new Error(`为满足两级止盈最小名义价值，需要 ${notional.toFixed(2)} USDT，超过允许上浮范围`);
  }
  const takeProfit1Quantity = minTp1;
  const takeProfit2Quantity = floorToStep(quantity - takeProfit1Quantity, rules.stepSize);
  if (takeProfit2Quantity < minTp2) throw new Error("数量不足以拆分两级止盈");
  return {
    targetNotional,
    actualNotional: notional,
    marginEstimate: Number((notional / leverage).toFixed(8)),
    quantity,
    takeProfit1Quantity,
    takeProfit2Quantity,
  };
}

export function splitFilledQuantity(quantity, { takeProfit1, takeProfit2, rules }) {
  const normalized = floorToStep(quantity, rules.stepSize);
  if (normalized < rules.minQuantity) throw new Error("实际成交数量低于最小保护数量");
  const half = floorToStep(normalized / 2, rules.stepSize);
  const remainder = floorToStep(normalized - half, rules.stepSize);
  const canSplit = half >= rules.minQuantity
    && remainder >= rules.minQuantity
    && half * takeProfit1 >= rules.minNotional
    && remainder * takeProfit2 >= rules.minNotional;
  return canSplit
    ? { mode: "TWO_TARGETS", takeProfit1Quantity: half, takeProfit2Quantity: remainder }
    : { mode: "SINGLE_TARGET", takeProfit1Quantity: 0, takeProfit2Quantity: normalized };
}
