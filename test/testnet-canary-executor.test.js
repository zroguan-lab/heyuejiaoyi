import test from "node:test";
import { beginMaintenance, lifecycleStatus, storeRunLocks, verifyHandoffFacts } from "../src/application/runtime-lifecycle.js";

test("TEAM031 handoff verifier accepts actual canary plan and completed protection, not cached or missing TP", async () => {
  const { executor, client, run } = await tpRecoveryFixture();
  await executor.ensureProtection(run, 0.0012);
  const account = { environment: "TESTNET", authority: "BINANCE_TESTNET", positionMode: "ONE_WAY",
    positions: structuredClone(client.account.positions), openOrders: [],
    openAlgoOrders: [...client.algos.values()].map(order => ({ ...structuredClone(order), positionSide: "BOTH" })),
    symbolConfig: [{ symbol: run.symbol, leverage: run.plan.leverage, marginType: "ISOLATED" }] };
  const check = () => verifyHandoffFacts({ account, runs: [run], requestStartedAt: 1, responseReceivedAt: 2, now: 3 });
  assert.equal(check().safe, true, JSON.stringify(check()));
  const removed = account.openAlgoOrders.pop();
  assert.equal(check().safe, false); account.openAlgoOrders.push(removed);
  run.protection.observations = { stop: { known: false } };
  assert.equal(check().safe, false);
});

test("TEAM031 same Store direct prepare and execute cannot bypass maintenance", async () => {
  const store = new MemoryStore(signalRecord(1000000)), client = new FakeTradingClient();
  const a = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => 1000000 });
  const prepared = await a.prepare("gate");
  const b = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => 1000000 });
  beginMaintenance(store);
  await assert.rejects(b.prepare("new"), { code: "MAINTENANCE_PAUSED" });
  await assert.rejects(b.prepareOperatorCanary(), { code: "MAINTENANCE_PAUSED" });
  await assert.rejects(b.execute(prepared.run.id, prepared.confirmationCode), { code: "MAINTENANCE_PAUSED" });
  assert.equal(client.calls.placeEntry, 0); assert.equal(b.runtimeStatus().maintenance.active, true);
});

test("TEAM031 maintenance crossing prepare account await writes no new plan and makes no permission or entry request", async () => {
  const store = new MemoryStore(signalRecord(1000000)), client = new FakeTradingClient();
  let release, entered; const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const fetch = client.fetchAccountState.bind(client);
  client.fetchAccountState = async (...args) => { entered(); await gate; return fetch(...args); };
  const executor = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => 1000000 });
  const pending = executor.prepare("race"); await ready; beginMaintenance(store); release();
  await assert.rejects(pending, { code: "MAINTENANCE_PAUSED" });
  assert.equal(store.runs.size, 0); assert.equal(client.calls.placeEntry, 0); assert.equal(client.calls.permissionTests ?? 0, 0);
});

test("TEAM031 executor stop waits ownership waiter then rejects unsubmitted entry before releasing lock", async () => {
  const store = new MemoryStore(signalRecord(1000000)), client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => 1000000 });
  const prepared = await executor.prepare("waiting");
  let release, entered, unlocked = false;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  executor.releaseProcessLock = () => { unlocked = true; };
  const holder = executor.withRunOwnership(prepared.run.id, async () => { entered(); await gate; });
  await ready;
  const execution = executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.ok(lifecycleStatus(store).inFlight >= 3);
  const rejection = assert.rejects(execution, /停止/);
  let stopped = false; const stopping = executor.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(unlocked, false); assert.equal(stopped, false);
  release(); await holder; await rejection; await stopping;
  assert.equal(client.calls.placeEntry, 0); assert.equal(unlocked, true);
});

test("TEAM031 maintenance after actual entry submission preserves original SL TP2 TP1 management", async () => {
  const store = new MemoryStore(signalRecord(1000000)), client = new FakeTradingClient();
  client.fillEntryImmediately = true;
  const executor = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => 1000000 });
  const prepared = await executor.prepare("submitted"), post = client.placeLimitOrder.bind(client);
  client.placeLimitOrder = async (...args) => { const ack = await post(...args); beginMaintenance(store); return ack; };
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "OPEN_PROTECTED"); assert.equal(client.calls.placeEntry, 1);
  assert.deepEqual(client.calls.placeAlgo.map(o => o.role), ["stop", "tp2", "tp1"]);
  assert.equal(storeRunLocks(store).maintenance.active, true);
  await executor.reconcileAll(); assert.equal(storeRunLocks(store).maintenance.active, true);
});

test("TEAM031 startup account await cannot reinstall executor timer after resource stop", async () => {
  let release, entered; const gate = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
  const store = { async listActiveExecutionRuns() { entered(); await gate; return []; } };
  const executor = new ProductionExecutor({ store, client: {}, enabled: false });
  executor.acquireProcessLock = () => {};
  const starting = executor.start(); await ready; const stopping = executor.stop(); release();
  await starting; await stopping; assert.equal(executor.timer, null);
});
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { TestnetCanaryExecutor as ProductionExecutor } from "../src/execution/testnet-canary-executor.js";
import { BinanceApiError, TestnetWriteDisabledError } from "../src/execution/binance-testnet-trading.js";
import { projectExecutionRun } from "../src/execution/execution-run-projection.js";
import { verifiedProtectionExitOrders, ownedExitFills } from "../src/execution/execution-fill-facts.js";

test("TEAM026C真实定时入口的Store拒绝不逃逸进程且记录故障", () => {
  const source = `import { TestnetCanaryExecutor } from './src/execution/testnet-canary-executor.js';
    let reads=0;
    const executor=new TestnetCanaryExecutor({client:{},store:{async listActiveExecutionRuns(){if(++reads>=3)throw Error('fixture secret=must-not-leak');return []}},pollMs:5,logger:{error(){}}});
    executor.acquireProcessLock=()=>{};
    await executor.start();
    setTimeout(()=>{executor.stop();const state=executor.runtimeStatus();if(state.active!==true||JSON.stringify(state).includes('must-not-leak'))process.exitCode=2;else console.log('FAULT_CAPTURED')},45);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 3000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /FAULT_CAPTURED/);
});

test("TEAM026双run同时持有后触发全局停止不能跨锁死锁或重复撤入场", async () => {
  const store = new MemoryStore(null), client = new FakeTradingClient();
  for (const id of ["a", "b"]) store.runs.set(id, { id, status: "OPEN_PROTECTED" });
  const executor = new TestnetCanaryExecutor({ store, client, enabled: true, logger: { error() {} } });
  let count = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const both = Promise.all(["a", "b"].map(id => executor.withRunOwnership(id, async () => {
    if (++count === 2) release();
    await barrier;
    await executor.engageEmergencyStop("fixture", id);
  })));
  assert.equal(await Promise.race([both.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))]), "done");
  assert.equal(await executor.isEmergencyStopped(), true);
});

test("TEAM026双持有ENTRY广播释放后逐笔新读，只撤每笔一次且拒绝一般跨笔嵌套", async () => {
  const store = new MemoryStore(null), client = new FakeTradingClient(), orders = new Map(), canceled = [];
  for (const [id, symbol] of [["a", "BTCUSDT"], ["b", "ETHUSDT"]]) {
    store.runs.set(id, { id, symbol, status: "ENTRY_PENDING", plan: { clientIds: { entry: `${id}-entry` } } });
    orders.set(`${id}-entry`, { symbol, clientOrderId: `${id}-entry`, orderId: id, status: "NEW", executedQuantity: 0 });
  }
  client.queryOrder = async (_symbol, id) => structuredClone(orders.get(id));
  client.cancelOrder = async (_symbol, id) => {
    canceled.push(id); const order = { ...orders.get(id), status: "CANCELED" }; orders.set(id, order); return structuredClone(order);
  };
  const executor = new TestnetCanaryExecutor({ store, client, enabled: true, allowedSymbols: ["BTCUSDT", "ETHUSDT"], logger: { error() {} } });
  let count = 0, release; const barrier = new Promise(resolve => { release = resolve; });
  const both = Promise.all(["a", "b"].map(id => executor.withRunOwnership(id, async () => {
    if (++count === 2) release(); await barrier; await executor.engageEmergencyStop("fixture", id);
  })));
  assert.equal(await Promise.race([both.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("blocked"), 100))]), "done");
  assert.deepEqual(canceled.sort(), ["a-entry", "b-entry"]);
  assert.equal((await store.getExecutionRun("a")).status, "CANCELED");
  assert.equal((await store.getExecutionRun("b")).status, "CANCELED");
  await assert.rejects(executor.withRunOwnership("a", () => executor.withRunOwnership("b", async () => {})), /跨笔工作/);
  assert.equal(await executor.withRunOwnership("a", async () => "released"), "released");
});

test("TEAM026QA停止广播查询取消审计异常保持故障，仍处理兄弟入场及已成交保护", async () => {
  for (const mode of ["query", "cancel", "entryAudit", "engageAudit"]) {
    const { executor, client, run, store } = await tpRecoveryFixture();
    run.status = "ENTRY_PENDING"; run.entryOrder.status = "PARTIALLY_FILLED";
    await store.saveExecutionRun(run);
    const sibling = structuredClone(run); sibling.id = "sibling"; sibling.symbol = "ETHUSDT";
    sibling.plan.clientIds = { entry: "sibling-entry" }; sibling.entryOrder = null;
    await store.saveExecutionRun(sibling); executor.allowSymbols(["ETHUSDT"]);
    const orders = new Map([[run.plan.clientIds.entry, structuredClone(run.entryOrder)], ["sibling-entry", { status: "NEW", executedQuantity: 0 }]]);
    client.queryOrder = async (_symbol, id) => { if (mode === "query" && id === run.plan.clientIds.entry) throw Error("fixture query"); return structuredClone(orders.get(id)); };
    const canceled = [];
    client.cancelOrder = async (_symbol, id) => {
      if (mode === "cancel" && id === run.plan.clientIds.entry) throw Error("fixture cancel unknown");
      canceled.push(id); const order = { ...orders.get(id), status: "CANCELED" }; orders.set(id, order); return structuredClone(order);
    };
    const append = store.appendExecutionAudit.bind(store); let failed = false;
    store.appendExecutionAudit = async (...args) => {
      if (!failed && ((mode === "entryAudit" && args[1] === "EMERGENCY_ENTRY_CANCELED" && args[0] === run.id)
        || (mode === "engageAudit" && args[1] === "EMERGENCY_STOP_ENGAGED"))) { failed = true; throw Error("fixture audit"); }
      return append(...args);
    };
    await executor.withRunOwnership(run.id, () => executor.engageEmergencyStop("fixture", run.id));
    assert.equal(await executor.isEmergencyStopped(), true, mode);
    assert.equal(executor.runtimeStatus().active, true, mode);
    assert.equal((await store.getExecutionRun(sibling.id)).status, "CANCELED", mode);
    assert.equal(canceled.filter(id => id === "sibling-entry").length, 1, mode);
    if (["entryAudit", "engageAudit"].includes(mode)) {
      assert.equal((await store.getExecutionRun(run.id)).status, "OPEN_PROTECTED", mode);
      assert.equal(client.calls.placeAlgo.filter(call => call.role === "stop").length, 1, mode);
    }
    assert.equal(await executor.withRunOwnership(run.id, async () => "released"), "released");
  }
});

test("TEAM026QA同run嵌套重复停止与另执行器部分成交恢复交错不重复撤单保护", async () => {
  const { executor, client, run, store, time } = await tpRecoveryFixture();
  run.status = "ENTRY_PENDING"; run.entryOrder.status = "PARTIALLY_FILLED";
  await store.saveExecutionRun(run); client.order = structuredClone(run.entryOrder);
  const other = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => time.now, logger: { error() {} } });
  let release, began; const ready = new Promise(resolve => { began = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const cancel = client.cancelOrder.bind(client);
  client.cancelOrder = async (...args) => { const result = await cancel(...args); client.calls.sequence.push("entry-canceled"); return result; };
  const stop = executor.withRunOwnership(run.id, async () => {
    await executor.engageEmergencyStop("first", run.id);
    await executor.withRunOwnership(run.id, () => executor.engageEmergencyStop("second", run.id));
    began(); await barrier;
  });
  await ready;
  const recovery = other.reconcile(run.id);
  release();
  const both = Promise.all([stop, recovery]);
  assert.equal(await Promise.race([both.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("blocked"), 200))]), "done");
  assert.equal(await executor.isEmergencyStopped(), true);
  assert.equal((await store.getExecutionRun(run.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.placeAlgo.filter(call => call.role === "stop").length, 1);
  assert.equal(client.calls.closeMarket ?? 0, 0);
  // The existing direct partial-fill recovery protects before canceling the remainder.
  assert.ok(client.calls.sequence.indexOf(`place:${run.plan.clientIds.stop}`) < client.calls.sequence.indexOf("entry-canceled"));
});

function team018ClockFixture(offset = -310) {
  const local = 2_000_000, exchange = local + offset;
  const run = {id:"clock-fixture",symbol:"BTCUSDT",createdAt:local-1000,status:"PROTECTION_INCOMPLETE",
    plan:{direction:"LONG",entrySide:"BUY",exitSide:"SELL",quantity:2,clientIds:{entry:"clock-entry"}},
    entryExecution:{submittedAt:local},entryFactVerification:{status:"ORDER_VERIFIED",ack:{orderId:"11"}},
    entryOrder:{symbol:"BTCUSDT",clientOrderId:"clock-entry",orderId:"11",side:"BUY",status:"FILLED",executedQuantity:2,createdTime:exchange-10,updateTime:exchange},
    protection:{stop:{actualOrderId:"12",actualQuantity:2}},result:null};
  const rows=[{id:"1",orderId:"11",symbol:run.symbol,side:"BUY",quantity:2,price:10,quoteQuantity:20,commission:0.01,commissionAsset:"USDT",realizedPnl:0,time:exchange},
    {id:"2",orderId:"12",symbol:run.symbol,side:"SELL",quantity:2,price:11,quoteQuantity:22,commission:0.01,commissionAsset:"USDT",realizedPnl:2,time:exchange+1000}];
  const calls=[];
  const client={async queryOrder(){return structuredClone(run.entryOrder)},async getExchangeTime(){return exchange+2000},
    async listUserTrades(symbol,query){calls.push(query);return structuredClone(rows)},async listIncomeHistory(){return []},
    async fetchAccountState(){return {environment:"TESTNET",authority:"BINANCE_TESTNET",positionMode:"ONE_WAY",positions:[],openOrders:[],openAlgoOrders:[]}}};
  const store=new MemoryStore(null);store.runs.set(run.id,structuredClone(run));
  return {run,rows,client,store,calls,executor:new ProductionExecutor({client,store,now:()=>local+2000})};
}

test("TEAM018同订单交易所时间早于本地提交仍完成成交及退出核验",async()=>{
  for(const offset of [-310,-200_000,200_000]){
    const {run,executor,client}=team018ClockFixture(offset);
    const facts=await executor.collectRunTrades(run);
    assert.equal(facts.exitFactsComplete,true,String(offset));assert.equal(facts.accountingComplete,true,String(offset));
    await executor.observeEntryFillVerification(run);assert.equal(run.entryFactVerification.fills.status,"VERIFIED");
    client.queryOrder=async()=>null;
    const verified=await executor.verifyEntryFacts(run);assert.equal(verified.pending,false);assert.equal(run.entryFactVerification.status,"FILLS_VERIFIED");
  }
});

test("TEAM018旧记录只含updateTime须同订单查询补齐，未知或错ID不伪造成交时间",async()=>{
  for(const mode of ["valid","missing","wrongId","wrongClient","wrongSide","wrongSymbol","badTime"]){
    const {run,executor,client,rows}=team018ClockFixture();const authoritative=structuredClone(run.entryOrder);
    delete run.entryOrder.createdTime;
    client.queryOrder=async()=>mode==="missing"?null:{...authoritative,
      ...(mode==="wrongId"?{orderId:"old-order"}:{}),...(mode==="wrongClient"?{clientOrderId:"other"}:{}),
      ...(mode==="wrongSide"?{side:"SELL"}:{}),...(mode==="wrongSymbol"?{symbol:"ETHUSDT"}:{}),...(mode==="badTime"?{createdTime:null}:{})};
    const originalSubmit=run.entryExecution.submittedAt;
    const facts=await executor.collectRunTrades(run);
    assert.equal(facts.accountingComplete,mode==="valid",mode);
    assert.equal(run.entryExecution.submittedAt,originalSubmit);
    await executor.observeEntryFillVerification(run);
    assert.equal(run.entryFactVerification.fills.status,mode==="valid"?"VERIFIED":"QUERY_UNAVAILABLE",mode);
    assert.equal(rows.length,2);
  }
});

test("TEAM018真实错误方向/旧成交/未来成交/冲突重复/缺页仍阻断，乱序部分成交去重且Funding界限不扩张",async()=>{
  for(const mode of ["valid","wrongSide","foreignId","oldFill","futureFill","duplicateConflict","missingPage"]){
    const {run,executor,client,rows,calls}=team018ClockFixture();const first=rows[0],exit=rows[1];
    rows.splice(0,2,exit,{...first,id:"3",quantity:1,quoteQuantity:10,time:first.time-1},{...first,quantity:1,quoteQuantity:10});
    rows.push({...rows[1]}); // identical overlap is deduplicated
    if(mode==="wrongSide")rows[2].side="SELL";
    if(mode==="foreignId")rows[2].orderId="foreign";
    if(mode==="oldFill")rows[2].time=run.entryOrder.createdTime-1;
    if(mode==="futureFill")rows[2].time=run.entryOrder.updateTime+1;
    if(mode==="duplicateConflict")rows.push({...rows[1],price:12});
    if(mode==="missingPage")client.listUserTrades=async()=>null;
    const funding=[];client.listIncomeHistory=async(symbol,q)=>{funding.push(q);return [{transactionId:"f1",symbol,incomeType:"FUNDING_FEE",asset:"USDT",income:0.1,time:first.time},
      {transactionId:"outside",symbol,incomeType:"FUNDING_FEE",asset:"USDT",income:999,time:run.entryOrder.createdTime}];};
    const facts=await executor.collectRunTrades(run);
    assert.equal(facts.accountingComplete,mode==="valid",mode);
    if(mode==="valid"){
      assert.equal(facts.trades.length,3);assert.equal(facts.fundingPnl,0.1);
      assert.equal(funding[0].startTime,first.time-1);assert.equal(funding[0].endTime,exit.time);
      assert.equal(calls[0].startTime,run.entryOrder.createdTime);
    }
  }
});

test("TEAM018新intent查回旧clientID订单必须阻断且不重复入场",async()=>{
  for(const unknownSubmission of [false,true]){
  const now=3_000_000,store=new MemoryStore(signalRecord(now)),client=new FakeTradingClient();
  const executor=new TestnetCanaryExecutor({store,client,enabled:true,now:()=>now});
  const prepared=await executor.prepare("new-intent");
  client.order={symbol:prepared.run.symbol,side:prepared.run.plan.entrySide,clientOrderId:prepared.run.plan.clientIds.entry,
    orderId:"9",status:"FILLED",executedQuantity:Number(prepared.run.plan.quantity),createdTime:now-100_000,updateTime:now-90_000};
  if(unknownSubmission){let reads=0;const old=client.order;client.queryOrder=async()=>++reads===1?null:structuredClone(old);client.failEntryUnknown=true;}
  const result=await executor.execute(prepared.run.id,prepared.confirmationCode);
  assert.equal(result.status,"ENTRY_FACT_CONFLICT");assert.equal(client.calls.placeEntry,unknownSubmission?1:0);
  assert.equal(client.calls.placeAlgo.length,0);
  }
});

test("TEAM018跨周查询片段保留同订单归属且不重复成交",async()=>{
  const {run,executor,client,rows}=team018ClockFixture();const week=7*24*60*60_000;
  rows[1].time=rows[0].time+week+100;
  client.getExchangeTime=async()=>rows[1].time+10;
  const queries=[];client.listUserTrades=async(symbol,q)=>{queries.push(q);return structuredClone(rows.filter(t=>t.time>=q.startTime&&t.time<=q.endTime));};
  const facts=await executor.collectRunTrades(run);
  assert.equal(facts.accountingComplete,true);assert.equal(facts.trades.length,2);
  assert.equal(queries.length,2);assert.equal(queries[0].endTime+1,queries[1].startTime);
});

test("TEAM018全部终态统一时间上界，EXPIRED_IN_MATCH合法partial保留且终态后成交拒绝",async()=>{
  for(const status of ["FILLED","CANCELED","EXPIRED","EXPIRED_IN_MATCH","REJECTED"]){
    for(const afterTerminal of [false,true]){
      const {run,executor,rows}=team018ClockFixture();
      run.entryOrder.status=status;run.plan.quantity=4; // confirmed partial quantity remains 2
      rows[0].time=run.entryOrder.updateTime+(afterTerminal?1:-1);
      const facts=await executor.collectRunTrades(run);
      assert.equal(facts.exitFactsComplete,!afterTerminal,status);
      assert.equal(facts.accountingComplete,!afterTerminal,status);
      await executor.observeEntryFillVerification(run,facts);
      assert.equal(run.entryFactVerification.fills.status,afterTerminal?"CONFLICT":"VERIFIED",status);
    }
  }
});

// The real client stamps each newly fetched response with its injected clock.
// Mirror that behavior for fake snapshots without altering executor logic.
class TestnetCanaryExecutor extends ProductionExecutor {
  constructor(options) {
    super(options);
    if (options.client instanceof FakeTradingClient) {
      options.client.snapshotNow = () => this.now();
      options.client.orderCreatedTime = this.now();
    }
  }
}

function symbolInfo(symbol = "BTCUSDT") {
  if (symbol !== "BTCUSDT") {
    return {
      symbol, quoteAsset: "USDT", status: "TRADING", contractType: "PERPETUAL",
      filters: [
        { filterType: "PRICE_FILTER", minPrice: "0.000001", maxPrice: "1000", tickSize: "0.000001" },
        { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000000", stepSize: "1" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    };
  }
  return {
    symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "100", maxPrice: "1000000", tickSize: "0.10" },
      { filterType: "LOT_SIZE", minQty: "0.0001", maxQty: "1000", stepSize: "0.0001" },
      { filterType: "MIN_NOTIONAL", notional: "50" },
    ],
  };
}

function signalRecord(now, { symbol = "BTCUSDT", direction = "LONG", strategy = "BREAKOUT" } = {}) {
  const alt = symbol !== "BTCUSDT";
  return {
    selected: true,
    candidate: { id: alt ? "ake-signal-exec" : "btc-signal-exec", symbol, direction, strategy },
    trade: {
      signalId: alt ? "ake-signal-exec" : "btc-signal-exec", symbol, direction, status: "ENTRY_PENDING",
      entryPrice: alt ? 0.0296641 : 85_000,
      stopLoss: alt ? 0.030395 : 84_000,
      takeProfit1: alt ? 0.02856775 : 87_000,
      takeProfit2: alt ? 0.02783685 : 89_000,
      expiresAt: now + 120_000,
    },
  };
}

class MemoryStore {
  constructor(signal) {
    this.signal = signal;
    this.runs = new Map();
    this.audit = [];
    this.metadata = new Map();
  }
  async getSignal(signalId) {
    const signal = structuredClone(this.signal);
    signal.candidate.id = signalId;
    signal.trade.signalId = signalId;
    return signal;
  }
  async getExecutionRunBySignal(signalId) { return structuredClone([...this.runs.values()].find((run) => run.signalId === signalId) ?? null); }
  async createExecutionRun(run) {
    const existing = [...this.runs.values()].find((item) => item.signalId === run.signalId);
    if (existing) return { created: false, run: structuredClone(existing) };
    this.runs.set(run.id, structuredClone(run));
    return { created: true, run: structuredClone(run) };
  }
  async saveExecutionRun(run) { this.runs.set(run.id, structuredClone(run)); return run; }
  async getExecutionRun(id) { return structuredClone(this.runs.get(id) ?? null); }
  async listExecutionRuns() { return structuredClone([...this.runs.values()]); }
  async listActiveExecutionRuns() { return structuredClone([...this.runs.values()].filter((run) => !["CLOSED", "CANCELED", "REJECTED", "FAILED"].includes(run.status))); }
  async appendExecutionAudit(runId, eventType, payload, createdAt) { this.audit.push({ runId, eventType, payload, createdAt }); }
  async getMetadata(key) { return this.metadata.has(key) ? { value: structuredClone(this.metadata.get(key)) } : null; }
  async setMetadata(key, value) { this.metadata.set(key, structuredClone(value)); }
}

class FakeTradingClient {
  constructor() {
    this.account = {
      environment: "TESTNET", authority: "BINANCE_TESTNET", canTrade: true, availableBalance: 100,
      positionMode: "ONE_WAY", positions: [], openOrders: [], openAlgoOrders: [],
      symbolConfig: { symbol: "BTCUSDT", marginType: "CROSSED", leverage: 20 },
    };
    this.order = null;
    this.orders = new Map();
    this.algos = new Map();
    this.calls = { placeEntry: 0, cancelEntry: 0, placeAlgo: [], cancelAlgo: [], leverage: [], marginType: [], sequence: [], accountOverview: 0 };
    this.credentialFingerprint = "fake-credential-hash";
    this.failEntryUnknown = false;
    this.fillEntryImmediately = false;
    this.failStop = false;
    this.failBreakEven = false;
    this.marginTypeUnknownOnce = false;
    this.leverageUnknownOnce = false;
    this.cancelUnknownOnce = false;
    this.delayedCanceledAlgo = null;
    this.delayedCanceledQueries = 0;
    this.hideAlgoTrades = false;
    this.externalTrades = [];
    this.bookTicker = { symbol: "BTCUSDT", bidPrice: 84_999, askPrice: 85_000, spreadBps: 0.117647 };
    this.markPrice = 85_000;
    this.maximumLeverage = 125;
  }
  async fetchAccountState(symbol = "BTCUSDT") {
    return structuredClone({ ...this.account, syncedAt: this.snapshotNow?.() ?? Date.now(), symbolConfig: { ...this.account.symbolConfig, symbol } });
  }
  async fetchAccountOverview() {
    this.calls.accountOverview += 1;
    return structuredClone({ ...this.account, symbolConfig: null });
  }
  async fetchExchangeInfo(symbol = "BTCUSDT") { return symbolInfo(symbol); }
  async fetchLeverageBrackets(symbol = "BTCUSDT") {
    return {
      symbol,
      brackets: [{
        bracket: 1,
        initialLeverage: this.maximumLeverage,
        notionalFloor: 0,
        notionalCap: 1_000_000_000,
        maintMarginRatio: 0.004,
        cum: 0,
      }],
    };
  }
  async fetchMarkPrice() { return this.markPrice; }
  async fetchBookTicker(symbol = "BTCUSDT") {
    if (symbol !== "BTCUSDT") return { symbol, bidPrice: 0.029665, askPrice: 0.029666, spreadBps: 0.337 };
    return structuredClone({ ...this.bookTicker, symbol });
  }
  async testLimitOrderPermission() { this.calls.permissionTests = (this.calls.permissionTests ?? 0) + 1; return { accepted: true }; }
  async queryOrder(_symbol, clientOrderId) {
    const order = this.orders.get(clientOrderId) ?? (clientOrderId?.includes("-close") ? (this.closeOrder ?? null) : this.order);
    return order ? structuredClone({createdTime:this.orderCreatedTime,updateTime:this.orderCreatedTime,...order}) : null;
  }
  async getExchangeTime() { return this.snapshotNow(); }
  async placeLimitOrder({ symbol, side, quantity, price, clientOrderId, timeInForce = "IOC" }) {
    this.calls.placeEntry += 1;
    this.calls.lastEntryRequest = { symbol, side, quantity, price, clientOrderId, timeInForce };
    if (this.failEntryUnknown) throw new Error("socket timeout");
    this.order = {
      symbol, side, originalQuantity: Number(quantity), executedQuantity: this.fillEntryImmediately ? Number(quantity) : 0,
      price: Number(price), averagePrice: this.fillEntryImmediately ? Number(price) : 0,
      clientOrderId, orderId: "1", status: this.fillEntryImmediately ? "FILLED" : "NEW", timeInForce, createdTime:this.orderCreatedTime, updateTime:this.orderCreatedTime,
    };
    if (this.fillEntryImmediately) this.account.positions = [{ symbol, quantity: Number(quantity), positionSide: "BOTH" }];
    return structuredClone(this.order);
  }
  async cancelOrder() {
    this.calls.cancelEntry += 1;
    this.order = { ...this.order, status: "CANCELED" };
    return structuredClone(this.order);
  }
  async closePositionMarket({ symbol, side, quantity, clientOrderId }) {
    this.calls.closeMarket = (this.calls.closeMarket ?? 0) + 1;
    this.closeOrder = {
      symbol, side, originalQuantity: Number(quantity), executedQuantity: Number(quantity), averagePrice: 85_000,
      clientOrderId, orderId: "9001", status: "FILLED", type: "MARKET", reduceOnly: true,
    };
    this.account.positions = [];
    return structuredClone(this.closeOrder);
  }
  async queryAlgoOrder(clientAlgoId) {
    if (this.delayedCanceledAlgo === clientAlgoId) {
      this.delayedCanceledQueries += 1;
      if (this.delayedCanceledQueries >= 2) {
        const current = this.algos.get(clientAlgoId);
        if (current) this.algos.set(clientAlgoId, { ...current, status: "EXPIRED" });
        this.delayedCanceledAlgo = null;
      }
    }
    return structuredClone(this.algos.get(clientAlgoId) ?? null);
  }
  async placeStopClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    this.calls.placeAlgo.push({ role: "stop", clientAlgoId, quantity });
    this.calls.sequence.push(`place:${clientAlgoId}`);
    if (this.failStop || (this.failBreakEven && clientAlgoId.endsWith("-slbe"))) {
      throw new BinanceApiError({ status: 400, code: -2021, message: "fixture explicit stop rejection" });
    }
    const order = {
      symbol, side, triggerPrice: Number(triggerPrice), clientAlgoId, algoId: String(this.algos.size + 1), status: "NEW",
      type: "STOP_MARKET", closePosition: quantity === null, quantity: quantity === null ? null : Number(quantity), reduceOnly: true,
    };
    this.algos.set(clientAlgoId, order);
    return structuredClone(order);
  }
  async placeTakeProfitClose({ symbol, side, triggerPrice, clientAlgoId, quantity = null }) {
    this.calls.placeAlgo.push({ role: quantity === null ? "tp2" : "tp1", clientAlgoId, quantity });
    const order = { symbol, side, triggerPrice: Number(triggerPrice), clientAlgoId, algoId: String(this.algos.size + 1), status: "NEW", type: "TAKE_PROFIT_MARKET", closePosition: quantity === null, quantity: quantity === null ? null : Number(quantity), reduceOnly: true };
    this.algos.set(clientAlgoId, order);
    return structuredClone(order);
  }
  async cancelAlgoOrder(clientAlgoId) {
    this.calls.cancelAlgo.push(clientAlgoId);
    this.calls.sequence.push(`cancel:${clientAlgoId}`);
    if (this.cancelUnknownOnce) {
      this.cancelUnknownOnce = false;
      this.delayedCanceledAlgo = clientAlgoId;
      this.delayedCanceledQueries = 0;
      const error = new Error("Unknown order sent");
      error.apiCode = -2011;
      throw error;
    }
    const order = this.algos.get(clientAlgoId);
    if (order) this.algos.set(clientAlgoId, { ...order, status: "CANCELED" });
    return { code: 200 };
  }
  async setMarginType(_symbol, value) {
    this.calls.marginType.push(value);
    this.account.symbolConfig.marginType = value;
    if (this.marginTypeUnknownOnce) {
      this.marginTypeUnknownOnce = false;
      throw new BinanceApiError({ status: 400, code: -1000, message: "unknown" });
    }
    return { code: 200 };
  }
  async setLeverage(_symbol, value) {
    this.calls.leverage.push(value);
    this.account.symbolConfig.leverage = value;
    if (this.leverageUnknownOnce) {
      this.leverageUnknownOnce = false;
      throw new BinanceApiError({ status: 400, code: -1000, message: "unknown" });
    }
    return { leverage: value };
  }
  async listUserTrades(_symbol, { startTime = 0, endTime = 9_000_300 } = {}) {
    const symbol = this.order?.symbol ?? 'BTCUSDT';
    const entrySide = this.order?.side ?? 'BUY';
    const exitSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
    const quantity = Number(this.order?.executedQuantity ?? 0);
    const rows = quantity > 0 ? [{ id: "1", orderId: this.order?.orderId, symbol, side: entrySide, quantity, price: Number(this.order.averagePrice) || 85000, commission: 0.04, commissionAsset: 'USDT', realizedPnl: 0, time: this.order?.createdTime ?? this.orderCreatedTime }] : [];
    if (this.closeOrder) rows.push({ id: "2", orderId: this.closeOrder.orderId, symbol, side: exitSide, quantity: Number(this.closeOrder.executedQuantity), price: 85000, commission: 0.04, commissionAsset: 'USDT', realizedPnl: -0.02, time: endTime });
    for (const algo of this.algos.values()) {
      if (this.hideAlgoTrades) continue;
      if (algo.actualOrderId) rows.push({ id: String(10000 + Number(algo.actualOrderId)), orderId: algo.actualOrderId, symbol: algo.symbol ?? symbol, side: algo.side ?? exitSide, quantity: Number(algo.actualQuantity), price: 85000, commission: 0.04, commissionAsset: 'USDT', realizedPnl: 1.2, time: endTime });
    }
    return [...rows, ...this.externalTrades];
  }
  async listIncomeHistory() { return []; }
}

function protectedRun(id, symbol, direction = "LONG") {
  const exitSide = direction === "LONG" ? "SELL" : "BUY";
  const clientIds = {
    entry: `${id}-entry`,
    stop: `${id}-sl`,
    breakEvenStop: `${id}-slbe`,
    takeProfit1: `${id}-tp1`,
    takeProfit2: `${id}-tp2`,
    operatorClose: null,
  };
  return {
    id,
    signalId: `${id}-signal`,
    sourceType: "SIGNAL",
    symbol,
    status: "OPEN_PROTECTED",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    entryOrder: { symbol, side: direction === 'LONG' ? 'BUY' : 'SELL', orderId: '8001', clientOrderId: clientIds.entry, executedQuantity: 1, status: "FILLED" },
    plan: { direction, entrySide: direction === 'LONG' ? 'BUY' : 'SELL', exitSide, quantity: 1, clientIds, rules: { stepSize: 0.001 }, prices: { entry: "100" } },
    protection: { mode: "TWO_TARGETS", stop: null, takeProfit1: null, takeProfit2: null, breakEvenStop: null },
    exchange: null,
    result: null,
    error: null,
  };
}

function algoFor(run, role, overrides = {}) {
  const stop = role === "stop" || role === "breakEvenStop";
  return {
    symbol: run.symbol,
    side: run.plan.exitSide,
    clientAlgoId: run.plan.clientIds[role],
    algoId: `${run.id}-${role}-order`,
    status: "NEW",
    type: stop ? "STOP_MARKET" : "TAKE_PROFIT_MARKET",
    closePosition: role !== "takeProfit1",
    reduceOnly: true,
    ...overrides,
  };
}

test("默认锁定时可以生成只读计划但不能提交订单", async () => {
  let clock = 1_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  assert.equal(prepared.run.status, "PREPARED");
  assert.equal(client.calls.placeEntry, 0);
  await assert.rejects(() => executor.execute(prepared.run.id, prepared.confirmationCode), TestnetWriteDisabledError);
  assert.equal(client.calls.placeEntry, 0);
});

test("执行器可随雷达增量扩展非 BTC 真实策略白名单", async () => {
  const clock = 1_200_000;
  const store = new MemoryStore(signalRecord(clock, { symbol: "AKEUSDT", direction: "SHORT" }));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  executor.allowSymbols(["AKEUSDT"]);

  const prepared = await executor.prepare("ake-signal-exec");

  assert.equal(prepared.run.symbol, "AKEUSDT");
  assert.equal(prepared.run.plan.entrySide, "SELL");
  assert.equal(client.calls.placeEntry, 0);
});

test("其他标的仓位已归属且有止损时可继续准备并提交新标的", async () => {
  const clock = 1_300_000;
  const store = new MemoryStore(signalRecord(clock, { symbol: "AKEUSDT", direction: "SHORT" }));
  const existing = protectedRun("btc-existing", "BTCUSDT", "LONG");
  store.runs.set(existing.id, structuredClone(existing));
  const client = new FakeTradingClient();
  const existingStop = algoFor(existing, "stop");
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.01, positionSide: "BOTH" }];
  client.account.openAlgoOrders = [existingStop];
  client.algos.set(existingStop.clientAlgoId, existingStop);
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    now: () => clock,
    allowedSymbols: ["BTCUSDT", "AKEUSDT"],
  });

  const prepared = await executor.prepare("ake-signal-exec");
  const submitted = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(prepared.run.symbol, "AKEUSDT");
  assert.equal(submitted.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.equal((await store.getExecutionRun(existing.id)).status, "OPEN_PROTECTED");
});

test("突破信号使用盘口可成交 IOC 限价并固化滑点上限审计", async () => {
  const clock = 1_400_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, activeLimitMaxBps: 10 });

  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(run.entryExecution.mode, "MARKETABLE_LIMIT_IOC");
  assert.equal(client.calls.lastEntryRequest.timeInForce, "IOC");
  assert.equal(Number(client.calls.lastEntryRequest.price), 85_085);
  const intent = store.audit.find((event) => event.eventType === "ENTRY_INTENT_PERSISTED");
  assert.equal(intent.payload.plannedPrice, "85000.0");
  assert.equal(intent.payload.executionMode, "MARKETABLE_LIMIT_IOC");
  assert.equal(intent.payload.referencePrice, 85_000);
});

test("突破盘口超过滑点预算时不提交订单并记录明确原因", async () => {
  const clock = 1_425_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.bookTicker = { symbol: "BTCUSDT", bidPrice: 85_099, askPrice: 85_100, spreadBps: 0.1175 };
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, activeLimitMaxBps: 10 });

  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);

  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET");
  assert.equal(client.calls.placeEntry, 0);
  assert.ok(store.audit.some((event) => event.eventType === "ENTRY_SKIPPED_SLIPPAGE_BUDGET"));
});

test("回调信号使用短时 GTC 限价，结构失效时立即撤单", async () => {
  let clock = 1_450_000;
  const record = signalRecord(clock, { strategy: "PULLBACK" });
  record.trade.expiresAt = clock + 10 * 60_000;
  const store = new MemoryStore(record);
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, pullbackEntryTtlMs: 180_000 });

  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(run.plan.entryPolicy.mode, "PASSIVE_LIMIT_GTC");
  assert.equal(run.plan.entryPolicy.expiresAt, clock + 180_000);
  assert.equal(client.calls.lastEntryRequest.timeInForce, "GTC");
  assert.equal(Number(client.calls.lastEntryRequest.price), 85_000);

  client.markPrice = 83_999;
  clock += 15_000;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.cancellationReason, "SETUP_INVALIDATED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.placeAlgo.length, 0);
});

test("Demo canTrade=false 时准备和执行前都以不进撮合的测试单复核权限", async () => {
  let clock = 1_500_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.account.canTrade = false;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  assert.equal(prepared.run.status, "PREPARED");
  assert.equal(client.calls.permissionTests, 1);
  await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(client.calls.permissionTests, 2);
  assert.equal(client.calls.placeEntry, 1);
  const permission = await executor.permissionStatus();
  assert.equal(permission.valid, true);
});

test("TEAM014缺失canTrade必须逐笔探针；准备或执行前探针失败均不发入场单",async()=>{
  for(const failAt of [1,2]){
    const clock=1_500_000,store=new MemoryStore(signalRecord(clock)),client=new FakeTradingClient();
    delete client.account.canTrade;
    let probes=0;
    client.testLimitOrderPermission=async()=>{probes++;if(probes===failAt)throw Error('fixture permission denied');return {accepted:true};};
    const executor=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});
    if(failAt===1)await assert.rejects(()=>executor.prepare("btc-signal-exec"),/permission denied/);
    else {const prepared=await executor.prepare("btc-signal-exec");await assert.rejects(()=>executor.execute(prepared.run.id,prepared.confirmationCode),/permission denied/);}
    assert.equal(probes,failAt);
    assert.equal(client.calls.placeEntry,0);
  }
});

test("人工金丝雀与策略绩效隔离并可在保护后幂等主动平仓", async () => {
  let clock = 1_700_000;
  const store = new MemoryStore(signalRecord(clock));
  store.createOperatorCanarySource = async () => true;
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepareOperatorCanary("LONG");
  assert.equal(prepared.run.sourceType, "OPERATOR_CANARY");
  assert.equal(prepared.run.performanceEligible, false);
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.closeOperatorCanary(run.id, "操作员确认Demo技术闭环已经完成，因此主动平仓结束测试。");
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.reason, "EXCHANGE_POSITION_CLOSED");
  assert.equal(run.result.exitRole, "operatorClose");
  assert.equal(run.result.exitReason, "操作员确认Demo技术闭环已经完成，因此主动平仓结束测试。");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.result.trades.length, 2);
  const repeated = await executor.closeOperatorCanary(run.id);
  assert.equal(repeated.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("真实策略 run 可持久化唯一 reduceOnly 意图后幂等主动平仓并严格归属成交", async () => {
  let clock = 1_750_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", marginType: "ISOLATED" }];
  await assert.rejects(() => executor.closeExecutionRun(run.id), /主动平仓原因/);
  assert.equal(client.calls.closeMarket ?? 0, 0);
  run = await executor.closeExecutionRun(run.id, "策略测试已完成且需要验证主动退出链路，因此平掉当前Demo仓位。");
  assert.equal(run.status, "CLOSED");
  assert.match(run.plan.clientIds.operatorClose, /^cfs-[A-Za-z0-9_-]+-close$/);
  assert.equal(run.operatorCloseOrder.reduceOnly, true);
  assert.equal(run.result.accountingComplete, true);
  assert.deepEqual(run.result.ownedOrderIds, ["1", "9001"]);
  assert.deepEqual(run.result.trades.map((trade) => trade.orderId), ["1", "9001"]);
  assert.equal(client.calls.closeMarket, 1);
  assert.ok(store.audit.some((event) => event.eventType === "OPERATOR_CLOSE_INTENT_PERSISTED"));
  assert.equal(store.audit.find((event) => event.eventType === "OPERATOR_CLOSE_INTENT_PERSISTED").payload.reason,
    "策略测试已完成且需要验证主动退出链路，因此平掉当前Demo仓位。");
  const repeated = await executor.closeExecutionRun(run.id);
  assert.equal(repeated.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("平仓后交易所自动终止保护单时容忍一次 -2011 撤单竞态并完成结算", async () => {
  let clock = 1_760_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.cancelUnknownOnce = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", marginType: "ISOLATED" }];
  run = await executor.closeExecutionRun(run.id, "策略测试已完成且需要验证保护单清理，因此平掉当前Demo仓位。");
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.accountingComplete, true);
  assert.equal(client.calls.closeMarket, 1);
  assert.ok(client.delayedCanceledQueries >= 2);
});

test("策略主动平仓在仓位无法唯一归属或缺少止损时拒绝写入", async () => {
  const clock = 1_775_000;
  const run = protectedRun("unsafe-close", "BTCUSDT");
  const store = new MemoryStore(signalRecord(clock));
  store.runs.set(run.id, structuredClone(run));
  const client = new FakeTradingClient();
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 1, positionSide: "BOTH", marginType: "ISOLATED" }];
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  await assert.rejects(() => executor.closeExecutionRun(run.id, "账户归属检查实验需要尝试主动退出，因此请求平掉当前Demo仓位。"), /无法归属、冲突或缺少止损/);
  assert.equal(client.calls.closeMarket ?? 0, 0);
});

test("入场限价首次响应直接成交时立即建立保护单而不是误报无保护", async () => {
  let clock = 1_800_000;
  const store = new MemoryStore(signalRecord(clock));
  store.createOperatorCanarySource = async () => true;
  const client = new FakeTradingClient();
  client.fillEntryImmediately = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepareOperatorCanary("LONG");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.equal(run.protection.stop.status, "NEW");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")), null);
});

test("完整闭环只提交一次入场单，成交后先建止损，再建止盈，平仓后清理兄弟单", async () => {
  let clock = 2_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.deepEqual(client.calls.marginType, ["ISOLATED"]);
  assert.deepEqual(client.calls.leverage, [10]);

  // Explicit exchange aggregate evidence for pre-settlement mark observations.
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000, cumulativeQuote: 102 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.deepEqual(client.calls.placeAlgo.map((item) => item.role), ["stop", "tp2", "tp1"]);
  assert.match(store.audit.find((event) => event.eventType === "ENTRY_INTENT_PERSISTED").payload.reason, /因此开仓做多/);
  assert.equal(store.audit.filter((event) => event.eventType === "PROTECTION_ORDER_INTENT_PERSISTED").length, 3);
  assert.equal(client.calls.placeEntry, 1);

  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", markPrice: 85_500 }];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.ok(run.performance.mfePnl > 0);
  assert.equal(run.performance.maePnl, 0);
  assert.equal(client.calls.placeEntry, 1);

  const tp2Id = run.plan.clientIds.takeProfit2;
  client.algos.set(tp2Id, { ...client.algos.get(tp2Id), status: "FINISHED", actualQuantity: 0.0012, actualOrderId: "9002" });
  client.account.positions = [];
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.netPnl, 1.1199999999999999);
  assert.equal(run.result.accountingComplete, true);
  assert.equal(run.result.exitRole, "takeProfit2");
  assert.match(run.result.exitReason, /平掉剩余仓位/);
  assert.deepEqual(run.result.trades.map((trade) => trade.orderId), ["1", "9002"]);
  assert.equal(run.performance.modelVersion, "TRADE_EXCURSION_R1");
  // Complete fills use the fixture's observed execution price (85000),
  // never the virtual TP2 target. Entry and exit share the mock clock.
  assert.ok(Math.abs(run.performance.mfeR - 0.5) < 1e-8);
  assert.equal(run.performance.maeR, 0);
  assert.equal(run.performance.mfePrice, 85_500);
  assert.equal(run.performance.timeToTp2Ms, 0);
  assert.equal(run.performance.maxFavorableExcursionBeforeExitR, 0.5);
  assert.equal(run.performance.maxAdverseExcursionBeforeExitR, 0);
  assert.ok(client.calls.cancelAlgo.length >= 2);
});

async function tpRecoveryFixture() {
  const time = { now: 2_000_000 };
  const store = new MemoryStore(signalRecord(time.now));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => time.now });
  const prepared = await executor.prepare("btc-signal-exec");
  const run = prepared.run;
  run.status = "PROTECTION_PENDING";
  run.entryOrder = { symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry,
    orderId: "9006", executedQuantity: 0.0012, status: "FILLED", createdTime:time.now, updateTime: time.now };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  return { time, store, client, executor, run };
}

async function unknownStopFixture(){
  const ctx=await tpRecoveryFixture(),{client,executor,run,store}=ctx;
  client.order=structuredClone(run.entryOrder);client.placeStopClose=async()=>{throw Error("fixture SL submission unknown");};
  await executor.ensureProtection(run,0.0012);assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.orderSubmissions.stop.attempted,true);await store.saveExecutionRun(run);return ctx;
}

async function completeRuntimeOverview(client) {
  const account = await client.fetchAccountState();
  account.openAlgoOrders = structuredClone([...client.algos.values()].filter(order => order.status === "NEW"));
  return account;
}

test("TEAM026C同Store运行故障强阻断准备和execute但真实保护管理继续，新完整对账只恢复运行状态", async () => {
  const { executor, client, run, store, time } = await tpRecoveryFixture();
  client.order = structuredClone(run.entryOrder);
  await executor.ensureProtection(run, 0.0012);
  executor.recordRuntimeFault("FIXTURE");
  const other = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => time.now, logger: { error() {} } });
  await assert.rejects(other.prepare("another"), /运行故障/);
  await assert.rejects(other.prepareOperatorCanary(), /运行故障/);
  await assert.rejects(other.execute(run.id, "unused"), /运行故障/);
  assert.equal(client.calls.placeEntry, 0);
  let queries = 0;
  const query = client.queryAlgoOrder.bind(client);
  client.queryAlgoOrder = async id => { queries++; return query(id); };
  await other.reconcile(run.id);
  assert.ok(queries > 0);
  assert.equal(other.runtimeStatus().active, true);
  await store.setMetadata("testnet_execution_emergency_stop", { active: true, reason: "operator fixture" });
  const original = await store.getMetadata("testnet_execution_emergency_stop");
  client.fetchAccountOverview = () => completeRuntimeOverview(client);
  await other.reconcileAll();
  assert.equal(executor.runtimeStatus().active, false);
  assert.deepEqual(await store.getMetadata("testnet_execution_emergency_stop"), original);
  assert.equal((await store.getExecutionRun(run.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.closeMarket ?? 0, 0);
});

test("TEAM026C空列表不能独自恢复，完整新鲜零账户和再次空列表才恢复", async () => {
  for (const mode of ["missing", "stale", "future", "foreign", "newRun", "good"]) {
    const store = new MemoryStore(null), client = new FakeTradingClient(), now = 9_000_000;
    const executor = new TestnetCanaryExecutor({ store, client, enabled: true, now: () => now, logger: { error() {} } });
    executor.recordRuntimeFault("FIXTURE");
    client.fetchAccountOverview = async () => {
      const account = await client.fetchAccountState();
      if (mode === "missing") delete account.syncedAt;
      if (mode === "stale") account.syncedAt = now - 1;
      if (mode === "future") account.syncedAt = now + 1;
      if (mode === "foreign") account.openOrders.push({ symbol: "BTCUSDT", clientOrderId: "foreign" });
      if (mode === "newRun") store.runs.set("new", { id: "new", status: "ENTRY_PENDING" });
      return account;
    };
    await executor.reconcileAll();
    assert.equal(executor.runtimeStatus().active, mode !== "good", mode);
  }
});

test("TEAM026C较早成功不能清较新故障，部分保护查询失败不能恢复，后续完整新对账可恢复", async () => {
  const { executor, client, run, store, time } = await tpRecoveryFixture();
  client.order = structuredClone(run.entryOrder);
  await executor.ensureProtection(run, 0.0012);
  executor.recordRuntimeFault("INITIAL");
  const other = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => time.now, logger: { error() {} } });
  let release, began;
  const ready = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  client.fetchAccountOverview = async () => { began(); return pending; };
  const old = executor.reconcileAll(); await ready;
  client.fetchAccountOverview = async () => { throw Error("private fixture"); };
  await other.reconcileAll();
  const fault = other.runtimeStatus().generation;
  release(await completeRuntimeOverview(client)); await old;
  assert.equal(executor.runtimeStatus().active, true);
  assert.equal(executor.runtimeStatus().generation, fault);
  client.fetchAccountOverview = async () => {
    const account = await completeRuntimeOverview(client);
    account.openAlgoOrders = account.openAlgoOrders.filter(order => order.clientAlgoId !== run.plan.clientIds.takeProfit1);
    return account;
  };
  const query = client.queryAlgoOrder.bind(client);
  client.queryAlgoOrder = async id => { if (id === run.plan.clientIds.takeProfit1) throw Error("private query"); return query(id); };
  await other.reconcileAll();
  assert.equal(executor.runtimeStatus().active, true);
  client.queryAlgoOrder = query;
  client.fetchAccountOverview = () => completeRuntimeOverview(client);
  await other.reconcileAll();
  assert.equal(executor.runtimeStatus().active, false);
});
test("TEAM025明确原SL负查询和独立新鲜归属仓位进入既有应急而非永久unknown",async()=>{
  const {executor,client,run,store}=await unknownStopFixture();
  let accounts=0,negativeQueries=0;
  const fetch=client.fetchAccountState.bind(client),query=client.queryAlgoOrder.bind(client);
  client.fetchAccountState=async(...args)=>{accounts++;return fetch(...args);};
  client.queryAlgoOrder=async id=>{const order=await query(id);if(id===run.plan.clientIds.stop&&order===null)negativeQueries++;return order;};
  await executor.reconcileProtected(run);
  assert.ok(store.audit.some(e=>e.eventType==="MISSING_STOP_CONFIRMED"));assert.equal(await executor.isEmergencyStopped(),true);
  assert.ok(store.audit.some(e=>e.eventType==="UNPROTECTED_AUTO_CLOSE_REQUESTED"));assert.equal(client.calls.closeMarket,1);
  assert.ok(accounts>=2);assert.ok(negativeQueries>=2);
  assert.ok(store.audit.findIndex(e=>e.eventType==="MISSING_STOP_CONFIRMED")<store.audit.findIndex(e=>e.eventType==="UNPROTECTED_AUTO_CLOSE_REQUESTED"));
  assert.equal(client.calls.placeAlgo.length,0);assert.equal(client.calls.cancelAlgo.length,0);
});
test("TEAM026已验证原SL历史退出证据在顶层暂空后仍进入真实归属会计",async()=>{
  const {executor,client,run,time}=await unknownStopFixture();
  run.protection.observations={stop:{executionEvidence:{runId:run.id,role:"stop",clientAlgoId:run.plan.clientIds.stop,
    symbol:run.symbol,side:run.plan.exitSide,sourceClientAlgoId:run.plan.clientIds.stop,identityVerified:true,
    status:"FINISHED",actualOrderId:"9200",actualQuantity:0.0012,updateTime:time.now,
    type:"STOP_MARKET",sourceSymbol:run.symbol,sourceSide:run.plan.exitSide,sourcePositionSide:"BOTH"}}};
  client.externalTrades=[{id:"66",orderId:"9200",symbol:run.symbol,side:run.plan.exitSide,quantity:0.0012,
    price:86000,quoteQuantity:103.2,commission:0.04,commissionAsset:"USDT",realizedPnl:1.2,time:time.now}];
  const accounting=await executor.collectRunTrades(run);
  assert.ok(accounting.ownedOrderIds.includes("9200"));assert.equal(accounting.exitFactsComplete,true);
  assert.equal(accounting.accountingComplete,true);
  client.account.positions=[];
  await executor.reconcileProtected(run);
  assert.equal(run.status,"CLOSED");assert.equal(run.result.exitRole,"stop");
  assert.equal(run.result.accountingComplete,true);assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM026QA未来历史退出时间不能自行扩大交易所可信上界或结算", async () => {
  const { executor, client, run, time } = await unknownStopFixture();
  const future = time.now + 3_600_000;
  run.protection.observations = { stop: { executionEvidence: {
    runId: run.id, role: "stop", clientAlgoId: run.plan.clientIds.stop, symbol: run.symbol, side: run.plan.exitSide,
    sourceClientAlgoId: run.plan.clientIds.stop, sourceSymbol: run.symbol, sourceSide: run.plan.exitSide,
    sourcePositionSide: "BOTH", type: "STOP_MARKET", identityVerified: true, status: "FINISHED",
    actualOrderId: "9200", actualQuantity: 0.0012, updateTime: future, observedAt: time.now,
  } } };
  client.externalTrades = [{ id: "66", orderId: "9200", symbol: run.symbol, side: run.plan.exitSide,
    quantity: 0.0012, price: 86000, quoteQuantity: 103.2, commission: 0.04, commissionAsset: "USDT", realizedPnl: 1.2, time: future }];
  const facts = await executor.collectRunTrades(run);
  assert.equal(facts.exitFactsComplete, false);
  assert.equal(facts.accountingComplete, false);
  assert.equal(facts.ownedOrderIds.includes("9200"), false);
  client.account.positions = [];
  await executor.reconcileProtected(run);
  assert.notEqual(run.status, "CLOSED");
  assert.equal(client.calls.cancelAlgo.length, 0);
});

test("TEAM026QA历史退出可信上界缺失非法未来及持久化恢复矩阵，不混用本地时钟", async () => {
  for (const mode of ["good", "localAhead", "localBehind", "futureOrder", "futureFill", "missingOrderTime", "fractionalOrderTime", "fractionalFillTime", "missingClock", "booleanClock", "fractionalClock"]) {
    const { executor, client, run, time, store } = await unknownStopFixture();
    const exchangeNow = time.now;
    executor.now = () => exchangeNow + (mode === "localAhead" ? 3_600_000 : mode === "localBehind" ? -1_000_000 : 0);
    client.getExchangeTime = async () => mode === "missingClock" ? null : mode === "booleanClock" ? true : mode === "fractionalClock" ? exchangeNow + 0.5 : exchangeNow;
    const updated = mode === "futureOrder" ? exchangeNow + 1 : mode === "missingOrderTime" ? null : mode === "fractionalOrderTime" ? exchangeNow - 0.5 : exchangeNow;
    run.protection.observations = { stop: { executionEvidence: {
      runId: run.id, role: "stop", clientAlgoId: run.plan.clientIds.stop, symbol: run.symbol, side: run.plan.exitSide,
      sourceClientAlgoId: run.plan.clientIds.stop, sourceSymbol: run.symbol, sourceSide: run.plan.exitSide, sourcePositionSide: "BOTH",
      type: "STOP_MARKET", identityVerified: true, status: "FINISHED", actualOrderId: "9200", actualQuantity: 0.0012, updateTime: updated,
    } } };
    client.externalTrades = [{ id: "66", orderId: "9200", symbol: run.symbol, side: run.plan.exitSide, quantity: 0.0012,
      price: 86000, quoteQuantity: 103.2, commission: 0.04, commissionAsset: "USDT", realizedPnl: 1.2,
      time: mode === "futureFill" ? exchangeNow + 1 : mode === "fractionalFillTime" ? exchangeNow - 0.5 : exchangeNow }];
    const good = ["good", "localAhead", "localBehind"].includes(mode);
    const facts = await executor.collectRunTrades(run);
    assert.equal(facts.exitFactsComplete, good, mode);
    assert.equal(facts.accountingComplete, good, mode);
    run.result = executor.buildRunResult(facts, run);
    await store.saveExecutionRun(run);
    const restored = await store.getExecutionRun(run.id);
    assert.equal(ownedExitFills(restored).length, good ? 1 : 0, mode);
    if (["missingClock", "booleanClock", "fractionalClock", "futureOrder", "missingOrderTime", "fractionalOrderTime"].includes(mode)) {
      assert.equal(verifiedProtectionExitOrders(restored).length, 0, mode);
    }
    client.account.positions = [];
    const other = new TestnetCanaryExecutor({ store, client, enabled: true, now: executor.now, logger: { error() {} } });
    await other.reconcile(restored.id);
    assert.equal((await store.getExecutionRun(run.id)).status === "CLOSED", good, mode);
  }
});
test("TEAM026 FINISHED全量后的同ID非零弱NEW不得恢复有效保护或新增TP",async()=>{
  const {executor,client,run,time}=await unknownStopFixture(),id=run.plan.clientIds.stop;
  run.protection.stop={symbol:run.symbol,side:run.plan.exitSide,type:"STOP_MARKET",clientAlgoId:id,algoId:"7",
    status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200",updateTime:time.now};
  client.algos.set(id,{...run.protection.stop,status:"NEW",actualQuantity:0.0001,actualOrderId:null,closePosition:true});
  await executor.reconcileProtected(run);assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.observations.stop.executionConflict,true);assert.equal(client.calls.placeAlgo.length,0);
});
test("TEAM026批次晚失败不得覆盖同Store另一执行器真实结算的终态和结果",async()=>{
  const {executor,client,run,store,time}=await finishedStopFixture();
  run.status="OPEN_PROTECTED";await store.saveExecutionRun(run);client.account.positions=[];
  let reject,started;const pending=new Promise((_,r)=>{reject=r}),ready=new Promise(r=>{started=r});
  client.fetchAccountOverview=async()=>{started();return pending;};
  const batch=executor.reconcileAll();await ready;
  const other=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>time.now,logger:{error(){}}});
  const closed=await other.reconcile(run.id);assert.equal(closed.status,"CLOSED");
  reject(Error("fixture delayed batch failure"));await batch;
  assert.deepEqual(await store.getExecutionRun(run.id),closed);
});
test("TEAM026同Store execute直接恢复与两次退出串行，不重复入场退出且finally释放",async()=>{
  const clock=3_900_000,store=new MemoryStore(signalRecord(clock)),client=new FakeTradingClient();
  client.fillEntryImmediately=true;
  const first=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});
  const second=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});
  const p=await first.prepare("btc-signal-exec");let release,started;
  const gate=new Promise(r=>{release=r}),ready=new Promise(r=>{started=r});const margin=client.setMarginType.bind(client);
  client.setMarginType=async(...args)=>{started();await gate;return margin(...args);};
  const execution=first.execute(p.run.id,p.confirmationCode);await ready;
  const recovery=second.reconcile(p.run.id);
  const reason="Fixture controlled exit after protected execution for concurrency verification.";
  const close1=second.closeExecutionRun(p.run.id,reason),close2=first.closeExecutionRun(p.run.id,reason);
  assert.equal(client.calls.placeEntry,0);assert.equal(client.calls.closeMarket??0,0);release();
  await Promise.all([execution,recovery,close1,close2]);
  assert.equal(client.calls.placeEntry,1);assert.equal(client.calls.closeMarket,1);
  assert.equal((await store.getExecutionRun(p.run.id)).status,"CLOSED");
  await assert.rejects(first.withRunOwnership(p.run.id,async()=>{throw Error("fixture ownership exception");}));
  assert.equal(await second.withRunOwnership(p.run.id,async()=>"released"),"released");
});
test("TEAM026逐run所有权不阻塞其他标的，较晚成功批次不复活终态",async()=>{
  const {executor,client,run,store,time}=await finishedStopFixture();run.status="OPEN_PROTECTED";await store.saveExecutionRun(run);client.account.positions=[];
  let resolve,started;const pending=new Promise(r=>{resolve=r}),ready=new Promise(r=>{started=r});
  client.fetchAccountOverview=async()=>{started();return pending;};const batch=executor.reconcileAll();await ready;
  const other=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>time.now});
  const closed=await other.reconcile(run.id);resolve(structuredClone(client.account));await batch;
  assert.deepEqual(await store.getExecutionRun(run.id),closed);
  let unlock,entered;const gate=new Promise(r=>{unlock=r}),inside=new Promise(r=>{entered=r});
  const owned=executor.withRunOwnership(run.id,async()=>{entered();await gate;});await inside;
  assert.equal(await other.withRunOwnership("different-symbol-run",async()=>"independent"),"independent");unlock();await owned;
});
test("TEAM025原ID未知无效身份账户不完整旧快照和未完余单不得确认缺SL或下单",async()=>{
  for(const mode of ["throw","undefined","identity","side","symbol","accountMissing","accountStale","accountFuture","externalPosition","externalOrder","remainder","entryConflict","entryQueryUnknown","priorExit"]){
    const {executor,client,run,store,time}=await unknownStopFixture(),fetch=client.fetchAccountState.bind(client);
    if(mode==="throw")client.queryAlgoOrder=async()=>{throw Error("fixture network unknown");};
    if(mode==="undefined")client.queryAlgoOrder=async()=>undefined;
    if(["identity","side","symbol"].includes(mode))client.queryAlgoOrder=async id=>id===run.plan.clientIds.stop?{clientAlgoId:mode==="identity"?"foreign":id,symbol:mode==="symbol"?"ETHUSDT":run.symbol,side:mode==="side"?"BUY":run.plan.exitSide,type:"STOP_MARKET",status:"NEW",closePosition:true}:null;
    if(mode.startsWith("account"))client.fetchAccountState=async()=>{const a=await fetch();if(mode==="accountMissing")delete a.openAlgoOrders;if(mode==="accountStale")a.syncedAt=time.now-1;if(mode==="accountFuture")a.syncedAt=time.now+1;return a;};
    if(mode==="externalPosition")client.account.positions.push({symbol:"ETHUSDT",quantity:1,positionSide:"BOTH"});
    if(mode==="externalOrder")client.account.openOrders.push({symbol:run.symbol,clientOrderId:"foreign"});
    if(mode==="remainder")run.entryExecution={remainderPending:true};
    if(mode==="entryConflict")client.account.positions[0].quantity=-0.0012;
    if(mode==="entryQueryUnknown")client.queryOrder=async()=>{throw Error("fixture entry identity unknown");};
    if(mode==="priorExit")run.protection.stop={status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200"};
    await executor.reconcileProtected(run);
    if(mode==="priorExit")await executor.reconcileProtected(run);
    assert.equal(client.calls.closeMarket??0,0,mode);assert.equal(client.calls.placeAlgo.length,0,mode);
    assert.equal(client.calls.cancelAlgo.length,0,mode);assert.equal(await executor.isEmergencyStopped(),false,mode);assert.equal(store.audit.some(e=>e.eventType==="MISSING_STOP_CONFIRMED"),false,mode);
  }
});
test("TEAM025原SL在独立复核时迟到成功只保持保护不执行应急",async()=>{
  const {executor,client,run,store}=await unknownStopFixture();let reads=0;
  client.queryAlgoOrder=async id=>id===run.plan.clientIds.stop&&++reads>=2?{symbol:run.symbol,side:run.plan.exitSide,type:"STOP_MARKET",clientAlgoId:id,algoId:"7",status:"NEW",closePosition:true}:null;
  await executor.reconcileProtected(run);assert.equal(client.calls.closeMarket??0,0);assert.equal(await executor.isEmergencyStopped(),false);
  assert.equal(run.protection.cleanupVerification.reason,"MISSING_STOP_PROTECTION_REAPPEARED");assert.equal(store.audit.some(e=>e.eventType==="MISSING_STOP_CONFIRMED"),false);
});
test("TEAM025缓存FINISHED到冲突NEW再负查询跨轮及重启不得擦除退出证据",async()=>{
  const {executor,client,run,store,time}=await unknownStopFixture();
  const id=run.plan.clientIds.stop;
  run.protection.stop={symbol:run.symbol,side:run.plan.exitSide,type:"STOP_MARKET",clientAlgoId:id,algoId:"7",status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200",updateTime:time.now};
  client.algos.set(id,{...run.protection.stop,status:"NEW",actualQuantity:0,actualOrderId:null,closePosition:true});
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  client.algos.delete(id);await executor.reconcileProtected(run);
  const restored=await store.getExecutionRun(run.id);
  await executor.reconcileProtected(restored);
  assert.equal(client.calls.closeMarket??0,0);
  assert.equal(store.audit.some(e=>e.eventType==="MISSING_STOP_CONFIRMED"),false);
  assert.equal(await executor.isEmergencyStopped(),false);
  assert.equal(restored.protection.observations.stop.executionMayHaveOccurred,true);
  const evidence=restored.protection.observations.stop.executionEvidence;
  assert.equal(evidence.runId,run.id);assert.equal(evidence.clientAlgoId,id);assert.equal(evidence.role,"stop");
  assert.equal(evidence.symbol,run.symbol);assert.equal(evidence.side,run.plan.exitSide);
  assert.equal(evidence.actualOrderId,"9200");assert.equal(evidence.actualQuantity,0.0012);
  assert.equal(evidence.identityVerified,true);
});
test("TEAM025直接保护恢复也不得以冲突NEW擦除原ID的实际退出证据",async()=>{
  const {executor,client,run,time,store}=await unknownStopFixture(),id=run.plan.clientIds.stop;
  run.protection.stop={symbol:run.symbol,side:run.plan.exitSide,type:"STOP_MARKET",clientAlgoId:id,algoId:"7",status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200",updateTime:time.now};
  client.algos.set(id,{...run.protection.stop,status:"NEW",actualQuantity:0,actualOrderId:null,closePosition:true});
  await executor.ensureProtection(run,0.0012);assert.equal(run.status,"PROTECTION_INCOMPLETE");
  client.algos.delete(id);await executor.reconcileProtected(run);
  assert.equal(client.calls.closeMarket??0,0);assert.equal(client.calls.placeAlgo.length,0);
  assert.equal(store.audit.some(e=>e.eventType==="MISSING_STOP_CONFIRMED"),false);
  assert.equal(run.protection.observations.stop.executionEvidence.actualOrderId,"9200");
});
test("TEAM024跨查询NEW到FINISHED的止损不得在恢复入口误判失败或重发保护",async()=>{
  const {executor,client,run,store,time}=await tpRecoveryFixture();await executor.ensureProtection(run,0.0012);
  run.status="PROTECTION_INCOMPLETE";await store.saveExecutionRun(run);client.order=structuredClone(run.entryOrder);
  const before=client.calls.placeAlgo.length,query=client.queryAlgoOrder.bind(client);let reads=0;
  client.queryAlgoOrder=async id=>{const order=await query(id);if(id===run.plan.clientIds.stop&&++reads>=2)return {...order,status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200",updateTime:time.now};return order;};
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(await executor.isEmergencyStopped(),false);
  assert.equal(store.audit.some(e=>e.eventType==="STOP_PROTECTION_FAILED"),false);
  assert.equal(client.calls.closeMarket??0,0);assert.equal(client.calls.placeAlgo.length,before);assert.notEqual(run.performanceEligible,false);
});
async function finishedStopFixture(changes={}){
  const ctx=await tpRecoveryFixture(),{executor,client,run,time}=ctx;await executor.ensureProtection(run,0.0012);client.order=structuredClone(run.entryOrder);
  const id=run.plan.clientIds.stop,stop={...client.algos.get(id),status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9200",updateTime:time.now,...changes};client.algos.set(id,stop);return {...ctx,stop};
}
test("TEAM024各保护和入场恢复入口对已执行止损只等待核实且不误排资格",async()=>{
  for(const entry of ["ensure","reconcile","entry","remainder","managed"]){
    const {executor,client,run,store}=await finishedStopFixture();const before=JSON.stringify(run.plan),posts=client.calls.placeAlgo.length;
    if(entry==="ensure")await executor.ensureProtection(run,0.0012);
    else if(entry==="entry"||entry==="remainder"){run.status="ENTRY_FACT_PENDING";if(entry==="remainder")run.entryExecution={remainderPending:true};await store.saveExecutionRun(run);await executor.reconcile(run.id);}
    else {run.status=entry==="managed"?"TP1_FILLED":"PROTECTION_INCOMPLETE";await executor.reconcileProtected(run);}
    const saved=await store.getExecutionRun(run.id);assert.equal(saved.status,"PROTECTION_INCOMPLETE",entry);assert.notEqual(saved.performanceEligible,false,entry);
    assert.equal(await executor.isEmergencyStopped(),false,entry);assert.equal(client.calls.placeAlgo.length,posts,entry);assert.equal(client.calls.closeMarket??0,0,entry);assert.equal(client.calls.cancelAlgo.length,0,entry);assert.equal(JSON.stringify(saved.plan),before,entry);
  }
});
test("TEAM024FINISHED缺数量时间成交或身份不符均不等于全量退出且保留阻断",async()=>{
  for(const changes of [{actualQuantity:null},{actualQuantity:0},{actualOrderId:null},{updateTime:null},{clientAlgoId:"foreign"},{symbol:"ETHUSDT"},{side:"BUY"}]){
    const {executor,client,run,store}=await finishedStopFixture(changes),count=client.calls.placeAlgo.length;run.status="PROTECTION_INCOMPLETE";
    await executor.reconcileProtected(run);assert.equal(run.status,"PROTECTION_INCOMPLETE",JSON.stringify(changes));assert.notEqual(run.performanceEligible,false);
    assert.equal(client.calls.placeAlgo.length,count);assert.equal(client.calls.cancelAlgo.length,0);assert.equal(client.calls.closeMarket??0,0);assert.equal(await executor.isEmergencyStopped(),false);
    assert.equal(store.audit.some(e=>e.eventType==="CANARY_CLOSED"),false);
  }
});
test("TEAM024部分止损且剩余仓无覆盖及取消拒绝过期止损保持原应急",async()=>{
  for(const changes of [{actualQuantity:0.0006},{status:"CANCELED",actualQuantity:0},{status:"REJECTED",actualQuantity:0},{status:"EXPIRED",actualQuantity:0}]){
    const {executor,client,run,store}=await finishedStopFixture(changes);run.status="PROTECTION_INCOMPLETE";
    if(changes.actualQuantity===0.0006)client.account.positions[0].quantity=0.0006;
    await executor.reconcileProtected(run);assert.equal(await executor.isEmergencyStopped(),true,JSON.stringify(changes));assert.ok(store.audit.some(e=>e.eventType==="UNPROTECTED_POSITION_CLASSIFIED"));
  }
});
test("TEAM024全量SL晚到账必须等归属fills和独立新鲜零仓才清理结算且不清旧停止",async()=>{
  const {executor,client,run,store}=await finishedStopFixture();run.status="PROTECTION_INCOMPLETE";
  await store.setMetadata("testnet_execution_emergency_stop",{active:true,reason:"FIXTURE_OLD_STOP"});
  await executor.reconcileProtected(run);assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(client.calls.cancelAlgo.length,0);
  client.account.positions=[];client.hideAlgoTrades=true;await executor.reconcileProtected(run);assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(client.calls.cancelAlgo.length,0);
  client.hideAlgoTrades=false;await executor.reconcileProtected(run);assert.equal(run.status,"CLOSED");assert.equal(run.result.accountingComplete,true);assert.equal(run.result.trades.filter(t=>t.side===run.plan.exitSide).length,1);
  assert.equal(await executor.isEmergencyStopped(),true);assert.notEqual(run.performanceEligible,false);assert.equal(client.calls.closeMarket??0,0);
});
test("TEAM024止损查询未知不补单，TP1后FINISHED的BE保留原数量和退出等待",async()=>{
  const {executor,client,run,time}=await finishedStopFixture();const base=client.queryAlgoOrder.bind(client),count=client.calls.placeAlgo.length;
  client.queryAlgoOrder=async id=>{if(id===run.plan.clientIds.stop)throw Error("fixture unknown stop query");return base(id);};
  await executor.ensureProtection(run,0.0012);assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(client.calls.placeAlgo.length,count);
  client.queryAlgoOrder=base;
  const tp1=client.algos.get(run.plan.clientIds.takeProfit1);client.algos.set(tp1.clientAlgoId,{...tp1,status:"FINISHED",actualQuantity:0.0006,actualOrderId:"9201",updateTime:time.now});
  const stop=client.algos.get(run.plan.clientIds.stop);client.algos.set(stop.clientAlgoId,{...stop,status:"CANCELED",actualQuantity:0,actualOrderId:null});
  const be={...stop,clientAlgoId:run.plan.clientIds.breakEvenStop,status:"FINISHED",actualQuantity:0.0006,quantity:0.0006,actualOrderId:"9202",updateTime:time.now};
  run.protection.breakEvenStop=be;client.algos.set(be.clientAlgoId,be);run.status="TP1_FILLED";client.account.positions[0].quantity=0.0006;
  await executor.reconcileProtected(run);assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(run.protection.cleanupVerification.reason,"breakEvenStop:EXIT_SETTLEMENT_UNCONFIRMED");
  assert.equal(client.calls.placeAlgo.length,count);assert.equal(client.calls.cancelAlgo.length,0);assert.equal(client.calls.closeMarket??0,0);assert.equal(await executor.isEmergencyStopped(),false);
});
test("TP2终态不阻断TP1，退避后新ID恢复且planHash/价格比例不变", async () => {
  const { time, store, client, executor, run } = await tpRecoveryFixture();
  const before = JSON.stringify(run.plan), planHash = run.planHash;
  client.algos.set(run.plan.clientIds.takeProfit2, { symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId: run.plan.clientIds.takeProfit2, algoId: "rejected-tp2", status: "REJECTED", actualQuantity: 0 });
  await executor.ensureProtection(run, 0.0012);
  assert.equal(run.status, "PROTECTION_INCOMPLETE");
  assert.equal(run.protection.takeProfit1.status, "NEW");
  assert.equal(run.protection.stop.status, "NEW");
  assert.deepEqual(client.calls.placeAlgo.map(x=>x.role), ["stop", "tp1"]);
  const count = store.audit.length;
  for (let i=0;i<10;i++) await executor.ensureProtection(run, 0.0012);
  assert.equal(store.audit.length, count, "no repeated failure or stop confirmation audit during backoff");
  time.now += 30_000;
  await executor.ensureProtection(run, 0.0012);
  assert.equal(run.status, "OPEN_PROTECTED");
  assert.equal(run.protection.takeProfit2.clientAlgoId, run.plan.clientIds.takeProfit2 + "-r1");
  assert.equal(run.protection.takeProfit2.triggerPrice, Number(run.plan.prices.takeProfit2));
  assert.equal(run.protection.takeProfit1.quantity, 0.0006);
  assert.equal(JSON.stringify(run.plan), before);
  assert.equal(run.planHash, planHash);
  assert.equal(client.calls.cancelAlgo.length, 0);
  const restarted = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => time.now });
  const restored = await store.getExecutionRun(run.id);
  const queried = await restarted.queryKnownProtection(restored);
  assert.equal(queried.takeProfit2.clientAlgoId, run.plan.clientIds.takeProfit2 + "-r1");
  await store.saveExecutionRun(restored);
  client.account.openAlgoOrders=[...client.algos.values()].filter(order=>order.status==="NEW");
  const reconciled=await restarted.reconcileAll();
  assert.equal(reconciled.length,1);
  assert.equal(reconciled[0].status,"OPEN_PROTECTED");
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"),null);
  await restarted.ensureProtection(restored, 0.0012);
  assert.equal(client.calls.placeAlgo.length, 3);
});

test("OPEN_PROTECTED后TP终态失效也进入有限恢复，未成交腿不互相阻断",async()=>{
  for(const [role,status] of [["takeProfit1","REJECTED"],["takeProfit2","CANCELED"]]){
    const {time,client,executor,run}=await tpRecoveryFixture();
    await executor.ensureProtection(run,0.0012);
    assert.equal(run.status,"OPEN_PROTECTED");
    const before=client.calls.placeAlgo.length,plan=JSON.stringify(run.plan),hash=run.planHash;
    const id=run.plan.clientIds[role];
    client.algos.set(id,{...client.algos.get(id),status,actualQuantity:0});
    Object.assign(run,await executor.reconcile(run.id));
    assert.equal(run.status,"PROTECTION_INCOMPLETE",`${role} must leave OPEN_PROTECTED when terminal`);
    assert.equal(run.protection.tpRecovery[role].reason,"TERMINAL_"+status);
    assert.equal(client.calls.placeAlgo.length,before,"backoff before replacement");
    time.now+=30_000;Object.assign(run,await executor.reconcile(run.id));
    assert.equal(run.status,"OPEN_PROTECTED");
    assert.equal(run.protection[role].clientAlgoId,id+"-r1");
    assert.equal(client.calls.placeAlgo.length,before+1);
    assert.equal(client.calls.cancelAlgo.length,0);
    assert.equal(client.calls.placeAlgo.filter(x=>x.role==='stop').length,1);
    assert.equal(JSON.stringify(run.plan),plan);
    assert.equal(run.planHash,hash);
  }
});

test("TP1明确-2021拒绝后有界退避重试，保留SL与已活动TP2", async () => {
  const { time, client, executor, run } = await tpRecoveryFixture();
  const original = client.placeTakeProfitClose.bind(client);
  let attempts = 0;
  client.placeTakeProfitClose = async req => {
    if (req.quantity !== null && req.quantity !== undefined) {
      attempts++;
      throw new BinanceApiError({status:400,code:-2021,message:"Order would immediately trigger."});
    }
    return original(req);
  };
  await executor.ensureProtection(run, 0.0012);
  assert.equal(attempts, 1);
  assert.equal(run.protection.takeProfit2.status, "NEW");
  for(let i=0;i<8;i++) {time.now += 300_000; await executor.ensureProtection(run,0.0012);}
  assert.equal(attempts, 4, "one original plus three replacement attempts");
  assert.equal(run.protection.tpRecovery.takeProfit1.replacements,3);
  assert.equal(run.protection.tpRecovery.takeProfit1.reason,"RETRY_LIMIT_REACHED");
  assert.equal(client.calls.cancelAlgo.length,0);
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='stop').length,1);
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp2').length,1);
});

test("TP未知提交在重启后只查同ID，迟到订单被认领且不盲重发", async () => {
  const { time, store, client, executor, run } = await tpRecoveryFixture();
  const original = client.placeTakeProfitClose.bind(client);
  let attempts = 0;
  client.placeTakeProfitClose = async req => {
    if (req.quantity === null) {attempts++; throw new Error("socket timeout");}
    return original(req);
  };
  await executor.ensureProtection(run,0.0012);
  assert.equal(run.protection.takeProfit1.status,"NEW");
  assert.equal(run.protection.tpRecovery.takeProfit2.pending,true);
  const restarted = new TestnetCanaryExecutor({client,store,enabled:true,now:()=>time.now});
  const restored = await store.getExecutionRun(run.id);
  for(let i=0;i<4;i++){time.now+=300_000; await restarted.ensureProtection(restored,0.0012);}
  assert.equal(attempts,1);
  assert.equal(restored.protection.tpRecovery.takeProfit2.replacements,0);
  client.algos.set(run.plan.clientIds.takeProfit2,{symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId:run.plan.clientIds.takeProfit2,algoId:"late",status:"NEW"});
  await restarted.ensureProtection(restored,0.0012);
  assert.equal(restored.status,"OPEN_PROTECTED");
  assert.equal(attempts,1);
});

test("TP1部分成交或FINISHED不得补发，拒绝TP2仍可独立恢复", async () => {
  for(const status of ["NEW","FINISHED","CANCELED"]) {
    const { time, client, executor, run } = await tpRecoveryFixture();
    client.algos.set(run.plan.clientIds.takeProfit1,{symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId:run.plan.clientIds.takeProfit1,algoId:"partial-tp1",status,actualQuantity:0.0003,actualOrderId:"9003"});
    client.algos.set(run.plan.clientIds.takeProfit2,{symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId:run.plan.clientIds.takeProfit2,algoId:"failed-tp2",status:"REJECTED",actualQuantity:0});
    await executor.ensureProtection(run,0.0012);time.now+=30_000;
    await executor.ensureProtection(run,0.0012);
    assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp1').length,0);
    assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp2').length,1);
    assert.equal(client.calls.cancelAlgo.length,0);
  }
});

test("恢复ID的成交和旧订单均归属本run，无仓时只清理不恢复", async () => {
  const { time, client, executor, run } = await tpRecoveryFixture();
  client.algos.set(run.plan.clientIds.takeProfit2,{symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId:run.plan.clientIds.takeProfit2,algoId:"old-tp2",status:"REJECTED",actualQuantity:0});
  await executor.ensureProtection(run,0.0012);time.now+=30_000;
  await executor.ensureProtection(run,0.0012);
  const replacement = run.protection.tpRecovery.takeProfit2.currentClientId;
  client.algos.set(replacement,{...client.algos.get(replacement),status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9004"});
  const protection = await executor.queryKnownProtection(run);
  run.protection={...run.protection,...protection};
  client.listUserTrades=async()=>[
    {id:"101",orderId:"9006",symbol:'BTCUSDT',quantity:0.0012,side:"BUY",price:85000,commission:0,commissionAsset:'USDT',realizedPnl:0,time:run.entryOrder.createdTime},
    {id:"102",orderId:"9004",symbol:'BTCUSDT',quantity:0.0012,side:"SELL",price:89000,commission:0,commissionAsset:'USDT',realizedPnl:4.8,time:time.now},
    {id:"foreign",orderId:"external",commission:999,realizedPnl:999},
  ];
  const accounting = await executor.collectRunTrades(run);
  assert.equal(accounting.accountingComplete,true);
  assert.deepEqual(accounting.trades.map(x=>x.id),["101","102"]);
  assert.equal(executor.buildRunResult(accounting,run).exitRole,"takeProfit2");
  const before=client.calls.placeAlgo.length;
  client.account.positions=[];
  await executor.reconcileProtected(run);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(run.status,"CLOSED");
  assert.equal(run.result.netPnl,4.8);
});

test("prepare返回真实计划依据深拷贝且reused不回填", async()=>{
  const clock=2_000_000,store=new MemoryStore(signalRecord(clock)),client=new FakeTradingClient();
  const executor=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});
  const prepared=await executor.prepare("btc-signal-exec");
  assert.equal(prepared.sourceDecisionRecord.trade.entryPrice,Number(prepared.run.plan.prices.entry));
  prepared.sourceDecisionRecord.trade.entryPrice=1;
  assert.equal(store.signal.trade.entryPrice,85000);
  assert.equal(prepared.run.plan.prices.entry,"85000.0");
  const reused=await executor.prepare("btc-signal-exec");
  assert.equal(reused.reused,true);
  assert.equal(reused.sourceDecisionRecord,undefined);
});

test("FINISHED缺成交量及取消单缺成交量不自动补腿，保留止损", async()=>{
  for(const status of ["FINISHED","CANCELED","EXPIRED"]) {
    const {time,client,executor,run}=await tpRecoveryFixture();
    client.algos.set(run.plan.clientIds.takeProfit2,{symbol:run.symbol,side:run.plan.exitSide,type:"TAKE_PROFIT_MARKET",clientAlgoId:run.plan.clientIds.takeProfit2,algoId:"uncertain-terminal",status,actualQuantity:null});
    await executor.ensureProtection(run,0.0012);time.now+=300_000;
    await executor.ensureProtection(run,0.0012);
    assert.equal(run.status,"PROTECTION_INCOMPLETE");
    assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp2').length,0);
    assert.equal(client.calls.cancelAlgo.length,0);
    if(status==='FINISHED') assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp1').length,0);
  }
});

test("TP1先成交后的BE顺序保持，下一轮独立恢复TP2且不重建TP1/原止损",async()=>{
  const {time,client,executor,run}=await tpRecoveryFixture();
  await executor.ensureProtection(run,0.0012);
  const tp1=run.plan.clientIds.takeProfit1,tp2=run.plan.clientIds.takeProfit2;
  client.algos.set(tp1,{...client.algos.get(tp1),status:"FINISHED",actualQuantity:0.0006,actualOrderId:"9003",updateTime:time.now});
  client.algos.set(tp2,{...client.algos.get(tp2),status:"REJECTED",actualQuantity:0});
  client.account.positions=[{symbol:"BTCUSDT",quantity:0.0006,positionSide:"BOTH"}];
  await executor.reconcileProtected(run);
  assert.equal(run.status,"TP1_FILLED");
  assert.equal(run.protection.breakEvenStop.status,"NEW");
  assert.equal(run.protection.breakEvenStop.triggerPrice,Number(run.plan.prices.entry));
  assert.equal(run.protection.breakEvenStop.quantity,0.0006);
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  const before=client.calls.placeAlgo.length;
  time.now+=30_000;await executor.reconcileProtected(run);
  assert.equal(run.status,"TP1_FILLED");
  assert.equal(client.calls.placeAlgo.length,before+1);
  assert.equal(run.protection.takeProfit2.status,"NEW");
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp1').length,1);
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='stop').length,2,"original SL plus BE, no restoration of canceled SL");
  assert.equal(client.calls.cancelAlgo.length,1,"only existing BE transition cancels original SL");
});

test("TP2已全量成交且仓位快照滞后时不恢复或新增TP1",async()=>{
  const {client,executor,run}=await tpRecoveryFixture();
  await executor.ensureProtection(run,0.0012);
  client.algos.set(run.plan.clientIds.takeProfit2,{...client.algos.get(run.plan.clientIds.takeProfit2),status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9005"});
  run.status="PROTECTION_INCOMPLETE";
  const before=client.calls.placeAlgo.length;
  await executor.reconcileProtected(run);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.cancelAlgo.length,0);
});

test("TP查询异常不阻断另一腿，历史缺失订单按未知保留不盲发",async()=>{
  const {client,executor,run}=await tpRecoveryFixture();
  const query=client.queryAlgoOrder.bind(client);
  client.queryAlgoOrder=async id=>{
    if(id===run.plan.clientIds.takeProfit2)throw new Error("query timeout");
    return query(id);
  };
  await executor.ensureProtection(run,0.0012);
  assert.equal(run.protection.takeProfit1.status,"NEW");
  assert.equal(run.protection.tpRecovery.takeProfit2.reason,"QUERY_UNKNOWN");
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp2').length,0);
  assert.equal(client.calls.cancelAlgo.length,0);
  const legacy=structuredClone(run);delete legacy.protection.tpRecovery;
  legacy.protection.takeProfit1=null;
  client.algos.delete(run.plan.clientIds.takeProfit1);
  client.queryAlgoOrder=query;
  const before=client.calls.placeAlgo.length;
  await executor.ensureProtection(legacy,0.0012);
  assert.equal(legacy.protection.tpRecovery.takeProfit1.reason,"SUBMISSION_UNKNOWN_QUERY_ONLY");
  assert.equal(client.calls.placeAlgo.length,before);
});

test("统计成交证据UNKNOWN不改变正常成交准入、保护请求顺序或状态迁移", async () => {
  const groups = [];
  for (const confirmed of [true, false]) {
    const clock = 2_000_000;
    const store = new MemoryStore(signalRecord(clock));
    const client = new FakeTradingClient();
    const requests = [];
    for (const method of ["placeStopClose", "placeTakeProfitClose"]) {
      const original = client[method].bind(client);
      client[method] = async (request) => {
        requests.push({ method, request: structuredClone(request) });
        return original(request);
      };
    }
    const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
    const transitions = [];
    executor.on("execution", run => transitions.push(run.status));
    const prepared = await executor.prepare("btc-signal-exec");
    let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
    client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, updateTime: clock,
      averagePrice: confirmed ? 85000 : null, cumulativeQuote: confirmed ? 102 : null };
    client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH", markPrice: 85000 }];
    run = await executor.reconcile(run.id);
    assert.equal(run.executionMetrics.entryFactStatus, confirmed ? "CONFIRMED" : "UNKNOWN");
    assert.equal(run.executionMetrics.fillAccepted, true);
    assert.equal(run.executionMetrics.fillRatio, 1);
    assert.equal(run.status, "OPEN_PROTECTED");
    assert.deepEqual(client.calls.placeAlgo.map(o => o.role), ["stop", "tp2", "tp1"]);
    assert.equal(client.calls.placeEntry, 1);
    assert.equal(client.calls.cancelEntry, 0);
    const entryRequest = structuredClone(client.calls.lastEntryRequest);
    const fillAccepted = run.executionMetrics.fillAccepted;
    // A second protection reconciliation must also remain equivalent; UNKNOWN
    // cannot silently freeze new protection or initiate an emergency close.
    run = await executor.reconcile(run.id);
    assert.equal(run.status, "OPEN_PROTECTED");
    assert.equal(run.executionMetrics.entryFactStatus, confirmed ? "CONFIRMED" : "UNKNOWN");
    assert.equal(await store.getMetadata("testnet_execution_emergency_stop"), null);
    groups.push({ transitions, requests, entryRequest, fillAccepted,
      fillRatio: run.executionMetrics.fillRatio, eligible: run.performanceEligible,
      exception: run.executionException, protection: run.protection, calls: client.calls });
  }
  assert.deepEqual(groups[0], groups[1]);
});

test("结算逐笔观察乱序部分退出成交，虚拟TP价格不参与极值", async () => {
  const results = [];
  for (const reversed of [false, true]) {
    const clock = 2_000_000;
    const store = new MemoryStore(signalRecord(clock));
    const client = new FakeTradingClient();
    const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
    const prepared = await executor.prepare("btc-signal-exec");
    let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
    client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000, updateTime: clock };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
    run = await executor.reconcile(run.id);
    for (const [role, id] of [["takeProfit1", "9007"], ["takeProfit2", "9008"]]) {
      const key = run.plan.clientIds[role];
      client.algos.set(key, { ...client.algos.get(key), status: "FINISHED", actualQuantity: 0.0006, actualOrderId: id });
    }
    const rows = [
      { id: "101", orderId: "1", symbol: 'BTCUSDT', side: "BUY", price: 85000, quantity: 0.0012, time: clock, commission: 0, commissionAsset: 'USDT', realizedPnl: 0 },
      { id: "102", orderId: "9007", symbol: 'BTCUSDT', side: "SELL", price: 87000, quantity: 0.0003, time: clock + 100, commission: 0, commissionAsset: 'USDT', realizedPnl: 0 },
      { id: "103", orderId: "9007", symbol: 'BTCUSDT', side: "SELL", price: 84500, quantity: 0.0003, time: clock + 200, commission: 0, commissionAsset: 'USDT', realizedPnl: 0 },
      { id: "104", orderId: "9008", symbol: 'BTCUSDT', side: "SELL", price: 88000, quantity: 0.0006, time: clock + 300, commission: 0, commissionAsset: 'USDT', realizedPnl: 0 },
    ];
    client.listUserTrades = async () => reversed ? [...rows].reverse() : rows;
    executor.now = () => clock + 300;
    client.account.positions = [];
    run = await executor.reconcile(run.id);
    assert.equal(run.status, "CLOSED");
    assert.equal(run.performance.observedPriceHigh, 88000);
    assert.equal(run.performance.observedPriceLow, 84500);
    assert.equal(run.performance.timeToMfeMs, 300);
    assert.equal(run.performance.timeToMaeMs, 200);
    assert.equal(run.performance.closedAt, clock + 300);
    assert.equal(run.performance.maeBeforeTp1R, null);
    results.push(run.performance);
  }
  assert.deepEqual(results[0], results[1]);
});

test("低于95%的部分成交立即撤余单、建立保护、排除绩效并受控平仓", async () => {
  let clock = 3_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "PARTIALLY_FILLED", executedQuantity: 0.0007, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0007, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "ENTRY_FILL_BELOW_MINIMUM");
  assert.ok(run.executionMetrics.fillRatio < 0.95);
  assert.equal(run.protection.mode, "SINGLE_TARGET");
  assert.deepEqual(client.calls.placeAlgo.map((item) => item.role), ["stop", "tp2"]);
  assert.equal(client.calls.closeMarket, 1);
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
});

test("未成交限价到期后撤单并结束，不会建立保护单", async () => {
  let clock = 3_500_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  clock = run.plan.expiresAt + 1;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_NOT_FILLED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.placeAlgo.length, 0);
});

test("TP1 成交后撤销原止损并把剩余仓位止损移动到保本", async () => {
  let clock = 3_700_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0006, positionSide: "BOTH" }];
  const tp1Id = run.plan.clientIds.takeProfit1;
  client.algos.set(tp1Id, { ...client.algos.get(tp1Id), status: "FINISHED", actualQuantity: 0.0006, actualOrderId: '9020', actualPrice: 87_000 });
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "TP1_FILLED");
  assert.equal(run.protection.breakEvenStop.triggerPrice, 85_000);
  assert.equal(run.protection.breakEvenStop.closePosition, false);
  assert.equal(run.protection.breakEvenStop.quantity, 0.0006);
  assert.ok(client.calls.cancelAlgo.includes(run.plan.clientIds.stop));
  assert.equal(client.calls.placeAlgo.at(-1).clientAlgoId, run.plan.clientIds.breakEvenStop);
  assert.ok(
    client.calls.sequence.indexOf(`place:${run.plan.clientIds.breakEvenStop}`)
      < client.calls.sequence.indexOf(`cancel:${run.plan.clientIds.stop}`),
    "必须先确认保本止损，再撤销原止损",
  );
});

test("TEAM016初始保护不能只凭NEW把错方向订单当作全仓止损",async()=>{
  const {client,executor,run}=await tpRecoveryFixture();
  const sl=run.plan.clientIds.stop;
  client.algos.set(sl,{symbol:run.symbol,clientAlgoId:sl,algoId:"1",status:"NEW",side:"BUY",type:"STOP_MARKET",closePosition:true});
  await executor.ensureProtection(run,0.0012);
  assert.notEqual(run.status,"OPEN_PROTECTED");
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp1'||x.role==='tp2').length,0);
});

test("TEAM016无效账户在prepare/execute/clear/cleanup入口均失败关闭，零仓缺side也不放行",async()=>{
  const bad=[{}, {environment:"TESTNET",authority:"BINANCE_TESTNET",positionMode:"ONE_WAY",positions:[],openOrders:[]}];
  for(const quantity of [0,0.0012])for(const side of [undefined,null,"LONG","SHORT",5,{}]){
    const p={symbol:"BTCUSDT",quantity};if(side!==undefined)p.positionSide=side;
    bad.push({environment:"TESTNET",authority:"BINANCE_TESTNET",positionMode:"ONE_WAY",positions:[p],openOrders:[],openAlgoOrders:[]});
  }
  for(const snapshot of bad){
    const {client,executor,run,store}=await tpRecoveryFixture();
    await executor.ensureProtection(run,0.0012);
    const original=client.fetchAccountState.bind(client);
    await store.setMetadata("testnet_execution_emergency_stop",{active:true,reason:"fixture existing hold"});
    let metadataWrites=0;const write=store.setMetadata.bind(store);store.setMetadata=async(...args)=>{metadataWrites++;return write(...args);};
    client.fetchAccountState=async()=>structuredClone(snapshot);
    await assert.rejects(()=>executor.clearEmergencyStop(),/不能解除/);
    await executor.reconcileProtected(run);
    assert.equal(run.status,"PROTECTION_INCOMPLETE");
    assert.equal(client.calls.cancelAlgo.length,0);
    assert.equal(metadataWrites,0);
    assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active,true);
    client.fetchAccountState=original;
    const freshStore=new MemoryStore(signalRecord(3_000_000)),freshClient=new FakeTradingClient();
    const fresh=new TestnetCanaryExecutor({client:freshClient,store:freshStore,enabled:true,now:()=>3_000_000});
    const prepared=await fresh.prepare("fixture-entry");
    freshClient.fetchAccountState=async()=>structuredClone(snapshot);
    await assert.rejects(()=>fresh.execute(prepared.run.id,prepared.confirmationCode));
    await assert.rejects(()=>fresh.prepare("another-entry"));
    assert.equal(freshClient.calls.placeEntry,0);
  }
});

test("TEAM016止损提交未知跨重启只查原ID，迟到合法保护才继续，不盲重发或误平",async()=>{
  const {client,executor,run,store,time}=await tpRecoveryFixture();
  let attempts=0;
  client.placeStopClose=async()=>{attempts++;throw Error('fixture network timeout');};
  await executor.ensureProtection(run,0.0012);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(client.calls.closeMarket??0,0);
  const restored=await store.getExecutionRun(run.id);
  const restarted=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>time.now});
  await restarted.ensureProtection(restored,0.0012);
  assert.equal(attempts,1);
  const id=run.plan.clientIds.stop;
  client.algos.set(id,{symbol:run.symbol,clientAlgoId:id,algoId:"111",side:run.plan.exitSide,type:"STOP_MARKET",status:"NEW",closePosition:true});
  await restarted.ensureProtection(restored,0.0012);
  assert.equal(restored.status,"OPEN_PROTECTED");
  assert.equal(attempts,1);
});

test("TEAM016首次SL明确拒绝保留既有无保护应急，未知结果仅查原ID直到终态证实",async()=>{
  for(const code of [-1111,-2010,-2019,-2021,-2022,-4003]){
    const {client,executor,run}=await tpRecoveryFixture();
    client.placeStopClose=async()=>{throw new BinanceApiError({status:400,code,message:"fixture rejection"});};
    await executor.ensureProtection(run,0.0012);
    assert.equal(run.executionException,"UNPROTECTED_POSITION_AUTO_CLOSE",String(code));
    assert.ok(client.calls.closeMarket>0,String(code));
  }
  const {client,executor,run}=await tpRecoveryFixture();let attempts=0;
  client.placeStopClose=async()=>{attempts++;throw new BinanceApiError({status:503,code:-1007,message:"fixture unknown"});};
  for(let i=0;i<3;i++)await executor.ensureProtection(run,0.0012);
  assert.equal(attempts,1);assert.equal(client.calls.closeMarket??0,0);
  const clientAlgoId=run.plan.clientIds.stop;
  client.algos.set(clientAlgoId,{clientAlgoId,symbol:run.symbol,side:run.plan.exitSide,type:"STOP_MARKET",status:"REJECTED"});
  await executor.ensureProtection(run,0.0012);
  assert.equal(attempts,1);assert.ok(client.calls.closeMarket>0);
});

test("TEAM016初始SL查询未知不得由缓存认定无保护，批量与启动恢复保留冻结",async()=>{
  const {client,executor,run,store,time}=await tpRecoveryFixture();
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  await executor.ensureProtection(run,0.0012);
  const query=client.queryAlgoOrder.bind(client),before=client.calls.placeAlgo.length;
  client.queryAlgoOrder=async id=>{if(id===run.plan.clientIds.stop)throw Error("fixture empty or unavailable response is unknown");return query(id);};
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(client.calls.closeMarket??0,0);
  assert.equal(client.calls.cancelAlgo.length,0);
  client.fetchAccountOverview=async()=>({});
  const restarted=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>time.now,logger:{error(){}}});
  await restarted.start();restarted.stop();
  assert.equal((await store.getExecutionRun(run.id)).status,"PROTECTION_INCOMPLETE");
  assert.match(restarted.lastReconcileError.message,/字段未确认/);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM016空提交响应仍为未知，批量账户失败不能覆盖平仓与账务生命周期",async()=>{
  const {client,executor,run,store}=await tpRecoveryFixture();let attempts=0;
  client.placeStopClose=async()=>{attempts++;return null;};
  await executor.ensureProtection(run,0.0012);await executor.ensureProtection(run,0.0012);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(attempts,1);assert.equal(client.calls.closeMarket??0,0);
  client.fetchAccountOverview=async()=>({});
  for(const status of ["OPERATOR_CLOSE_SUBMITTING","OPERATOR_CLOSE_PENDING","OPERATOR_CLOSE_UNKNOWN","ACCOUNTING_PENDING","PROTECTION_CLEANUP_PENDING","ERROR_UNPROTECTED"]){
    run.status=status;await store.saveExecutionRun(run);
    await executor.reconcileAll();
    assert.equal((await store.getExecutionRun(run.id)).status,status);
  }
});

test("TEAM016 TP成交响应先验身份：错误ID/标的/类型/方向不能触发BE或写历史",async()=>{
  for(const change of [{clientAlgoId:"foreign"},{clientAlgoId:undefined},{symbol:"ETHUSDT"},{type:"STOP_MARKET"},{side:"BUY"},{positionSide:"LONG"}]){
    for(const recovery of [true,false]){
      const {client,executor,run}=await tpRecoveryFixture();
      await executor.ensureProtection(run,0.0012);
      const key="takeProfit1",id=run.plan.clientIds[key];
      const bad={...client.algos.get(id),status:"FINISHED",actualQuantity:0.0006,actualOrderId:"foreign-child",...change};
      if(recovery){run.protection.tpRecovery[key].ids.push(id+"-r1");run.protection.tpRecovery[key].currentClientId=id+"-r1";}
      else delete run.protection.tpRecovery[key];
      const query=client.queryAlgoOrder.bind(client);
      client.queryAlgoOrder=async value=>value===id?structuredClone(bad):query(value);
      const facts=await executor.queryKnownProtection(run);
      assert.equal(facts.takeProfit1,null,JSON.stringify(change));
      assert.equal(Object.keys(run.protection).some(x=>x.startsWith("tpHistory_takeProfit1_")),false);
      await executor.reconcileProtected(run);
      assert.notEqual(run.status,"TP1_FILLED");
      assert.equal(client.calls.placeAlgo.filter(x=>x.clientAlgoId===run.plan.clientIds.breakEvenStop).length,0);
      assert.equal(client.calls.cancelAlgo.length,0);
    }
    const {client,executor,run}=await tpRecoveryFixture();
    const state=executor.takeProfitRecovery(run,"takeProfit1");
    const bad={symbol:run.symbol,type:"TAKE_PROFIT_MARKET",side:run.plan.exitSide,clientAlgoId:state.currentClientId,
      status:"FINISHED",actualQuantity:0.0006,actualOrderId:"foreign-child",...change};
    assert.equal(await executor.ensureTakeProfit(run,"takeProfit1",async()=>bad),false);
    assert.equal(run.protection.takeProfit1,null);
    assert.equal(state.pending,true);
    assert.equal(state.reason,"ORDER_IDENTITY_INVALID");
  }
});

test("TEAM015 TP1后入场事实补查不能回到INITIAL误判已取消旧SL",async()=>{
  const {client,executor,run,store}=await tpRecoveryFixture();
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  await executor.ensureProtection(run,0.0012);
  const tp1=run.plan.clientIds.takeProfit1;
  client.algos.set(tp1,{...client.algos.get(tp1),status:"FINISHED",actualQuantity:0.0006,actualOrderId:"9901"});
  client.account.positions=[{symbol:run.symbol,quantity:0.0006,positionSide:"BOTH"}];
  await executor.reconcileProtected(run);
  assert.equal(run.status,"TP1_FILLED");
  assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE");
  const placements=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length;
  run.status="ENTRY_FACT_PENDING";
  await store.saveExecutionRun(run);
  const recovered=await executor.reconcile(run.id);
  assert.equal(recovered.status,"TP1_FILLED");
  assert.equal(recovered.protection.phase,"BREAKEVEN_ACTIVE");
  assert.equal(client.calls.closeMarket??0,0,"valid BE must not be mistaken for missing original SL");
  assert.equal(client.calls.placeAlgo.length,placements);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(store.audit.some(e=>e.eventType==='STOP_PROTECTION_FAILED'),false);
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"),null);
});

async function team015ManagedFixture() {
  const context=await tpRecoveryFixture();
  const {client,executor,run}=context;
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  await executor.ensureProtection(run,0.0012);
  const tp1=run.plan.clientIds.takeProfit1;
  client.algos.set(tp1,{...client.algos.get(tp1),status:"FINISHED",actualQuantity:0.0006,actualOrderId:"9901"});
  client.account.positions=[{symbol:run.symbol,quantity:0.0006,positionSide:"BOTH"}];
  await executor.reconcileProtected(run);
  assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE");
  return context;
}

test("TEAM015 QA反例：保护查询失败后TP1暂空，当前有效BE保持管理且不回INITIAL",async()=>{
  const {client,executor,run,store}=await team015ManagedFixture();
  const query=client.queryAlgoOrder.bind(client),before=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length;
  client.queryAlgoOrder=async id=>{if(id===run.plan.clientIds.breakEvenStop)throw Error('protection timeout');return query(id);};
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE");
  client.queryAlgoOrder=async id=>id===run.plan.clientIds.takeProfit1?null:query(id);
  await executor.reconcileProtected(run);
  assert.equal(run.status,"TP1_FILLED");
  assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE");
  assert.equal(client.calls.closeMarket??0,0);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(store.audit.some(e=>e.eventType==='STOP_PROTECTION_FAILED'),false);
});

test("TEAM015 QA阻断：TP1暂空且BE有效时，失败TP2仍退避恢复并保持阻断",async()=>{
  const {client,executor,run,store,time}=await team015ManagedFixture();
  const query=client.queryAlgoOrder.bind(client),tp1=run.plan.clientIds.takeProfit1,tp2=run.plan.clientIds.takeProfit2;
  client.queryAlgoOrder=async id=>id===tp1?null:query(id);
  client.algos.set(tp2,{...client.algos.get(tp2),status:"REJECTED",actualQuantity:0});
  const placements=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length,be=structuredClone(run.protection.breakEvenStop);
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.tpRecovery.takeProfit2.reason,"TERMINAL_REJECTED");
  assert.match(run.error,/takeProfit2/);
  assert.equal(client.calls.placeAlgo.length,placements);
  time.now+=30_000;
  await executor.reconcileProtected(run);
  assert.equal(run.status,"TP1_FILLED");
  assert.equal(run.error,null);
  assert.equal(run.protection.takeProfit2.clientAlgoId,tp2+"-r1");
  assert.equal(client.calls.placeAlgo.length,placements+1);
  assert.equal(client.calls.placeAlgo.filter(x=>x.role==='tp1').length,1);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.deepEqual(run.protection.breakEvenStop,be);
  assert.equal(client.calls.closeMarket??0,0);
  assert.equal(store.audit.some(e=>e.eventType==='STOP_PROTECTION_FAILED'),false);
});

test("TEAM015 TP1暂空时TP2连续拒绝仍有界且每次保持阻断，不以生命周期标记清空错误",async()=>{
  const {client,executor,run,time}=await team015ManagedFixture();
  const query=client.queryAlgoOrder.bind(client),tp1=run.plan.clientIds.takeProfit1,tp2=run.plan.clientIds.takeProfit2;
  client.queryAlgoOrder=async id=>id===tp1?null:query(id);
  client.algos.set(tp2,{...client.algos.get(tp2),status:"REJECTED",actualQuantity:0});
  let replacements=0;
  client.placeTakeProfitClose=async()=>{replacements++;throw new BinanceApiError({status:400,code:-2021,message:"fixture immediately trigger"});};
  const be=structuredClone(run.protection.breakEvenStop),cancels=client.calls.cancelAlgo.length;
  for(let i=0;i<8;i++){
    await executor.reconcileProtected(run);
    assert.equal(run.status,"PROTECTION_INCOMPLETE");
    assert.match(run.error,/takeProfit2/);
    time.now+=300_000;
  }
  assert.equal(replacements,3);
  assert.equal(run.protection.tpRecovery.takeProfit2.reason,"RETRY_LIMIT_REACHED");
  assert.deepEqual(run.protection.breakEvenStop,be);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM015 TP1暂空且BE未确认但旧SL有效时，不正常化完成或撤销旧SL",async()=>{
  const {client,executor,run}=await team015ManagedFixture();
  const query=client.queryAlgoOrder.bind(client),tp1=run.plan.clientIds.takeProfit1,be=run.plan.clientIds.breakEvenStop,sl=run.plan.clientIds.stop;
  client.algos.set(sl,{...client.algos.get(sl),status:"NEW"});
  client.queryAlgoOrder=async id=>id===tp1||id===be?null:query(id);
  const cancels=client.calls.cancelAlgo.length,placements=client.calls.placeAlgo.length;
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.managedRecovery.reason,"BREAK_EVEN_REQUIRES_CONFIRMATION");
  assert.equal(client.algos.get(sl).status,"NEW");
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(client.calls.placeAlgo.length,placements);
  assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM015 假空仓与入场查询超时跨轮恢复，不丢BE阶段也不按原数量重建保护",async()=>{
  const {client,executor,run,store}=await team015ManagedFixture();
  const query=client.queryOrder.bind(client),before=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length;
  client.queryOrder=async()=>{throw Error('entry lookup timeout');};
  await executor.reconcileProtected(run,{...structuredClone(client.account),positions:[]});
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE");
  assert.equal(run.protection.managedRecovery.postTp1,true);
  client.queryOrder=query;
  run.status="ENTRY_FACT_PENDING";await store.saveExecutionRun(run);
  const recovered=await executor.reconcile(run.id);
  assert.equal(recovered.status,"TP1_FILLED");
  assert.equal(recovered.protection.breakEvenStop.quantity,0.0006);
  assert.equal(recovered.entryOrder.executedQuantity,0.0012);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM015 余单恢复继续取消待撤部分，但不重建旧SL或重分TP数量",async()=>{
  const {client,executor,run,store}=await team015ManagedFixture();
  const before=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length;
  client.order={...client.order,status:"PARTIALLY_FILLED"};
  run.entryExecution={...run.entryExecution,remainderPending:true};
  await store.saveExecutionRun(run);
  const recovered=await executor.reconcile(run.id);
  assert.equal(recovered.status,"TP1_FILLED");
  assert.equal(recovered.protection.phase,"BREAKEVEN_ACTIVE");
  assert.equal(recovered.entryExecution.remainderPending,false);
  assert.equal(client.calls.cancelEntry,1);
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.cancelAlgo.length,cancels);
  assert.equal(client.calls.closeMarket??0,0);
});

test("TEAM015 当前BE查不到或账户失效时冻结，不以缓存BE误清理或误平仓",async()=>{
  for(const mode of ["missingBE","accountFailure","invalidAccount"]){
    const {client,executor,run}=await team015ManagedFixture();
    const query=client.queryAlgoOrder.bind(client),account=client.fetchAccountState.bind(client),before=client.calls.placeAlgo.length,cancels=client.calls.cancelAlgo.length;
    if(mode==='missingBE')client.queryAlgoOrder=async id=>id===run.plan.clientIds.breakEvenStop?null:query(id);
    else client.fetchAccountState=async()=>{if(mode==='accountFailure')throw Error('account timeout');return {...await account(),positions:null};};
    await executor.reconcileProtected(run);
    assert.equal(run.status,"PROTECTION_INCOMPLETE",mode);
    assert.equal(run.protection.phase,"BREAKEVEN_ACTIVE",mode);
    assert.equal(client.calls.closeMarket??0,0,mode);
    assert.equal(client.calls.placeAlgo.length,before,mode);
    assert.equal(client.calls.cancelAlgo.length,cancels,mode);
  }
});

test("TEAM015 BE数量不足或方向错误不能冒充有效保护，原SL有效时不得取消",async()=>{
  for(const keepOriginal of [true,false])for(const mode of ["quantity","direction"]){
    const {client,executor,run,store}=await team015ManagedFixture();
    const beId=run.plan.clientIds.breakEvenStop,slId=run.plan.clientIds.stop;
    client.algos.set(beId,{...client.algos.get(beId),...(mode==='quantity'?{quantity:0.0002}:{side:"BUY"})});
    if(keepOriginal)client.algos.set(slId,{...client.algos.get(slId),status:"NEW"});
    await executor.reconcileProtected(run);
    assert.notEqual(run.status,"TP1_FILLED");
    if(keepOriginal){assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(client.algos.get(slId).status,"NEW");assert.equal(client.calls.closeMarket??0,0);}
    else if(mode==="quantity"){assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active,true);assert.equal(client.calls.closeMarket,1);}
    else {assert.equal(run.status,"PROTECTION_INCOMPLETE");assert.equal(await executor.isEmergencyStopped(),false);assert.equal(client.calls.closeMarket??0,0);}
  }
});

test("TEAM015 BE初次确认数量不足不得撤原SL，直接INITIAL重入也被拒绝",async()=>{
  const {client,executor,run}=await tpRecoveryFixture();
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  await executor.ensureProtection(run,0.0012);
  const tp1=run.plan.clientIds.takeProfit1;
  client.algos.set(tp1,{...client.algos.get(tp1),status:"FINISHED",actualQuantity:0.0006,actualOrderId:"9901"});
  client.account.positions=[{symbol:run.symbol,quantity:0.0006,positionSide:"BOTH"}];
  const place=client.placeStopClose.bind(client);
  client.placeStopClose=async request=>place({...request,quantity:0.0002});
  await executor.reconcileProtected(run);
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(run.protection.phase,"BREAKEVEN_PENDING");
  assert.equal(client.algos.get(run.plan.clientIds.stop).status,"NEW");
  assert.equal(client.calls.cancelAlgo.length,0);
  const before=client.calls.placeAlgo.length;
  await executor.ensureProtection(run,0.0012);
  assert.equal(run.protection.phase,"BREAKEVEN_PENDING");
  assert.equal(client.calls.placeAlgo.length,before);
  assert.equal(client.calls.closeMarket??0,0);
});

test("保本止损创建失败时保留原止损，不产生无保护窗口", async () => {
  let clock = 3_800_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0006, positionSide: "BOTH" }];
  const tp1Id = run.plan.clientIds.takeProfit1;
  client.algos.set(tp1Id, { ...client.algos.get(tp1Id), status: "FINISHED", actualQuantity: 0.0006, actualOrderId: '9020', actualPrice: 87_000 });
  client.failBreakEven = true;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "PROTECTION_INCOMPLETE");
  assert.equal(client.algos.get(run.plan.clientIds.stop).status, "NEW");
  assert.equal(client.calls.cancelAlgo.includes(run.plan.clientIds.stop), false);
  const failedAttempts = client.calls.placeAlgo.filter((item) => item.clientAlgoId === run.plan.clientIds.breakEvenStop).length;
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.placeAlgo.filter((item) => item.clientAlgoId === run.plan.clientIds.breakEvenStop).length, failedAttempts);
  assert.equal(store.audit.filter((event) => event.eventType === "BREAKEVEN_STOP_FAILED").length, 1);

  run = await executor.closeExecutionRun(run.id, "V1切换至V2前需要结束现有Demo仓位，因此在原止损仍有效时主动平仓。");
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
});

test("进程重启后只按客户端订单号恢复，不会再次提交入场单", async () => {
  let clock = 3_900_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const firstExecutor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await firstExecutor.prepare("btc-signal-exec");
  const pending = await firstExecutor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(pending.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  const restartedExecutor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const recovered = await restartedExecutor.reconcileAll();
  assert.equal(recovered[0].status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
});

test("TEAM020提交意图后的查询异常保留活动未知状态，ACK异常保留事实恢复且不重复POST", async () => {
  for(const branch of ["initial-query","post-and-query","ack-audit"]){
    const clock=4_000_000,store=new MemoryStore(signalRecord(clock)),client=new FakeTradingClient();
    const executor=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});
    const prepared=await executor.prepare("btc-signal-exec"),query=client.queryOrder.bind(client);let reads=0;
    if(branch==="initial-query")client.queryOrder=async()=>{throw Error("fixture initial lookup timeout");};
    if(branch==="post-and-query"){client.failEntryUnknown=true;client.queryOrder=async()=>{if(++reads===1)return null;throw Error("fixture recovery lookup timeout");};}
    if(branch==="ack-audit"){const append=store.appendExecutionAudit.bind(store);store.appendExecutionAudit=async(...args)=>{if(args[1]==="ENTRY_ORDER_CONFIRMED")throw Error("fixture ack audit failure");return append(...args);};}
    let run;try{run=await executor.execute(prepared.run.id,prepared.confirmationCode);}catch{run=await store.getExecutionRun(prepared.run.id);}
    assert.equal(run.status,branch==="ack-audit"?"ENTRY_FACT_PENDING":"SUBMISSION_UNKNOWN",branch);
    assert.notEqual(run.result?.filledQuantity,0);assert.notEqual(run.executionException,"PRE_ENTRY_CONFIGURATION_FAILED");
    assert.ok((await store.listActiveExecutionRuns()).some(r=>r.id===run.id));assert.equal(run.plan.clientIds.entry,prepared.run.plan.clientIds.entry);
    const posts=client.calls.placeEntry;client.queryOrder=query;
    const restarted=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});await restarted.reconcileAll();assert.equal(client.calls.placeEntry,posts,branch);
  }
});
test("TEAM020真正前置配置失败仍可无成交终结，已确认成交后异常仍保留风险保护", async () => {
  for(const filled of [false,true]){
    const clock=4_000_000,store=new MemoryStore(signalRecord(clock)),client=new FakeTradingClient();
    const executor=new TestnetCanaryExecutor({client,store,enabled:true,now:()=>clock});const p=await executor.prepare("btc-signal-exec");
    if(!filled)client.setMarginType=async()=>{throw new BinanceApiError({status:400,code:-4000,message:"fixture definite config rejection"});};
    else {client.fillEntryImmediately=true;const append=store.appendExecutionAudit.bind(store);store.appendExecutionAudit=async(...args)=>{if(args[1]==="ENTRY_ORDER_CONFIRMED")throw Error("fixture filled ack audit failure");return append(...args);};}
    await assert.rejects(executor.execute(p.run.id,p.confirmationCode));const run=await store.getExecutionRun(p.run.id);
    assert.equal(run.status,filled?"ERROR_UNPROTECTED":"FAILED");
    if(filled){assert.ok(run.entryOrder.executedQuantity>0);assert.notEqual(run.result?.filledQuantity,0);assert.equal(await executor.isEmergencyStopped(),true);}
    else {assert.equal(run.result.reason,"PRE_ENTRY_CONFIGURATION_FAILED");assert.equal(run.result.filledQuantity,0);assert.equal(client.calls.placeEntry,0);}
  }
});
test("入场请求超时且交易所持续查不到订单时隔离冲突且绝不盲目重试", async () => {
  let clock = 4_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.failEntryUnknown = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  assert.equal(client.calls.placeEntry, 1);
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  assert.equal(client.calls.placeEntry, 1);
  clock += 120_001;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "ENTRY_FACT_CONFLICT");
  assert.equal(run.performanceEligible, false);
  assert.equal(run.result.netPnl, null);
  assert.equal(run.result.accountingComplete, false);
  assert.ok((await store.listActiveExecutionRuns()).some(item => item.id === run.id));
  assert.equal(client.calls.placeEntry, 1);
});

test("杠杆档位不支持10倍时预检终止且不修改账户或提交订单", async () => {
  const clock = 4_100_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.maximumLeverage = 5;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "REJECTED");
  assert.equal(run.executionException, "UNSUPPORTED_LEVERAGE");
  assert.equal(run.performanceEligible, false);
  assert.equal(client.calls.leverage.length, 0);
  assert.equal(client.calls.marginType.length, 0);
  assert.equal(client.calls.placeEntry, 0);
  assert.equal(store.audit.some((event) => event.eventType === "LEVERAGE_PRECHECK_REJECTED"), true);
});

test("Testnet配置返回-1000时先核验实际状态而不是丢弃信号", async () => {
  const clock = 4_125_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.marginTypeUnknownOnce = true;
  client.leverageUnknownOnce = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "ENTRY_PENDING");
  assert.equal(client.calls.placeEntry, 1);
  assert.equal(client.calls.marginType.length, 1);
  assert.equal(client.calls.leverage.length, 1);
  assert.equal(store.audit.some((event) => event.eventType === "MARGIN_TYPE_VERIFIED_AFTER_UNKNOWN"), true);
  assert.equal(store.audit.some((event) => event.eventType === "LEVERAGE_VERIFIED_AFTER_UNKNOWN"), true);
});

test("恢复时的配置中或无提交时间未知记录收敛为入场前失败", async () => {
  const clock = 4_150_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  const configuring = structuredClone(prepared.run);
  configuring.status = "CONFIGURING";
  await store.saveExecutionRun(configuring);
  let run = await executor.reconcile(configuring.id);
  assert.equal(run.status, "FAILED");
  assert.equal(run.result.reason, "PRE_ENTRY_CONFIGURATION_INTERRUPTED");

  const secondStore = new MemoryStore(signalRecord(clock));
  const secondExecutor = new TestnetCanaryExecutor({ client, store: secondStore, enabled: true, now: () => clock });
  const secondPrepared = await secondExecutor.prepare("btc-signal-exec");
  const unknown = structuredClone(secondPrepared.run);
  unknown.status = "SUBMISSION_UNKNOWN";
  unknown.entryExecution = null;
  await secondStore.saveExecutionRun(unknown);
  run = await secondExecutor.reconcile(unknown.id);
  assert.equal(run.status, "FAILED");
  assert.equal(run.result.reason, "PRE_ENTRY_CONFIGURATION_FAILED");
  assert.equal(client.calls.placeEntry, 0);
});

test("紧急停止后延迟出现的未知入场单会在恢复查询时立即撤销", async () => {
  let clock = 4_200_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  client.failEntryUnknown = true;
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  assert.equal(run.status, "SUBMISSION_UNKNOWN");
  await executor.engageEmergencyStop("MANUAL");
  client.order = {
    symbol: "BTCUSDT", side: "BUY", originalQuantity: 0.0012, executedQuantity: 0,
    price: 85_000, averagePrice: 0, clientOrderId: run.plan.clientIds.entry, orderId: "9009", status: "NEW",
  };
  run = await executor.reconcile(run.id);
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(run.status, "CANCELED");
  assert.equal(run.result.reason, "ENTRY_NOT_FILLED");
});

test("过期待确认计划自动取消并释放唯一执行槽", async () => {
  let clock = 4_400_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  const first = await executor.prepare("btc-signal-exec");
  await assert.rejects(() => executor.prepare("btc-signal-second"), /已有未结束/);
  clock = first.run.plan.expiresAt + 1;
  store.signal.trade.expiresAt = clock + 120_000;
  const second = await executor.prepare("btc-signal-second");
  assert.equal((await store.getExecutionRun(first.run.id)).status, "CANCELED");
  assert.equal(second.run.status, "PREPARED");
});

test("交易所返回非活动止损时冻结新订单并自动仅减仓平仓", async () => {
  let clock = 4_600_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.algos.set(run.plan.clientIds.stop, { ...client.algos.get(run.plan.clientIds.stop), status: "CANCELED" });
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "UNPROTECTED_POSITION_AUTO_CLOSE");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, true);
});

test("止损已全量成交但仓位快照滞后时等待结算且不误触发紧急停止", async () => {
  let clock = 4_800_000;
  const store = new MemoryStore(signalRecord(clock));
  const run = protectedRun("btc-stop-settlement", "BTCUSDT", "LONG");
  store.runs.set(run.id, structuredClone(run));
  const client = new FakeTradingClient();
  client.order = structuredClone(run.entryOrder);
  const stop = algoFor(run, "stop", {
    status: "FINISHED",
    actualQuantity: 1,
    actualOrderId: "9010",
    updateTime: clock - 1_000,
  });
  const takeProfit1 = algoFor(run, "takeProfit1");
  const takeProfit2 = algoFor(run, "takeProfit2", { status: "EXPIRED" });
  for (const algo of [stop, takeProfit1, takeProfit2]) client.algos.set(algo.clientAlgoId, algo);
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 1, positionSide: "BOTH" }];
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });

  let result = await executor.reconcile(run.id);

  assert.equal(result.status, "PROTECTION_INCOMPLETE");
  assert.equal(client.calls.closeMarket ?? 0, 0);
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"), null);
  assert.equal(store.audit.at(-1).eventType, "PROTECTION_CLEANUP_BLOCKED");
  assert.equal(result.protection.cleanupVerification.reason, "stop:EXIT_SETTLEMENT_UNCONFIRMED");

  client.account.positions = [];
  clock += 15_000;
  result = await executor.reconcile(run.id);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.result.exitRole, "stop");
  assert.equal(result.performanceEligible, undefined);
  assert.equal(await store.getMetadata("testnet_execution_emergency_stop"), null);
});

test("止损创建失败会冻结新订单、排除绩效并自动仅减仓平仓", async () => {
  let clock = 5_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock, logger: { error() {} } });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  client.failStop = true;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "OPERATOR_CLOSE_PENDING");
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(client.calls.closeMarket, 1);
  assert.equal(run.performanceEligible, false);
  assert.equal(run.executionException, "UNPROTECTED_POSITION_AUTO_CLOSE");
  assert.equal(run.result.exitRole, "operatorClose");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, true);
  await assert.rejects(() => executor.prepare("another-signal"), /紧急停止/);
  await executor.clearEmergencyStop();
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, false);
});

test("存在未结束交易时关闭写入锁会拒绝启动，避免留下无人管理的仓位", async () => {
  let clock = 6_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const armed = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await armed.prepare("btc-signal-exec");
  await armed.execute(prepared.run.id, prepared.confirmationCode);
  const locked = new TestnetCanaryExecutor({ client, store, enabled: false, now: () => clock });
  await assert.rejects(() => locked.start(), /未结束的测试网执行记录/);
});

test("一笔自然平仓只清理自己的保护单且不等待其他标的清空", async () => {
  const store = new MemoryStore(signalRecord(7_000_000));
  const closed = protectedRun("btc-run", "BTCUSDT", "LONG");
  const sibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(closed.id, structuredClone(closed));
  store.runs.set(sibling.id, structuredClone(sibling));
  const client = new FakeTradingClient();
  const closedStop = algoFor(closed, "stop");
  const closedTp1 = algoFor(closed, "takeProfit1");
  const closedTp2 = algoFor(closed, "takeProfit2", {
    status: "FINISHED",
    actualQuantity: 1,
    actualOrderId: "9011",
  });
  const siblingStop = algoFor(sibling, "stop");
  for (const algo of [closedStop, closedTp1, closedTp2, siblingStop]) client.algos.set(algo.clientAlgoId, algo);
  client.order = structuredClone(closed.entryOrder);
  client.account.positions = [{ symbol: "ETHUSDT", quantity: -1, positionSide: "BOTH" }];
  client.account.openAlgoOrders = [siblingStop];
  client.externalTrades = [{ id: "manual", orderId: "manual-order", commission: 50, realizedPnl: 999, time: 9_000_300 }];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_000_000,
  });

  const result = await executor.reconcile(closed.id);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.result.accountingComplete, true);
  assert.equal(result.result.trades.some((trade) => trade.orderId === "manual-order"), false);
  assert.ok(result.result.netPnl < 10);
  assert.equal((await store.getExecutionRun(sibling.id)).status, "OPEN_PROTECTED");
  assert.ok(client.calls.cancelAlgo.includes(closed.plan.clientIds.stop));
  assert.ok(client.calls.cancelAlgo.includes(closed.plan.clientIds.takeProfit1));
  assert.equal(client.calls.cancelAlgo.includes(sibling.plan.clientIds.stop), false);
});

test("一笔完成TP1只移动自己的止损且不触碰兄弟仓位保护", async () => {
  const store = new MemoryStore(signalRecord(7_250_000));
  const btc = protectedRun("btc-run", "BTCUSDT", "LONG");
  const eth = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(btc.id, structuredClone(btc));
  store.runs.set(eth.id, structuredClone(eth));
  const client = new FakeTradingClient();
  const btcStop = algoFor(btc, "stop");
  const btcTp1 = algoFor(btc, "takeProfit1", { status: "FINISHED", actualQuantity: 0.5, actualOrderId: "9012" });
  const btcTp2 = algoFor(btc, "takeProfit2");
  const ethStop = algoFor(eth, "stop");
  for (const algo of [btcStop, btcTp1, btcTp2, ethStop]) client.algos.set(algo.clientAlgoId, algo);
  client.account.positions = [
    { symbol: "BTCUSDT", quantity: 0.5, positionSide: "BOTH" },
    { symbol: "ETHUSDT", quantity: -1, positionSide: "BOTH" },
  ];
  client.orders.set(btc.plan.clientIds.entry, btc.entryOrder);
  client.orders.set(eth.plan.clientIds.entry, eth.entryOrder);
  client.account.openAlgoOrders = [btcStop, btcTp2, ethStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_250_000,
  });

  const result = await executor.reconcile(btc.id);

  assert.equal(result.status, "TP1_FILLED");
  assert.ok(client.calls.cancelAlgo.includes(btc.plan.clientIds.stop));
  assert.equal(client.calls.cancelAlgo.includes(eth.plan.clientIds.stop), false);
  assert.equal((await store.getExecutionRun(eth.id)).status, "OPEN_PROTECTED");
});

test("全局紧急停止只撤销等待入场单并保留兄弟仓位保护", async () => {
  const store = new MemoryStore(signalRecord(7_400_000));
  const protectedSibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  const pending = protectedRun("btc-pending", "BTCUSDT", "LONG");
  pending.status = "ENTRY_PENDING";
  pending.entryOrder = {
    symbol: "BTCUSDT",
    orderId: "pending-order",
    clientOrderId: pending.plan.clientIds.entry,
    executedQuantity: 0,
    status: "NEW",
  };
  store.runs.set(protectedSibling.id, structuredClone(protectedSibling));
  store.runs.set(pending.id, structuredClone(pending));
  const client = new FakeTradingClient();
  client.order = structuredClone(pending.entryOrder);
  const siblingStop = algoFor(protectedSibling, "stop");
  client.algos.set(siblingStop.clientAlgoId, siblingStop);
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_400_000,
  });

  await executor.engageEmergencyStop("MANUAL");

  assert.equal((await store.getExecutionRun(pending.id)).status, "CANCELED");
  assert.equal((await store.getExecutionRun(protectedSibling.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.cancelEntry, 1);
  assert.equal(client.calls.cancelAlgo.length, 0);
  assert.equal(client.algos.get(siblingStop.clientAlgoId).status, "NEW");
});

test("紧急停止可在所有现有仓位均已归属且受保护时解除", async () => {
  const store = new MemoryStore(signalRecord(7_500_000));
  const sibling = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(sibling.id, structuredClone(sibling));
  store.metadata.set("testnet_execution_emergency_stop", { active: true, reason: "MANUAL" });
  const client = new FakeTradingClient();
  const siblingStop = algoFor(sibling, "stop");
  client.account.positions = [{ symbol: "ETHUSDT", quantity: -1, positionSide: "BOTH" }];
  client.account.openAlgoOrders = [siblingStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 7_500_000,
  });

  const result = await executor.clearEmergencyStop();

  assert.equal(result.active, false);
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active, false);
});

test("TEAM014首次快照漏仓但新鲜查询仍持仓时不得撤销任何保护",async()=>{
  const {client,executor,run}=await tpRecoveryFixture();
  await executor.ensureProtection(run,0.0012);
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  client.account.positions=[{symbol:run.symbol,quantity:0.0012,positionSide:"BOTH"}];
  const first={...structuredClone(client.account),positions:[]};
  const before=client.calls.cancelAlgo.length;
  await executor.reconcileProtected(run,first);
  assert.equal(client.calls.cancelAlgo.length,before,"first missing position must not authorize protective cancellation");
  assert.equal(client.algos.get(run.plan.clientIds.stop).status,"NEW");
  assert.equal(run.status,"PROTECTION_INCOMPLETE");
  assert.equal(client.calls.closeMarket??0,0);
});

async function team014ClosedFixture() {
  const context=await tpRecoveryFixture();
  const {client,executor,run}=context;
  await executor.ensureProtection(run,0.0012);
  client.order={...run.entryOrder,symbol:run.symbol,side:run.plan.entrySide,clientOrderId:run.plan.clientIds.entry};
  const tp2=run.plan.clientIds.takeProfit2;
  client.algos.set(tp2,{...client.algos.get(tp2),status:"FINISHED",actualQuantity:0.0012,actualOrderId:"9100"});
  client.account.positions=[];
  await context.store.saveExecutionRun(run);
  return context;
}

test("TEAM018真实退出恢复先刷新旧CONFLICT成交核验再结算，不二次请求成交",async()=>{
  const {run,executor,client,store,time}=await team014ClosedFixture();
  run.entryExecution={submittedAt:time.now+310};
  run.entryFactVerification={status:"ORDER_VERIFIED",fills:{status:"CONFLICT",quantity:null,count:1},history:[]};
  let queries=0;const read=client.listUserTrades.bind(client);client.listUserTrades=async(...args)=>{queries++;return read(...args);};
  await executor.reconcileProtected(run);
  assert.equal(run.status,"CLOSED");assert.equal(run.entryFactVerification.fills.status,"VERIFIED");
  assert.equal(queries,1);
  const projected=projectExecutionRun(run);assert.equal(projected.entryFactStatus,"CONFIRMED");assert.ok(Number.isFinite(projected.netR));
  const checked=store.audit.findIndex(x=>x.eventType==="ENTRY_FILLS_CHECKED"&&x.payload.status==="VERIFIED");
  const closed=store.audit.findIndex(x=>x.eventType==="CANARY_CLOSED");assert.ok(checked>=0&&checked<closed);
});

test("TEAM014完整退出事实仍需独立新鲜零仓：有仓/陈旧/未来/缺项/冲突/查询失败均保留保护",async()=>{
  for(const mode of ["position","stale","future","missingTimestamp","missingPositions","missingOrders","wrongAuthority","duplicatePosition","failure"]) {
    const {client,executor,run,time,store}=await team014ClosedFixture();
    const first={...structuredClone(client.account),syncedAt:time.now};
    client.fetchAccountState=async()=>{
      if(mode==='failure')throw Error('account timeout');
      const snapshot={...structuredClone(first),syncedAt:time.now};
      if(mode==='position')snapshot.positions=[{symbol:run.symbol,quantity:0.0012,positionSide:"BOTH"}];
      if(mode==='stale')snapshot.syncedAt=time.now-1;
      if(mode==='future')snapshot.syncedAt=time.now+1;
      if(mode==='missingTimestamp')delete snapshot.syncedAt;
      if(mode==='missingPositions')delete snapshot.positions;
      if(mode==='missingOrders')delete snapshot.openOrders;
      if(mode==='wrongAuthority')snapshot.authority="UNKNOWN";
      if(mode==='duplicatePosition')snapshot.positions=[{symbol:run.symbol,quantity:0,positionSide:"BOTH"},{symbol:run.symbol,quantity:0,positionSide:"BOTH"}];
      return snapshot;
    };
    await executor.reconcileProtected(run,first);
    assert.equal(run.status,"PROTECTION_INCOMPLETE",mode);
    assert.equal(client.calls.cancelAlgo.length,0,mode);
    assert.equal(client.algos.get(run.plan.clientIds.stop).status,"NEW",mode);
    assert.equal(client.calls.closeMarket??0,0,mode);
    assert.equal(store.audit.some(e=>e.eventType==='PROTECTION_CLEANUP_AUTHORIZED'),false,mode);
  }
});

test("TEAM014两次空仓不抵消退出证据缺失，重复/外部/超量/缺页/错误方向均不清理",async()=>{
  for(const mode of ["missing","duplicateOnly","external","overQuantity","wrongSide","queryFailure","missingPage"]) {
    const {client,executor,run,time,store}=await team014ClosedFixture();
    const rows=[
      {id:"1001",orderId:"9006",symbol:run.symbol,side:"BUY",quantity:0.0012,price:85000,commission:0,commissionAsset:"USDT",realizedPnl:0,time:time.now},
      {id:"1002",orderId:"9100",symbol:run.symbol,side:"SELL",quantity:0.0012,price:89000,commission:0,commissionAsset:"USDT",realizedPnl:4.8,time:time.now},
    ];
    if(mode==='missing')rows.pop();
    if(mode==='duplicateOnly'){rows[1].quantity=0.0006;rows.push({...rows[1]});}
    if(mode==='external')rows[1].orderId="99999";
    if(mode==='overQuantity')rows[1].quantity=0.0024;
    if(mode==='wrongSide')rows[1].side="BUY";
    client.listUserTrades=async()=>{if(mode==='queryFailure')throw Error('trades timeout');return mode==='missingPage'?null:rows;};
    await executor.reconcileProtected(run);
    await executor.reconcileProtected(run);
    assert.equal(run.status,"PROTECTION_INCOMPLETE",mode);
    assert.equal(client.calls.cancelAlgo.length,0,mode);
    assert.equal(client.algos.get(run.plan.clientIds.stop).status,"NEW",mode);
    assert.equal(store.audit.filter(e=>e.eventType==='PROTECTION_CLEANUP_BLOCKED').length,1,"same failure does not flood audit");
    // The actual coordinator's existing global hold includes this exact state.
    assert.equal((await store.listActiveExecutionRuns())[0].status,"PROTECTION_INCOMPLETE");
  }
});

test("TEAM014完整退出和独立新鲜零仓先于撤单，Funding缺失另等且不解紧急停止",async()=>{
  const {client,executor,run,store}=await team014ClosedFixture();
  await store.setMetadata("testnet_execution_emergency_stop",{active:true,reason:"EXISTING_HOLD"});
  client.listIncomeHistory=async()=>{throw Error('funding timeout');};
  const events=[];
  const originalAccount=client.fetchAccountState.bind(client),originalCancel=client.cancelAlgoOrder.bind(client),originalTrades=client.listUserTrades.bind(client);
  client.fetchAccountState=async(...args)=>{events.push("ACCOUNT");return originalAccount(...args);};
  client.listUserTrades=async(...args)=>{events.push("TRADES");return originalTrades(...args);};
  client.cancelAlgoOrder=async(...args)=>{assert.equal(run.protection.cleanupVerification.status,"CONFIRMED");events.push("CANCEL");return originalCancel(...args);};
  await executor.reconcileProtected(run);
  assert.equal(run.status,"ACCOUNTING_PENDING");
  assert.equal(run.result.netPnl,null);
  assert.equal(events.slice(0,4).join(","),"ACCOUNT,TRADES,ACCOUNT,CANCEL");
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active,true);
  client.listIncomeHistory=async()=>[];
  await executor.reconcileProtected(run);
  assert.equal(run.status,"CLOSED");
  assert.equal(run.result.accountingComplete,true);
  assert.equal((await store.getMetadata("testnet_execution_emergency_stop")).value.active,true);
});

test("仓位已关闭但成交明细尚未到达时保持对账中并在后续轮询完成", async () => {
  const clock = 8_000_000;
  const store = new MemoryStore(signalRecord(clock));
  const client = new FakeTradingClient();
  const executor = new TestnetCanaryExecutor({ client, store, enabled: true, now: () => clock });
  const prepared = await executor.prepare("btc-signal-exec");
  let run = await executor.execute(prepared.run.id, prepared.confirmationCode);
  client.order = { ...client.order, status: "FILLED", executedQuantity: 0.0012, averagePrice: 85_000 };
  client.account.positions = [{ symbol: "BTCUSDT", quantity: 0.0012, positionSide: "BOTH" }];
  run = await executor.reconcile(run.id);
  const tp2Id = run.plan.clientIds.takeProfit2;
  client.algos.set(tp2Id, { ...client.algos.get(tp2Id), status: "FINISHED", actualQuantity: 0.0012, actualOrderId: "9013" });
  client.account.positions = [];
  client.hideAlgoTrades = true;

  run = await executor.reconcile(run.id);
  // Missing exit fills cannot authorize protective cancellation, even with a zero-position snapshot.
  assert.equal(run.status, "PROTECTION_INCOMPLETE");
  assert.equal(client.algos.get(run.plan.clientIds.stop).status, "NEW");
  assert.equal(client.calls.cancelAlgo.length, 0);
  assert.equal(run.result?.netPnl ?? null, null);

  client.hideAlgoTrades = false;
  run = await executor.reconcile(run.id);
  assert.equal(run.status, "CLOSED");
  assert.equal(run.result.accountingComplete, true);
});

test("重启恢复会逐笔对账多个受保护仓位且不会重复提交入场", async () => {
  const store = new MemoryStore(signalRecord(8_500_000));
  const btc = protectedRun("btc-run", "BTCUSDT", "LONG");
  const eth = protectedRun("eth-run", "ETHUSDT", "SHORT");
  store.runs.set(btc.id, structuredClone(btc));
  store.runs.set(eth.id, structuredClone(eth));
  const client = new FakeTradingClient();
  const btcStop = algoFor(btc, "stop");
  const ethStop = algoFor(eth, "stop");
  client.algos.set(btcStop.clientAlgoId, btcStop);
  client.algos.set(ethStop.clientAlgoId, ethStop);
  client.account.positions = [
    { symbol: "BTCUSDT", quantity: 1, positionSide: "BOTH" },
    { symbol: "ETHUSDT", quantity: -1, positionSide: "BOTH" },
  ];
  client.orders.set(btc.plan.clientIds.entry, btc.entryOrder);
  client.orders.set(eth.plan.clientIds.entry, eth.entryOrder);
  client.account.openAlgoOrders = [btcStop, ethStop];
  const executor = new TestnetCanaryExecutor({
    client,
    store,
    enabled: true,
    allowedSymbols: ["BTCUSDT", "ETHUSDT"],
    now: () => 8_500_000,
  });

  await executor.start();
  executor.stop();

  assert.equal((await store.getExecutionRun(btc.id)).status, "OPEN_PROTECTED");
  assert.equal((await store.getExecutionRun(eth.id)).status, "OPEN_PROTECTED");
  assert.equal(client.calls.placeEntry, 0);
  assert.equal(client.calls.placeAlgo.length, 0);
  assert.equal(client.calls.accountOverview, 1);
});
