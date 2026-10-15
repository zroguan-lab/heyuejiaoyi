import test from "node:test";
import assert from "node:assert/strict";
import { BinanceFuturesClient } from "../src/exchanges/binance-futures.js";
import { HistoricalBinanceFuturesClient } from "../src/research/historical-binance-client.js";
import { OkxFuturesClient, toOkxInstrument } from "../src/exchanges/okx-futures.js";
import { HyperliquidFuturesClient, toHyperliquidCoin } from "../src/exchanges/hyperliquid-futures.js";

test("交易所适配器解析 K 线并排除未收盘数据", async () => {
  const rows = [
    [1000, "10", "12", "9", "11", "100", 1999, "1000", 10],
    [2000, "11", "13", "10", "12", "120", 2999, "1200", 12],
  ];
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/fapi\/v1\/klines/);
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const client = new BinanceFuturesClient({ fetchImpl });
  const candles = await client.fetchKlines("BTCUSDT", "15m", 100, 2500);
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0], {
    openTime: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100, closeTime: 1999, quoteVolume: 1000, trades: 10,
  });
});

test("交易所适配器拒绝非法交易对", async () => {
  const client = new BinanceFuturesClient({ fetchImpl: async () => new Response("[]") });
  await assert.rejects(() => client.fetchKlines("../BTC", "15m", 100), /无效交易对/);
});

test("Binance K线在同一收盘周期内复用缓存，避免50标的重复轮询", async () => {
  let calls = 0;
  const rows = [[0, "10", "11", "9", "10.5", "100", 59_999, "1000", 10]];
  const client = new BinanceFuturesClient({ fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify(rows));
  } });
  await client.fetchKlines("BTCUSDT", "1m", 100, 60_500);
  await client.fetchKlines("BTCUSDT", "1m", 100, 90_000);
  assert.equal(calls, 1);
  await client.fetchKlines("BTCUSDT", "1m", 100, 121_500);
  assert.equal(calls, 2);
});

test("Binance 行情请求超时时只对幂等读取重试一次", async () => {
  let calls = 0;
  const rows = [[0, "10", "11", "9", "10.5", "100", 59_999, "1000", 10]];
  const client = new BinanceFuturesClient({ fetchImpl: async () => {
    calls += 1;
    if (calls === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(JSON.stringify(rows));
  } });
  const candles = await client.fetchKlines("BTCUSDT", "1m", 100, 60_500);
  assert.equal(calls, 2);
  assert.equal(candles.length, 1);
});

test("Binance 行情请求连续失败后保留明确的重试次数", async () => {
  let calls = 0;
  const client = new BinanceFuturesClient({ fetchImpl: async () => {
    calls += 1;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  } });
  await assert.rejects(() => client.fetchKlines("BTCUSDT", "1m", 100, 60_500), /连续2次失败/);
  assert.equal(calls, 2);
});

test("Binance 遇到418后在交易所封禁到期前本地暂停请求", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new BinanceFuturesClient({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ code: -1003, msg: "IP banned until 5000" }), { status: 418 });
      return new Response("[]");
    },
  });
  await assert.rejects(() => client.fetchKlines("BTCUSDT", "1m", 100, now), /HTTP 418/);
  now = 2_000;
  await assert.rejects(() => client.fetchKlines("BTCUSDT", "1m", 100, now), /本地暂停/);
  assert.equal(calls, 1);
  now = 5_001;
  await client.fetchKlines("BTCUSDT", "1m", 100, now);
  assert.equal(calls, 2);
});

test("历史客户端节流分页并在429暂停结束后有限重试", async () => {
  let now = 10_000;
  let calls = 0;
  const sleeps = [];
  const client = new HistoricalBinanceFuturesClient({
    baseUrl: "https://history-retry.test",
    now: () => now,
    minimumRequestIntervalMs: 100,
    rateLimitRetries: 2,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ code: -1003, msg: "Too many requests" }), {
          status: 429,
          headers: { "retry-after": "0.01" },
        });
      }
      return new Response(JSON.stringify({ serverTime: now }), { status: 200 });
    },
  });
  const result = await client.request("/fapi/v1/time");
  assert.equal(result.serverTime, now);
  assert.equal(calls, 2);
  assert.ok(sleeps.reduce((sum, value) => sum + value, 0) >= 100);
  await client.request("/fapi/v1/time");
  assert.equal(calls, 3);
  assert.ok(sleeps.reduce((sum, value) => sum + value, 0) >= 200);
});

test("Binance 标的池只保留满足合约、上市时间、点差和成交额规则的前N个", async () => {
  const now = 200 * 86_400_000;
  const payloads = {
    "/fapi/v1/exchangeInfo": { symbols: [
      { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 0 },
      { symbol: "ETHUSDT", baseAsset: "ETH", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 0 },
      { symbol: "NEWUSDT", baseAsset: "NEW", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: now - 10 * 86_400_000 },
      { symbol: "USDCUSDT", baseAsset: "USDC", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 0 },
      { symbol: "BADUSDT", baseAsset: "BAD", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 0 },
      { symbol: "我踏马来了USDT", baseAsset: "我踏马来了", quoteAsset: "USDT", contractType: "PERPETUAL", status: "TRADING", onboardDate: 0 },
    ] },
    "/fapi/v1/ticker/24hr": [
      { symbol: "BTCUSDT", quoteVolume: "1000", lastPrice: "100", priceChangePercent: "2", highPrice: "102", lowPrice: "98", count: 10 }, { symbol: "ETHUSDT", quoteVolume: "2000", lastPrice: "200", priceChangePercent: "3", highPrice: "205", lowPrice: "190", count: 20 }, { symbol: "NEWUSDT", quoteVolume: "9000" }, { symbol: "USDCUSDT", quoteVolume: "8000" }, { symbol: "BADUSDT", quoteVolume: "999999", lastPrice: "100", priceChangePercent: "1", highPrice: "101", lowPrice: "99", count: 100 }, { symbol: "我踏马来了USDT", quoteVolume: "999999", lastPrice: "1", priceChangePercent: "10", highPrice: "1.1", lowPrice: "0.9", count: 9999 },
    ],
    "/fapi/v1/ticker/bookTicker": [
      { symbol: "BTCUSDT", bidPrice: "99.9", askPrice: "100" }, { symbol: "ETHUSDT", bidPrice: "99.9", askPrice: "100" }, { symbol: "NEWUSDT", bidPrice: "99.9", askPrice: "100" }, { symbol: "USDCUSDT", bidPrice: "0.999", askPrice: "1" }, { symbol: "BADUSDT", bidPrice: "101", askPrice: "100" }, { symbol: "我踏马来了USDT", bidPrice: "0.999", askPrice: "1" },
    ],
  };
  const client = new BinanceFuturesClient({ fetchImpl: async (url) => new Response(JSON.stringify(payloads[new URL(url).pathname])) });
  const items = await client.fetchUniverse({ limit: 2, minListingDays: 90, maxSpreadBps: 20, now });
  assert.deepEqual(items.map((item) => item.symbol), ["ETHUSDT", "BTCUSDT"]);
  assert.equal(items[0].lastPrice, 200);
  assert.equal(items[0].priceChangePercent24h, 3);
  assert.equal(items[0].tradeCount24h, 20);
  assert.deepEqual(items.map((item) => item.liquidityRank), [1, 2]);

  const snapshot = await client.fetchUniverseSnapshot({ minListingDays: 90, maxSpreadBps: 20, discoverySize: 2, now });
  assert.equal(snapshot.capturedAt, now);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.eligibleCount, 2);
  assert.deepEqual(snapshot.items.map((item) => item.symbol), ["ETHUSDT", "BTCUSDT"]);
  assert.equal(snapshot.items[0].bidPrice, 99.9);
  assert.equal(snapshot.items[0].askPrice, 100);
});

test("Binance 历史 K 线按时间分页、去重并保持升序", async () => {
  const pages = [
    [
      [0, "10", "11", "9", "10.5", "100", 59_999, "1000", 10],
      [60_000, "10.5", "12", "10", "11", "110", 119_999, "1100", 11],
    ],
    [
      [60_000, "10.5", "12", "10", "11", "110", 119_999, "1100", 11],
      [120_000, "11", "13", "10.5", "12", "120", 179_999, "1200", 12],
    ],
    [],
  ];
  let calls = 0;
  const client = new BinanceFuturesClient({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("symbol"), "BTCUSDT");
      assert.equal(parsed.searchParams.get("interval"), "1m");
      return new Response(JSON.stringify(pages[calls++] ?? []), { status: 200 });
    },
  });
  const candles = await client.fetchHistoricalKlines("BTCUSDT", "1m", {
    startTime: 0,
    endTime: 180_000,
    pageLimit: 2,
  });
  assert.deepEqual(candles.map((item) => item.openTime), [0, 60_000, 120_000]);
  assert.equal(calls, 3);
});

test("Binance 资金费率历史按时间分页并转换为数字", async () => {
  const pages = [
    [{ symbol: "BTCUSDT", fundingTime: 1000, fundingRate: "0.0001", markPrice: "100" }],
    [],
  ];
  let calls = 0;
  const client = new BinanceFuturesClient({ fetchImpl: async () => new Response(JSON.stringify(pages[calls++] ?? [])) });
  const events = await client.fetchFundingRates("BTCUSDT", { startTime: 1, endTime: 2000, pageLimit: 1 });
  assert.deepEqual(events, [{ symbol: "BTCUSDT", fundingTime: 1000, rate: 0.0001, markPrice: 100 }]);
  assert.equal(calls, 2);
});

test("Binance 预交易成本读取当前标记价格与下一次资金费率", async () => {
  const client = new BinanceFuturesClient({
    now: () => 6_000,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/fapi/v1/premiumIndex");
      return new Response(JSON.stringify({ symbol: "BTCUSDT", markPrice: "101.5", lastFundingRate: "0.0001", nextFundingTime: 10_000, time: 500 }));
    },
  });
  assert.deepEqual(await client.fetchPremiumIndex("BTCUSDT"), {
    symbol: "BTCUSDT", markPrice: 101.5, lastFundingRate: 0.0001, nextFundingTime: 10_000, time: 500,
  });
});

test("OKX 适配器映射永续合约、排除未收盘 K 线并恢复时间顺序", async () => {
  const payload = { code: "0", msg: "", data: [
    ["2000", "11", "13", "10", "12", "20", "2", "240", "0"],
    ["1000", "10", "12", "9", "11", "10", "1", "110", "1"],
  ] };
  const fetchImpl = async (url) => {
    assert.match(String(url), /instId=BTC-USDT-SWAP/);
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const client = new OkxFuturesClient({ fetchImpl });
  const candles = await client.fetchKlines("BTCUSDT", "15m", 100);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].openTime, 1000);
  assert.equal(candles[0].volume, 110);
  assert.equal(toOkxInstrument("ETHUSDT"), "ETH-USDT-SWAP");
});

test("Hyperliquid 适配器发送 candleSnapshot 并排除未收盘 K 线", async () => {
  const rows = [
    { t: 2000, T: 2999, o: "11", h: "13", l: "10", c: "12", v: "20", n: 12 },
    { t: 1000, T: 1999, o: "10", h: "12", l: "9", c: "11", v: "10", n: 10 },
  ];
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), "https://api.hyperliquid.xyz/info");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.type, "candleSnapshot");
    assert.equal(body.req.coin, "BTC");
    assert.equal(body.req.interval, "15m");
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const client = new HyperliquidFuturesClient({ fetchImpl });
  const candles = await client.fetchKlines("BTCUSDT", "15m", 100, 2500);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].openTime, 1000);
  assert.equal(candles[0].quoteVolume, 110);
  assert.equal(toHyperliquidCoin("SOLUSDT"), "SOL");
});
