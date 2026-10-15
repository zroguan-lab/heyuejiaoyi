import { BinanceFuturesClient } from "../exchanges/binance-futures.js";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rateLimited(error) {
  return error?.code === "BINANCE_RATE_LIMIT_BLOCKED"
    || /Binance HTTP (?:418|429):/.test(String(error?.message ?? error));
}

export class HistoricalBinanceFuturesClient extends BinanceFuturesClient {
  constructor({
    minimumRequestIntervalMs = 500,
    rateLimitRetries = 8,
    sleep = delay,
    ...options
  } = {}) {
    super(options);
    if (!Number.isFinite(minimumRequestIntervalMs) || minimumRequestIntervalMs < 0 || minimumRequestIntervalMs > 60_000) {
      throw new Error("历史行情请求间隔必须是0到60000毫秒");
    }
    if (!Number.isInteger(rateLimitRetries) || rateLimitRetries < 0 || rateLimitRetries > 20) {
      throw new Error("历史行情限流重试次数必须是0到20的整数");
    }
    if (typeof sleep !== "function") throw new TypeError("历史行情客户端缺少sleep函数");
    this.minimumRequestIntervalMs = Number(minimumRequestIntervalMs);
    this.rateLimitRetries = rateLimitRetries;
    this.sleep = sleep;
    this.nextRequestAt = 0;
  }

  async pace() {
    const waitMs = this.nextRequestAt - this.now();
    if (waitMs > 0) await this.sleep(waitMs);
    this.nextRequestAt = this.now() + this.minimumRequestIntervalMs;
  }

  async request(pathname, parameters = {}) {
    for (let attempt = 0; attempt <= this.rateLimitRetries; attempt += 1) {
      await this.pace();
      try {
        return await super.request(pathname, parameters);
      } catch (error) {
        if (!rateLimited(error) || attempt >= this.rateLimitRetries) throw error;
        const status = this.rateLimitStatus();
        const waitMs = Math.max(
          this.minimumRequestIntervalMs,
          Number(error?.retryAt ?? status.blockedUntil) - this.now(),
          1,
        );
        await this.sleep(waitMs);
      }
    }
    throw new Error("历史行情限流重试未能收敛");
  }
}
