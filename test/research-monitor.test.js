import test from "node:test";
import assert from "node:assert/strict";
import { ResearchMonitor } from "../src/application/research-monitor.js";

test("资金费率接口失败不会阻断价格路径推进", async () => {
  const messages = [];
  const candle = { openTime: 2_000, closeTime: 2_999, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  const primaryExchange = {
    async fetchKlines() { return [candle]; },
    async fetchFundingRates() { throw new Error("funding unavailable"); },
  };
  const config = {
    symbols: ["BTCUSDT"],
    intervals: { path: "1m" },
    universe: { dynamic: false, refreshHours: 168 },
    portfolio: { selectionMode: "ALL_ELIGIBLE" },
    pollMs: 30_000,
  };
  const monitor = new ResearchMonitor({
    primaryExchange,
    store: {},
    config,
    logger: { error(message) { messages.push(message); } },
  });
  const result = await monitor.fetchTradeEvents({ symbol: "BTCUSDT", lastProcessedAt: 1_000, lastFundingAt: 1_000 });
  assert.equal(result.candles.length, 1);
  assert.deepEqual(result.funding, []);
  assert.match(messages[0], /funding unavailable/);
});

test("Binance共享限流窗口内整轮扫描暂停，不逐标的重复请求", async () => {
  let requests = 0;
  const retryAt = Date.now() + 60_000;
  const monitor = new ResearchMonitor({
    primaryExchange: {
      rateLimitStatus() { return { blocked: true, blockedUntil: retryAt }; },
      async fetchKlines() { requests += 1; return []; },
    },
    store: {},
    config: {
      symbols: ["BTCUSDT", "ETHUSDT"],
      universe: { dynamic: false, refreshHours: 168 },
      strategy: { minConfidence: 70 },
      pollMs: 30_000,
    },
  });
  const result = await monitor.scanAll();
  assert.equal(result.reason, "binance_rate_limited");
  assert.equal(requests, 0);
  assert.equal(monitor.snapshot().rateLimit.blockedUntil, retryAt);
});

test("研究监控器把Binance批量行情转换成雷达快照和动态深度池", async () => {
  const metadata = new Map();
  const moverCandles = (step) => Array.from({ length: 33 }, (_, index) => ({
    openTime: index * 900_000,
    closeTime: (index + 1) * 900_000 - 1,
    open: 100 + step * Math.max(0, index - 1),
    high: 101 + step * index,
    low: 99 + step * index,
    close: 100 + step * index,
    volume: 100,
    quoteVolume: index === 32 ? 200 : 100,
  }));
  const store = {
    async getMetadata(key) { return metadata.has(key) ? { value: metadata.get(key), updatedAt: 0 } : null; },
    async setMetadata(key, value) { metadata.set(key, structuredClone(value)); },
    async saveUniverseSnapshot() {},
  };
  const monitor = new ResearchMonitor({
    primaryExchange: {
      async fetchUniverse() {
        return [
          { symbol: "BTCUSDT", quoteVolume24h: 1_000_000, priceChangePercent24h: 2, spreadBps: 1, tradeCount24h: 100, lastPrice: 100 },
          { symbol: "ETHUSDT", quoteVolume24h: 900_000, priceChangePercent24h: 1, spreadBps: 1, tradeCount24h: 90, lastPrice: 50 },
          { symbol: "SOLUSDT", quoteVolume24h: 800_000, priceChangePercent24h: 8, spreadBps: 2, tradeCount24h: 200, lastPrice: 20 },
        ];
      },
      async fetchKlines(symbol) {
        return moverCandles(symbol === "SOLUSDT" ? 1 : symbol === "ETHUSDT" ? 0.3 : 0.5);
      },
    },
    store,
    config: {
      symbols: ["BTCUSDT"], primaryProvider: "binance", pollMs: 30_000,
      universe: { dynamic: true, size: 2, refreshHours: 168, minListingDays: 90, maxSpreadBps: 20 },
      scanConcurrency: 2,
      marketRadar: {
        enabled: true, modelVersion: "MARKET_RADAR_R3_PREMOVE", discoverySize: 3, deepScanSize: 2,
        refreshMinutes: 15, minimumHoldMinutes: 30, coreMinimumScore: 68, requiredForV2: true,
        moverCandleLimit: 33, gainerCount: 1, loserCount: 1, rankVelocityCount: 1,
        volumeShockCount: 1, minimumVolumeShockRatio: 1.2,
      },
      strategy: { minConfidence: 70 },
    },
  });
  await monitor.initialize();
  assert.equal(monitor.symbols.length, 2);
  assert.equal(monitor.snapshot().marketRadar.discoverySize, 3);
  assert.equal(metadata.get("market_radar").version, "MARKET_RADAR_R3_PREMOVE");
  assert.equal(metadata.get("market_radar").source, "BINANCE_USDT_PERPETUAL_CLOSED_15M_PREMOVE");
  assert.deepEqual(metadata.get("universe").items.map((item) => item.symbol), monitor.symbols);
});
