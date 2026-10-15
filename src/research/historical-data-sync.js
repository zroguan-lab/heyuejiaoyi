import {
  HISTORICAL_DATA_TYPES,
  partitionRecordsByCatalogPeriod,
  partitionRecordsByUtcMonth,
  utcMonthBounds,
} from "./historical-data-catalog.js";

function boundedRange(partition, startTime, endTime) {
  const bounds = utcMonthBounds(partition);
  return {
    startTime: Math.max(bounds.startTime, startTime),
    endTime: Math.min(bounds.endTime, endTime),
  };
}

export function selectUniverseBackfillBatch(snapshot, { offset = 0, count = 50 } = {}) {
  if (!snapshot?.complete || !Array.isArray(snapshot.items)) throw new Error("历史回填需要完整的全市场快照");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("历史回填 offset 必须是非负整数");
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("历史回填 count 必须是1到50的整数");
  return snapshot.items.slice(offset, offset + count).map((item) => ({
    symbol: item.symbol,
    liquidityRank: Number(item.liquidityRank),
  }));
}

export function buildUniverseBackfillPlan(snapshots, {
  offset = 0,
  count = 50,
  days = 7,
  snapshotCapturedAt = null,
} = {}) {
  if (!Array.isArray(snapshots) || !snapshots.length) throw new Error("历史回填需要至少一份已封存全市场快照");
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new Error("历史同步天数必须是 1 到 180 的整数");
  if (offset > 0 && !Number.isFinite(snapshotCapturedAt)) {
    throw new Error("分批历史回填必须指定首批使用的 snapshotCapturedAt，防止排名与时间窗漂移");
  }
  const ordered = [...snapshots].sort((left, right) => Number(left.capturedAt) - Number(right.capturedAt));
  const snapshot = Number.isFinite(snapshotCapturedAt)
    ? ordered.find((item) => Number(item.capturedAt) === Number(snapshotCapturedAt))
    : ordered.at(-1);
  if (!snapshot) throw new Error(`找不到已封存全市场快照: ${snapshotCapturedAt}`);
  const capturedAt = Number(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt)) throw new Error("全市场快照 capturedAt 无效");
  const endTime = Math.floor(capturedAt / 60_000) * 60_000 - 1;
  const startTime = endTime - days * 86_400_000 + 1;
  return {
    snapshot,
    rankedSelection: selectUniverseBackfillBatch(snapshot, { offset, count }),
    range: { startTime, endTime },
  };
}

async function persistPartitions({ catalog, descriptor, records, source, startTime, endTime }) {
  const outputs = [];
  for (const [partition, rows] of partitionRecordsByUtcMonth(records, descriptor.dataType)) {
    outputs.push(await catalog.writePartition({
      descriptor: { ...descriptor, partition },
      records: rows,
      source,
      requestedRange: boundedRange(partition, startTime, endTime),
    }));
  }
  return outputs;
}

export async function syncHistoricalSymbol({
  client,
  catalog,
  symbol,
  startTime,
  endTime,
  interval = "1m",
  includeFunding = true,
  sourceBaseUrl = null,
} = {}) {
  if (!client || !catalog) throw new TypeError("历史同步需要 client 和 catalog");
  const normalizedSymbol = String(symbol ?? "").toUpperCase();
  if (!/^[A-Z0-9]{1,20}USDT$/.test(normalizedSymbol)) throw new Error(`无效历史交易对: ${symbol}`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new Error("历史同步区间无效");

  const step = interval === "1m" ? 60_000 : null;
  if (!step) throw new Error("M2 原始目录当前只同步 1m K线；更高周期由后续重放层派生");
  const maximumRows = Math.min(1_000_000, Math.ceil((endTime - startTime + 1) / step) + 10);
  const candles = await client.fetchHistoricalKlines(normalizedSymbol, interval, {
    startTime,
    endTime,
    maxCandles: maximumRows,
  });
  const source = {
    provider: "BINANCE_PUBLIC_MARKET_DATA",
    baseUrl: sourceBaseUrl ?? client.baseUrl ?? null,
    endpoint: "/fapi/v1/klines",
    fetchedAt: new Date().toISOString(),
  };
  const klineDatasets = await persistPartitions({
    catalog,
    descriptor: {
      exchange: "BINANCE",
      market: "USD_M_PERPETUAL",
      dataType: HISTORICAL_DATA_TYPES.KLINES,
      symbol: normalizedSymbol,
      interval,
    },
    records: candles,
    source,
    startTime,
    endTime,
  });

  let funding = [];
  let fundingDatasets = [];
  if (includeFunding) {
    funding = await client.fetchFundingRates(normalizedSymbol, { startTime, endTime });
    if (funding.length) {
      fundingDatasets = await persistPartitions({
        catalog,
        descriptor: {
          exchange: "BINANCE",
          market: "USD_M_PERPETUAL",
          dataType: HISTORICAL_DATA_TYPES.FUNDING,
          symbol: normalizedSymbol,
          interval: null,
        },
        records: funding,
        source: { ...source, endpoint: "/fapi/v1/fundingRate" },
        startTime,
        endTime,
      });
    }
  }

  const coverage = await catalog.auditCoverage({
    exchange: "BINANCE",
    market: "USD_M_PERPETUAL",
    dataType: HISTORICAL_DATA_TYPES.KLINES,
    symbol: normalizedSymbol,
    interval,
    startTime,
    endTime,
  });
  return {
    symbol: normalizedSymbol,
    interval,
    startTime,
    endTime,
    klineRows: candles.length,
    fundingRows: funding.length,
    klineDatasets: klineDatasets.map((item) => item.id),
    fundingDatasets: fundingDatasets.map((item) => item.id),
    coverage,
  };
}

export async function syncContractMetadata({ client, catalog, capturedAt = null, sourceBaseUrl = null } = {}) {
  if (!client || !catalog) throw new TypeError("合约元数据同步需要 client 和 catalog");
  const payload = await client.request("/fapi/v1/exchangeInfo");
  if (!Array.isArray(payload?.symbols)) throw new Error("Binance exchangeInfo 响应格式不正确");
  const effectiveCapturedAt = Number.isFinite(capturedAt) ? Number(capturedAt) : Date.now();
  const records = payload.symbols
    .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT")
    .map((item) => ({
      capturedAt: effectiveCapturedAt,
      symbol: item.symbol,
      pair: item.pair,
      contractType: item.contractType,
      status: item.status,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      marginAsset: item.marginAsset,
      onboardDate: Number(item.onboardDate),
      deliveryDate: Number(item.deliveryDate),
      pricePrecision: Number(item.pricePrecision),
      quantityPrecision: Number(item.quantityPrecision),
      filters: item.filters,
    }));
  if (!records.length) throw new Error("Binance exchangeInfo 没有 USDT 永续合约");
  const [partition] = partitionRecordsByUtcMonth(records, HISTORICAL_DATA_TYPES.CONTRACTS).keys();
  return catalog.writePartition({
    descriptor: {
      exchange: "BINANCE",
      market: "USD_M_PERPETUAL",
      dataType: HISTORICAL_DATA_TYPES.CONTRACTS,
      symbol: "ALL",
      interval: null,
      partition,
    },
    records,
    source: {
      provider: "BINANCE_PUBLIC_MARKET_DATA",
      baseUrl: sourceBaseUrl ?? client.baseUrl ?? null,
      endpoint: "/fapi/v1/exchangeInfo",
      fetchedAt: new Date().toISOString(),
    },
    requestedRange: { startTime: effectiveCapturedAt, endTime: effectiveCapturedAt },
  });
}

export async function syncMarketUniverseSnapshot({
  client,
  catalog,
  capturedAt = null,
  minListingDays = 90,
  maxSpreadBps = 20,
  discoverySize = 100,
  sourceBaseUrl = null,
} = {}) {
  if (!client || !catalog) throw new TypeError("全市场快照同步需要 client 和 catalog");
  const snapshot = await client.fetchUniverseSnapshot({
    minListingDays,
    maxSpreadBps,
    discoverySize,
    ...(Number.isFinite(capturedAt) ? { now: Number(capturedAt) } : {}),
  });
  const [partition] = partitionRecordsByCatalogPeriod([snapshot], HISTORICAL_DATA_TYPES.UNIVERSE).keys();
  return catalog.writePartition({
    descriptor: {
      exchange: "BINANCE",
      market: "USD_M_PERPETUAL",
      dataType: HISTORICAL_DATA_TYPES.UNIVERSE,
      symbol: "ALL",
      interval: null,
      partition,
    },
    records: [snapshot],
    source: {
      provider: "BINANCE_PUBLIC_MARKET_DATA",
      baseUrl: sourceBaseUrl ?? client.baseUrl ?? null,
      endpoints: ["/fapi/v1/exchangeInfo", "/fapi/v1/ticker/24hr", "/fapi/v1/ticker/bookTicker"],
      fetchedAt: new Date(snapshot.capturedAt).toISOString(),
    },
    requestedRange: { startTime: snapshot.capturedAt, endTime: snapshot.capturedAt },
  });
}
