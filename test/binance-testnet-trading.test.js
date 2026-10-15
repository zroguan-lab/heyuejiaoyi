import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  BinanceTestnetTradingClient,
  TestnetWriteDisabledError,
} from "../src/execution/binance-testnet-trading.js";

test("交易客户端只接受 Demo 域名、BTC 白名单且默认拒绝所有写入", async () => {
  assert.throws(() => new BinanceTestnetTradingClient({
    baseUrl: "https://fapi.binance.com", apiKey: "key", apiSecret: "secret",
  }), /仅允许/);
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    fetchImpl: async () => new Response("{}"),
  });
  await assert.rejects(() => client.placeLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "80000", clientOrderId: "cfs-entry-a",
  }), TestnetWriteDisabledError);
  await assert.rejects(() => client.placeLimitOrder({
    symbol: "ETHUSDT", side: "BUY", quantity: "0.01", price: "2000", clientOrderId: "cfs-entry-b",
  }), /非白名单标的/);
  await assert.rejects(() => client.signedRequest("POST", "/fapi/v1/allOpenOrders", { symbol: "BTCUSDT" }), /非白名单/);
});

test("交易客户端只允许显式注入的多币策略白名单", async () => {
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    allowedSymbols: ["BTCUSDT"],
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("symbol"), "AKEUSDT");
      return new Response(JSON.stringify({ symbol: "AKEUSDT", markPrice: "0.03" }));
    },
  });
  client.allowSymbols(["AKEUSDT"]);
  assert.equal(await client.fetchMarkPrice("AKEUSDT"), 0.03);
  assert.throws(() => client.allowSymbols(["我踏马来了USDT"]), /有效的 USDT 永续合约代码/);
  await assert.rejects(() => client.fetchMarkPrice("UNLISTEDUSDT"), /非白名单标的/);
});

test("交易客户端把签名 POST 放在表单体并使用唯一客户端订单号", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (new URL(url).pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 11_000 }));
    return new Response(JSON.stringify({
      symbol: "BTCUSDT", orderId: 7, clientOrderId: "cfs-entry-a", status: "NEW",
      side: "BUY", type: "LIMIT", price: "80000.0", origQty: "0.0012", executedQty: "0",
    }));
  };
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "test-key", apiSecret: "test-secret",
    writeEnabled: true, fetchImpl, now: () => 10_000,
  });
  const order = await client.placeLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.0012", price: "80000.0", clientOrderId: "cfs-entry-a",
  });
  assert.equal(order.orderId, "7");
  const request = requests.find((item) => item.url.pathname === "/fapi/v1/order");
  assert.equal(request.options.method, "POST");
  assert.equal(request.url.search, "");
  assert.equal(request.options.headers["X-MBX-APIKEY"], "test-key");
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("newClientOrderId"), "cfs-entry-a");
  assert.equal(form.get("positionSide"), "BOTH");
  assert.equal(form.get("timeInForce"), "IOC");
  const unsigned = request.options.body.replace(/&signature=[a-f0-9]+$/, "");
  assert.equal(form.get("signature"), createHmac("sha256", "test-secret").update(unsigned).digest("hex"));
});

test("测试下单可在写入锁关闭时验证权限且永不进入真实订单端点", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    if (new URL(url).pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
    return new Response("{}");
  };
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "test-key", apiSecret: "test-secret",
    writeEnabled: false, fetchImpl, now: () => 10_000,
  });
  const result = await client.testLimitOrderPermission({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.0012", price: "80000.0", clientOrderId: "cfs-perm-a",
  });
  assert.deepEqual(result, { accepted: true, submittedToMatchingEngine: false });
  const request = requests.find((item) => item.url.pathname === "/fapi/v1/order/test");
  assert.ok(request);
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get("type"), "LIMIT");
  assert.equal(form.get("timeInForce"), "IOC");
  assert.equal(form.get("positionSide"), "BOTH");
  assert.equal(requests.some((item) => item.url.pathname === "/fapi/v1/order"), false);
});

test("人工金丝雀市价平仓强制使用 reduceOnly 且不携带价格", async () => {
  const requests = [];
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", writeEnabled: true, now: () => 10_000,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (new URL(url).pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
      return new Response(JSON.stringify({
        symbol: "BTCUSDT", orderId: 8, clientOrderId: "cfs-close-a", status: "FILLED",
        side: "SELL", type: "MARKET", origQty: "0.0012", executedQty: "0.0012", reduceOnly: true,
      }));
    },
  });
  const order = await client.closePositionMarket({
    symbol: "BTCUSDT", side: "SELL", quantity: "0.0012", clientOrderId: "cfs-close-a",
  });
  assert.equal(order.status, "FILLED");
  const form = new URLSearchParams(requests.find((item) => item.url.pathname === "/fapi/v1/order").options.body);
  assert.equal(form.get("type"), "MARKET");
  assert.equal(form.get("reduceOnly"), "true");
  assert.equal(form.has("price"), false);
  assert.equal(form.has("timeInForce"), false);
});

test("标记价格只允许从白名单公开端点读取并校验为正数", async () => {
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/fapi/v1/premiumIndex");
      assert.equal(new URL(url).searchParams.get("symbol"), "BTCUSDT");
      return new Response(JSON.stringify({ symbol: "BTCUSDT", markPrice: "81234.5" }));
    },
  });
  assert.equal(await client.fetchMarkPrice("BTCUSDT"), 81234.5);
});

test("交易客户端从 Demo 盘口读取买一卖一并计算点差", async () => {
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/fapi/v1/ticker/bookTicker");
      assert.equal(new URL(url).searchParams.get("symbol"), "BTCUSDT");
      return new Response(JSON.stringify({ symbol: "BTCUSDT", bidPrice: "84999", askPrice: "85001", time: 9_999 }));
    },
  });
  const book = await client.fetchBookTicker("BTCUSDT");
  assert.equal(book.bidPrice, 84_999);
  assert.equal(book.askPrice, 85_001);
  assert.ok(book.spreadBps > 0);
});

test("回调入场可显式提交 GTC 限价单", async () => {
  const requests = [];
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", writeEnabled: true, now: () => 10_000,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (new URL(url).pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
      return new Response(JSON.stringify({
        symbol: "BTCUSDT", orderId: 71, clientOrderId: "cfs-gtc-entry", status: "NEW",
        side: "BUY", type: "LIMIT", timeInForce: "GTC", price: "80000", origQty: "0.0012", executedQty: "0",
      }));
    },
  });
  await client.placeLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.0012", price: "80000", timeInForce: "GTC", clientOrderId: "cfs-gtc-entry",
  });
  const form = new URLSearchParams(requests.find((item) => item.url.pathname === "/fapi/v1/order").options.body);
  assert.equal(form.get("timeInForce"), "GTC");
});

test("交易客户端收到418后在封禁到期前不会继续请求Demo接口", async () => {
  let now = 1_000;
  let calls = 0;
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ code: -1003, msg: "IP banned until 5000" }), { status: 418 });
      return new Response(JSON.stringify({ markPrice: "100" }));
    },
  });
  await assert.rejects(() => client.fetchMarkPrice("BTCUSDT"), /HTTP 418/);
  now = 2_000;
  await assert.rejects(() => client.fetchMarkPrice("BTCUSDT"), /本地暂停/);
  assert.equal(calls, 1);
  now = 5_001;
  assert.equal(await client.fetchMarkPrice("BTCUSDT"), 100);
  assert.equal(calls, 2);
});

test("交易客户端读取资金费收入用于Demo净盈亏归因", async () => {
  const requests = [];
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => 10_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
      requests.push(parsed);
      return new Response(JSON.stringify([{
        symbol: "BTCUSDT", incomeType: "FUNDING_FEE", income: "-0.015", asset: "USDT", time: 9_000, tranId: 7,
      }]));
    },
  });
  const rows = await client.listIncomeHistory("BTCUSDT", { incomeType: "FUNDING_FEE", startTime: 8_000, endTime: 10_000 });
  assert.equal(rows[0].income, -0.015);
  assert.equal(rows[0].transactionId, "7");
  assert.equal(requests[0].pathname, "/fapi/v1/income");
  assert.equal(requests[0].searchParams.get("incomeType"), "FUNDING_FEE");
});

test("交易客户端在下单前读取名义价值杠杆档位", async () => {
  const requests = [];
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => 10_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
      requests.push(parsed);
      return new Response(JSON.stringify([{
        symbol: "BTCUSDT",
        brackets: [{
          bracket: 1, initialLeverage: 125, notionalFloor: 0, notionalCap: 50_000,
          maintMarginRatio: 0.004, cum: 0,
        }],
      }]));
    },
  });
  const result = await client.fetchLeverageBrackets("BTCUSDT");
  assert.equal(result.brackets[0].initialLeverage, 125);
  assert.equal(result.brackets[0].notionalCap, 50_000);
  assert.equal(requests[0].pathname, "/fapi/v1/leverageBracket");
  assert.equal(requests[0].searchParams.get("symbol"), "BTCUSDT");
});

test("交易客户端使用新 Algo 接口创建只能平仓的止损与止盈", async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === "/fapi/v1/time") return new Response(JSON.stringify({ serverTime: 10_000 }));
    bodies.push(new URLSearchParams(options.body));
    return new Response(JSON.stringify({ algoId: bodies.length, clientAlgoId: bodies.at(-1).get("clientAlgoId"), algoStatus: "NEW" }));
  };
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    writeEnabled: true, fetchImpl, now: () => 10_000,
  });
  await client.placeStopClose({ symbol: "BTCUSDT", side: "SELL", triggerPrice: "79000.0", clientAlgoId: "cfs-sl-a" });
  await client.placeStopClose({ symbol: "BTCUSDT", side: "SELL", triggerPrice: "80000.0", clientAlgoId: "cfs-slbe-a", quantity: "0.0006" });
  await client.placeTakeProfitClose({ symbol: "BTCUSDT", side: "SELL", triggerPrice: "82000.0", clientAlgoId: "cfs-tp1-a", quantity: "0.0006" });
  assert.equal(bodies[0].get("closePosition"), "true");
  assert.equal(bodies[0].has("quantity"), false);
  assert.equal(bodies[1].get("reduceOnly"), "true");
  assert.equal(bodies[1].get("quantity"), "0.0006");
  assert.equal(bodies[1].has("closePosition"), false);
  assert.equal(bodies[2].get("reduceOnly"), "true");
  assert.equal(bodies[2].get("quantity"), "0.0006");
  assert.equal(bodies[2].get("algoType"), "CONDITIONAL");
});

test("并发账户查询只进行一次服务器时间同步", async () => {
  let timeRequests = 0;
  const signedUrls = [];
  const responses = {
    "/fapi/v3/account": { canTrade: true, availableBalance: "100" },
    "/fapi/v3/positionRisk": [{
      symbol: "BCHUSDT", positionSide: "BOTH", positionAmt: "-0.324", entryPrice: "308.69", markPrice: "310",
      isolatedMargin: "9.99", isolatedWallet: "10.28", unRealizedProfit: "-0.42",
    }],
    "/fapi/v1/openOrders": [],
    "/fapi/v1/openAlgoOrders": [],
    "/fapi/v1/positionSide/dual": { dualSidePosition: false },
    "/fapi/v1/symbolConfig": [{ symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 10 }],
  };
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => 10_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      if (pathname === "/fapi/v1/time") { timeRequests += 1; return new Response(JSON.stringify({ serverTime: 10_000 })); }
      signedUrls.push(parsed);
      return new Response(JSON.stringify(responses[pathname]));
    },
  });
  const state = await client.fetchAccountState("BTCUSDT");
  assert.equal(state.positionMode, "ONE_WAY");
  assert.equal(state.positions[0].marginType, "isolated");
  assert.equal(timeRequests, 1);
  for (const pathname of ["/fapi/v3/positionRisk", "/fapi/v1/openOrders", "/fapi/v1/openAlgoOrders"]) {
    assert.equal(signedUrls.find((url) => url.pathname === pathname).searchParams.has("symbol"), false);
  }
  assert.equal(signedUrls.find((url) => url.pathname === "/fapi/v1/symbolConfig").searchParams.get("symbol"), "BTCUSDT");
});

test("交易所明确拒绝过期时间戳时只重新校时并重签一次", async () => {
  let timeRequests = 0;
  let orderRequests = 0;
  const client = new BinanceTestnetTradingClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret",
    writeEnabled: true, now: () => 10_000,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/fapi/v1/time") {
        timeRequests += 1;
        return new Response(JSON.stringify({ serverTime: 10_000 }));
      }
      orderRequests += 1;
      if (orderRequests === 1) {
        return new Response(JSON.stringify({ code: -1021, msg: "timestamp outside recvWindow" }), { status: 400 });
      }
      return new Response(JSON.stringify({
        symbol: "BTCUSDT", orderId: 9, clientOrderId: "cfs-retry", status: "NEW",
        side: "BUY", type: "LIMIT", price: "80000", origQty: "0.0012", executedQty: "0",
      }));
    },
  });
  const order = await client.placeLimitOrder({
    symbol: "BTCUSDT", side: "BUY", quantity: "0.0012", price: "80000", clientOrderId: "cfs-retry",
  });
  assert.equal(order.orderId, "9");
  assert.equal(timeRequests, 2);
  assert.equal(orderRequests, 2);
});
