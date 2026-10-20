import { createHmac } from "node:crypto";
import { networkErrorDetail } from "../exchanges/network-error.js";
import { assertBinanceRequestAvailable, binanceRetryAt, recordBinanceBlock } from "../exchanges/binance-rate-limit.js";
import { credentialFingerprint } from "./order-permission.js";
import { assertExecutionSymbol } from "./execution-symbols.js";
import { inferPositionMarginType } from "./binance-position.js";

const TESTNET_ORIGIN = "https://demo-fapi.binance.com";
const TIME_SYNC_TTL_MS = 5 * 60_000;
const PUBLIC_PATHS = new Set(["/fapi/v1/time", "/fapi/v1/exchangeInfo", "/fapi/v1/premiumIndex", "/fapi/v1/ticker/bookTicker"]);
const SIGNED_READ_PATHS = new Set([
  "/fapi/v3/account",
  "/fapi/v3/positionRisk",
  "/fapi/v1/openOrders",
  "/fapi/v1/openAlgoOrders",
  "/fapi/v1/positionSide/dual",
  "/fapi/v1/symbolConfig",
  "/fapi/v1/leverageBracket",
  "/fapi/v1/order",
  "/fapi/v1/algoOrder",
  "/fapi/v1/userTrades",
  "/fapi/v1/income",
]);
const SIGNED_WRITE_OPERATIONS = new Set([
  "POST /fapi/v1/order",
  "POST /fapi/v1/algoOrder",
  "POST /fapi/v1/leverage",
  "POST /fapi/v1/marginType",
  "DELETE /fapi/v1/order",
  "DELETE /fapi/v1/algoOrder",
]);
const SIGNED_DRY_RUN_OPERATIONS = new Set(["POST /fapi/v1/order/test"]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeParameters(parameters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return query;
}

export class BinanceApiError extends Error {
  constructor({ status, code = "UNKNOWN", message = "请求失败", retryAt = null } = {}) {
    super(`Binance Testnet HTTP ${status}: ${code} ${String(message).slice(0, 160)}`);
    this.name = "BinanceApiError";
    this.status = status;
    this.apiCode = Number.isFinite(Number(code)) ? Number(code) : code;
    this.retryAt = Number.isFinite(retryAt) ? retryAt : null;
  }
}

export class TestnetWriteDisabledError extends Error {
  constructor(action) {
    super(`测试网写入锁尚未开启，拒绝操作: ${action}`);
    this.name = "TestnetWriteDisabledError";
    this.code = "TESTNET_WRITE_DISABLED";
  }
}

function parseApiError(status, text, retryAt = null) {
  try {
    const payload = JSON.parse(text);
    return new BinanceApiError({ status, code: payload.code, message: payload.msg, retryAt });
  } catch {
    return new BinanceApiError({ status, retryAt });
  }
}

function assertClientId(value, label) {
  if (!/^[.A-Z:/a-z0-9_-]{1,36}$/.test(String(value ?? ""))) {
    throw new TypeError(`${label} 必须是 1-36 位 Binance 允许的字符`);
  }
}

function assertPositiveString(value, label) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new TypeError(`${label} 必须是正数`);
}

function assertTimeInForce(value) {
  if (!new Set(["IOC", "GTC"]).has(value)) throw new TypeError("timeInForce 只允许 IOC 或 GTC");
  return value;
}

function normalizeOrder(item) {
  if (!item) return null;
  return {
    symbol: item.symbol,
    orderId: String(item.orderId),
    clientOrderId: item.clientOrderId,
    side: item.side,
    positionSide: item.positionSide,
    type: item.type,
    timeInForce: item.timeInForce ?? null,
    status: item.status,
    price: finiteNumber(item.price),
    averagePrice: finiteNumber(item.avgPrice),
    originalQuantity: finiteNumber(item.origQty),
    executedQuantity: finiteNumber(item.executedQty ?? item.cumQty),
    cumulativeQuote: finiteNumber(item.cumQuote),
    reduceOnly: Boolean(item.reduceOnly),
    updateTime: Number(item.updateTime ?? item.time),
  };
}

function normalizeAlgoOrder(item) {
  if (!item) return null;
  return {
    symbol: item.symbol,
    algoId: String(item.algoId),
    clientAlgoId: item.clientAlgoId,
    side: item.side,
    positionSide: item.positionSide,
    type: item.orderType ?? item.type,
    status: item.algoStatus ?? item.status,
    quantity: finiteNumber(item.quantity),
    actualQuantity: finiteNumber(item.actualQty),
    actualOrderId: item.actualOrderId === undefined || item.actualOrderId === null || item.actualOrderId === ""
      ? null
      : String(item.actualOrderId),
    actualPrice: finiteNumber(item.actualPrice),
    triggerPrice: finiteNumber(item.triggerPrice),
    closePosition: String(item.closePosition) === "true" || item.closePosition === true,
    reduceOnly: String(item.reduceOnly) === "true" || item.reduceOnly === true,
    updateTime: Number(item.updateTime ?? item.createTime),
  };
}

export class BinanceTestnetTradingClient {
  constructor({
    baseUrl,
    apiKey,
    apiSecret,
    writeEnabled = false,
    allowedSymbols = ["BTCUSDT"],
    timeoutMs = 10_000,
    recvWindow = 5_000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  } = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.origin !== TESTNET_ORIGIN || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new Error(`交易客户端仅允许 ${TESTNET_ORIGIN}`);
    }
    if (!apiKey || !apiSecret) throw new Error("缺少 Binance 测试网 API 凭据");
    if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 版本不支持 fetch");
    this.baseUrl = TESTNET_ORIGIN;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.credentialFingerprint = credentialFingerprint(apiKey);
    this.writeEnabled = Boolean(writeEnabled);
    if (!Array.isArray(allowedSymbols) || allowedSymbols.length === 0) throw new Error("执行客户端至少需要一个标的白名单");
    this.allowedSymbols = new Set(allowedSymbols.map((symbol) => assertExecutionSymbol(symbol, "执行白名单标的")));
    this.timeoutMs = timeoutMs;
    this.recvWindow = recvWindow;
    this.fetch = fetchImpl;
    this.now = now;
    this.serverOffsetMs = 0;
    this.lastTimeSyncAt = 0;
    this.timeSyncPromise = null;
    this.blockedUntil = 0;
  }

  assertSymbol(symbol) {
    if (!this.allowedSymbols.has(symbol)) throw new Error(`执行客户端拒绝非白名单标的: ${symbol}`);
  }

  allowSymbols(symbols = []) {
    if (!Array.isArray(symbols)) throw new TypeError("动态执行白名单必须是数组");
    for (const symbol of symbols) this.allowedSymbols.add(assertExecutionSymbol(symbol, "动态执行白名单标的"));
    return [...this.allowedSymbols];
  }

  async requestPublic(pathname, parameters = {}) {
    if (!PUBLIC_PATHS.has(pathname)) throw new Error(`拒绝非白名单公开端点: ${pathname}`);
    const url = new URL(pathname, `${this.baseUrl}/`);
    url.search = normalizeParameters(parameters).toString();
    assertBinanceRequestAvailable(this.blockedUntil, this.now(), this.baseUrl);
    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store",
          pragma: "no-cache",
          "user-agent": "futures-signal-bot/0.3",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Binance Testnet 连接失败: ${networkErrorDetail(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAt = binanceRetryAt(response, text, this.now());
      if (retryAt) this.blockedUntil = recordBinanceBlock(this.baseUrl, Math.max(this.blockedUntil, retryAt));
      throw parseApiError(response.status, text, retryAt);
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
    // Keep signed requests at or behind the observed server time. A midpoint
    // estimate can be over 1s ahead when the proxy path is slow or asymmetric.
    this.serverOffsetMs = serverTime - after;
    this.lastTimeSyncAt = after;
    return { serverTime, offsetMs: this.serverOffsetMs };
  }

  async ensureTimeSync(force = false) {
    if (!force && this.lastTimeSyncAt > 0 && this.now() - this.lastTimeSyncAt <= TIME_SYNC_TTL_MS) return;
    if (!this.timeSyncPromise) {
      this.timeSyncPromise = this.syncServerTime().finally(() => { this.timeSyncPromise = null; });
    }
    await this.timeSyncPromise;
  }

  async signedRequest(method, pathname, parameters = {}, allowTimestampRetry = true) {
    const upperMethod = String(method).toUpperCase();
    const operation = `${upperMethod} ${pathname}`;
    const readAllowed = upperMethod === "GET" && SIGNED_READ_PATHS.has(pathname);
    const writeAllowed = SIGNED_WRITE_OPERATIONS.has(operation);
    const dryRunAllowed = SIGNED_DRY_RUN_OPERATIONS.has(operation);
    if (!readAllowed && !writeAllowed && !dryRunAllowed) throw new Error(`拒绝非白名单 Binance 操作: ${operation}`);
    if (writeAllowed && !this.writeEnabled) throw new TestnetWriteDisabledError(operation);
    assertBinanceRequestAvailable(this.blockedUntil, this.now(), this.baseUrl);
    await this.ensureTimeSync();

    const query = normalizeParameters(parameters);
    query.set("recvWindow", String(this.recvWindow));
    query.set("timestamp", String(Math.trunc(this.now() + this.serverOffsetMs)));
    const payload = query.toString();
    const signature = createHmac("sha256", this.apiSecret).update(payload).digest("hex");
    const signedPayload = `${payload}&signature=${signature}`;
    const url = new URL(pathname, `${this.baseUrl}/`);
    const options = {
      method: upperMethod,
      headers: {
        accept: "application/json",
        "user-agent": "futures-signal-bot/0.3",
        "X-MBX-APIKEY": this.apiKey,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (upperMethod === "POST") {
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      options.body = signedPayload;
    } else {
      url.search = signedPayload;
    }

    let response;
    try {
      response = await this.fetch(url, options);
    } catch (error) {
      throw new Error(`Binance Testnet 请求结果未知: ${networkErrorDetail(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAt = binanceRetryAt(response, text, this.now());
      if (retryAt) this.blockedUntil = recordBinanceBlock(this.baseUrl, Math.max(this.blockedUntil, retryAt));
      const apiError = parseApiError(response.status, text, retryAt);
      // -1021 is an explicit exchange rejection, so a single re-sign after
      // time resync is safe even for writes and cannot duplicate an order.
      if (allowTimestampRetry && apiError.apiCode === -1021) {
        await this.ensureTimeSync(true);
        return await this.signedRequest(method, pathname, parameters, false);
      }
      throw apiError;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Binance Testnet 返回了无效 JSON");
    }
  }

  async fetchExchangeInfo(symbol) {
    this.assertSymbol(symbol);
    const payload = await this.requestPublic("/fapi/v1/exchangeInfo");
    const item = Array.isArray(payload?.symbols) ? payload.symbols.find((value) => value.symbol === symbol) : null;
    if (!item) throw new Error(`Binance Testnet 未返回 ${symbol} 合约规则`);
    return item;
  }

  async fetchMarkPrice(symbol) {
    this.assertSymbol(symbol);
    const payload = await this.requestPublic("/fapi/v1/premiumIndex", { symbol });
    const markPrice = finiteNumber(payload?.markPrice);
    if (markPrice === null || markPrice <= 0) throw new Error(`Binance Testnet 未返回有效的 ${symbol} 标记价格`);
    return markPrice;
  }

  async fetchBookTicker(symbol) {
    this.assertSymbol(symbol);
    const payload = await this.requestPublic("/fapi/v1/ticker/bookTicker", { symbol });
    const bidPrice = finiteNumber(payload?.bidPrice);
    const askPrice = finiteNumber(payload?.askPrice);
    if (bidPrice === null || askPrice === null || bidPrice <= 0 || askPrice <= 0 || bidPrice > askPrice) {
      throw new Error(`Binance Testnet 未返回有效的 ${symbol} 买一卖一价格`);
    }
    const midPrice = (bidPrice + askPrice) / 2;
    return {
      symbol,
      bidPrice,
      askPrice,
      spreadBps: ((askPrice - bidPrice) / midPrice) * 10_000,
      updateTime: Number(payload?.time ?? this.now()),
    };
  }

  async fetchAccountOverview() {
    const [account, positions, openOrders, openAlgoOrders, positionMode] = await Promise.all([
      this.signedRequest("GET", "/fapi/v3/account"),
      this.signedRequest("GET", "/fapi/v3/positionRisk"),
      this.signedRequest("GET", "/fapi/v1/openOrders"),
      this.signedRequest("GET", "/fapi/v1/openAlgoOrders", { algoType: "CONDITIONAL" }),
      this.signedRequest("GET", "/fapi/v1/positionSide/dual"),
    ]);
    const activePositions = (Array.isArray(positions) ? positions : [])
      .filter((item) => Math.abs(Number(item.positionAmt)) > 0)
      .map((item) => ({
        symbol: item.symbol,
        positionSide: item.positionSide,
        quantity: finiteNumber(item.positionAmt),
        entryPrice: finiteNumber(item.entryPrice),
        markPrice: finiteNumber(item.markPrice),
        unrealizedPnl: finiteNumber(item.unRealizedProfit ?? item.unrealizedProfit),
        leverage: finiteNumber(item.leverage),
        marginType: inferPositionMarginType(item),
      }));
    return {
      environment: "TESTNET",
      authority: "BINANCE_TESTNET",
      syncedAt: this.now(),
      canTrade: Boolean(account?.canTrade),
      availableBalance: finiteNumber(account?.availableBalance),
      positionMode: positionMode?.dualSidePosition ? "HEDGE" : "ONE_WAY",
      positions: activePositions,
      openOrders: (Array.isArray(openOrders) ? openOrders : []).map(normalizeOrder),
      openAlgoOrders: (Array.isArray(openAlgoOrders) ? openAlgoOrders : []).map(normalizeAlgoOrder),
      symbolConfig: null,
    };
  }

  async fetchAccountState(symbol) {
    this.assertSymbol(symbol);
    const [overview, symbolConfigs] = await Promise.all([
      this.fetchAccountOverview(),
      this.signedRequest("GET", "/fapi/v1/symbolConfig", { symbol }),
    ]);
    const symbolConfig = (Array.isArray(symbolConfigs) ? symbolConfigs : []).find((item) => item.symbol === symbol) ?? null;
    return {
      ...overview,
      symbolConfig: symbolConfig ? {
        symbol: symbolConfig.symbol,
        marginType: symbolConfig.marginType,
        leverage: finiteNumber(symbolConfig.leverage),
        maxNotionalValue: finiteNumber(symbolConfig.maxNotionalValue),
      } : null,
    };
  }

  async fetchLeverageBrackets(symbol) {
    this.assertSymbol(symbol);
    const payload = await this.signedRequest("GET", "/fapi/v1/leverageBracket", { symbol });
    const item = Array.isArray(payload)
      ? payload.find((value) => value?.symbol === symbol)
      : payload?.symbol === symbol ? payload : null;
    const brackets = (Array.isArray(item?.brackets) ? item.brackets : []).map((bracket) => ({
      bracket: finiteNumber(bracket?.bracket),
      initialLeverage: finiteNumber(bracket?.initialLeverage),
      notionalFloor: finiteNumber(bracket?.notionalFloor),
      notionalCap: finiteNumber(bracket?.notionalCap),
      maintMarginRatio: finiteNumber(bracket?.maintMarginRatio),
      cum: finiteNumber(bracket?.cum),
    })).filter((bracket) => (
      bracket.initialLeverage !== null
      && bracket.initialLeverage >= 1
      && bracket.notionalFloor !== null
      && bracket.notionalCap !== null
      && bracket.notionalCap > bracket.notionalFloor
    ));
    if (!item || !brackets.length) throw new Error(`Binance Testnet 未返回 ${symbol} 有效的杠杆档位`);
    return {
      symbol,
      notionalCoef: finiteNumber(item.notionalCoef),
      brackets,
    };
  }

  async queryOrder(symbol, clientOrderId) {
    this.assertSymbol(symbol);
    assertClientId(clientOrderId, "clientOrderId");
    try {
      return normalizeOrder(await this.signedRequest("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }));
    } catch (error) {
      if (error instanceof BinanceApiError && error.apiCode === -2013) return null;
      throw error;
    }
  }

  async queryAlgoOrder(clientAlgoId) {
    assertClientId(clientAlgoId, "clientAlgoId");
    try {
      return normalizeAlgoOrder(await this.signedRequest("GET", "/fapi/v1/algoOrder", { clientAlgoId }));
    } catch (error) {
      if (error instanceof BinanceApiError && [-2011, -2013].includes(error.apiCode)) return null;
      throw error;
    }
  }

  async testLimitOrderPermission({ symbol, side, quantity, price, clientOrderId, timeInForce = "IOC" }) {
    this.assertSymbol(symbol);
    if (!new Set(["BUY", "SELL"]).has(side)) throw new TypeError("入场方向必须是 BUY 或 SELL");
    assertPositiveString(quantity, "quantity");
    assertPositiveString(price, "price");
    assertClientId(clientOrderId, "clientOrderId");
    assertTimeInForce(timeInForce);
    await this.signedRequest("POST", "/fapi/v1/order/test", {
      symbol,
      side,
      type: "LIMIT",
      timeInForce,
      quantity,
      price,
      positionSide: "BOTH",
      newClientOrderId: clientOrderId,
      newOrderRespType: "RESULT",
    });
    return { accepted: true, submittedToMatchingEngine: false };
  }

  async placeLimitOrder({ symbol, side, quantity, price, clientOrderId, timeInForce = "IOC" }) {
    this.assertSymbol(symbol);
    if (!new Set(["BUY", "SELL"]).has(side)) throw new TypeError("入场方向必须是 BUY 或 SELL");
    assertPositiveString(quantity, "quantity");
    assertPositiveString(price, "price");
    assertClientId(clientOrderId, "clientOrderId");
    assertTimeInForce(timeInForce);
    const result = await this.signedRequest("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "LIMIT",
      timeInForce,
      quantity,
      price,
      positionSide: "BOTH",
      newClientOrderId: clientOrderId,
      newOrderRespType: "RESULT",
    });
    return normalizeOrder(result);
  }

  async closePositionMarket({ symbol, side, quantity, clientOrderId }) {
    this.assertSymbol(symbol);
    if (!new Set(["BUY", "SELL"]).has(side)) throw new TypeError("平仓方向必须是 BUY 或 SELL");
    assertPositiveString(quantity, "quantity");
    assertClientId(clientOrderId, "clientOrderId");
    return normalizeOrder(await this.signedRequest("POST", "/fapi/v1/order", {
      symbol,
      side,
      type: "MARKET",
      quantity,
      positionSide: "BOTH",
      reduceOnly: "true",
      newClientOrderId: clientOrderId,
      newOrderRespType: "RESULT",
    }));
  }

  async cancelOrder(symbol, clientOrderId) {
    this.assertSymbol(symbol);
    assertClientId(clientOrderId, "clientOrderId");
    return normalizeOrder(await this.signedRequest("DELETE", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId }));
  }

  async placeStopClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    return this.placeAlgoOrder({
      symbol,
      side,
      type: "STOP_MARKET",
      triggerPrice,
      clientAlgoId,
      closePosition: quantity === null,
      quantity,
    });
  }

  async placeTakeProfitClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    return this.placeAlgoOrder({ symbol, side, type: "TAKE_PROFIT_MARKET", triggerPrice, clientAlgoId, closePosition: quantity === null, quantity });
  }

  async placeAlgoOrder({ symbol, side, type, triggerPrice, clientAlgoId, closePosition = false, quantity = null }) {
    this.assertSymbol(symbol);
    if (!new Set(["BUY", "SELL"]).has(side)) throw new TypeError("保护单方向必须是 BUY 或 SELL");
    if (!new Set(["STOP_MARKET", "TAKE_PROFIT_MARKET"]).has(type)) throw new TypeError("只允许 STOP_MARKET 或 TAKE_PROFIT_MARKET 保护单");
    assertPositiveString(triggerPrice, "triggerPrice");
    assertClientId(clientAlgoId, "clientAlgoId");
    if (closePosition && quantity !== null) throw new TypeError("closePosition 保护单不能同时指定 quantity");
    if (!closePosition) assertPositiveString(quantity, "quantity");
    const result = await this.signedRequest("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol,
      side,
      type,
      triggerPrice,
      workingType: "MARK_PRICE",
      positionSide: "BOTH",
      clientAlgoId,
      closePosition: closePosition ? "true" : undefined,
      quantity: closePosition ? undefined : quantity,
      reduceOnly: closePosition ? undefined : "true",
      priceProtect: "false",
    });
    return normalizeAlgoOrder(result);
  }

  async cancelAlgoOrder(clientAlgoId) {
    assertClientId(clientAlgoId, "clientAlgoId");
    return await this.signedRequest("DELETE", "/fapi/v1/algoOrder", { clientAlgoId });
  }

  async setLeverage(symbol, leverage) {
    this.assertSymbol(symbol);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new TypeError("leverage 必须是 1-125 的整数");
    return await this.signedRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
  }

  async setMarginType(symbol, marginType) {
    this.assertSymbol(symbol);
    if (!new Set(["ISOLATED", "CROSSED"]).has(marginType)) throw new TypeError("marginType 必须是 ISOLATED 或 CROSSED");
    return await this.signedRequest("POST", "/fapi/v1/marginType", { symbol, marginType });
  }

  async listUserTrades(symbol, { startTime = undefined, endTime = undefined, fromId = undefined, orderId = undefined } = {}) {
    this.assertSymbol(symbol);
    if (fromId !== undefined && (startTime !== undefined || endTime !== undefined)) {
      throw new TypeError("fromId 不能与 startTime/endTime 同时发送");
    }
    const rows = await this.signedRequest("GET", "/fapi/v1/userTrades", { symbol, startTime, endTime, fromId, orderId, limit: 1000 });
    if (!Array.isArray(rows)) throw new TypeError("成交历史响应不是数组，完整性未知");
    return rows.map((item) => ({
      id: String(item.id),
      orderId: String(item.orderId),
      symbol: item.symbol,
      side: item.side,
      price: finiteNumber(item.price),
      quantity: finiteNumber(item.qty),
      quoteQuantity: finiteNumber(item.quoteQty),
      commission: finiteNumber(item.commission),
      commissionAsset: item.commissionAsset,
      realizedPnl: finiteNumber(item.realizedPnl),
      time: Number(item.time),
      maker: Boolean(item.maker),
    }));
  }

  async listIncomeHistory(symbol, { incomeType = undefined, startTime = undefined, endTime = undefined, page = undefined } = {}) {
    this.assertSymbol(symbol);
    const rows = await this.signedRequest("GET", "/fapi/v1/income", {
      symbol,
      incomeType,
      startTime,
      endTime,
      page,
      limit: 1000,
    });
    if (!Array.isArray(rows)) throw new TypeError("资金费历史响应不是数组，完整性未知");
    return rows.map((item) => ({
      symbol: item.symbol,
      incomeType: item.incomeType,
      income: finiteNumber(item.income),
      asset: item.asset,
      info: item.info,
      time: Number(item.time),
      transactionId: item.tranId === undefined || item.tranId === null ? null : String(item.tranId),
      tradeId: item.tradeId === undefined || item.tradeId === null ? null : String(item.tradeId),
    }));
  }
}

export { PUBLIC_PATHS, SIGNED_DRY_RUN_OPERATIONS, SIGNED_READ_PATHS, SIGNED_WRITE_OPERATIONS, TESTNET_ORIGIN };
