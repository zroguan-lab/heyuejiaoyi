import { createHmac } from "node:crypto";
import { networkErrorDetail } from "../exchanges/network-error.js";
import { assertBinanceRequestAvailable, binanceRetryAt, recordBinanceBlock } from "../exchanges/binance-rate-limit.js";
import { inferPositionMarginType } from "./binance-position.js";

const TESTNET_ORIGIN = "https://demo-fapi.binance.com";
const TIME_SYNC_TTL_MS = 5 * 60_000;
const READ_ONLY_PATHS = new Set([
  "/fapi/v3/account",
  "/fapi/v3/positionRisk",
  "/fapi/v1/openOrders",
  "/fapi/v1/openAlgoOrders",
  "/fapi/v1/positionSide/dual",
  "/fapi/v1/symbolConfig",
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeApiError(status, text) {
  try {
    const payload = JSON.parse(text);
    return `Binance Testnet HTTP ${status}: ${payload.code ?? "UNKNOWN"} ${String(payload.msg ?? "请求失败").slice(0, 160)}`;
  } catch {
    return `Binance Testnet HTTP ${status}: 请求失败`;
  }
}

function apiErrorCode(text) {
  try {
    const code = Number(JSON.parse(text)?.code);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

export class BinanceTestnetReadOnlyClient {
  constructor({
    baseUrl,
    apiKey,
    apiSecret,
    timeoutMs = 10_000,
    recvWindow = 5_000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.origin !== TESTNET_ORIGIN || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new Error(`只读账户客户端仅允许 ${TESTNET_ORIGIN}`);
    }
    if (!apiKey || !apiSecret) throw new Error("缺少 Binance 测试网 API 凭据");
    if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 版本不支持 fetch");
    this.baseUrl = TESTNET_ORIGIN;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.timeoutMs = timeoutMs;
    this.recvWindow = recvWindow;
    this.fetch = fetchImpl;
    this.now = now;
    this.serverOffsetMs = 0;
    this.lastServerTime = null;
    this.lastTimeSyncAt = 0;
    this.timeSyncPromise = null;
    this.blockedUntil = 0;
  }

  async requestPublic(pathname) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertBinanceRequestAvailable(this.blockedUntil, this.now(), this.baseUrl);
      try {
        response = await this.fetch(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "cache-control": "no-cache, no-store",
            pragma: "no-cache",
            "user-agent": "futures-signal-bot/0.2",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(attempt === 0 ? this.timeoutMs : Math.min(this.timeoutMs * 2, 60_000)),
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!response) {
      throw new Error(`Binance Testnet 连接连续2次失败: ${networkErrorDetail(lastError)}`, { cause: lastError });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAt = binanceRetryAt(response, text, this.now());
      if (retryAt) this.blockedUntil = recordBinanceBlock(this.baseUrl, Math.max(this.blockedUntil, retryAt));
      throw new Error(safeApiError(response.status, text));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Binance Testnet 返回了无效 JSON");
    }
  }

  async syncServerTime() {
    const result = await this.requestPublic("/fapi/v1/time");
    const after = this.now();
    const serverTime = Number(result.serverTime);
    if (!Number.isFinite(serverTime)) throw new Error("Binance Testnet 服务器时间无效");
    // Binance rejects timestamps more than 1s ahead even when recvWindow is larger.
    // Anchoring to response receipt is deliberately conservative under a slow proxy.
    this.serverOffsetMs = serverTime - after;
    this.lastServerTime = serverTime;
    this.lastTimeSyncAt = after;
    return { serverTime, offsetMs: this.serverOffsetMs };
  }

  async ensureTimeSync(force = false) {
    if (!force && this.lastTimeSyncAt > 0 && this.now() - this.lastTimeSyncAt <= TIME_SYNC_TTL_MS) {
      return { serverTime: this.lastServerTime, offsetMs: this.serverOffsetMs };
    }
    if (!this.timeSyncPromise) {
      this.timeSyncPromise = this.syncServerTime().finally(() => { this.timeSyncPromise = null; });
    }
    return await this.timeSyncPromise;
  }

  async signedGet(pathname, parameters = {}, allowTimestampRetry = true, allowNetworkRetry = true) {
    if (!READ_ONLY_PATHS.has(pathname)) throw new Error(`拒绝非只读账户端点: ${pathname}`);
    assertBinanceRequestAvailable(this.blockedUntil, this.now(), this.baseUrl);
    await this.ensureTimeSync();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    query.set("recvWindow", String(this.recvWindow));
    query.set("timestamp", String(Math.trunc(this.now() + this.serverOffsetMs)));
    const payload = query.toString();
    const signature = createHmac("sha256", this.apiSecret).update(payload).digest("hex");
    const url = new URL(pathname, `${this.baseUrl}/`);
    url.search = `${payload}&signature=${signature}`;
    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "futures-signal-bot/0.2",
          "X-MBX-APIKEY": this.apiKey,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (allowNetworkRetry) {
        await this.ensureTimeSync(true);
        return await this.signedGet(pathname, parameters, allowTimestampRetry, false);
      }
      throw new Error(`Binance Testnet 只读请求失败: ${networkErrorDetail(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAt = binanceRetryAt(response, text, this.now());
      if (retryAt) this.blockedUntil = recordBinanceBlock(this.baseUrl, Math.max(this.blockedUntil, retryAt));
      if (allowTimestampRetry && apiErrorCode(text) === -1021) {
        await this.ensureTimeSync(true);
        return await this.signedGet(pathname, parameters, false, allowNetworkRetry);
      }
      throw new Error(safeApiError(response.status, text));
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Binance Testnet 返回了无效 JSON");
    }
  }

  async fetchSnapshot() {
    const timing = await this.ensureTimeSync();
    const [account, positions, openOrders, openAlgoOrders, positionMode, symbolConfigs] = await Promise.all([
      this.signedGet("/fapi/v3/account"),
      this.signedGet("/fapi/v3/positionRisk"),
      this.signedGet("/fapi/v1/openOrders"),
      this.signedGet("/fapi/v1/openAlgoOrders", { algoType: "CONDITIONAL" }),
      this.signedGet("/fapi/v1/positionSide/dual"),
      this.signedGet("/fapi/v1/symbolConfig", { symbol: "BTCUSDT" }),
    ]);
    if (![positions, openOrders, openAlgoOrders, symbolConfigs].every(Array.isArray)) throw new Error("Binance Testnet 账户响应格式不正确");
    const activePositions = positions
      .filter((item) => Math.abs(Number(item.positionAmt)) > 0)
      .map((item) => ({
        symbol: item.symbol,
        positionSide: item.positionSide,
        quantity: finiteNumber(item.positionAmt),
        entryPrice: finiteNumber(item.entryPrice),
        markPrice: finiteNumber(item.markPrice),
        liquidationPrice: finiteNumber(item.liquidationPrice),
        unrealizedPnl: finiteNumber(item.unRealizedProfit ?? item.unrealizedProfit),
        leverage: finiteNumber(item.leverage),
        marginType: inferPositionMarginType(item),
      }));
    const orders = openOrders.map((item) => ({
      symbol: item.symbol,
      orderId: String(item.orderId),
      clientOrderId: item.clientOrderId,
      side: item.side,
      positionSide: item.positionSide,
      type: item.type,
      status: item.status,
      price: finiteNumber(item.price),
      originalQuantity: finiteNumber(item.origQty),
      executedQuantity: finiteNumber(item.executedQty),
      reduceOnly: Boolean(item.reduceOnly),
      updateTime: Number(item.updateTime ?? item.time),
    }));
    const algoOrders = openAlgoOrders.map((item) => ({
      symbol: item.symbol,
      algoId: String(item.algoId),
      clientAlgoId: item.clientAlgoId,
      side: item.side,
      positionSide: item.positionSide,
      type: item.orderType ?? item.type,
      status: item.algoStatus ?? item.status,
      quantity: finiteNumber(item.quantity),
      triggerPrice: finiteNumber(item.triggerPrice),
      closePosition: String(item.closePosition) === "true" || item.closePosition === true,
      reduceOnly: String(item.reduceOnly) === "true" || item.reduceOnly === true,
      updateTime: Number(item.updateTime ?? item.createTime),
    }));
    const btcConfig = symbolConfigs.find((item) => item.symbol === "BTCUSDT") ?? null;
    const assets = Array.isArray(account?.assets)
      ? account.assets
        .filter((item) => Math.abs(Number(item.walletBalance)) > 0 || Math.abs(Number(item.unrealizedProfit)) > 0)
        .map((item) => ({
          asset: item.asset,
          walletBalance: finiteNumber(item.walletBalance),
          availableBalance: finiteNumber(item.availableBalance),
          unrealizedPnl: finiteNumber(item.unrealizedProfit),
        }))
      : [];
    return {
      environment: "TESTNET",
      authority: "BINANCE_TESTNET",
      readOnly: true,
      syncedAt: this.now(),
      serverTime: timing.serverTime,
      clockOffsetMs: timing.offsetMs,
      account: {
        canTrade: Boolean(account?.canTrade),
        totalWalletBalance: finiteNumber(account?.totalWalletBalance),
        availableBalance: finiteNumber(account?.availableBalance),
        totalMarginBalance: finiteNumber(account?.totalMarginBalance),
        totalUnrealizedPnl: finiteNumber(account?.totalUnrealizedProfit),
        assets,
      },
      positionMode: positionMode?.dualSidePosition ? "HEDGE" : "ONE_WAY",
      positions: activePositions,
      openOrders: orders,
      openAlgoOrders: algoOrders,
      symbolConfig: btcConfig ? {
        symbol: btcConfig.symbol,
        marginType: btcConfig.marginType,
        leverage: finiteNumber(btcConfig.leverage),
        maxNotionalValue: finiteNumber(btcConfig.maxNotionalValue),
      } : null,
    };
  }
}

export { READ_ONLY_PATHS, TESTNET_ORIGIN };
