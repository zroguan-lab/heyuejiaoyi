import test from "node:test";
import assert from "node:assert/strict";
import { MarketMonitor } from "../src/application/monitor.js";
import { strategyConfig, trendingCandles } from "./helpers.js";

test("监控器隔离单一市场故障并保留成功结果", async () => {
  const appended = [];
  const exchange = {
    async fetchKlines(symbol) {
      if (symbol === "BADUSDT") throw new Error("upstream unavailable");
      return trendingCandles("up");
    },
  };
  const store = { async append(item) { appended.push(item); return true; }, list() { return appended; } };
  const logger = { info() {}, error() {} };
  const config = { symbols: ["BTCUSDT", "BADUSDT"], interval: "15m", candleLimit: 120, pollMs: 30_000, strategy: strategyConfig };
  const monitor = new MarketMonitor({ exchange, store, config, logger });

  await monitor.scanAll();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.latest.length, 1);
  assert.equal(snapshot.latest[0].symbol, "BTCUSDT");
  assert.match(snapshot.errors.BADUSDT.message, /upstream unavailable/);
  assert.equal(appended.length, 1);
});

test("后续行情失败时撤下旧的当前信号，避免展示过期建议", async () => {
  let shouldFail = false;
  const exchange = { async fetchKlines() { if (shouldFail) throw new Error("network down"); return trendingCandles("up"); } };
  const store = { async append() { return true; }, list() { return []; } };
  const logger = { info() {}, error() {} };
  const config = { symbols: ["BTCUSDT"], interval: "15m", candleLimit: 120, pollMs: 30_000, strategy: strategyConfig };
  const monitor = new MarketMonitor({ exchange, store, config, logger });

  await monitor.scanAll();
  assert.equal(monitor.snapshot().latest.length, 1);
  shouldFail = true;
  await monitor.scanAll();
  assert.equal(monitor.snapshot().latest.length, 0);
  assert.match(monitor.snapshot().errors.BTCUSDT.message, /network down/);
});
