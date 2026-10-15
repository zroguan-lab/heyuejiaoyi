function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) throw new TypeError("period 必须是正整数");
}

function assertValues(values) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("指标输入必须是有限数字数组");
  }
}

export function sma(values, period) {
  assertValues(values);
  assertPeriod(period);
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1) result[index] = sum / period;
  }
  return result;
}

export function ema(values, period) {
  assertValues(values);
  assertPeriod(period);
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;

  let seed = 0;
  for (let index = 0; index < period; index += 1) seed += values[index];
  result[period - 1] = seed / period;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    result[index] = (values[index] - result[index - 1]) * multiplier + result[index - 1];
  }
  return result;
}

export function rsi(values, period = 14) {
  assertValues(values);
  assertPeriod(period);
  const result = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  result[period] = rsiFromAverages(averageGain, averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] = rsiFromAverages(averageGain, averageLoss);
  }
  return result;
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function atr(candles, period = 14) {
  assertPeriod(period);
  if (!Array.isArray(candles)) throw new TypeError("candles 必须是数组");
  const result = Array(candles.length).fill(null);
  if (candles.length < period) return result;

  const trueRanges = candles.map((candle, index) => {
    if (![candle.high, candle.low, candle.close].every(Number.isFinite)) {
      throw new TypeError("K 线价格必须是有限数字");
    }
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });

  let seed = 0;
  for (let index = 0; index < period; index += 1) seed += trueRanges[index];
  result[period - 1] = seed / period;
  for (let index = period; index < candles.length; index += 1) {
    result[index] = (result[index - 1] * (period - 1) + trueRanges[index]) / period;
  }
  return result;
}

export function lastDefined(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null && values[index] !== undefined) return values[index];
  }
  return null;
}
