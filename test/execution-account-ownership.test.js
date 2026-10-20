import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAccountReadyForNewEntry,
  classifyExecutionAccountState,
} from "../src/execution/execution-account-ownership.js";

function run(id, symbol, direction = "LONG", status = "OPEN_PROTECTED") {
  return {
    id,
    symbol,
    status,
    entryOrder: status === "PREPARED" ? null : { orderId: `${id}-entry-order`, executedQuantity: 1 },
    plan: {
      direction,
      exitSide: direction === "LONG" ? "SELL" : "BUY",
      clientIds: {
        entry: `${id}-entry`,
        operatorClose: `${id}-close`,
        stop: `${id}-sl`,
        breakEvenStop: `${id}-slbe`,
        takeProfit1: `${id}-tp1`,
        takeProfit2: `${id}-tp2`,
      },
    },
  };
}

function account(overrides = {}) {
  return {
    environment: "TESTNET",
    authority: "BINANCE_TESTNET",
    positionMode: "ONE_WAY",
    positions: [],
    openOrders: [],
    openAlgoOrders: [],
    ...overrides,
  };
}

function stopFor(runValue) {
  return {
    symbol: runValue.symbol,
    clientAlgoId: runValue.plan.clientIds.stop,
    algoId: `${runValue.id}-stop-order`,
    status: "NEW",
    type: "STOP_MARKET",
    side: runValue.plan.exitSide,
    closePosition: true,
  };
}

test("本run持久化的TP恢复ID归属明确，外部同币ID及错币保持unknown",()=>{
  const btc=run("btc","BTCUSDT");
  btc.protection={tpRecovery:{takeProfit2:{ids:["btc-tp2","btc-tp2-r1"],currentClientId:"btc-tp2-r1"}}};
  const owned={symbol:"BTCUSDT",clientAlgoId:"btc-tp2-r1",status:"NEW",type:"TAKE_PROFIT_MARKET",side:"SELL"};
  const state=account({positions:[{symbol:"BTCUSDT",quantity:1}],openAlgoOrders:[stopFor(btc),owned]});
  const result=classifyExecutionAccountState(state,[btc]);
  assert.equal(result.safe,true);
  assert.equal(result.owned.algoOrders.find(x=>x.item===owned).runId,"btc");
  state.openAlgoOrders.push({...owned,clientAlgoId:"btc-tp2-r99"});
  assert.equal(classifyExecutionAccountState(state,[btc]).unknown[0].clientAlgoId,"btc-tp2-r99");
  const wrongSymbol=classifyExecutionAccountState(account({openAlgoOrders:[{...owned,symbol:"ETHUSDT"}]}),[btc]);
  assert.equal(wrongSymbol.unknown[0].kind,"ALGO_ORDER");
  btc.protection.tpRecovery.takeProfit2.currentClientId="unpersisted-current";
  assert.equal(classifyExecutionAccountState(account({openAlgoOrders:[{...owned,clientAlgoId:"unpersisted-current"}]}),[btc]).unknown.length,1);
});

test("不同run认领同一恢复ID产生冲突，不用同币归属兜底",()=>{
  const btc=run("btc","BTCUSDT"),eth=run("eth","ETHUSDT");
  for(const value of [btc,eth])value.protection={tpRecovery:{takeProfit1:{ids:["shared-r1"]}}};
  const state=account({openAlgoOrders:[{symbol:"BTCUSDT",clientAlgoId:"shared-r1",status:"NEW"}]});
  const result=classifyExecutionAccountState(state,[btc,eth]);
  assert.equal(result.safe,false);
  assert.deepEqual(result.conflicts,[{kind:"CLIENT_ALGO_ID",identity:"shared-r1",runIds:["btc","eth"]}]);
  assert.throws(()=>assertAccountReadyForNewEntry(state,[btc,eth],{candidateSymbol:"SOLUSDT"}),/冲突/);
});

test("不同标的的已归属受保护仓位允许准备下一笔", () => {
  const btc = run("btc", "BTCUSDT", "LONG");
  const eth = run("eth", "ETHUSDT", "SHORT");
  const state = account({
    positions: [
      { symbol: "BTCUSDT", quantity: 0.01 },
      { symbol: "ETHUSDT", quantity: -0.1 },
    ],
    openAlgoOrders: [stopFor(btc), stopFor(eth)],
  });
  const result = assertAccountReadyForNewEntry(state, [btc, eth], { candidateSymbol: "SOLUSDT" });
  assert.equal(result.safe, true);
  assert.equal(result.owned.positions.length, 2);
});

test("未知外部订单或无止损仓位会冻结新入场", () => {
  const btc = run("btc", "BTCUSDT", "LONG");
  const unknown = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.01 }],
    openOrders: [{ symbol: "XRPUSDT", clientOrderId: "manual-order", orderId: "42" }],
  }), [btc]);
  assert.equal(unknown.safe, false);
  assert.equal(unknown.unknown[0].kind, "ORDER");
  assert.deepEqual(unknown.missingStops, [{ runId: "btc", symbol: "BTCUSDT" }]);
  assert.throws(() => assertAccountReadyForNewEntry(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.01 }],
  }), [btc], { candidateSymbol: "SOLUSDT" }), /没有活动止损/);
});

test("数量型reduce-only保本止损只有覆盖全部剩余仓位才算有效保护", () => {
  const q = run("q", "QUSDT", "SHORT", "TP1_FILLED");
  q.entryOrder.executedQuantity = 869;
  q.plan.rules = { stepSize: 1 };
  const position = { symbol: "QUSDT", quantity: -435, marginType: "isolated" };
  const breakEven = {
    symbol: "QUSDT",
    clientAlgoId: q.plan.clientIds.breakEvenStop,
    algoId: "q-break-even",
    status: "NEW",
    type: "STOP_MARKET",
    side: "BUY",
    closePosition: false,
    reduceOnly: true,
    quantity: 435,
  };

  const protectedState = classifyExecutionAccountState(account({
    positions: [position],
    openAlgoOrders: [breakEven],
  }), [q]);
  assert.equal(protectedState.safe, true);

  const underProtected = classifyExecutionAccountState(account({
    positions: [position],
    openAlgoOrders: [{ ...breakEven, quantity: 434 }],
  }), [q]);
  assert.equal(underProtected.safe, false);
  assert.deepEqual(underProtected.missingStops, [{ runId: "q", symbol: "QUSDT" }]);
});

test("同标的活动记录、方向冲突和PREPARED前出现仓位均被拒绝", () => {
  const btc = run("btc", "BTCUSDT", "LONG");
  assert.throws(() => assertAccountReadyForNewEntry(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.01 }],
    openAlgoOrders: [stopFor(btc)],
  }), [btc], { candidateSymbol: "BTCUSDT" }), /标的 BTCUSDT 已有未结束/);

  const directionConflict = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: -0.01 }],
    openAlgoOrders: [stopFor(btc)],
  }), [btc]);
  assert.equal(directionConflict.conflicts[0].kind, "POSITION_DIRECTION");

  const prepared = run("sol", "SOLUSDT", "LONG", "PREPARED");
  const premature = classifyExecutionAccountState(account({
    positions: [{ symbol: "SOLUSDT", quantity: 1 }],
    openOrders: [{ symbol: "SOLUSDT", clientOrderId: prepared.plan.clientIds.entry, orderId: "unexpected" }],
  }), [prepared]);
  assert.equal(premature.unknown[0].kind, "POSITION");
  assert.equal(premature.unknown[1].kind, "ORDER");
});

test("非逐仓、杠杆不符或超出系统成交数量的仓位不会被冒认为系统仓位", () => {
  const btc = run("btc", "BTCUSDT", "LONG");
  btc.plan.leverage = 10;
  btc.plan.rules = { stepSize: 0.001 };
  const stop = stopFor(btc);
  const crossed = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.5, marginType: "cross", leverage: 10 }],
    openAlgoOrders: [stop],
  }), [btc]);
  assert.equal(crossed.conflicts[0].kind, "POSITION_MARGIN_MODE");

  const wrongLeverage = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.5, marginType: "isolated", leverage: 20 }],
    openAlgoOrders: [stop],
  }), [btc]);
  assert.equal(wrongLeverage.conflicts[0].kind, "POSITION_LEVERAGE");

  const leverageUnavailable = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: 0.5, marginType: "isolated", leverage: null }],
    openAlgoOrders: [stop],
  }), [btc]);
  assert.equal(leverageUnavailable.safe, true);
  assert.deepEqual(leverageUnavailable.conflicts, []);

  const oversized = classifyExecutionAccountState(account({
    positions: [{ symbol: "BTCUSDT", quantity: 1.1, marginType: "isolated", leverage: 10 }],
    openAlgoOrders: [stop],
  }), [btc]);
  assert.equal(oversized.conflicts[0].kind, "POSITION_QUANTITY");
});

test("任一入场提交结果未知时全局暂停准备新订单", () => {
  const unknown = run("unknown", "BTCUSDT", "LONG", "SUBMISSION_UNKNOWN");
  assert.throws(() => assertAccountReadyForNewEntry(account(), [unknown], { candidateSymbol: "ETHUSDT" }), /入场提交结果未知/);
});
