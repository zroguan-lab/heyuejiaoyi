import { ALLOWED_INTERVALS } from "../config.js";
import { networkErrorDetail } from "./network-error.js";

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;
const SUPPORTED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M",
]);
const INTERVAL_MS = new Map([
  ["1m", 60_000], ["3m", 180_000], ["5m", 300_000], ["15m", 900_000], ["30m", 1_800_000],
  ["1h", 3_600_000], ["2h", 7_200_000], ["4h", 14_400_000], ["8h", 28_800_000],
  ["12h", 43_200_000], ["1d", 86_400_000], ["3d", 259_200_000], ["1w", 604_800_000], ["1M", 2_592_000_000],
]);

export function toHyperliquidCoin(symbol) {
  if (!SYMBOL_PATTERN.test(symbol) || !symbol.endsWith("USDT") || symbol.length <= 4) {
    throw new Error(`Hyperliquid 适配器只接受形如 BTCUSDT 的统一交易对代码: ${symbol}`);
  }
  return symbol.slice(0, -4);
}

export class HyperliquidFuturesClient {
  constructor({ baseUrl = "https://api.hyperliquid.xyz", timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    if (typeof this.fetch !== "function") throw new Error("当前 Node.js 版本不支持 fetch");
  }

  async request(body) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/info`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "futures-signal-bot/0.1" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Hyperliquid 行情请求失败: ${networkErrorDetail(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error("Hyperliquid 返回了无效 JSON"); }
  }

  async fetchKlines(symbol, interval, limit = 300, now = Date.now()) {
    if (!ALLOWED_INTERVALS.has(interval) || !SUPPORTED_INTERVALS.has(interval)) {
      throw new Error(`Hyperliquid 不支持周期: ${interval}`);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit 必须是 1 到 1500 的整数");
    const duration = INTERVAL_MS.get(interval);
    const requested = Math.min(limit, 1500);
    const rows = await this.request({
      type: "candleSnapshot",
      req: {
        coin: toHyperliquidCoin(symbol),
        interval,
        startTime: now - duration * (requested + 2),
        endTime: now,
      },
    });
    if (!Array.isArray(rows)) throw new Error("Hyperliquid K 线响应格式不正确");
    return rows
      .map((row) => {
        const close = Number(row.c);
        const volume = Number(row.v);
        return {
          openTime: Number(row.t),
          open: Number(row.o),
          high: Number(row.h),
          low: Number(row.l),
          close,
          volume,
          closeTime: Number(row.T),
          quoteVolume: volume * close,
          trades: Number(row.n),
        };
      })
      .filter((candle) => candle.closeTime < now)
      .filter((candle) => [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
      .sort((left, right) => left.openTime - right.openTime)
      .slice(-requested);
  }

  async ping(now = Date.now()) {
    const rows = await this.fetchKlines("BTCUSDT", "1m", 2, now);
    return { serverTime: rows.at(-1)?.closeTime ?? null };
  }
}
