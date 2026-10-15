import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BinanceTestnetReadOnlyClient } from "../src/execution/binance-testnet-readonly.js";
import { ExecutionDisabledError, TestnetExecutionGateway } from "../src/execution/testnet-execution-gateway.js";

test("只读客户端拒绝生产域名和任何非白名单端点", async () => {
  assert.throws(() => new BinanceTestnetReadOnlyClient({ baseUrl: "https://fapi.binance.com", apiKey: "key", apiSecret: "secret" }), /仅允许/);
  const client = new BinanceTestnetReadOnlyClient({ baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", fetchImpl: async () => new Response("{}") });
  await assert.rejects(() => client.signedGet("/fapi/v1/order"), /拒绝非只读/);
});

test("只读请求使用服务器时差、API Key 与 HMAC SHA256 签名", async () => {
  const requests = [];
  const responses = {
    "/fapi/v1/time": { serverTime: 11_000 },
    "/fapi/v3/account": { canTrade: true, totalWalletBalance: "100", availableBalance: "90", totalMarginBalance: "100", totalUnrealizedProfit: "0", assets: [] },
    "/fapi/v3/positionRisk": [{
      symbol: "BCHUSDT", positionSide: "BOTH", positionAmt: "-0.324", entryPrice: "308.69", markPrice: "310",
      isolatedMargin: "9.99", isolatedWallet: "10.28", unRealizedProfit: "-0.42",
    }],
    "/fapi/v1/openOrders": [],
    "/fapi/v1/openAlgoOrders": [],
    "/fapi/v1/positionSide/dual": { dualSidePosition: false },
    "/fapi/v1/symbolConfig": [{ symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 10, maxNotionalValue: "1000000" }],
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    return new Response(JSON.stringify(responses[new URL(url).pathname]), { status: 200 });
  };
  const client = new BinanceTestnetReadOnlyClient({
    baseUrl: "https://demo-fapi.binance.com",
    apiKey: "test-key",
    apiSecret: "test-secret",
    now: () => 10_000,
    fetchImpl,
  });
  const snapshot = await client.fetchSnapshot();
  assert.equal(snapshot.positionMode, "ONE_WAY");
  assert.equal(snapshot.account.canTrade, true);
  assert.equal(snapshot.account.totalWalletBalance, 100);
  assert.equal(snapshot.symbolConfig.leverage, 10);
  assert.equal(snapshot.positions[0].marginType, "isolated");
  const timeRequest = requests.find((item) => item.url.pathname === "/fapi/v1/time");
  assert.equal(timeRequest.options.cache, "no-store");
  assert.equal(timeRequest.options.headers["cache-control"], "no-cache, no-store");
  const signed = requests.find((item) => item.url.pathname === "/fapi/v3/account");
  assert.equal(signed.options.method, "GET");
  assert.equal(signed.options.headers["X-MBX-APIKEY"], "test-key");
  assert.equal(signed.url.searchParams.get("timestamp"), "11000");
  const payload = `recvWindow=5000&timestamp=11000`;
  assert.equal(signed.url.searchParams.get("signature"), createHmac("sha256", "test-secret").update(payload).digest("hex"));
});

test("只读同步遇到时间窗拒绝时重新校时一次并恢复", async () => {
  let timeRequests = 0;
  let accountRequests = 0;
  const responses = {
    "/fapi/v3/account": { canTrade: true, availableBalance: "100", assets: [] },
    "/fapi/v3/positionRisk": [],
    "/fapi/v1/openOrders": [],
    "/fapi/v1/openAlgoOrders": [],
    "/fapi/v1/positionSide/dual": { dualSidePosition: false },
    "/fapi/v1/symbolConfig": [{ symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 10 }],
  };
  const client = new BinanceTestnetReadOnlyClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => 10_000,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/fapi/v1/time") {
        timeRequests += 1;
        return new Response(JSON.stringify({ serverTime: 10_000 }));
      }
      if (pathname === "/fapi/v3/account") {
        accountRequests += 1;
        if (accountRequests === 1) {
          return new Response(JSON.stringify({ code: -1021, msg: "timestamp outside recvWindow" }), { status: 400 });
        }
      }
      return new Response(JSON.stringify(responses[pathname]));
    },
  });
  const snapshot = await client.fetchSnapshot();
  assert.equal(snapshot.account.canTrade, true);
  assert.equal(timeRequests, 2);
  assert.equal(accountRequests, 2);
});

test("连续账户轮询复用新鲜服务器时差，避免代理缓存反复制造过期时间戳", async () => {
  let now = 10_000;
  let timeRequests = 0;
  const responses = {
    "/fapi/v3/account": { canTrade: true, availableBalance: "100", assets: [] },
    "/fapi/v3/positionRisk": [],
    "/fapi/v1/openOrders": [],
    "/fapi/v1/openAlgoOrders": [],
    "/fapi/v1/positionSide/dual": { dualSidePosition: false },
    "/fapi/v1/symbolConfig": [{ symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 10 }],
  };
  const client = new BinanceTestnetReadOnlyClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => now,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/fapi/v1/time") {
        timeRequests += 1;
        return new Response(JSON.stringify({ serverTime: now }));
      }
      return new Response(JSON.stringify(responses[pathname]));
    },
  });
  await client.fetchSnapshot();
  now += 60_000;
  await client.fetchSnapshot();
  assert.equal(timeRequests, 1);
});

test("只读账户请求遇到一次网络超时会重新校时并安全重试", async () => {
  let timeRequests = 0;
  let accountRequests = 0;
  const client = new BinanceTestnetReadOnlyClient({
    baseUrl: "https://demo-fapi.binance.com", apiKey: "key", apiSecret: "secret", now: () => 10_000,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/fapi/v1/time") {
        timeRequests += 1;
        return new Response(JSON.stringify({ serverTime: 10_000 }));
      }
      if (pathname === "/fapi/v3/account") {
        accountRequests += 1;
        if (accountRequests === 1) throw new DOMException("timed out", "TimeoutError");
        return new Response(JSON.stringify({ canTrade: true, availableBalance: "100", assets: [] }));
      }
      throw new Error(`unexpected endpoint ${pathname}`);
    },
  });

  const account = await client.signedGet("/fapi/v3/account");
  assert.equal(account.canTrade, true);
  assert.equal(accountRequests, 2);
  assert.equal(timeRequests, 2);
});

test("执行网关在当前阶段结构性拒绝下单和撤单", async () => {
  const gateway = new TestnetExecutionGateway({ environment: "TESTNET", orderSubmissionEnabled: false });
  assert.equal(gateway.snapshot().orderSubmissionEnabled, false);
  await assert.rejects(() => gateway.submitOrder({ symbol: "BTCUSDT" }), ExecutionDisabledError);
  await assert.rejects(() => gateway.cancelAllOrders(), /尚未启用/);
  assert.throws(() => new TestnetExecutionGateway({ environment: "PRODUCTION" }), /只能绑定/);
  assert.throws(() => new TestnetExecutionGateway({ environment: "TESTNET", orderSubmissionEnabled: true }), /必须提供执行器/);
});

test("解锁后的网关只能把已确认的金丝雀计划交给执行器", async () => {
  const calls = [];
  const executor = {
    async execute(runId, confirmationCode) { calls.push({ runId, confirmationCode }); return { id: runId, status: "ENTRY_PENDING" }; },
    async engageEmergencyStop(reason) { return { active: true, reason }; },
  };
  const gateway = new TestnetExecutionGateway({ environment: "TESTNET", orderSubmissionEnabled: true, executor });
  const result = await gateway.submitOrder({ runId: "canary-1", confirmationCode: "confirm" });
  assert.equal(result.status, "ENTRY_PENDING");
  assert.deepEqual(calls, [{ runId: "canary-1", confirmationCode: "confirm" }]);
  assert.equal((await gateway.emergencyStop("MANUAL")).active, true);
  await assert.rejects(() => gateway.cancelAllOrders(), /禁止账户级全撤/);
});
