import { BinanceFuturesClient } from "./binance-futures.js";
import { OkxFuturesClient } from "./okx-futures.js";
import { HyperliquidFuturesClient } from "./hyperliquid-futures.js";

export function createMarketDataClient(config) {
  if (config.provider === "binance") {
    return new BinanceFuturesClient({ baseUrl: config.binanceBaseUrl, timeoutMs: config.requestTimeoutMs });
  }
  if (config.provider === "okx") {
    return new OkxFuturesClient({ baseUrl: config.okxBaseUrl, timeoutMs: config.requestTimeoutMs });
  }
  if (config.provider === "hyperliquid") {
    return new HyperliquidFuturesClient({ baseUrl: config.hyperliquidBaseUrl, timeoutMs: config.requestTimeoutMs });
  }
  throw new Error(`不支持的行情源: ${config.provider}`);
}

export function providerLabel(provider) {
  if (provider === "hyperliquid") return "Hyperliquid Perpetuals";
  if (provider === "okx") return "OKX USDT Perpetual";
  return "Binance USDⓈ-M Futures";
}
