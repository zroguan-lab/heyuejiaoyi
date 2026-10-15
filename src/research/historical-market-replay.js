import { buildMarketRegime } from "../domain/market-regime.js";
import {
  buildMarketRadarSnapshot,
  deriveMoverMetrics,
  marketRadarContext,
} from "../domain/market-radar.js";
import {
  analyzeV23SignalSnapshot,
  runV23StrategyAdapter,
  V23_HISTORICAL_ADAPTER,
} from "../domain/v2-3-strategy-engine.js";
import { HISTORICAL_DATA_TYPES } from "./historical-data-catalog.js";

export const STRICT_POINT_IN_TIME_METADATA = "POINT_IN_TIME_STRICT";
export const RESEARCH_CURRENT_METADATA = "CURRENT_SNAPSHOT_RESEARCH_ONLY";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const STABLE_BASES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD"]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function orderedClosedMinutes(candles, decisionTime) {
  return [...(candles ?? [])]
    .filter((item) => Number.isFinite(Number(item?.openTime)) && Number.isFinite(Number(item?.closeTime)))
    .filter((item) => Number(item.closeTime) <= decisionTime)
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
}

export function aggregateClosedKlines(candles = [], intervalMs, { decisionTime = Infinity } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < MINUTE_MS || intervalMs % MINUTE_MS !== 0) {
    throw new Error("历史K线聚合周期必须是完整分钟倍数");
  }
  const expected = intervalMs / MINUTE_MS;
  const buckets = new Map();
  for (const candle of orderedClosedMinutes(candles, decisionTime)) {
    const openTime = Number(candle.openTime);
    const bucketOpen = Math.floor(openTime / intervalMs) * intervalMs;
    const bucketClose = bucketOpen + intervalMs - 1;
    if (bucketClose > decisionTime) continue;
    if (!buckets.has(bucketOpen)) buckets.set(bucketOpen, new Map());
    const bucket = buckets.get(bucketOpen);
    if (bucket.has(openTime)) throw new Error(`HISTORICAL_DUPLICATE_MINUTE:${openTime}`);
    bucket.set(openTime, candle);
  }

  const result = [];
  for (const [bucketOpen, byTime] of [...buckets.entries()].sort((left, right) => left[0] - right[0])) {
    if (byTime.size !== expected) continue;
    const rows = [...byTime.values()].sort((left, right) => Number(left.openTime) - Number(right.openTime));
    const complete = rows.every((row, index) => Number(row.openTime) === bucketOpen + index * MINUTE_MS
      && Number(row.closeTime) === Number(row.openTime) + MINUTE_MS - 1);
    if (!complete) continue;
    result.push({
      openTime: bucketOpen,
      open: Number(rows[0].open),
      high: Math.max(...rows.map((row) => Number(row.high))),
      low: Math.min(...rows.map((row) => Number(row.low))),
      close: Number(rows.at(-1).close),
      volume: rows.reduce((sum, row) => sum + (finite(row.volume) ?? 0), 0),
      closeTime: bucketOpen + intervalMs - 1,
      quoteVolume: rows.reduce((sum, row) => sum + (finite(row.quoteVolume) ?? (Number(row.close) * (finite(row.volume) ?? 0))), 0),
      trades: rows.reduce((sum, row) => sum + (finite(row.trades) ?? 0), 0),
    });
  }
  return result;
}

function exactTrailingDay(candles, decisionTime) {
  const closed = orderedClosedMinutes(candles, decisionTime);
  const expectedLastOpen = Math.floor((decisionTime - (MINUTE_MS - 1)) / MINUTE_MS) * MINUTE_MS;
  const window = closed.filter((item) => Number(item.openTime) >= expectedLastOpen - (1_439 * MINUTE_MS)
    && Number(item.openTime) <= expectedLastOpen);
  if (window.length !== 1_440) return null;
  const continuous = window.every((item, index) => Number(item.openTime) === expectedLastOpen - (1_439 - index) * MINUTE_MS);
  return continuous ? window : null;
}

function selectContractSnapshot(contractRecords, decisionTime, metadataPolicy) {
  const captureTimes = [...new Set((contractRecords ?? []).map((item) => Number(item.capturedAt)).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const past = captureTimes.filter((time) => time <= decisionTime);
  let capturedAt = past.at(-1) ?? null;
  let survivorshipBias = false;
  if (capturedAt === null && metadataPolicy === RESEARCH_CURRENT_METADATA && captureTimes.length) {
    capturedAt = captureTimes[0];
    survivorshipBias = true;
  }
  if (capturedAt === null) {
    throw new Error("HISTORICAL_POINT_IN_TIME_CONTRACT_SNAPSHOT_UNAVAILABLE");
  }
  return {
    capturedAt,
    survivorshipBias,
    records: contractRecords.filter((item) => Number(item.capturedAt) === capturedAt),
  };
}

function latestSpread(spreadSnapshots, symbol, decisionTime, maximumAgeMs) {
  const rows = Array.isArray(spreadSnapshots?.[symbol]) ? spreadSnapshots[symbol] : [];
  const latest = [...rows]
    .filter((item) => Number(item.time) <= decisionTime && Number.isFinite(Number(item.spreadBps)))
    .sort((left, right) => Number(left.time) - Number(right.time))
    .at(-1) ?? null;
  return latest && decisionTime - Number(latest.time) <= maximumAgeMs ? latest : null;
}

function latestMarketCoverage(marketCoverageSnapshots, decisionTime) {
  return [...(marketCoverageSnapshots ?? [])]
    .filter((item) => Number(item?.asOf) <= decisionTime)
    .sort((left, right) => Number(left.asOf) - Number(right.asOf))
    .at(-1) ?? null;
}

function radarOptions(config, previousSnapshot, decisionTime) {
  const radar = config.marketRadar;
  return {
    previousSnapshot,
    now: decisionTime,
    discoverySize: radar.discoverySize,
    deepScanSize: radar.deepScanSize,
    minimumHoldMs: radar.minimumHoldMinutes * 60_000,
    coreMinimumScore: radar.coreMinimumScore,
    maxSpreadBps: config.universe.maxSpreadBps,
    gainerCount: radar.gainerCount,
    loserCount: radar.loserCount,
    rankVelocityCount: radar.rankVelocityCount,
    volumeShockCount: radar.volumeShockCount,
    minimumVolumeShockRatio: radar.minimumVolumeShockRatio,
    compressionCount: radar.compressionCount,
    boundaryPressureCount: radar.boundaryPressureCount,
    earlyAccelerationCount: radar.earlyAccelerationCount,
  };
}

export function buildHistoricalRadarPoint({
  marketData,
  contractRecords,
  decisionTime,
  previousSnapshot = null,
  config,
  metadataPolicy = STRICT_POINT_IN_TIME_METADATA,
  spreadSnapshots = null,
  marketCoverage = null,
} = {}) {
  if (!marketData || !config?.marketRadar || !Number.isFinite(decisionTime)) {
    throw new TypeError("历史雷达重建缺少marketData、config或decisionTime");
  }
  if (![STRICT_POINT_IN_TIME_METADATA, RESEARCH_CURRENT_METADATA].includes(metadataPolicy)) {
    throw new Error(`不支持的历史元数据政策: ${metadataPolicy}`);
  }
  const contractSnapshot = selectContractSnapshot(contractRecords, decisionTime, metadataPolicy);
  const contractSnapshotAgeMs = contractSnapshot.capturedAt <= decisionTime ? decisionTime - contractSnapshot.capturedAt : null;
  const contractSnapshotFutureLeadMs = contractSnapshot.capturedAt > decisionTime ? contractSnapshot.capturedAt - decisionTime : 0;
  const contractSnapshotStale = contractSnapshotAgeMs !== null
    && contractSnapshotAgeMs > Number(config.universe.refreshHours ?? 168) * 3_600_000;
  const contractBySymbol = new Map(contractSnapshot.records.map((item) => [item.symbol, item]));
  const aggregates = new Map();
  const rawItems = [];

  for (const [symbol, candles] of Object.entries(marketData)) {
    const contract = contractBySymbol.get(symbol);
    if (!contract || contract.status !== "TRADING" || contract.contractType !== "PERPETUAL" || contract.quoteAsset !== "USDT") continue;
    if (STABLE_BASES.has(contract.baseAsset)) continue;
    const onboardDate = Number(contract.onboardDate);
    if (!Number.isFinite(onboardDate) || decisionTime - onboardDate < config.universe.minListingDays * 86_400_000) continue;
    const trailingDay = exactTrailingDay(candles, decisionTime);
    if (!trailingDay) continue;
    const closed = orderedClosedMinutes(candles, decisionTime);
    const fifteen = aggregateClosedKlines(closed, 15 * MINUTE_MS, { decisionTime });
    const five = aggregateClosedKlines(closed, 5 * MINUTE_MS, { decisionTime });
    const hourly = aggregateClosedKlines(closed, 60 * MINUTE_MS, { decisionTime });
    const fourHour = aggregateClosedKlines(closed, 4 * 60 * MINUTE_MS, { decisionTime });
    const moverMetrics = deriveMoverMetrics(fifteen.slice(-config.marketRadar.moverCandleLimit));
    if (!moverMetrics.moverDataComplete) continue;
    const spread = latestSpread(
      spreadSnapshots,
      symbol,
      decisionTime,
      Math.max(60_000, config.marketRadar.refreshMinutes * 60_000),
    );
    const spreadBps = spread ? Number(spread.spreadBps) : Number(config.universe.maxSpreadBps);
    const quoteVolume24h = trailingDay.reduce((sum, item) => sum + (finite(item.quoteVolume) ?? Number(item.close) * (finite(item.volume) ?? 0)), 0);
    const item = {
      symbol,
      baseAsset: contract.baseAsset,
      onboardDate,
      quoteVolume24h,
      lastPrice: Number(trailingDay.at(-1).close),
      priceChangePercent24h: ((Number(trailingDay.at(-1).close) / Number(trailingDay[0].open)) - 1) * 100,
      highPrice24h: Math.max(...trailingDay.map((row) => Number(row.high))),
      lowPrice24h: Math.min(...trailingDay.map((row) => Number(row.low))),
      tradeCount24h: trailingDay.reduce((sum, row) => sum + (finite(row.trades) ?? 0), 0),
      spreadBps,
      historicalInputQuality: {
        contractSnapshotCapturedAt: contractSnapshot.capturedAt,
        contractSurvivorshipBias: contractSnapshot.survivorshipBias,
        spreadModel: spread ? "POINT_IN_TIME_SNAPSHOT" : "CONSERVATIVE_MAX_BPS_PROXY",
      },
      ...moverMetrics,
    };
    rawItems.push(item);
    aggregates.set(symbol, { oneMinute: closed, five, fifteen, hourly, fourHour, universeItem: item });
  }
  if (!rawItems.length) throw new Error("HISTORICAL_RADAR_NO_ELIGIBLE_SYMBOLS");
  const snapshot = buildMarketRadarSnapshot(rawItems, radarOptions(config, previousSnapshot, decisionTime));
  const discoveryInputs = [...rawItems]
    .sort((left, right) => Number(right.quoteVolume24h) - Number(left.quoteVolume24h))
    .slice(0, config.marketRadar.discoverySize);
  const exactSpreadCount = discoveryInputs.filter((item) => item.historicalInputQuality.spreadModel === "POINT_IN_TIME_SNAPSHOT").length;
  const exactSpreadCoverage = exactSpreadCount === discoveryInputs.length;
  const declaredCoverageTime = Number(marketCoverage?.asOf);
  const marketCoverageDeclared = marketCoverage?.complete === true
    && (!Number.isFinite(declaredCoverageTime) || declaredCoverageTime <= decisionTime);
  const marketCoverageComplete = marketCoverageDeclared && rawItems.length >= config.marketRadar.discoverySize;
  snapshot.reconstruction = {
    decisionTime,
    metadataPolicy,
    contractSnapshotCapturedAt: contractSnapshot.capturedAt,
    contractSnapshotAgeMs,
    contractSnapshotFutureLeadMs,
    contractSnapshotStale,
    survivorshipBias: contractSnapshot.survivorshipBias,
    spreadModel: exactSpreadCoverage
      ? "POINT_IN_TIME_SNAPSHOT"
      : exactSpreadCount > 0 ? "MIXED_POINT_IN_TIME_OR_CONSERVATIVE" : "CONSERVATIVE_MAX_BPS_PROXY",
    exactSpreadCount,
    spreadUniverseSize: discoveryInputs.length,
    catalogEligibleSymbols: rawItems.length,
    requiredDiscoverySize: config.marketRadar.discoverySize,
    marketCoverageSource: marketCoverage?.source ?? null,
    marketCoverageDeclared,
    marketCoverageComplete,
    promotionEligible: !contractSnapshot.survivorshipBias
      && !contractSnapshotStale
      && exactSpreadCoverage
      && marketCoverageComplete,
  };
  return {
    snapshot,
    aggregates,
    universe: rawItems.sort((left, right) => right.quoteVolume24h - left.quoteVolume24h),
  };
}

function fundingPremiumAt(funding = [], decisionTime) {
  const latest = [...funding]
    .filter((item) => Number(item.fundingTime) <= decisionTime)
    .sort((left, right) => Number(left.fundingTime) - Number(right.fundingTime))
    .at(-1);
  if (!latest) return null;
  let nextFundingTime = Number(latest.fundingTime) + 8 * 3_600_000;
  while (nextFundingTime <= decisionTime) nextFundingTime += 8 * 3_600_000;
  return {
    symbol: latest.symbol,
    markPrice: Number(latest.markPrice),
    lastFundingRate: Number(latest.rate),
    nextFundingTime,
    time: Number(latest.fundingTime),
    historicalApproximation: "LAST_SETTLED_RATE_NO_FUTURE_LOOKAHEAD",
  };
}

function strategyInput({ symbol, radarPoint, decisionTime, config, fundingBySymbol, equity }) {
  const aggregate = radarPoint.aggregates.get(symbol);
  const radarItem = radarPoint.snapshot.items.find((item) => item.symbol === symbol);
  const universeIndex = radarPoint.universe.findIndex((item) => item.symbol === symbol);
  return {
    symbol,
    hourly: aggregate.hourly,
    fifteen: aggregate.fifteen,
    five: aggregate.five,
    radar: {
      ...marketRadarContext(radarPoint.snapshot, radarItem),
      reconstruction: radarPoint.snapshot.reconstruction,
    },
    universeItem: aggregate.universeItem,
    universeIndex,
    universeSize: radarPoint.universe.length,
    primarySource: "binance-historical-catalog",
    decisionTime,
    premium: fundingPremiumAt(fundingBySymbol?.[symbol] ?? [], decisionTime),
    equity: equity ?? config.portfolio.startingEquity,
  };
}

export function runHistoricalV23Point({
  marketData,
  contractRecords,
  fundingBySymbol = {},
  decisionTime,
  previousRadar = null,
  config,
  metadataPolicy = STRICT_POINT_IN_TIME_METADATA,
  spreadSnapshots = null,
  marketCoverage = null,
  marketCoverageSnapshots = null,
  equity = null,
} = {}) {
  const pointInTimeMarketCoverage = latestMarketCoverage(marketCoverageSnapshots, decisionTime) ?? marketCoverage;
  const radarPoint = buildHistoricalRadarPoint({
    marketData,
    contractRecords,
    decisionTime,
    previousSnapshot: previousRadar,
    config,
    metadataPolicy,
    spreadSnapshots,
    marketCoverage: pointInTimeMarketCoverage,
  });
  const inputs = radarPoint.snapshot.selectedSymbols
    .filter((symbol) => radarPoint.aggregates.has(symbol))
    .map((symbol) => strategyInput({ symbol, radarPoint, decisionTime, config, fundingBySymbol, equity }));
  const preliminary = inputs.map((input) => analyzeV23SignalSnapshot(input, {
    strategyConfig: config.strategy,
    costsConfig: config.costs,
  }));
  const btc = radarPoint.aggregates.get("BTCUSDT");
  if (!btc) throw new Error("HISTORICAL_REGIME_REQUIRES_BTCUSDT");
  const marketRegime = buildMarketRegime({
    btcFourHour: btc.fourHour,
    btcHourly: btc.hourly,
    analyses: preliminary,
    config: config.strategy,
  });
  const decisions = inputs.map((input) => runV23StrategyAdapter({
    adapter: V23_HISTORICAL_ADAPTER,
    snapshot: { ...input, marketRegime },
    config,
  }));
  return {
    decisionTime,
    radar: radarPoint.snapshot,
    marketRegime,
    decisions,
    candidateCount: decisions.reduce((sum, item) => sum + item.decision.candidates.length, 0),
    promotionEligible: radarPoint.snapshot.reconstruction.promotionEligible,
  };
}

export function runHistoricalV23Timeline({ decisionTimes = [], ...options } = {}) {
  const times = [...new Set(decisionTimes.map(Number).filter(Number.isFinite))].sort((left, right) => left - right);
  if (!times.length) throw new Error("历史V2.3时间线至少需要一个决策时间");
  const results = [];
  let previousRadar = options.previousRadar ?? null;
  for (const decisionTime of times) {
    const result = runHistoricalV23Point({ ...options, previousRadar, decisionTime });
    results.push(result);
    previousRadar = result.radar;
  }
  return results;
}

export function historicalReplayWarmupMs(config = {}) {
  const strategy = config.strategy ?? {};
  const slowTrendHours = (Number(strategy.emaSlow ?? 50) + Number(strategy.slopeLookback ?? 3) + 5) * 4;
  const volatilityHours = Number(strategy.atrPeriod ?? 14) + 180 + 5;
  return Math.max(24, slowTrendHours, volatilityHours) * HOUR_MS;
}

export async function resolveHistoricalReplayWindow({
  catalog,
  symbols = null,
  decisionPoints = 1,
  stepMs = 5 * MINUTE_MS,
  warmupMs,
  config = {},
} = {}) {
  if (!catalog || typeof catalog.availableCoverageRanges !== "function") {
    throw new TypeError("解析历史重放窗口需要支持覆盖范围查询的catalog");
  }
  if (!Number.isInteger(decisionPoints) || decisionPoints < 1) throw new Error("历史重放决策点数量必须是正整数");
  if (!Number.isFinite(stepMs) || stepMs < MINUTE_MS) throw new Error("历史重放步长至少为1分钟");
  const selectedSymbols = symbols?.length ? [...new Set(symbols)] : await catalog.availableSymbols();
  const ranges = await catalog.availableCoverageRanges({
    dataType: HISTORICAL_DATA_TYPES.KLINES,
    interval: "1m",
    symbols: selectedSymbols,
  });
  if (!ranges.length) throw new Error("历史目录没有可重放的1分钟K线覆盖范围");
  const covered = new Set(ranges.map((item) => item.symbol));
  const replaySymbols = selectedSymbols.filter((symbol) => covered.has(symbol));
  const decisionEndTime = Math.min(...ranges.map((item) => Number(item.lastTime) + MINUTE_MS - 1));
  const decisionStartTime = decisionEndTime - (decisionPoints - 1) * Number(stepMs);
  const effectiveWarmupMs = Number.isFinite(warmupMs) ? Number(warmupMs) : historicalReplayWarmupMs(config);
  if (effectiveWarmupMs < 24 * HOUR_MS) throw new Error("历史重放预热窗口不能少于24小时");
  return {
    symbols: replaySymbols,
    ranges,
    decisionStartTime,
    decisionEndTime,
    loadStartTime: decisionStartTime - effectiveWarmupMs,
    loadEndTime: decisionEndTime,
    warmupMs: effectiveWarmupMs,
  };
}

export async function loadHistoricalReplayInputs({ catalog, symbols = null, startTime = -Infinity, endTime = Infinity } = {}) {
  if (!catalog) throw new TypeError("加载历史重放数据需要catalog");
  if (finite(startTime) !== null && finite(endTime) !== null && Number(startTime) > Number(endTime)) {
    throw new Error("历史重放加载窗口起点不能晚于终点");
  }
  const selectedSymbols = symbols?.length ? [...new Set(symbols)] : await catalog.availableSymbols();
  const marketData = {};
  const fundingBySymbol = {};
  for (const symbol of selectedSymbols) {
    marketData[symbol] = await catalog.queryRecords({
      dataType: HISTORICAL_DATA_TYPES.KLINES,
      symbol,
      interval: "1m",
      startTime,
      endTime,
    });
    fundingBySymbol[symbol] = await catalog.queryRecords({
      dataType: HISTORICAL_DATA_TYPES.FUNDING,
      symbol,
      interval: null,
      startTime: Number.isFinite(Number(startTime)) ? Number(startTime) - 8 * HOUR_MS : startTime,
      endTime,
    });
  }
  const contractRecords = await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.CONTRACTS,
    symbol: "ALL",
    interval: null,
  });
  const universeRecords = await catalog.queryRecords({
    dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
    symbol: "ALL",
    interval: null,
  });
  const spreadSnapshots = {};
  for (const snapshot of universeRecords) {
    for (const item of snapshot.items ?? []) {
      if (!spreadSnapshots[item.symbol]) spreadSnapshots[item.symbol] = [];
      spreadSnapshots[item.symbol].push({
        time: Number(snapshot.capturedAt),
        spreadBps: Number(item.spreadBps),
        bidPrice: Number(item.bidPrice),
        askPrice: Number(item.askPrice),
        liquidityRank: Number(item.liquidityRank),
      });
    }
  }
  const marketCoverageSnapshots = universeRecords.map((snapshot) => ({
    asOf: Number(snapshot.capturedAt),
    complete: snapshot.complete === true,
    source: "BINANCE_POINT_IN_TIME_UNIVERSE_SNAPSHOT",
    eligibleCount: Number(snapshot.eligibleCount),
    discoverySize: Number(snapshot.discoverySize),
  }));
  return {
    symbols: selectedSymbols,
    marketData,
    fundingBySymbol,
    contractRecords,
    spreadSnapshots,
    marketCoverageSnapshots,
    inputWindow: { startTime, endTime },
  };
}
