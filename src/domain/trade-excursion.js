export const TRADE_EXCURSION_MODEL_VERSION = "TRADE_EXCURSION_R1";

const STOP_EXIT_REASONS = new Set([
  "STOP_LOSS",
  "AMBIGUOUS_STOP_FIRST",
  "BREAKEVEN_AFTER_TP1",
  "AMBIGUOUS_BREAKEVEN_FIRST",
]);

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${name}必须是有限数字`);
  return number;
}

function optionalTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function round(value, digits = 8) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function durationFields(openedAt, observedAt) {
  const elapsedMs = Math.max(0, observedAt - openedAt);
  const minutesHeld = elapsedMs / 60_000;
  return {
    minutesHeld: round(minutesHeld, 4),
    barsHeld5m: Math.ceil(minutesHeld / 5),
  };
}

export function createTradeExcursionState({ direction, entryPrice, stopLoss, openedAt } = {}) {
  if (!new Set(["LONG", "SHORT"]).has(direction)) throw new TypeError("MFE/MAE需要LONG或SHORT方向");
  const entry = finite(entryPrice, "入场价");
  const stop = finite(stopLoss, "初始止损价");
  const opened = finite(openedAt, "入场时间");
  const initialRiskPrice = Math.abs(entry - stop);
  if (entry <= 0 || stop <= 0 || initialRiskPrice <= 0 || opened < 0) throw new TypeError("MFE/MAE需要有效入场、止损与时间");
  return {
    modelVersion: TRADE_EXCURSION_MODEL_VERSION,
    direction,
    entryPrice: entry,
    initialStopLoss: stop,
    initialRiskPrice,
    openedAt: opened,
    lastObservedAt: opened,
    mfeR: 0,
    maeR: 0,
    mfePrice: entry,
    maePrice: entry,
    timeToMfeMs: null,
    timeToMaeMs: null,
    timeToTp1Ms: null,
    timeToTp2Ms: null,
    timeToStopMs: null,
    mfeBeforeStopR: null,
    maeBeforeTp1R: null,
    maxFavorableExcursionBeforeExitR: null,
    maxAdverseExcursionBeforeExitR: null,
    barsHeld5m: 0,
    minutesHeld: 0,
    closedAt: null,
    exitReason: null,
  };
}

export function observeTradeExcursion(input, { low, high, observedAt } = {}) {
  if (!input) throw new TypeError("缺少MFE/MAE状态");
  const state = { ...input };
  const observed = finite(observedAt, "观测时间");
  if (observed < state.openedAt || observed < state.lastObservedAt) throw new Error("MFE/MAE观测时间不能早于入场或倒序");
  const observedLow = finite(low, "最低价");
  const observedHigh = finite(high, "最高价");
  if (observedLow <= 0 || observedHigh <= 0 || observedHigh < observedLow) throw new TypeError("MFE/MAE价格区间无效");

  const favorablePrice = state.direction === "LONG" ? observedHigh : observedLow;
  const adversePrice = state.direction === "LONG" ? observedLow : observedHigh;
  const favorableDistance = Math.max(0, state.direction === "LONG"
    ? favorablePrice - state.entryPrice
    : state.entryPrice - favorablePrice);
  const adverseDistance = Math.max(0, state.direction === "LONG"
    ? state.entryPrice - adversePrice
    : adversePrice - state.entryPrice);
  const favorableR = favorableDistance / state.initialRiskPrice;
  const adverseR = adverseDistance / state.initialRiskPrice;

  if (favorableR > Number(state.mfeR ?? 0)) {
    state.mfeR = round(favorableR);
    state.mfePrice = favorablePrice;
    state.timeToMfeMs = observed - state.openedAt;
  }
  if (adverseR > Number(state.maeR ?? 0)) {
    state.maeR = round(adverseR);
    state.maePrice = adversePrice;
    state.timeToMaeMs = observed - state.openedAt;
  }
  state.lastObservedAt = observed;
  Object.assign(state, durationFields(state.openedAt, observed));
  return state;
}

export function markTradeExcursionMilestone(input, type, at) {
  if (!input) throw new TypeError("缺少MFE/MAE状态");
  const state = { ...input };
  const milestoneAt = finite(at, "里程碑时间");
  if (milestoneAt < state.openedAt) throw new Error("交易里程碑不能早于入场");
  const elapsed = milestoneAt - state.openedAt;
  if (type === "TP1") {
    state.timeToTp1Ms ??= elapsed;
    state.maeBeforeTp1R ??= round(Number(state.maeR ?? 0));
  } else if (type === "TP2") {
    state.timeToTp2Ms ??= elapsed;
  } else if (type === "STOP") {
    state.timeToStopMs ??= elapsed;
    state.mfeBeforeStopR ??= round(Number(state.mfeR ?? 0));
  } else {
    throw new TypeError(`未知MFE/MAE里程碑: ${type}`);
  }
  state.lastObservedAt = Math.max(Number(state.lastObservedAt ?? state.openedAt), milestoneAt);
  Object.assign(state, durationFields(state.openedAt, state.lastObservedAt));
  return state;
}

export function finalizeTradeExcursion(input, { closedAt, exitReason = null } = {}) {
  if (!input) return null;
  let state = { ...input };
  const closed = finite(closedAt, "平仓时间");
  if (STOP_EXIT_REASONS.has(exitReason) && state.timeToStopMs === null) {
    state = markTradeExcursionMilestone(state, "STOP", closed);
  }
  state.closedAt = closed;
  state.exitReason = exitReason;
  state.lastObservedAt = Math.max(Number(state.lastObservedAt ?? state.openedAt), closed);
  state.maxFavorableExcursionBeforeExitR = round(Number(state.mfeR ?? 0));
  state.maxAdverseExcursionBeforeExitR = round(Number(state.maeR ?? 0));
  Object.assign(state, durationFields(state.openedAt, closed));
  return state;
}

export function excursionFields(state) {
  const source = state ?? {};
  return {
    mfeR: Number.isFinite(Number(source.mfeR)) ? Number(source.mfeR) : null,
    maeR: Number.isFinite(Number(source.maeR)) ? Number(source.maeR) : null,
    mfePrice: Number.isFinite(Number(source.mfePrice)) ? Number(source.mfePrice) : null,
    maePrice: Number.isFinite(Number(source.maePrice)) ? Number(source.maePrice) : null,
    timeToMfeMs: optionalTime(source.timeToMfeMs),
    timeToMaeMs: optionalTime(source.timeToMaeMs),
    timeToTp1Ms: optionalTime(source.timeToTp1Ms),
    timeToTp2Ms: optionalTime(source.timeToTp2Ms),
    timeToStopMs: optionalTime(source.timeToStopMs),
    mfeBeforeStopR: Number.isFinite(Number(source.mfeBeforeStopR)) ? Number(source.mfeBeforeStopR) : null,
    maeBeforeTp1R: Number.isFinite(Number(source.maeBeforeTp1R)) ? Number(source.maeBeforeTp1R) : null,
    maxFavorableExcursionBeforeExitR: Number.isFinite(Number(source.maxFavorableExcursionBeforeExitR))
      ? Number(source.maxFavorableExcursionBeforeExitR)
      : null,
    maxAdverseExcursionBeforeExitR: Number.isFinite(Number(source.maxAdverseExcursionBeforeExitR))
      ? Number(source.maxAdverseExcursionBeforeExitR)
      : null,
    barsHeld5m: Number.isFinite(Number(source.barsHeld5m)) ? Number(source.barsHeld5m) : null,
    minutesHeld: Number.isFinite(Number(source.minutesHeld)) ? Number(source.minutesHeld) : null,
  };
}

export function isStopExitReason(reason) {
  return STOP_EXIT_REASONS.has(reason);
}
