import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const HISTORICAL_CATALOG_VERSION = "BINANCE_USDM_HISTORY_V1";
export const HISTORICAL_DATA_TYPES = Object.freeze({
  KLINES: "KLINES",
  FUNDING: "FUNDING",
  CONTRACTS: "CONTRACTS",
  UNIVERSE: "UNIVERSE",
});

export const HISTORICAL_INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
});

const SYMBOL_PATTERN = /^(?:[A-Z0-9]{1,20}USDT|ALL)$/;
const MONTH_PARTITION_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const HOUR_PARTITION_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3])$/;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalNdjson(records) {
  if (!records.length) return "";
  return `${records.map((record) => JSON.stringify(stableValue(record))).join("\n")}\n`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function normalizedDescriptor(input = {}) {
  const descriptor = {
    exchange: String(input.exchange ?? "BINANCE").toUpperCase(),
    market: String(input.market ?? "USD_M_PERPETUAL").toUpperCase(),
    dataType: String(input.dataType ?? "").toUpperCase(),
    symbol: String(input.symbol ?? "").toUpperCase(),
    interval: input.interval ? String(input.interval) : null,
    partition: String(input.partition ?? ""),
  };
  if (descriptor.exchange !== "BINANCE" || descriptor.market !== "USD_M_PERPETUAL") {
    throw new Error("历史目录当前只接受 Binance USD-M 永续数据");
  }
  if (!Object.values(HISTORICAL_DATA_TYPES).includes(descriptor.dataType)) {
    throw new Error(`不支持的历史数据类型: ${descriptor.dataType}`);
  }
  if (!SYMBOL_PATTERN.test(descriptor.symbol)) throw new Error(`无效历史交易对: ${descriptor.symbol}`);
  const validMonthlyPartition = MONTH_PARTITION_PATTERN.test(descriptor.partition);
  const validHourlyUniversePartition = descriptor.dataType === HISTORICAL_DATA_TYPES.UNIVERSE
    && HOUR_PARTITION_PATTERN.test(descriptor.partition);
  if (!validMonthlyPartition && !validHourlyUniversePartition) {
    throw new Error(`无效历史分区: ${descriptor.partition}`);
  }
  if (descriptor.dataType === HISTORICAL_DATA_TYPES.KLINES && !HISTORICAL_INTERVAL_MS[descriptor.interval]) {
    throw new Error(`K线历史目录不支持周期: ${descriptor.interval}`);
  }
  if (descriptor.dataType !== HISTORICAL_DATA_TYPES.KLINES && descriptor.interval !== null) {
    throw new Error(`${descriptor.dataType} 数据不应设置 interval`);
  }
  if ([HISTORICAL_DATA_TYPES.CONTRACTS, HISTORICAL_DATA_TYPES.UNIVERSE].includes(descriptor.dataType)
    && descriptor.symbol !== "ALL") {
    throw new Error(`${descriptor.dataType} 元数据必须使用 ALL 作为 symbol`);
  }
  return descriptor;
}

export function historicalDatasetId(input) {
  const item = normalizedDescriptor(input);
  return [item.exchange, item.market, item.dataType, item.symbol, item.interval ?? "NA", item.partition].join(":");
}

function recordTime(dataType, record) {
  if (dataType === HISTORICAL_DATA_TYPES.KLINES) return Number(record?.openTime);
  if (dataType === HISTORICAL_DATA_TYPES.FUNDING) return Number(record?.fundingTime);
  return Number(record?.capturedAt);
}

function recordKey(dataType, record) {
  const time = recordTime(dataType, record);
  if (dataType === HISTORICAL_DATA_TYPES.CONTRACTS) return `${time}:${String(record?.symbol ?? "")}`;
  return String(time);
}

function utcMonth(time) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new Error(`无效历史时间: ${time}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function utcHour(time) {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new Error(`无效历史时间: ${time}`);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}`;
}

function recordPartition(dataType, time, descriptorPartition) {
  if (dataType === HISTORICAL_DATA_TYPES.UNIVERSE && HOUR_PARTITION_PATTERN.test(descriptorPartition)) {
    return utcHour(time);
  }
  return utcMonth(time);
}

function klineExpectedRange(startTime, endTime, step) {
  if (!finite(startTime) || !finite(endTime) || endTime < startTime) return null;
  const firstOpenTime = Math.ceil(Number(startTime) / step) * step;
  const lastOpenTime = Math.floor((Number(endTime) - (step - 1)) / step) * step;
  return lastOpenTime >= firstOpenTime
    ? { firstOpenTime, lastOpenTime, expectedRows: Math.floor((lastOpenTime - firstOpenTime) / step) + 1 }
    : { firstOpenTime: null, lastOpenTime: null, expectedRows: 0 };
}

export function auditHistoricalRecords(records = [], {
  dataType,
  interval = null,
  expectedStartTime = null,
  expectedEndTime = null,
} = {}) {
  const normalizedType = String(dataType ?? "").toUpperCase();
  if (!Object.values(HISTORICAL_DATA_TYPES).includes(normalizedType)) throw new Error(`无法审计数据类型: ${dataType}`);
  const step = normalizedType === HISTORICAL_DATA_TYPES.KLINES ? HISTORICAL_INTERVAL_MS[interval] : null;
  if (normalizedType === HISTORICAL_DATA_TYPES.KLINES && !step) throw new Error(`无法审计K线周期: ${interval}`);

  const invalid = [];
  const duplicateKeys = [];
  const seen = new Set();
  const ordered = [...records].sort((left, right) => {
    const delta = recordTime(normalizedType, left) - recordTime(normalizedType, right);
    return delta || recordKey(normalizedType, left).localeCompare(recordKey(normalizedType, right));
  });

  ordered.forEach((record, index) => {
    const time = recordTime(normalizedType, record);
    const key = recordKey(normalizedType, record);
    if (!Number.isFinite(time)) invalid.push({ index, reason: "INVALID_TIME" });
    if (seen.has(key)) duplicateKeys.push(key);
    seen.add(key);

    if (normalizedType === HISTORICAL_DATA_TYPES.KLINES) {
      const values = [record.open, record.high, record.low, record.close, record.volume, record.closeTime];
      if (!values.every(finite)) invalid.push({ index, reason: "INVALID_KLINE_NUMBER" });
      else if (Number(record.high) < Math.max(Number(record.open), Number(record.close), Number(record.low))
        || Number(record.low) > Math.min(Number(record.open), Number(record.close), Number(record.high))) {
        invalid.push({ index, reason: "INVALID_OHLC" });
      } else if (Number(record.volume) < 0) invalid.push({ index, reason: "NEGATIVE_VOLUME" });
      else if (Number(record.closeTime) !== time + step - 1) invalid.push({ index, reason: "INVALID_CLOSE_TIME" });
    } else if (normalizedType === HISTORICAL_DATA_TYPES.FUNDING) {
      if (!finite(record.rate) || !finite(record.markPrice) || Number(record.markPrice) <= 0) {
        invalid.push({ index, reason: "INVALID_FUNDING_RECORD" });
      }
    } else if (normalizedType === HISTORICAL_DATA_TYPES.CONTRACTS) {
      const contractSymbol = String(record.symbol ?? "");
      if (!contractSymbol.endsWith("USDT") || contractSymbol.length > 64 || /[\u0000-\u001f\\/]/u.test(contractSymbol) || !record.contractType) {
        invalid.push({ index, reason: "INVALID_CONTRACT_RECORD" });
      }
    } else {
      const items = Array.isArray(record.items) ? record.items : [];
      const uniqueSymbols = new Set(items.map((item) => item?.symbol));
      const validItems = items.every((item, itemIndex) => {
        const bidPrice = Number(item?.bidPrice);
        const askPrice = Number(item?.askPrice);
        const midpoint = (bidPrice + askPrice) / 2;
        const expectedSpreadBps = midpoint > 0 ? ((askPrice - bidPrice) / midpoint) * 10_000 : NaN;
        const validBaseFields = SYMBOL_PATTERN.test(String(item?.symbol ?? ""))
          && Number(item?.liquidityRank) === itemIndex + 1
          && finite(item?.quoteVolume24h) && Number(item.quoteVolume24h) > 0
          && finite(item?.spreadBps) && Number(item.spreadBps) >= 0;
        if (Number(record.schemaVersion ?? 1) < 2) return validBaseFields;
        return validBaseFields
          && Number.isFinite(bidPrice) && bidPrice > 0
          && Number.isFinite(askPrice) && askPrice >= bidPrice
          && Math.abs(Number(item.spreadBps) - expectedSpreadBps) <= 1e-6;
      });
      if (record.complete !== true
        || ![1, 2].includes(Number(record.schemaVersion ?? 1))
        || !Number.isInteger(Number(record.discoverySize)) || Number(record.discoverySize) < 1
        || Number(record.eligibleCount) !== items.length
        || !items.length
        || uniqueSymbols.size !== items.length
        || !validItems) {
        invalid.push({ index, reason: "INVALID_UNIVERSE_SNAPSHOT" });
      }
    }
  });

  const gaps = [];
  if (normalizedType === HISTORICAL_DATA_TYPES.KLINES) {
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = Number(ordered[index - 1].openTime);
      const current = Number(ordered[index].openTime);
      const delta = current - previous;
      if (delta > step) {
        gaps.push({
          afterOpenTime: previous,
          beforeOpenTime: current,
          missingBars: Number.isInteger(delta / step) ? (delta / step) - 1 : null,
          reason: Number.isInteger(delta / step) ? "MISSING_BARS" : "IRREGULAR_INTERVAL",
        });
      } else if (delta > 0 && delta !== step) {
        gaps.push({ afterOpenTime: previous, beforeOpenTime: current, missingBars: null, reason: "IRREGULAR_INTERVAL" });
      }
    }
  }

  const expected = normalizedType === HISTORICAL_DATA_TYPES.KLINES
    ? klineExpectedRange(expectedStartTime, expectedEndTime, step)
    : null;
  const firstTime = ordered.length ? recordTime(normalizedType, ordered[0]) : null;
  const lastTime = ordered.length ? recordTime(normalizedType, ordered.at(-1)) : null;
  const missingLeadingBars = expected?.expectedRows && firstTime > expected.firstOpenTime
    ? Math.floor((firstTime - expected.firstOpenTime) / step)
    : 0;
  const missingTrailingBars = expected?.expectedRows && lastTime < expected.lastOpenTime
    ? Math.floor((expected.lastOpenTime - lastTime) / step)
    : 0;
  const missingAllExpectedRows = expected?.expectedRows > 0 && ordered.length === 0 ? expected.expectedRows : 0;

  return {
    status: invalid.length || duplicateKeys.length || gaps.length || missingLeadingBars || missingTrailingBars || missingAllExpectedRows
      ? "GAPS_OR_INVALID"
      : "COMPLETE",
    rowCount: ordered.length,
    firstTime,
    lastTime,
    invalidRecordCount: invalid.length,
    invalidRecords: invalid.slice(0, 100),
    duplicateCount: duplicateKeys.length,
    duplicateKeys: duplicateKeys.slice(0, 100),
    gapCount: gaps.length,
    gaps: gaps.slice(0, 1_000),
    expectedRows: expected?.expectedRows ?? null,
    missingLeadingBars,
    missingTrailingBars,
    missingAllExpectedRows,
  };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { flag: "wx" });
  await rename(temporary, target);
}

function safeCatalogPath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("历史目录对象路径越界");
  return resolved;
}

function mergeRecords(dataType, existing, incoming) {
  const merged = new Map();
  for (const record of [...existing, ...incoming]) {
    const key = recordKey(dataType, record);
    const previous = merged.get(key);
    if (previous && JSON.stringify(stableValue(previous)) !== JSON.stringify(stableValue(record))) {
      throw new Error(`HISTORICAL_CONFLICTING_RECORD:${key}`);
    }
    merged.set(key, stableValue(record));
  }
  return [...merged.values()].sort((left, right) => {
    const delta = recordTime(dataType, left) - recordTime(dataType, right);
    return delta || recordKey(dataType, left).localeCompare(recordKey(dataType, right));
  });
}

export class HistoricalDataCatalog {
  constructor({
    root = path.resolve(process.cwd(), "research-data"),
    now = Date.now,
    writeLockWaitMs = 0,
    writeLockPollMs = 100,
  } = {}) {
    if (!Number.isFinite(writeLockWaitMs) || writeLockWaitMs < 0 || writeLockWaitMs > 300_000) {
      throw new Error("历史目录写锁等待时间必须是0到300000毫秒");
    }
    if (!Number.isFinite(writeLockPollMs) || writeLockPollMs < 10 || writeLockPollMs > 5_000) {
      throw new Error("历史目录写锁轮询间隔必须是10到5000毫秒");
    }
    this.root = path.resolve(root);
    this.manifestPath = path.join(this.root, "manifest.json");
    this.now = now;
    this.writeLockWaitMs = Number(writeLockWaitMs);
    this.writeLockPollMs = Number(writeLockPollMs);
    this.writeQueue = Promise.resolve();
  }

  async loadManifest() {
    if (!(await pathExists(this.manifestPath))) {
      return {
        catalogVersion: HISTORICAL_CATALOG_VERSION,
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        datasets: [],
      };
    }
    const manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
    if (manifest.catalogVersion !== HISTORICAL_CATALOG_VERSION || !Array.isArray(manifest.datasets)) {
      throw new Error("历史目录 manifest 版本或结构不兼容");
    }
    return manifest;
  }

  async readObject(object) {
    const objectPath = safeCatalogPath(this.root, object.path);
    const compressed = await readFile(objectPath);
    const decoded = await gunzip(compressed);
    const actualChecksum = sha256(decoded);
    if (actualChecksum !== object.checksum) throw new Error(`HISTORICAL_CHECKSUM_MISMATCH:${object.checksum}`);
    const text = decoded.toString("utf8");
    return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  }

  async readPartition(datasetId) {
    const manifest = await this.loadManifest();
    const dataset = manifest.datasets.find((item) => item.id === datasetId);
    if (!dataset) throw new Error(`历史数据分区不存在: ${datasetId}`);
    const revision = dataset.revisions.find((item) => item.id === dataset.currentRevisionId);
    if (!revision) throw new Error(`历史数据分区缺少当前修订: ${datasetId}`);
    return this.readObject(revision.object);
  }

  async queryRecords({
    exchange = "BINANCE",
    market = "USD_M_PERPETUAL",
    dataType,
    symbol,
    interval = null,
    startTime = -Infinity,
    endTime = Infinity,
  } = {}) {
    const normalizedType = String(dataType ?? "").toUpperCase();
    if (!Object.values(HISTORICAL_DATA_TYPES).includes(normalizedType)) throw new Error(`无法查询数据类型: ${dataType}`);
    const manifest = await this.loadManifest();
    const datasets = manifest.datasets.filter((item) => item.exchange === exchange
      && item.market === market
      && item.dataType === normalizedType
      && (symbol === undefined || item.symbol === symbol)
      && item.interval === interval
      && (!finite(startTime) || !finite(item.lastTime) || Number(item.lastTime) >= Number(startTime))
      && (!finite(endTime) || !finite(item.firstTime) || Number(item.firstTime) <= Number(endTime)));
    const rows = [];
    for (const dataset of datasets) {
      const revision = dataset.revisions.find((item) => item.id === dataset.currentRevisionId);
      if (!revision) throw new Error(`历史数据分区缺少当前修订: ${dataset.id}`);
      const records = await this.readObject(revision.object);
      rows.push(...records.filter((record) => {
        const time = recordTime(normalizedType, record);
        return time >= startTime && time <= endTime;
      }));
    }
    return mergeRecords(normalizedType, [], rows);
  }

  async availableSymbols({ dataType = HISTORICAL_DATA_TYPES.KLINES, interval = "1m" } = {}) {
    const manifest = await this.loadManifest();
    return [...new Set(manifest.datasets
      .filter((item) => item.dataType === dataType && item.interval === interval && item.symbol !== "ALL")
      .map((item) => item.symbol))]
      .sort();
  }

  async availableCoverageRanges({ dataType = HISTORICAL_DATA_TYPES.KLINES, interval = "1m", symbols = null } = {}) {
    const normalizedType = String(dataType ?? "").toUpperCase();
    if (!Object.values(HISTORICAL_DATA_TYPES).includes(normalizedType)) throw new Error(`无法汇总数据类型: ${dataType}`);
    const selected = symbols?.length ? new Set(symbols.map((item) => String(item).toUpperCase())) : null;
    const manifest = await this.loadManifest();
    const grouped = new Map();
    for (const dataset of manifest.datasets) {
      if (dataset.dataType !== normalizedType || dataset.interval !== interval || dataset.symbol === "ALL") continue;
      if (selected && !selected.has(dataset.symbol)) continue;
      if (!finite(dataset.firstTime) || !finite(dataset.lastTime)) continue;
      const current = grouped.get(dataset.symbol) ?? {
        symbol: dataset.symbol,
        firstTime: Number(dataset.firstTime),
        lastTime: Number(dataset.lastTime),
        rowCount: 0,
        partitionCount: 0,
      };
      current.firstTime = Math.min(current.firstTime, Number(dataset.firstTime));
      current.lastTime = Math.max(current.lastTime, Number(dataset.lastTime));
      current.rowCount += Number(dataset.rowCount ?? 0);
      current.partitionCount += 1;
      grouped.set(dataset.symbol, current);
    }
    return [...grouped.values()].sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  async withWriteLock(operation) {
    const previous = this.writeQueue;
    let releaseQueue;
    this.writeQueue = new Promise((resolve) => { releaseQueue = resolve; });
    await previous;
    const lockPath = path.join(this.root, ".writer.lock");
    let handle;
    try {
      await mkdir(this.root, { recursive: true });
      const deadline = Date.now() + this.writeLockWaitMs;
      while (!handle) {
        try {
          handle = await open(lockPath, "wx");
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          if (Date.now() >= deadline) {
            throw new Error("HISTORICAL_CATALOG_BUSY:已有同步进程持有写锁", { cause: error });
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(this.writeLockPollMs, Math.max(1, deadline - Date.now()))));
        }
      }
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date(this.now()).toISOString() })}\n`);
      return await operation();
    } catch (error) {
      throw error;
    } finally {
      if (handle) {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      }
      releaseQueue();
    }
  }

  async writePartition(input = {}) {
    return this.withWriteLock(() => this.writePartitionUnlocked(input));
  }

  async writePartitionUnlocked({ descriptor: input, records = [], source = {}, requestedRange = null } = {}) {
    const descriptor = normalizedDescriptor(input);
    if (!Array.isArray(records) || records.length === 0) throw new Error("历史分区不能写入空记录集");
    for (const record of records) {
      if (recordPartition(descriptor.dataType, recordTime(descriptor.dataType, record), descriptor.partition) !== descriptor.partition) {
        throw new Error(`历史记录不属于目标分区 ${descriptor.partition}`);
      }
    }

    const manifest = await this.loadManifest();
    const id = historicalDatasetId(descriptor);
    const existingDataset = manifest.datasets.find((item) => item.id === id);
    const existingRecords = existingDataset ? await this.readPartition(id) : [];
    const merged = mergeRecords(descriptor.dataType, existingRecords, records);
    const mergedRange = requestedRange || existingDataset?.requestedRange
      ? {
        startTime: Math.min(
          ...[requestedRange?.startTime, existingDataset?.requestedRange?.startTime].filter(finite).map(Number),
        ),
        endTime: Math.max(
          ...[requestedRange?.endTime, existingDataset?.requestedRange?.endTime].filter(finite).map(Number),
        ),
      }
      : null;
    const audit = auditHistoricalRecords(merged, {
      dataType: descriptor.dataType,
      interval: descriptor.interval,
      expectedStartTime: mergedRange?.startTime,
      expectedEndTime: mergedRange?.endTime,
    });
    if (audit.invalidRecordCount || audit.duplicateCount) {
      throw new Error(`HISTORICAL_INVALID_RECORDS:${id}`);
    }

    const plain = Buffer.from(canonicalNdjson(merged), "utf8");
    const checksum = sha256(plain);
    const relativeObjectPath = path.posix.join("objects", "sha256", checksum.slice(0, 2), `${checksum}.jsonl.gz`);
    const objectPath = safeCatalogPath(this.root, relativeObjectPath);
    if (!(await pathExists(objectPath))) await atomicWrite(objectPath, await gzip(plain, { level: 9 }));

    const capturedAt = new Date(this.now()).toISOString();
    const revisionId = `sha256:${checksum}`;
    const revision = {
      id: revisionId,
      createdAt: capturedAt,
      rowCount: merged.length,
      firstTime: audit.firstTime,
      lastTime: audit.lastTime,
      audit,
      requestedRange: mergedRange,
      source: stableValue(source),
      object: {
        algorithm: "sha256",
        checksum,
        encoding: "jsonl+gzip",
        path: relativeObjectPath,
      },
    };

    const revisions = [...(existingDataset?.revisions ?? [])];
    if (!revisions.some((item) => item.id === revisionId)) revisions.push(revision);
    const dataset = {
      id,
      ...descriptor,
      currentRevisionId: revisionId,
      requestedRange: mergedRange,
      rowCount: merged.length,
      firstTime: audit.firstTime,
      lastTime: audit.lastTime,
      status: audit.status,
      revisions,
    };
    const datasets = manifest.datasets.filter((item) => item.id !== id).concat(dataset).sort((left, right) => left.id.localeCompare(right.id));
    const nextManifest = {
      ...manifest,
      updatedAt: capturedAt,
      datasets,
    };
    await atomicWrite(this.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    return dataset;
  }

  async auditCoverage({ exchange = "BINANCE", market = "USD_M_PERPETUAL", dataType, symbol, interval = null, startTime, endTime } = {}) {
    const manifest = await this.loadManifest();
    const descriptors = manifest.datasets.filter((item) => item.exchange === exchange
      && item.market === market
      && item.dataType === dataType
      && item.symbol === symbol
      && item.interval === interval);
    const records = (await Promise.all(descriptors.map((item) => this.readPartition(item.id))))
      .flat()
      .filter((record) => {
        const time = recordTime(dataType, record);
        return time >= startTime && time <= endTime;
      });
    return {
      query: { exchange, market, dataType, symbol, interval, startTime, endTime },
      partitions: descriptors.map((item) => item.partition).sort(),
      ...auditHistoricalRecords(records, { dataType, interval, expectedStartTime: startTime, expectedEndTime: endTime }),
    };
  }

  async auditAll() {
    const manifest = await this.loadManifest();
    const datasets = [];
    for (const dataset of manifest.datasets) {
      const revision = dataset.revisions.find((item) => item.id === dataset.currentRevisionId);
      try {
        const records = await this.readObject(revision.object);
        const audit = auditHistoricalRecords(records, {
          dataType: dataset.dataType,
          interval: dataset.interval,
          expectedStartTime: dataset.requestedRange?.startTime,
          expectedEndTime: dataset.requestedRange?.endTime,
        });
        datasets.push({ id: dataset.id, objectVerified: true, ...audit });
      } catch (error) {
        datasets.push({ id: dataset.id, objectVerified: false, status: "CORRUPT", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      catalogVersion: manifest.catalogVersion,
      root: this.root,
      datasetCount: datasets.length,
      healthy: datasets.length > 0 && datasets.every((item) => item.objectVerified && item.status === "COMPLETE"),
      datasets,
    };
  }
}

export function partitionRecordsByUtcMonth(records = [], dataType) {
  const partitions = new Map();
  for (const record of records) {
    const partition = utcMonth(recordTime(dataType, record));
    if (!partitions.has(partition)) partitions.set(partition, []);
    partitions.get(partition).push(record);
  }
  return partitions;
}

export function partitionRecordsByCatalogPeriod(records = [], dataType) {
  if (dataType !== HISTORICAL_DATA_TYPES.UNIVERSE) return partitionRecordsByUtcMonth(records, dataType);
  const partitions = new Map();
  for (const record of records) {
    const partition = utcHour(recordTime(dataType, record));
    if (!partitions.has(partition)) partitions.set(partition, []);
    partitions.get(partition).push(record);
  }
  return partitions;
}

export function utcMonthBounds(partition) {
  if (!MONTH_PARTITION_PATTERN.test(partition)) throw new Error(`无效 UTC 月分区: ${partition}`);
  const [year, month] = partition.split("-").map(Number);
  return {
    startTime: Date.UTC(year, month - 1, 1),
    endTime: Date.UTC(year, month, 1) - 1,
  };
}
