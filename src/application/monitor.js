import { EventEmitter } from "node:events";
import { analyzeMarket } from "../domain/strategy.js";

export class MarketMonitor extends EventEmitter {
  constructor({ exchange, store, config, logger = console }) {
    super();
    this.exchange = exchange;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.latest = new Map();
    this.timer = null;
    this.running = false;
    this.state = {
      startedAt: null,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      scanCount: 0,
      errors: {},
    };
  }

  async scanSymbol(symbol) {
    const candles = await this.exchange.fetchKlines(symbol, this.config.interval, this.config.candleLimit);
    const analysis = analyzeMarket({ symbol, interval: this.config.interval, candles, config: this.config.strategy });
    analysis.source = this.config.provider;
    this.latest.set(symbol, analysis);
    const created = await this.store.append(analysis);
    this.emit("analysis", analysis);
    if (created) this.logger.info(`[signal] ${symbol} ${analysis.action} @ ${analysis.risk.entry}`);
    return analysis;
  }

  async scanAll() {
    if (this.running) return { skipped: true, reason: "previous_scan_running" };
    this.running = true;
    this.state.lastScanStartedAt = new Date().toISOString();
    const results = await Promise.allSettled(this.config.symbols.map((symbol) => this.scanSymbol(symbol)));
    results.forEach((result, index) => {
      const symbol = this.config.symbols[index];
      if (result.status === "rejected") {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.latest.delete(symbol);
        this.state.errors[symbol] = { message, at: new Date().toISOString() };
        this.logger.error(`[error] ${symbol}: ${message}`);
      } else {
        delete this.state.errors[symbol];
      }
    });
    this.state.scanCount += 1;
    this.state.lastScanCompletedAt = new Date().toISOString();
    this.running = false;
    return { skipped: false, results };
  }

  async start() {
    if (this.timer) return;
    this.state.startedAt = new Date().toISOString();
    await this.scanAll();
    this.timer = setInterval(() => void this.scanAll(), this.config.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      status: this.running ? "SCANNING" : "IDLE",
      ...this.state,
      symbols: this.config.symbols,
      interval: this.config.interval,
      pollSeconds: this.config.pollMs / 1000,
      latest: this.config.symbols.map((symbol) => this.latest.get(symbol)).filter(Boolean),
    };
  }
}
