import { ALLOWED_INTERVALS } from "../config.js";
import { networkErrorDetail } from "./network-error.js";

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;
const OKX_INTERVALS = new Map([
  ["1m", "1m"], ["3m", "3m"], ["5m", "5m"], ["15m", "15m"], ["30m", "30m"],
  ["1h", "1H"], ["2h", "2H"], ["4h", "4H"], ["6h", "6H"], ["8h", "8H"], ["12h", "12H"],
  ["1d", "1D"], ["3d", "3D"], ["1w", "1W"], ["1M", "1M"],
]);
const INTERVAL_MS = new Map([
  ["1m", 60_000], ["3m", 180_000], ["5m", 300_000], ["15m", 900_000], ["30m", 1_800_000],
  ["1h", 3_600_000], ["2h", 7_200_000], ["4h", 14_400_000], ["6h", 21_600_000], ["8h", 28_800_000],
  ["12h", 43_200_000], ["1d", 86_400_000], ["3d", 259_200_000], ["1w", 604_800_000], ["1M", 2_592_000_000],
]);

export function toOkxInstrument(symbol) {
  if (!SYMBOL_PATTERN.test(symbol) || !symbol.endsWith("USDT") || symbol.length <= 4) {
    throw new Error(`OKX 适配器只接受形如 BTCUSDT 的 USDT 永续合约: ${symbol}`);
  }
  return `${symbol.slice(0, -4)}-USDT-SWAP`;
}

export class OkxFuturesClient {
  constructor({ baseUrl = "https://www.okx.com", timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    if (typeof this.fetch !== "function") throw new Error("当前 Node.js 版本不支持 fetch");
  }

  async request(pathname, parameters = {}) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetch(url, {
        headers: { accept: "application/json", "user-agent": "futures-signal-bot/0.1" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`OKX 行情请求失败: ${networkErrorDetail(error)}`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`OKX HTTP ${response.status}: ${text.slice(0, 200)}`);
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("OKX 返回了无效 JSON"); }
    if (payload.code !== "0") throw new Error(`OKX API ${payload.code}: ${payload.msg || "未知错误"}`);
    return payload.data;
  }

  async fetchKlines(symbol, interval, limit = 300) {
    if (!ALLOWED_INTERVALS.has(interval) || !OKX_INTERVALS.has(interval)) throw new Error(`OKX 不支持周期: ${interval}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1500) throw new Error("limit 必须是 1 到 1500 的整数");
    const rows = await this.request("/api/v5/market/candles", {
      instId: toOkxInstrument(symbol),
      bar: OKX_INTERVALS.get(interval),
      limit: Math.min(limit, 300),
    });
    if (!Array.isArray(rows)) throw new Error("OKX K 线响应格式不正确");
    const duration = INTERVAL_MS.get(interval);
    return rows
      .filter((row) => row[8] === "1")
      .map((row) => {
        const openTime = Number(row[0]);
        return {
          openTime,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[7] || row[6] || row[5]),
          closeTime: openTime + duration - 1,
          quoteVolume: Number(row[7] || 0),
          trades: 0,
        };
      })
      .filter((candle) => [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
      .sort((left, right) => left.openTime - right.openTime);
  }

  async ping() {
    const data = await this.request("/api/v5/public/time");
    return { serverTime: Number(data[0]?.ts) };
  }
}
