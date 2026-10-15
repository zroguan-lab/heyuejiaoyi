import test from "node:test";
import assert from "node:assert/strict";
import { TestnetAccountMonitor } from "../src/application/testnet-account-monitor.js";

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
