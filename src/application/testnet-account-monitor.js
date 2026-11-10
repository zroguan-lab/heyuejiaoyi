import { EventEmitter } from "node:events";
import { drainOperations, storeRunLocks, trackMethods } from "./runtime-lifecycle.js";

export class TestnetAccountMonitor extends EventEmitter {
  constructor({ client = null, store, enabled = false, pollMs = 60_000, logger = console } = {}) {
    super();
    this.client = client;
    this.store = store;
    this.enabled = enabled;
    this.pollMs = pollMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.stopGeneration = 0;
    trackMethods(this, store, { initializeFromStore: "management", sync: "management", start: "management" });
    this.state = {
      enabled,
      environment: "TESTNET",
      authority: "BINANCE_TESTNET",
      mode: "READ_ONLY",
      connected: false,
      orderSubmissionEnabled: false,
      lastAttemptAt: null,
      lastSuccessfulSyncAt: null,
      error: null,
      account: null,
      positionMode: null,
      positions: [],
      openOrders: [],
      openAlgoOrders: [],
      symbolConfig: null,
    };
  }

  async initializeFromStore() {
    const cached = await this.store.latestTestnetAccountSnapshot();
    if (!cached) return;
    this.state = {
      ...this.state,
      account: cached.account,
      positionMode: cached.positionMode,
      positions: cached.positions,
      openOrders: cached.openOrders,
      openAlgoOrders: cached.openAlgoOrders ?? [],
      symbolConfig: cached.symbolConfig ?? null,
      lastSuccessfulSyncAt: new Date(cached.syncedAt).toISOString(),
    };
  }

  async sync() {
    if (this.stopped) return { skipped: true, reason: "account_monitor_stopped" };
    if (!this.enabled) return { skipped: true, reason: "read_only_account_disabled" };
    if (this.running) return { skipped: true, reason: "previous_sync_running" };
    if (!this.client) throw new Error("测试网只读账户客户端未配置");
    this.running = true;
    this.state.lastAttemptAt = new Date().toISOString();
    try {
      const snapshot = await this.client.fetchSnapshot();
      await this.store.saveTestnetAccountSnapshot(snapshot);
      this.state = {
        ...this.state,
        connected: true,
        error: null,
        lastSuccessfulSyncAt: new Date(snapshot.syncedAt).toISOString(),
        account: snapshot.account,
        positionMode: snapshot.positionMode,
        positions: snapshot.positions,
        openOrders: snapshot.openOrders,
        openAlgoOrders: snapshot.openAlgoOrders ?? [],
        symbolConfig: snapshot.symbolConfig ?? null,
      };
      this.emit("account", this.snapshot());
      return { skipped: false, snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.connected = false;
      this.state.error = message;
      this.logger.error(`[testnet-account] ${message}`);
      this.emit("account", this.snapshot());
      return { skipped: false, error: message };
    } finally {
      this.running = false;
    }
  }

  async start() {
    const generation = this.stopGeneration;
    if (this.stopped) return;
    await this.initializeFromStore();
    if (!this.enabled || this.timer || this.stopped || generation !== this.stopGeneration) return;
    await this.sync();
    if (this.stopped || generation !== this.stopGeneration) return;
    this.timer = setInterval(() => {
      if (storeRunLocks(this.store).maintenance.managementPaused) return;
      void this.sync().catch(() => {});
    }, this.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    this.stopGeneration += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await drainOperations(this.store, { owner: this });
  }

  snapshot() {
    return structuredClone({ ...this.state, status: this.running ? "SYNCING" : this.enabled ? "IDLE" : "DISABLED" });
  }
}
