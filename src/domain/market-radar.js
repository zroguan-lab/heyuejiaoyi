export const MARKET_RADAR_VERSION = "MARKET_RADAR_R3_PREMOVE";
export const MARKET_RADAR_SCHEMA_REVISION = 4;

const SOURCE_LABELS = Object.freeze({
  RANK_GAINER: "1小时领涨",
  RANK_LOSER: "1小时领跌",
  RANK_VELOCITY: "排名加速",
  VOLUME_SHOCK: "成交量异常",
  VOLATILITY_COMPRESSION: "波动收缩",
  BOUNDARY_PRESSURE: "结构边界蓄势",
  EARLY_ACCELERATION: "早期动量抬升",
  CORE_MARKET: "核心市场",
  RETAINED: "最短观察期保留",
});

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const finiteValues = values.map(finite).filter((value) => value !== null);
  return finiteValues.length ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
}

function median(values) {
  const sorted = values.map(finite).filter((value) => value !== null).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileMap(items, valueOf) {
  const rows = items
    .map((item) => ({ symbol: item.symbol, value: finite(valueOf(item)) }))
    .filter((item) => item.value !== null)
    .sort((left, right) => left.value - right.value);
  const result = new Map(items.map((item) => [item.symbol, 0]));
  if (!rows.length) return result;
  rows.forEach((row, index) => result.set(row.symbol, rows.length === 1 ? 1 : index / (rows.length - 1)));
  return result;
}

function returnPercent(candles, lookback) {
  if (!Array.isArray(candles) || candles.length <= lookback) return null;
  const latest = finite(candles.at(-1)?.close);
  const reference = finite(candles.at(-(lookback + 1))?.close);
  return latest !== null && reference !== null && reference > 0 ? ((latest / reference) - 1) * 100 : null;
}

function trueRanges(candles) {
  return candles.map((candle, index) => {
    if (index === 0) return Number(candle.high) - Number(candle.low);
    const previousClose = Number(candles[index - 1].close);
    return Math.max(
      Number(candle.high) - Number(candle.low),
      Math.abs(Number(candle.high) - previousClose),
      Math.abs(Number(candle.low) - previousClose),
    );
  });
}

export function deriveMoverMetrics(candles = [], { volumeLookback = 20 } = {}) {
  const closed = [...candles]
    .filter((candle) => Number.isFinite(Number(candle?.closeTime)) && Number.isFinite(Number(candle?.close)))
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime));
  const latest = closed.at(-1) ?? null;
  const latestQuoteVolume = finite(latest?.quoteVolume) ?? finite(latest?.volume);
  const previousVolumes = closed
    .slice(-(volumeLookback + 1), -1)
    .map((candle) => finite(candle.quoteVolume) ?? finite(candle.volume));
  const baselineVolume = average(previousVolumes);
  const ranges = trueRanges(closed);
  const recentRange = average(ranges.slice(-4));
  const baselineRange = average(ranges.slice(-16, -4));
  const currentAtr = average(ranges.slice(-14));
  const structure = closed.slice(-9, -1);
  const structureHigh = structure.length ? Math.max(...structure.map((candle) => Number(candle.high))) : null;
  const structureLow = structure.length ? Math.min(...structure.map((candle) => Number(candle.low))) : null;
  const structureWidth = structureHigh !== null && structureLow !== null ? structureHigh - structureLow : null;
  const rangePosition = latest && structureWidth > 0 ? clamp((Number(latest.close) - structureLow) / structureWidth) : null;
  const nearestBoundaryAtr = latest && currentAtr > 0 && structureHigh !== null && structureLow !== null
    ? Math.min(Math.abs(structureHigh - Number(latest.close)), Math.abs(Number(latest.close) - structureLow)) / currentAtr
    : null;
  const recentVolumes = closed.slice(-3).map((candle) => finite(candle.quoteVolume) ?? finite(candle.volume));
  const priorVolumes = closed.slice(-23, -3).map((candle) => finite(candle.quoteVolume) ?? finite(candle.volume));
  const recentVolumeAverage = average(recentVolumes);
  const priorVolumeAverage = average(priorVolumes);
  return {
    return15m: round(returnPercent(closed, 1)),
    return1h: round(returnPercent(closed, 4)),
    return4h: round(returnPercent(closed, 16)),
    volumeRatio15m: latestQuoteVolume !== null && baselineVolume !== null && baselineVolume > 0
      ? round(latestQuoteVolume / baselineVolume)
      : null,
    volumeBuildRatio: recentVolumeAverage !== null && priorVolumeAverage !== null && priorVolumeAverage > 0
      ? round(recentVolumeAverage / priorVolumeAverage)
      : null,
    compressionRatio: recentRange !== null && baselineRange !== null && baselineRange > 0
      ? round(recentRange / baselineRange)
      : null,
    nearestBoundaryAtr: round(nearestBoundaryAtr),
    rangePosition: round(rangePosition),
    structureWidthAtr: structureWidth !== null && currentAtr > 0 ? round(structureWidth / currentAtr) : null,
    moverDataClosedAt: finite(latest?.closeTime),
    moverCandleCount: closed.length,
    moverDataComplete: closed.length >= Math.max(17, volumeLookback + 1),
  };
}

function directionFromReturns(return1h, return15m) {
  const hourly = finite(return1h);
  const short = finite(return15m);
  const reference = hourly !== null ? hourly : short;
  if (reference === null) return "NEUTRAL";
  if (reference >= 0.25) return "LONG";
  if (reference <= -0.25) return "SHORT";
  return "NEUTRAL";
}

function overextensionRisk(item) {
  const short = Math.abs(finite(item.return15m) ?? 0);
  const hourly = Math.abs(finite(item.return1h) ?? 0);
  const fourHour = Math.abs(finite(item.return4h) ?? 0);
  if (short >= 3 || hourly >= 8 || fourHour >= 20) return "HIGH";
  if (short >= 1.5 || hourly >= 4 || fourHour >= 10) return "MEDIUM";
  return "LOW";
}

function marketBreadth(items) {
  const changes = items.map((item) => finite(item.return1h)).filter((value) => value !== null);
  const long = changes.filter((value) => value > 0.25).length;
  const short = changes.filter((value) => value < -0.25).length;
  const neutral = changes.length - long - short;
  const longRatio = changes.length ? long / changes.length : 0;
  const shortRatio = changes.length ? short / changes.length : 0;
  let direction = "MIXED";
  if (longRatio >= 0.6) direction = "LONG";
  if (shortRatio >= 0.6) direction = "SHORT";
  return {
    direction,
    total: changes.length,
    long,
    short,
    neutral,
    longRatio: round(longRatio),
    shortRatio: round(shortRatio),
    medianReturn1h: round(median(changes)),
  };
}

function summaryItem(item) {
  return {
    symbol: item.symbol,
    radarTier: item.radarTier,
    radarScore: item.radarScore,
    bias: item.bias,
    moverRank: item.moverRank,
    rankVelocity: item.rankVelocity,
    rankPersistence: item.rankPersistence,
    return15m: item.return15m,
    return1h: item.return1h,
    return4h: item.return4h,
    relativeStrengthBtc1h: item.relativeStrengthBtc1h,
    relativeStrengthMarket1h: item.relativeStrengthMarket1h,
    volumeRatio15m: item.volumeRatio15m,
    volumeBuildRatio: item.volumeBuildRatio,
    compressionRatio: item.compressionRatio,
    nearestBoundaryAtr: item.nearestBoundaryAtr,
    rangePosition: item.rangePosition,
    structureWidthAtr: item.structureWidthAtr,
    opportunitySources: [...(item.opportunitySources ?? [])],
    overextensionRisk: item.overextensionRisk,
  };
}

function sourcePriority(item) {
  const sources = new Set(item.opportunitySources ?? []);
  if (sources.has("CORE_MARKET")) return 5;
  if (sources.has("RETAINED")) return 4.5;
  if (sources.has("VOLATILITY_COMPRESSION") && sources.has("BOUNDARY_PRESSURE")) return 4.25;
  if (sources.has("EARLY_ACCELERATION")) return 4;
  if (sources.has("RANK_VELOCITY")) return 4;
  if (sources.has("RANK_GAINER") || sources.has("RANK_LOSER")) return 3;
  if (sources.has("VOLATILITY_COMPRESSION")) return 3.5;
  if (sources.has("BOUNDARY_PRESSURE")) return 3;
  if (sources.has("VOLUME_SHOCK")) return 2;
  return 0;
}

export function buildMarketRadarSnapshot(rawItems = [], {
  previousSnapshot = null,
  now = Date.now(),
  discoverySize = 100,
  deepScanSize = 30,
  minimumHoldMs = 30 * 60_000,
  coreMinimumScore = 68,
  coreSymbols = ["BTCUSDT", "ETHUSDT"],
  maxSpreadBps = 20,
  gainerCount = 15,
  loserCount = 15,
  rankVelocityCount = 10,
  volumeShockCount = 10,
  minimumVolumeShockRatio = 1.2,
  compressionCount = 15,
  boundaryPressureCount = 15,
  earlyAccelerationCount = 10,
} = {}) {
  const liquid = rawItems
    .filter((item) => item?.symbol)
    .filter((item) => Number.isFinite(Number(item.quoteVolume24h)) && Number(item.quoteVolume24h) > 0)
    .filter((item) => Number.isFinite(Number(item.spreadBps)) && Number(item.spreadBps) <= maxSpreadBps)
    .sort((left, right) => Number(right.quoteVolume24h) - Number(left.quoteVolume24h));
  const discovery = liquid.slice(0, Math.max(deepScanSize, discoverySize));
  const eligible = discovery.filter((item) => Number.isFinite(Number(item.return1h)) && item.moverDataComplete !== false);
  if (!eligible.length) throw new Error("市场雷达R3没有可评估的已收盘15分钟K线");

  const previousBySymbol = new Map((previousSnapshot?.items ?? []).map((item) => [item.symbol, item]));
  const btcReturn1h = finite(eligible.find((item) => item.symbol === "BTCUSDT")?.return1h);
  const ethReturn1h = finite(eligible.find((item) => item.symbol === "ETHUSDT")?.return1h);
  const marketReturn1h = median(eligible.map((item) => item.return1h));
  const liquidityRank = new Map(liquid.map((item, index) => [item.symbol, index + 1]));
  const gainers = [...eligible].filter((item) => Number(item.return1h) > 0).sort((left, right) => Number(right.return1h) - Number(left.return1h));
  const losers = [...eligible].filter((item) => Number(item.return1h) < 0).sort((left, right) => Number(left.return1h) - Number(right.return1h));
  const moverRank = new Map();
  gainers.forEach((item, index) => moverRank.set(item.symbol, index + 1));
  losers.forEach((item, index) => moverRank.set(item.symbol, index + 1));

  const base = eligible.map((item) => {
    const previous = previousBySymbol.get(item.symbol);
    const bias = directionFromReturns(item.return1h, item.return15m);
    const currentMoverRank = moverRank.get(item.symbol) ?? null;
    const previousMoverRank = previous?.bias === bias ? finite(previous?.moverRank) : null;
    const rankVelocity = previousMoverRank !== null && currentMoverRank !== null ? previousMoverRank - currentMoverRank : null;
    const rankPersistence = previous?.bias === bias && previousMoverRank !== null ? Number(previous.rankPersistence ?? 1) + 1 : 1;
    return {
      ...item,
      bias,
      moverRank: currentMoverRank,
      previousMoverRank,
      rankVelocity,
      rankPersistence,
      relativeStrengthBtc1h: btcReturn1h !== null ? round(Number(item.return1h) - btcReturn1h) : null,
      relativeStrengthEth1h: ethReturn1h !== null ? round(Number(item.return1h) - ethReturn1h) : null,
      relativeStrengthMarket1h: marketReturn1h !== null ? round(Number(item.return1h) - marketReturn1h) : null,
      liquidityRank: liquidityRank.get(item.symbol) ?? null,
      overextensionRisk: overextensionRisk(item),
    };
  });

  const movementRanks = percentileMap(base, (item) => Math.abs(Number(item.return1h)));
  const activityRanks = percentileMap(base, (item) => item.volumeRatio15m);
  const volumeBuildRanks = percentileMap(base, (item) => item.volumeBuildRatio);
  const compressionRanks = percentileMap(base, (item) => -Number(item.compressionRatio));
  const boundaryRanks = percentileMap(base, (item) => -Number(item.nearestBoundaryAtr));
  const velocityRanks = percentileMap(base, (item) => Math.max(0, Number(item.rankVelocity) || 0));
  const relativeRanks = percentileMap(base, (item) => Math.abs(Number(item.relativeStrengthMarket1h) || 0));
  const scored = base.map((item) => {
    const compression = 25 * (compressionRanks.get(item.symbol) ?? 0);
    const activity = 20 * (volumeBuildRanks.get(item.symbol) ?? activityRanks.get(item.symbol) ?? 0);
    const boundaryProximity = 20 * (boundaryRanks.get(item.symbol) ?? 0);
    const velocity = 15 * (velocityRanks.get(item.symbol) ?? 0);
    const relativeStrength = 10 * (relativeRanks.get(item.symbol) ?? 0);
    const earlyMovement = 5 * (movementRanks.get(item.symbol) ?? 0) * clamp(1 - Math.abs(Number(item.return1h) || 0) / 8);
    const tradability = 5 * clamp(1 - Number(item.spreadBps) / maxSpreadBps);
    return {
      ...item,
      radarScore: round(compression + activity + boundaryProximity + velocity + relativeStrength + earlyMovement + tradability, 2),
      opportunitySources: [],
      tags: [],
      components: {
        compression: round(compression, 2),
        activity: round(activity, 2),
        boundaryProximity: round(boundaryProximity, 2),
        rankVelocity: round(velocity, 2),
        relativeStrength: round(relativeStrength, 2),
        earlyMovement: round(earlyMovement, 2),
        tradability: round(tradability, 2),
      },
    };
  });
  const scoredBySymbol = new Map(scored.map((item) => [item.symbol, item]));
  const addSource = (symbol, source) => {
    const item = scoredBySymbol.get(symbol);
    if (item && !item.opportunitySources.includes(source)) item.opportunitySources.push(source);
  };
  gainers.slice(0, gainerCount).forEach((item) => addSource(item.symbol, "RANK_GAINER"));
  losers.slice(0, loserCount).forEach((item) => addSource(item.symbol, "RANK_LOSER"));
  [...scored]
    .filter((item) => Number.isFinite(Number(item.compressionRatio)) && Number(item.compressionRatio) <= 1.1)
    .sort((left, right) => Number(left.compressionRatio) - Number(right.compressionRatio) || right.radarScore - left.radarScore)
    .slice(0, compressionCount)
    .forEach((item) => addSource(item.symbol, "VOLATILITY_COMPRESSION"));
  [...scored]
    .filter((item) => Number.isFinite(Number(item.nearestBoundaryAtr)) && Number(item.nearestBoundaryAtr) <= 1.25)
    .sort((left, right) => Number(left.nearestBoundaryAtr) - Number(right.nearestBoundaryAtr) || right.radarScore - left.radarScore)
    .slice(0, boundaryPressureCount)
    .forEach((item) => addSource(item.symbol, "BOUNDARY_PRESSURE"));
  [...scored]
    .filter((item) => Number(item.volumeBuildRatio) >= 0.9 && Math.abs(Number(item.return15m) || 0) < 2.5)
    .sort((left, right) => Number(right.volumeBuildRatio) - Number(left.volumeBuildRatio) || right.radarScore - left.radarScore)
    .slice(0, earlyAccelerationCount)
    .forEach((item) => addSource(item.symbol, "EARLY_ACCELERATION"));
  [...scored]
    .filter((item) => Number(item.rankVelocity) > 0)
    .sort((left, right) => Number(right.rankVelocity) - Number(left.rankVelocity) || right.radarScore - left.radarScore)
    .slice(0, rankVelocityCount)
    .forEach((item) => addSource(item.symbol, "RANK_VELOCITY"));
  [...scored]
    .filter((item) => Number(item.volumeRatio15m) >= minimumVolumeShockRatio)
    .sort((left, right) => Number(right.volumeRatio15m) - Number(left.volumeRatio15m))
    .slice(0, volumeShockCount)
    .forEach((item) => addSource(item.symbol, "VOLUME_SHOCK"));
  coreSymbols.forEach((symbol) => addSource(symbol, "CORE_MARKET"));

  for (const item of scored) {
    const previous = previousBySymbol.get(item.symbol);
    const firstSelectedAt = finite(previous?.firstSelectedAt);
    if (previous?.selected && firstSelectedAt !== null && now - firstSelectedAt < minimumHoldMs) addSource(item.symbol, "RETAINED");
    if (Number(item.volumeRatio15m) >= minimumVolumeShockRatio) item.tags.push("VOLUME_SHOCK");
    if (Number(item.compressionRatio) <= 1.1) item.tags.push("VOLATILITY_COMPRESSION");
    if (Number(item.nearestBoundaryAtr) <= 1.25) item.tags.push("NEAR_STRUCTURE_BOUNDARY");
    if (Number(item.volumeBuildRatio) >= 0.9) item.tags.push("VOLUME_BUILDING");
    if (Number(item.rankVelocity) > 0) item.tags.push("RANK_RISING");
    if (item.overextensionRisk === "HIGH") item.tags.push("OVEREXTENDED");
    if (Number(item.spreadBps) <= 3) item.tags.push("TIGHT_SPREAD");
  }

  const selectedItems = scored
    .filter((item) => item.opportunitySources.length > 0)
    .sort((left, right) => sourcePriority(right) - sourcePriority(left) || right.radarScore - left.radarScore)
    .slice(0, deepScanSize);
  const selected = new Set(selectedItems.map((item) => item.symbol));
  const items = scored
    .sort((left, right) => right.radarScore - left.radarScore || Number(right.quoteVolume24h) - Number(left.quoteVolume24h))
    .map((item, index) => {
      const previous = previousBySymbol.get(item.symbol);
      const isSelected = selected.has(item.symbol);
      const firstSelectedAt = isSelected ? (previous?.selected ? finite(previous.firstSelectedAt) ?? now : now) : null;
      const radarTier = isSelected && item.radarScore >= coreMinimumScore && item.overextensionRisk !== "HIGH" ? "CORE" : isSelected ? "EXPLORATION" : "WATCH";
      const sourceText = item.opportunitySources.filter((source) => source !== "RETAINED").map((source) => SOURCE_LABELS[source]).join("、") || SOURCE_LABELS.RETAINED;
      const reasons = [
        `${sourceText}进入候选`,
        `1小时${Number(item.return1h) >= 0 ? "+" : ""}${round(item.return1h, 2)}%（方向榜第${item.moverRank ?? "-"}）`,
        Number.isFinite(item.relativeStrengthBtc1h) ? `相对BTC ${item.relativeStrengthBtc1h >= 0 ? "+" : ""}${round(item.relativeStrengthBtc1h, 2)}%` : null,
        Number.isFinite(item.volumeRatio15m) ? `15分钟量能${round(item.volumeRatio15m, 2)}倍` : null,
        Number.isFinite(item.compressionRatio) ? `波动收缩比${round(item.compressionRatio, 2)}` : null,
        Number.isFinite(item.nearestBoundaryAtr) ? `距结构边界${round(item.nearestBoundaryAtr, 2)}ATR` : null,
        Number.isFinite(item.volumeBuildRatio) ? `量能抬升${round(item.volumeBuildRatio, 2)}倍` : null,
        Number(item.rankVelocity) > 0 ? `排名上升${item.rankVelocity}位` : null,
        item.overextensionRisk !== "LOW" ? `扩张风险${item.overextensionRisk}` : null,
      ].filter(Boolean);
      return {
        ...item,
        selected: isSelected,
        radarTier,
        radarRank: index + 1,
        firstSelectedAt,
        reasons,
      };
    });
  const finalSelected = items.filter((item) => item.selected).sort((left, right) => sourcePriority(right) - sourcePriority(left) || right.radarScore - left.radarScore);
  const snapshotId = `radar-r3-${now.toString(36)}`;
  const byVelocity = [...items].filter((item) => Number(item.rankVelocity) > 0).sort((left, right) => Number(right.rankVelocity) - Number(left.rankVelocity));
  const byActivity = [...items].filter((item) => Number.isFinite(item.volumeRatio15m)).sort((left, right) => Number(right.volumeRatio15m) - Number(left.volumeRatio15m));
  return {
    version: MARKET_RADAR_VERSION,
    schemaRevision: MARKET_RADAR_SCHEMA_REVISION,
    snapshotId,
    generatedAt: now,
    previousSnapshotId: previousSnapshot?.snapshotId ?? null,
    source: "BINANCE_USDT_PERPETUAL_CLOSED_15M_PREMOVE",
    discoverySize: discovery.length,
    eligibleSize: eligible.length,
    deepScanSize: finalSelected.length,
    selectionPolicy: {
      gainerCount,
      loserCount,
      rankVelocityCount,
      volumeShockCount,
      minimumVolumeShockRatio,
      compressionCount,
      boundaryPressureCount,
      earlyAccelerationCount,
      maximumSelected: deepScanSize,
    },
    benchmark: {
      btcReturn1h: round(btcReturn1h),
      ethReturn1h: round(ethReturn1h),
      marketMedianReturn1h: round(marketReturn1h),
    },
    market: { breadth: marketBreadth(items) },
    selectedSymbols: finalSelected.map((item) => item.symbol),
    leaders: [...items].sort((left, right) => Number(right.return1h) - Number(left.return1h)).slice(0, 10).map(summaryItem),
    laggards: [...items].sort((left, right) => Number(left.return1h) - Number(right.return1h)).slice(0, 10).map(summaryItem),
    activityLeaders: byActivity.slice(0, 10).map(summaryItem),
    rankVelocityLeaders: byVelocity.slice(0, 10).map(summaryItem),
    items,
  };
}

export function marketRadarContext(snapshot, item) {
  if (!snapshot || !item) return null;
  return {
    version: snapshot.version,
    schemaRevision: snapshot.schemaRevision,
    snapshotId: snapshot.snapshotId,
    generatedAt: snapshot.generatedAt,
    moverDataClosedAt: item.moverDataClosedAt ?? null,
    marketDirection: snapshot.market?.breadth?.direction ?? "MIXED",
    radarTier: item.radarTier,
    radarScore: item.radarScore,
    radarRank: item.radarRank,
    selected: item.selected === true,
    bias: item.bias,
    moverRank: item.moverRank,
    previousMoverRank: item.previousMoverRank,
    rankVelocity: item.rankVelocity,
    rankPersistence: item.rankPersistence,
    return15m: item.return15m,
    return1h: item.return1h,
    return4h: item.return4h,
    relativeStrengthBtc1h: item.relativeStrengthBtc1h,
    relativeStrengthEth1h: item.relativeStrengthEth1h,
    relativeStrengthMarket1h: item.relativeStrengthMarket1h,
    volumeRatio15m: item.volumeRatio15m,
    volumeBuildRatio: item.volumeBuildRatio,
    compressionRatio: item.compressionRatio,
    nearestBoundaryAtr: item.nearestBoundaryAtr,
    rangePosition: item.rangePosition,
    structureWidthAtr: item.structureWidthAtr,
    overextensionRisk: item.overextensionRisk,
    liquidityRank: item.liquidityRank,
    opportunitySources: [...(item.opportunitySources ?? [])],
    tags: [...(item.tags ?? [])],
    reasons: [...(item.reasons ?? [])],
  };
}

export function marketRadarSourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}
