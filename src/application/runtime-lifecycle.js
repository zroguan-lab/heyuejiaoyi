import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { splitFilledQuantity } from "../execution/contract-rules.js";
import { classifyExecutionAccountState } from "../execution/execution-account-ownership.js";
import { accountProtectionFactsKnown, blocksNewExecutionEntry, effectivePositionStop, hasManagedTp1Lifecycle, protectionOrderKnown, ACTIVE_ALGO_STATUSES } from "../execution/protection-state.js";

// The executor's original ownership/runtime context is also the lifecycle source
// of truth. There is deliberately no second, instance-local maintenance flag.
const STORE_RUN_LOCKS = new WeakMap();
const OPERATION_CONTEXT = new AsyncLocalStorage();
export function storeRunLocks(store) {
  let locks = STORE_RUN_LOCKS.get(store);
  if (!locks) {
    locks = { reconciling: new Set(), executing: new Set(), tails: new Map(), owners: new Map(),
      runtime: { known: true, active: false, generation: 0, fault: null, lastSuccessfulAt: null },
      maintenance: { active: false, managementPaused: false, phase: "RUNNING", reason: null },
      operations: new Set(), operationGeneration: 0, signals: new Map() };
    STORE_RUN_LOCKS.set(store, locks);
  }
  return locks;
}
export function maintenanceError() {
  return Object.assign(new Error("维护暂停：禁止新的入场或已暂停的管理派发"), { code: "MAINTENANCE_PAUSED" });
}
export function assertEntryAdmission(store) {
  if (storeRunLocks(store).maintenance.active) throw maintenanceError();
}
export function lifecycleStatus(store) {
  const locks = storeRunLocks(store);
  return { ...locks.maintenance, inFlight: locks.operations.size,
    executing: locks.executing.size, reconciling: locks.reconciling.size,
    waitingRuns: locks.tails.size, ownedRuns: locks.owners.size,
    operationGeneration: locks.operationGeneration };
}
export function assertStoreCloseSafe(store) {
  const locks=storeRunLocks(store),current=OPERATION_CONTEXT.getStore();
  const ownFinalClose=current?.locks===locks&&current.label==='store-close'&&current.owner instanceof RuntimeLifecycle
    &&locks.maintenance.phase==='FINALIZING';
  if(locks.operations.size>(ownFinalClose?1:0)||locks.tails.size||locks.owners.size||locks.executing.size||locks.reconciling.size||locks.runtime.active)
    throw new Error('STORE_CLOSE_IN_FLIGHT');
}
export function beginMaintenance(store, reason = "SHUTDOWN") {
  const state = storeRunLocks(store).maintenance;
  state.active = true;
  state.reason ??= reason;
  if (state.phase === "RUNNING") state.phase = "DRAINING";
  return lifecycleStatus(store);
}
export function trackOperation(store, owner, label, action, { lane = "management" } = {}) {
  const locks = storeRunLocks(store), parent = OPERATION_CONTEXT.getStore();
  const liveParent = parent?.locks === locks && locks.operations.has(parent);
  if (lane === "entry") assertEntryAdmission(store);
  if (locks.maintenance.managementPaused && !liveParent && lane !== "verification") throw maintenanceError();
  const operation = { owner, label, parent: liveParent ? parent : null, locks, promise: null };
  locks.operations.add(operation); // BEFORE action/its first await, including ownership waits.
  locks.operationGeneration += 1;
  let result;
  try { result = OPERATION_CONTEXT.run(operation, action); }
  catch (error) { locks.operations.delete(operation); throw error; }
  operation.promise = Promise.resolve(result).finally(() => locks.operations.delete(operation));
  return operation.promise;
}
export function trackMethods(instance, store, methods) {
  for (const [name, lane] of Object.entries(methods)) {
    const original = instance[name];
    instance[name] = function (...args) {
      try { return trackOperation(store, instance, name, () => original.apply(this, args), { lane }); }
      catch (error) { return Promise.reject(error); }
    };
  }
}
export async function drainOperations(store, { owner = null } = {}) {
  const locks = storeRunLocks(store), ancestors = new Set();
  for (let current = OPERATION_CONTEXT.getStore(); current?.locks === locks; current = current.parent) ancestors.add(current);
  for (;;) {
    const pending = [...locks.operations].filter(op => !ancestors.has(op) && (!owner || op.owner === owner));
    if (!pending.length) return lifecycleStatus(store);
    await Promise.allSettled(pending.map(op => op.promise));
  }
}

const numeric = value => !["number", "string"].includes(typeof value) || String(value).trim() === ""
  || !Number.isFinite(Number(value)) ? null : Number(value);
const positive = value => numeric(value) > 0;
const id = value => (typeof value !== "number" || Number.isSafeInteger(value)) && /^[1-9][0-9]*$/.test(String(value ?? ""));
const text = value => typeof value === "string" && value.length > 0;
const allowedStates = new Set(["OPEN_PROTECTED", "TP1_FILLED", "ACCOUNTING_PENDING"]);
const terminal = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function criticalState(store) {
  const runs = await store.listActiveExecutionRuns();
  const epoch = (await store.getMetadata?.("active_strategy_performance_epoch"))?.value ?? null;
  const emergency = (await store.getMetadata?.("testnet_execution_emergency_stop"))?.value ?? null;
  return { runs, hash: hash({ runs: [...runs].sort((a, b) => String(a.id).localeCompare(String(b.id))), epoch, emergency }) };
}

// A deployment/exit gate only: no changes to production entry/SL/TP policy.
// Uses a newly collected complete response, never a monitor cache or runtime's
// last-success marker. Even closePosition SL needs a valid, planned trigger.
export function verifyHandoffFacts({ account, runs, requestStartedAt, responseReceivedAt, now = Date.now() } = {}) {
  const fail = reason => ({ safe: false, reason });
  if (!Number.isFinite(requestStartedAt) || !Number.isFinite(responseReceivedAt)
    || requestStartedAt > responseReceivedAt || responseReceivedAt > now || now - requestStartedAt > 45_000) return fail("ACCOUNT_FACTS_STALE_OR_UNKNOWN");
  if (!accountProtectionFactsKnown(account) || !Array.isArray(runs) || !Array.isArray(account.symbolConfig)) return fail("ACCOUNT_FIELDS_UNCONFIRMED");
  if (runs.some(run => !terminal.has(run.status) && (!allowedStates.has(run.status) || blocksNewExecutionEntry(run)))) return fail("DEPLOYMENT_TRANSITION_NOT_DRAINED");
  if (runs.some(run => Object.values(run.protection?.observations ?? {}).some(fact => fact.known !== true)
    || ["INITIAL", "ENTRY_REMAINDER_PENDING", "TP_QUANTITY_PENDING", "BREAKEVEN_PENDING"].includes(run.protection?.phase)
    || Object.values(run.protection?.tpRecovery ?? {}).some(item => item?.pending === true || item?.status === "PENDING"))) return fail("PROTECTION_MANAGEMENT_NOT_CONVERGED");
  const configs = new Map();
  for (const config of account.symbolConfig) {
    const leverage = numeric(config?.leverage);
    if (!text(config?.symbol) || configs.has(config.symbol) || leverage === null || !Number.isInteger(leverage) || leverage < 0
      || !["ISOLATED", "CROSSED"].includes(String(config.marginType).toUpperCase())) return fail("SYMBOL_CONFIG_INVALID");
    configs.set(config.symbol, config);
  }
  const positions = [];
  for (const position of account.positions) {
    const quantity = numeric(position.quantity ?? position.positionAmt);
    if (quantity === null) return fail("POSITION_QUANTITY_INVALID");
    if (quantity === 0) continue;
    const config = configs.get(position.symbol), run = runs.find(r => r.symbol === position.symbol && !terminal.has(r.status));
    if (!run || !positive(config?.leverage) || numeric(config.leverage) !== numeric(run.plan?.leverage)
      || String(config.marginType).toUpperCase() !== "ISOLATED"
      || (position.marginType != null && String(position.marginType).toUpperCase() !== "ISOLATED")
      || (position.leverage != null && numeric(position.leverage) !== numeric(config.leverage))) return fail("POSITION_CONFIG_CONFLICT");
    positions.push({ ...position, quantity, leverage: numeric(config.leverage), marginType: "ISOLATED" });
  }
  const ordinaryValid = o => text(o?.clientOrderId) && id(o.orderId) && ["BUY", "SELL"].includes(o.side)
    && o.positionSide === "BOTH" && positive(o.quantity) && typeof o.reduceOnly === "boolean";
  const algoValid = o => text(o?.clientAlgoId) && id(o.algoId) && ["BUY", "SELL"].includes(o.side)
    && o.positionSide === "BOTH" && positive(o.triggerPrice) && typeof o.reduceOnly === "boolean"
    && typeof o.closePosition === "boolean" && (o.closePosition === true || positive(o.quantity));
  if (!account.openOrders.every(ordinaryValid) || !account.openAlgoOrders.every(algoValid)) return fail("ORDER_FIELDS_UNCONFIRMED");
  if (new Set(account.openAlgoOrders.map(o => String(o.algoId))).size !== account.openAlgoOrders.length
    || new Set(account.openAlgoOrders.map(o => o.clientAlgoId)).size !== account.openAlgoOrders.length) return fail("DUPLICATE_ORDER_IDENTITY");
  if (account.openOrders.length) return fail("UNFINISHED_ORDINARY_ORDER");
  const normalized = { ...account, positions }, ownership = classifyExecutionAccountState(normalized, runs);
  if (!ownership.safe) return fail("ACCOUNT_OWNERSHIP_OR_PROTECTION_UNKNOWN");
  for (const { item: order, runId } of ownership.owned.algoOrders) {
    const run = runs.find(r => r.id === runId), position = positions.find(p => p.symbol === run.symbol);
    const role = ["stop", "breakEvenStop", "takeProfit1", "takeProfit2"].find(role => protectionOrderKnown(order, run, role));
    const saved = run.protection?.[role], quantity = numeric(order.quantity), tolerance = numeric(run.plan?.rules?.stepSize) / 2;
    if (!position || !role || !saved || !id(saved.algoId) || String(saved.algoId) !== String(order.algoId)
      || saved.clientAlgoId !== order.clientAlgoId || !ACTIVE_ALGO_STATUSES.has(order.status)
      || (order.closePosition === false && (order.reduceOnly !== true || !(quantity > 0) || quantity > Math.abs(position.quantity) + tolerance))
      || (order.closePosition === true && order.quantity != null && (quantity === null || quantity < 0))) return fail("BOUND_PROTECTION_ORDER_CONFLICT");
    const target = numeric(role === "breakEvenStop" ? run.plan?.prices?.entry : role === "stop" ? run.plan?.prices?.stopLoss : run.plan?.prices?.[role]);
    const tick = numeric(run.plan?.rules?.tickSize);
    if (!(target > 0) || !(tick > 0) || Math.abs(numeric(order.triggerPrice) - target) > tick / 2 + 1e-10
      || role === "takeProfit1" && order.closePosition !== false) return fail("BOUND_PROTECTION_PLAN_CONFLICT");
  }
  for (const { item: position, runId } of ownership.owned.positions) {
    const run = runs.find(r => r.id === runId);
    const tick = numeric(run.plan?.rules?.tickSize);
    if (!(tick > 0) || !positive(run.plan?.rules?.stepSize) || !positive(run.plan?.rules?.minQuantity)
      || !positive(run.plan?.rules?.minNotional)) return fail("STOP_RULES_UNKNOWN");
    const stops = account.openAlgoOrders.filter(order => effectivePositionStop(order, run, position));
    const validStop = stops.some(order => {
      const be = order.clientAlgoId === run.plan?.clientIds?.breakEvenStop;
      const target = numeric(be ? run.plan?.prices?.entry : run.plan?.prices?.stopLoss);
      return target > 0 && Math.abs(numeric(order.triggerPrice) - target) <= tick / 2 + 1e-10;
    });
    if (!validStop) return fail("FULL_POSITION_PLANNED_STOP_UNCONFIRMED");
    const managedTp1 = hasManagedTp1Lifecycle(run);
    if (managedTp1 && run.protection?.phase !== "BREAKEVEN_ACTIVE") return fail("BREAKEVEN_NOT_CONVERGED");
    let split;
    try { split = splitFilledQuantity(numeric(run.entryOrder?.executedQuantity), {
      takeProfit1: numeric(run.plan?.prices?.takeProfit1), takeProfit2: numeric(run.plan?.prices?.takeProfit2), rules: run.plan.rules }); }
    catch { return fail("PROTECTION_QUANTITY_PLAN_UNKNOWN"); }
    const required = managedTp1 ? ["breakEvenStop", "takeProfit2"] : split.mode === "TWO_TARGETS"
      ? ["stop", "takeProfit1", "takeProfit2"] : ["stop", "takeProfit2"];
    for (const role of required) {
      const target = numeric(role === "breakEvenStop" ? run.plan?.prices?.entry : role === "stop" ? run.plan?.prices?.stopLoss : run.plan?.prices?.[role]);
      const expectedQuantity = role === "takeProfit1" ? split.takeProfit1Quantity : Math.abs(position.quantity);
      const valid = account.openAlgoOrders.some(order => protectionOrderKnown(order, run, role) && ACTIVE_ALGO_STATUSES.has(order.status)
        && target > 0 && Math.abs(numeric(order.triggerPrice) - target) <= tick / 2 + 1e-10
        && (order.closePosition === true && role !== "takeProfit1" || order.reduceOnly === true && positive(order.quantity)
          && (role.includes("Stop") || role === "stop" ? effectivePositionStop(order, run, position)
            : expectedQuantity > 0 && Math.abs(numeric(order.quantity) - expectedQuantity) <= numeric(run.plan?.rules?.stepSize) / 2)));
      if (!valid) return fail("REQUIRED_PROTECTION_NOT_CONVERGED");
    }
  }
  if (runs.some(run => ["OPEN_PROTECTED", "TP1_FILLED"].includes(run.status) && !positions.some(p => p.symbol === run.symbol))) return fail("POSITION_STATE_UNCONFIRMED");
  return { safe: true, positionCount: positions.length, ordinaryOrderCount: account.openOrders.length,
    algoOrderCount: account.openAlgoOrders.length, ownedPositionCount: ownership.owned.positions.length };
}

export function createHandoffVerifier({ store, collectAccount, now = Date.now } = {}) {
  return async () => {
    if (typeof collectAccount !== "function") return { safe: false, reason: "ACCOUNT_COLLECTOR_UNAVAILABLE" };
    const before = await criticalState(store), requestStartedAt = now();
    const account = await collectAccount();
    const responseReceivedAt = now(), after = await criticalState(store);
    if (before.hash !== after.hash) return { safe: false, reason: "CRITICAL_STATE_CHANGED" };
    const proof = verifyHandoffFacts({ account, runs: after.runs, requestStartedAt, responseReceivedAt, now: now() });
    return { ...proof, activeCriticalHash: after.hash, requestStartedAt, responseReceivedAt };
  };
}

// Explicitly invoked by the daemon's injected verifier only, never by CLI
// cleanup. Raw field validation precedes normalization ("false" is not true).
export function createAccountCollector(client) {
  return async () => {
    const url = new URL(client?.baseUrl);
    if (url.origin !== "https://demo-fapi.binance.com" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("Demo collector unavailable");
    const [account, positions, orders, algos, mode, configs] = await Promise.all([
      client.signedRequest("GET", "/fapi/v3/account"),
      client.signedRequest("GET", "/fapi/v3/positionRisk"),
      client.signedRequest("GET", "/fapi/v1/openOrders"),
      client.signedRequest("GET", "/fapi/v1/openAlgoOrders", { algoType: "CONDITIONAL" }),
      client.signedRequest("GET", "/fapi/v1/positionSide/dual"),
      client.signedRequest("GET", "/fapi/v1/symbolConfig"),
    ]);
    const bool = value => value === true || value === "true" ? true : value === false || value === "false" ? false : null;
    if (!account || numeric(account.availableBalance) === null || numeric(account.availableBalance) < 0
      || typeof mode?.dualSidePosition !== "boolean" || ![positions, orders, algos, configs].every(Array.isArray)
      || !positions.every(p => text(p?.symbol) && p.positionSide === "BOTH" && numeric(p.positionAmt) !== null)
      || new Set(positions.map(p => p.symbol)).size !== positions.length
      || !orders.every(o => text(o?.symbol) && id(o.orderId) && text(o.clientOrderId) && o.positionSide === "BOTH"
        && ["BUY", "SELL"].includes(o.side) && positive(o.origQty) && numeric(o.executedQty ?? o.cumQty) !== null
        && bool(o.reduceOnly) !== null)
      || !algos.every(o => text(o?.symbol) && id(o.algoId) && text(o.clientAlgoId) && o.positionSide === "BOTH"
        && ["BUY", "SELL"].includes(o.side) && text(o.algoStatus ?? o.status) && positive(o.triggerPrice)
        && bool(o.closePosition) !== null && bool(o.reduceOnly) !== null
        && (bool(o.closePosition) === true ? o.quantity == null || numeric(o.quantity) !== null && numeric(o.quantity) >= 0 : positive(o.quantity)))) {
      throw new Error("Incomplete Demo account response");
    }
    return { environment: "TESTNET", authority: "BINANCE_TESTNET", positionMode: mode.dualSidePosition ? "HEDGE" : "ONE_WAY",
      positions: positions.map(p => ({ ...p, quantity: numeric(p.positionAmt) })), symbolConfig: configs,
      openOrders: orders.map(o => ({ ...o, quantity: numeric(o.origQty), reduceOnly: bool(o.reduceOnly) })),
      openAlgoOrders: algos.map(o => ({ ...o, type: o.orderType ?? o.type, status: o.algoStatus ?? o.status,
        quantity: numeric(o.quantity), triggerPrice: numeric(o.triggerPrice), reduceOnly: bool(o.reduceOnly), closePosition: bool(o.closePosition) })) };
  };
}

export class RuntimeLifecycle {
  constructor({ store, monitor = null, accountMonitor = null, coordinator = null, executor = null, server = null,
    verifyHandoff = null, exit = () => {}, logger = console, deadlineMs = 45_000,
    setKeepAlive = () => setInterval(() => {}, 1000), clearKeepAlive = clearInterval } = {}) {
    Object.assign(this, { store, monitor, accountMonitor, coordinator, executor, server, verifyHandoff, exit, logger,
      deadlineMs, setKeepAlive, clearKeepAlive });
    this.flight = null;
    this.keepAlive = null;
    this.resources = { httpCloseAttempted: false, httpClosed: false, storeCloseAttempted: false, storeClosed: false,
      accountStopAttempted: false, accountStopped: false, executorStopAttempted: false, executorStopped: false, lockReleased: false };
    this.removeSignals = null;
    this.deadlineAt = null;
  }
  snapshot() { return { ...lifecycleStatus(this.store), resources: { ...this.resources } }; }
  requestShutdown(reason = "SHUTDOWN") {
    beginMaintenance(this.store, reason); // synchronous, even with a blocked previous request
    if (this.flight) return this.flight;
    // Publish before invoking any component: even a synchronously reentrant
    // signal emitted by stop() must join, not create a second finalizer.
    let settle;
    const flight = new Promise(resolve => { settle = resolve; });
    this.flight = flight;
    this.keepAlive ??= this.setKeepAlive(); // deliberately referenced: BLOCKED must remain alive
    this.deadlineAt = Date.now() + this.deadlineMs;
    const producerStops = [];
    try {
      this.server?.beginMaintenanceDrain?.();
      producerStops.push(this.coordinator?.stop(), this.monitor?.stop());
    } catch (error) { producerStops.push(Promise.reject(error)); }
    void this.performShutdown(producerStops).catch(error => this.blocked("SHUTDOWN_ERROR", error)).then(result => {
      // A later explicit signal may request a NEW proof, never an automatic
      // restart. Maintenance remains closed; unfinished timed-out work is still
      // registered and must drain in that next attempt.
      if (result.phase === "BLOCKED" && this.flight === flight) this.flight = null;
      settle(result);
    });
    return flight;
  }
  blocked(reason, error = null) {
    const state = storeRunLocks(this.store).maintenance;
    state.managementPaused = false;
    state.phase = Object.values(this.resources).some(Boolean) ? "PARTIAL" : "BLOCKED";
    state.failure = reason;
    try { this.logger.error?.(`[lifecycle] ${state.phase}: ${reason}${error ? " (operation failed)" : ""}`); } catch { /* retain the blocked state */ }
    return { ...this.snapshot(), safe: false, reason };
  }
  async bounded(action) {
    let timer;
    try {
      return await Promise.race([action, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("shutdown deadline"), { code: "SHUTDOWN_TIMEOUT" })), Math.max(0, this.deadlineAt - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }
  async performShutdown(producerStops) {
    try {
      await this.bounded(Promise.all(producerStops));
      // Pause only NEW management roots. Already accepted children/protection
      // continue, and remain registered through their final finally/afterRelease.
      storeRunLocks(this.store).maintenance.managementPaused = true;
      await this.bounded(drainOperations(this.store));
      const locks = storeRunLocks(this.store);
      if (locks.tails.size || locks.owners.size || locks.executing.size || locks.reconciling.size
        || locks.runtime.active || locks.runtime.known !== true) return this.blocked("RUNTIME_NOT_QUIESCENT");
      if (!this.verifyHandoff) return this.blocked("ACCOUNT_VERIFIER_UNAVAILABLE");
      const proof = await this.bounded(trackOperation(this.store, this, "handoff-proof", () => this.verifyHandoff(), { lane: "verification" }));
      if (proof?.safe !== true) return this.blocked(proof?.reason ?? "ACCOUNT_HANDOFF_UNKNOWN");
      if (locks.operations.size || locks.tails.size || locks.owners.size) return this.blocked("WORK_APPEARED_DURING_PROOF");
      locks.maintenance.phase = "FINALIZING";
      // Reversible management dispatch pause remains in force. Do not stop its
      // schedulers before HTTP close: close failure must retain protection work.
      if (this.server) {
        this.resources.httpCloseAttempted = true;
        await this.bounded(trackOperation(this.store, this, "http-close", async () => {
          await this.server.closeGracefully();
          this.resources.httpClosed = true;
          if (locks.maintenance.phase !== "FINALIZING") locks.maintenance.phase = "PARTIAL";
        }, { lane: "verification" }));
      }
      for (const [component, attempted, stopped] of [[this.accountMonitor, "accountStopAttempted", "accountStopped"],
        [this.executor, "executorStopAttempted", "executorStopped"]]) {
        if (!component) continue;
        this.resources[attempted] = true;
        await this.bounded(trackOperation(this.store, this, `${stopped}-resource`, async () => {
          await component.stop({ releaseLock: false });
          this.resources[stopped] = true;
        }, { lane: "verification" }));
      }
      this.resources.storeCloseAttempted = true;
      await this.bounded(trackOperation(this.store, this, "store-close", async () => {
        await this.store.close();
        this.resources.storeClosed = true;
      }, { lane: "verification" }));
      this.executor?.releaseProcessLock?.();
      if (this.executor) this.executor.releaseProcessLock = null;
      this.resources.lockReleased = true;
      locks.maintenance.phase = "TERMINATED";
      this.clearKeepAlive(this.keepAlive);
      this.keepAlive = null;
      this.removeSignals?.();
      await this.exit(0);
      return { safe: true, proof, ...this.snapshot() };
    } catch (error) { return this.blocked(error.code ?? "SHUTDOWN_ERROR", error); }
  }
  installSignalHandlers(processLike) {
    const handler = signal => { void this.requestShutdown(signal).catch(() => {}); };
    const interrupt = () => handler("SIGINT"), terminate = () => handler("SIGTERM");
    processLike.on("SIGINT", interrupt);
    processLike.on("SIGTERM", terminate);
    this.removeSignals = () => { processLike.off("SIGINT", interrupt); processLike.off("SIGTERM", terminate); };
    return this.removeSignals;
  }
}
