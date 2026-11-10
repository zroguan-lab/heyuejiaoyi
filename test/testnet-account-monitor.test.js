import test from "node:test";
import assert from "node:assert/strict";
import { TestnetAccountMonitor } from "../src/application/testnet-account-monitor.js";
import { lifecycleStatus } from "../src/application/runtime-lifecycle.js";

test("TEAM031 account stop drains late snapshot write and startup cannot rearm", async () => {
  let release, entered, writes = 0;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const store = { latestTestnetAccountSnapshot: async () => null, saveTestnetAccountSnapshot: async () => { writes++; } };
  const monitor = new TestnetAccountMonitor({ store, enabled: true, client: { fetchSnapshot: async () => {
    entered(); await gate; return { syncedAt: 1, account: {}, positions: [], openOrders: [], openAlgoOrders: [] };
  } } });
  const starting = monitor.start(); await ready;
  let stopped = false; const stopping = monitor.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); assert.ok(lifecycleStatus(store).inFlight >= 2);
  release(); await starting; await stopping;
  assert.equal(writes, 1); assert.equal(monitor.timer, null); assert.equal(lifecycleStatus(store).inFlight, 0);
  assert.equal((await monitor.sync()).reason, "account_monitor_stopped");
});

test("TEAM031 account stop crossing cached initialization never installs timer", async () => {
  let release; const gate = new Promise(r => { release = r; }); let fetches = 0;
  const monitor = new TestnetAccountMonitor({ enabled: true, store: { latestTestnetAccountSnapshot: () => gate },
    client: { fetchSnapshot: async () => { fetches++; } } });
  const starting = monitor.start(), stopping = monitor.stop();
  release(null); await starting; await stopping;
  assert.equal(monitor.timer, null); assert.equal(fetches, 0);
});

test("账户监控把 Binance 测试网作为事实源并将快照投影到存储", async () => {
  const saved = [];
  const snapshot = {
    environment: "TESTNET", authority: "BINANCE_TESTNET", readOnly: true, syncedAt: 1000,
    account: { canTrade: true, totalWalletBalance: 100, availableBalance: 90 }, positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [],
    symbolConfig: { symbol: "BTCUSDT", marginType: "ISOLATED", leverage: 10 },
  };
  const monitor = new TestnetAccountMonitor({
    enabled: true,
    client: { async fetchSnapshot() { return snapshot; } },
    store: {
      async latestTestnetAccountSnapshot() { return null; },
      async saveTestnetAccountSnapshot(value) { saved.push(value); return true; },
    },
    logger: { error() {} },
  });
  const result = await monitor.sync();
  assert.equal(result.skipped, false);
  assert.equal(monitor.snapshot().connected, true);
  assert.equal(monitor.snapshot().account.availableBalance, 90);
  assert.equal(monitor.snapshot().symbolConfig.leverage, 10);
  assert.equal(saved.length, 1);
  assert.equal(monitor.snapshot().orderSubmissionEnabled, false);
});

test("只读同步失败时保留缓存但明确标记断开", async () => {
  const cached = {
    environment: "TESTNET", authority: "BINANCE_TESTNET", readOnly: true, syncedAt: 1000,
    account: { canTrade: true, totalWalletBalance: 100 }, positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [],
  };
  const monitor = new TestnetAccountMonitor({
    enabled: true,
    client: { async fetchSnapshot() { throw new Error("invalid signature"); } },
    store: { async latestTestnetAccountSnapshot() { return cached; }, async saveTestnetAccountSnapshot() {} },
    logger: { error() {} },
  });
  await monitor.initializeFromStore();
  await monitor.sync();
  assert.equal(monitor.snapshot().connected, false);
  assert.equal(monitor.snapshot().account.totalWalletBalance, 100);
  assert.match(monitor.snapshot().error, /invalid signature/);
});
