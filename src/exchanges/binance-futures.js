import { ALLOWED_INTERVALS } from "../config.js";
import { networkErrorDetail } from "./network-error.js";
import { assertBinanceRequestAvailable, binanceRetryAt, getBinanceBlockedUntil, recordBinanceBlock } from "./binance-rate-limit.js";

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;
const INTERVAL_MS = Object.freeze({
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
  "3d": 3 * 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
});

function parseKlines(rows, now) {
  if (!Array.isArray(rows)) throw new Error("Binance K 线响应格式不正确");
  return rows
    .map((row) => ({
      openTime: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: Number(row[6]),
      quoteVolume: Number(row[7]),
      trades: Number(row[8]),
    }))
    .filter((candle) => candle.closeTime < now)
    .filter((candle) => [candle.openTime, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.closeTime].every(Number.isFinite));
}

function validateMarketRequest(symbol, interval) {
  if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`无效交易对: ${symbol}`);
  if (!ALLOWED_INTERVALS.has(interval)) throw new Error(`无效周期: ${interval}`);
}

export class BinanceFuturesClient {
  constructor({ baseUrl = "https://fapi.binance.com", timeoutMs = 10_000, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.blockedUntil = 0;
    this.candleCache = new Map();
    if (typeof this.fetch !== "function") throw new Error("当前 Node.js 版本不支持 fetch");
  }

  async request(pathname, parameters = {}) {
    assertBinanceRequestAvailable(this.blockedUntil, this.now(), this.baseUrl);
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    let networkError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        response = await this.fetch(url, {
          headers: { accept: "application/json", "user-agent": "futures-signal-bot/0.1" },
          signal: AbortSignal.timeout(attempt === 1 ? this.timeoutMs : Math.min(this.timeoutMs * 2, 60_000)),
        });
        networkError = null;
        break;
      } catch (error) {
        networkError = error;
      }
    }
    if (!response) {
      throw new Error(`Binance 行情请求连续2次失败: ${networkErrorDetail(networkError)}`, { cause: networkError });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAt = binanceRetryAt(response, text, this.now());
      if (retryAt) this.blockedUntil = recordBinanceBlock(this.baseUrl, Math.max(this.blockedUntil, retryAt));
      throw new Error(`Binance HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Binance 返回了无效 JSON");
    }
  }

  rateLimitStatus() {
    const blockedUntil = getBinanceBlockedUntil(this.baseUrl, this.blockedUntil);
    return { blocked: this.now() < blockedUntil, blockedUntil };
  }

  async fetchKlines(symbol, interval, limit = 300, now = Date.now()) {
    validateMarketRequest(symbol, interval);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit 必须是 1 到 1500 的整数");

    const cacheKey = `${symbol}:${interval}:${limit}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached && now < cached.expiresAt) return cached.candles;

    const rows = await this.request("/fapi/v1/klines", { symbol, interval, limit });
    const candles = parseKlines(rows, now);
    const step = INTERVAL_MS[interval];
    if (step) {
      const expiresAt = Math.floor(now / step) * step + step + 1_000;
      this.candleCache.set(cacheKey, { candles, expiresAt });
    }
    return candles;
  }

  async fetchHistoricalKlines(symbol, interval, {
    startTime,
    endTime = Date.now(),
    pageLimit = 1500,
    maxCandles = 100_000,
  } = {}) {
    validateMarketRequest(symbol, interval);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
      throw new Error("历史 K 线必须提供有效的 startTime 和 endTime");
    }
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1500) throw new Error("pageLimit 必须是 1 到 1500 的整数");
    if (!Number.isInteger(maxCandles) || maxCandles < 1 || maxCandles > 1_000_000) throw new Error("maxCandles 必须是 1 到 1000000 的整数");
    const step = INTERVAL_MS[interval];
    if (!step) throw new Error(`历史分页暂不支持周期: ${interval}`);

    const candles = new Map();
    let cursor = Math.trunc(startTime);
    while (cursor <= endTime && candles.size < maxCandles) {
      const requestLimit = Math.min(pageLimit, maxCandles - candles.size);
      const rows = await this.request("/fapi/v1/klines", {
        symbol,
        interval,
        limit: requestLimit,
        startTime: cursor,
        endTime: Math.trunc(endTime),
      });
      if (!Array.isArray(rows)) throw new Error("Binance K 线响应格式不正确");
      for (const candle of parseKlines(rows, Math.min(Date.now(), endTime + 1))) {
        if (candle.openTime >= startTime && candle.openTime <= endTime) candles.set(candle.openTime, candle);
      }
      if (!rows.length || rows.length < requestLimit) break;
      const lastOpenTime = Number(rows.at(-1)?.[0]);
      if (!Number.isFinite(lastOpenTime) || lastOpenTime < cursor) break;
      const nextCursor = lastOpenTime + step;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return [...candles.values()].sort((a, b) => a.openTime - b.openTime).slice(0, maxCandles);
  }

  async fetchFundingRates(symbol, {
    startTime,
    endTime = Date.now(),
    pageLimit = 1000,
    maxEvents = 100_000,
  } = {}) {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`无效交易对: ${symbol}`);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
      throw new Error("资金费率必须提供有效的 startTime 和 endTime");
    }
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 1000) throw new Error("pageLimit 必须是 1 到 1000 的整数");
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 100_000) throw new Error("maxEvents 必须是 1 到 100000 的整数");
    const events = new Map();
    let cursor = Math.trunc(startTime);
    while (cursor <= endTime && events.size < maxEvents) {
      const requestLimit = Math.min(pageLimit, maxEvents - events.size);
      const rows = await this.request("/fapi/v1/fundingRate", { symbol, startTime: cursor, endTime: Math.trunc(endTime), limit: requestLimit });
      if (!Array.isArray(rows)) throw new Error("Binance 资金费率响应格式不正确");
      for (const row of rows) {
        const fundingTime = Number(row.fundingTime);
        const rate = Number(row.fundingRate);
        const markPrice = Number(row.markPrice);
        if (Number.isFinite(fundingTime) && Number.isFinite(rate) && Number.isFinite(markPrice) && markPrice > 0) {
          events.set(fundingTime, { symbol, fundingTime, rate, markPrice });
        }
      }
      if (!rows.length || rows.length < requestLimit) break;
      const lastTime = Number(rows.at(-1)?.fundingTime);
      if (!Number.isFinite(lastTime) || lastTime < cursor) break;
      cursor = lastTime + 1;
    }
    return [...events.values()].sort((a, b) => a.fundingTime - b.fundingTime);
  }

  async fetchBookTicker(symbol) {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`无效交易对: ${symbol}`);
    const row = await this.request("/fapi/v1/ticker/bookTicker", { symbol });
    const bidPrice = Number(row.bidPrice);
    const askPrice = Number(row.askPrice);
    if (![bidPrice, askPrice].every(Number.isFinite) || bidPrice <= 0 || askPrice <= bidPrice) {
      throw new Error("Binance 买一卖一响应格式不正确");
    }
    const midpoint = (bidPrice + askPrice) / 2;
    return { symbol, bidPrice, askPrice, spreadBps: ((askPrice - bidPrice) / midpoint) * 10_000 };
  }

  async fetchPremiumIndex(symbol) {
    if (!SYMBOL_PATTERN.test(symbol)) throw new Error(`无效交易对: ${symbol}`);
    const row = await this.request("/fapi/v1/premiumIndex", { symbol });
    const markPrice = Number(row.markPrice);
    const lastFundingRate = Number(row.lastFundingRate);
    const nextFundingTime = Number(row.nextFundingTime);
    const time = Number(row.time);
    if (![markPrice, lastFundingRate, nextFundingTime].every(Number.isFinite) || markPrice <= 0) {
      throw new Error("Binance 标记价格与资金费率响应格式不正确");
    }
    return { symbol, markPrice, lastFundingRate, nextFundingTime, time: Number.isFinite(time) ? time : this.now() };
  }

  async fetchUniverseSnapshot({ minListingDays = 90, maxSpreadBps = 20, discoverySize = 100, now = null } = {}) {
    if (!Number.isFinite(minListingDays) || minListingDays < 0) throw new Error("minListingDays 必须是非负数");
    if (!Number.isFinite(maxSpreadBps) || maxSpreadBps <= 0) throw new Error("maxSpreadBps 必须是正数");
    if (!Number.isInteger(discoverySize) || discoverySize < 1) throw new Error("discoverySize 必须是正整数");
    const evaluatedAt = Number.isFinite(now) ? Number(now) : this.now();
    const [exchangeInfo, tickers, books] = await Promise.all([
      this.request("/fapi/v1/exchangeInfo"),
      this.request("/fapi/v1/ticker/24hr"),
      this.request("/fapi/v1/ticker/bookTicker"),
    ]);
    if (!Array.isArray(exchangeInfo?.symbols) || !Array.isArray(tickers) || !Array.isArray(books)) {
      throw new Error("Binance 标的池响应格式不正确");
    }
    const tickerMap = new Map(tickers.map((item) => [item.symbol, item]));
    const bookMap = new Map(books.map((item) => [item.symbol, item]));
    const excludedBases = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD"]);
    const minimumListingMs = minListingDays * 86_400_000;

    const items = exchangeInfo.symbols
      .filter((item) => item.status === "TRADING")
      .filter((item) => item.contractType === "PERPETUAL" && item.quoteAsset === "USDT")
      .filter((item) => SYMBOL_PATTERN.test(String(item.symbol ?? "")))
      .filter((item) => !excludedBases.has(item.baseAsset))
      .filter((item) => Number.isFinite(Number(item.onboardDate)) && evaluatedAt - Number(item.onboardDate) >= minimumListingMs)
      .map((item) => {
        const ticker = tickerMap.get(item.symbol) ?? {};
        const book = bookMap.get(item.symbol) ?? {};
        const bidPrice = Number(book.bidPrice);
        const askPrice = Number(book.askPrice);
        const midpoint = (bidPrice + askPrice) / 2;
        const spreadBps = midpoint > 0 ? ((askPrice - bidPrice) / midpoint) * 10_000 : Infinity;
        return {
          symbol: item.symbol,
          baseAsset: item.baseAsset,
          onboardDate: Number(item.onboardDate),
          quoteVolume24h: Number(ticker.quoteVolume),
          lastPrice: Number(ticker.lastPrice),
          priceChangePercent24h: Number(ticker.priceChangePercent),
          highPrice24h: Number(ticker.highPrice),
          lowPrice24h: Number(ticker.lowPrice),
          tradeCount24h: Number(ticker.count),
          bidPrice,
          askPrice,
          spreadBps,
        };
      })
      .filter((item) => Number.isFinite(item.quoteVolume24h) && item.quoteVolume24h > 0)
      .filter((item) => Number.isFinite(item.bidPrice) && item.bidPrice > 0
        && Number.isFinite(item.askPrice) && item.askPrice >= item.bidPrice
        && Number.isFinite(item.spreadBps) && item.spreadBps >= 0 && item.spreadBps <= maxSpreadBps)
      .sort((a, b) => b.quoteVolume24h - a.quoteVolume24h)
      .map((item, index) => ({ ...item, liquidityRank: index + 1 }));
    const capturedAt = Number.isFinite(now) ? Number(now) : this.now();
    return {
      schemaVersion: 2,
      capturedAt,
      complete: true,
      discoverySize,
      eligibleCount: items.length,
      filters: { minListingDays, maxSpreadBps },
      items,
    };
  }

  async fetchUniverse({ limit = 50, minListingDays = 90, maxSpreadBps = 20, now = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit 必须是正整数");
    const snapshot = await this.fetchUniverseSnapshot({
      minListingDays,
      maxSpreadBps,
      discoverySize: limit,
      now,
    });
    return snapshot.items.slice(0, limit);
  }

  async ping() {
    const result = await this.request("/fapi/v1/time");
    return { serverTime: Number(result.serverTime) };
  }
}
