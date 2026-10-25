import test from "node:test";
import assert from "node:assert/strict";
import { effectivePositionStop, accountProtectionFactsKnown, hasManagedTp1Lifecycle, blocksNewExecutionEntry } from "../src/execution/protection-state.js";
import { classifyExecutionAccountState, assertAccountReadyForNewEntry } from "../src/execution/execution-account-ownership.js";
import { assessTestnetReadiness } from "../src/execution/readiness.js";
const run={id:"r",symbol:"BTCUSDT",status:"TP1_FILLED",entryOrder:{orderId:"1",executedQuantity:2},
  plan:{direction:"LONG",exitSide:"SELL",rules:{stepSize:0.1},clientIds:{stop:"sl",breakEvenStop:"be"}},protection:{phase:"BREAKEVEN_ACTIVE"}};
const position={symbol:"BTCUSDT",quantity:1,positionSide:"BOTH"};
const stop={symbol:"BTCUSDT",clientAlgoId:"be",side:"SELL",positionSide:"BOTH",type:"STOP_MARKET",status:"NEW",quantity:1,reduceOnly:true};
const account=(p=position,s=stop)=>({environment:"TESTNET",authority:"BINANCE_TESTNET",positionMode:"ONE_WAY",positions:[p],openOrders:[],openAlgoOrders:[s]});

test("TEAM016新入场共享安全阻断区别正常并行与未知风险",()=>{
  const empty={...account(),positions:[],openAlgoOrders:[]};
  const ready = active => assessTestnetReadiness({account:{...empty,enabled:true,connected:true,account:{canTrade:true}},
    gateway:{environment:"TESTNET",positionPolicy:"V2_4_3_PREMOVE_BOUNDARY_FILTER_ALL_ELIGIBLE"},credentialsConfigured:true,activeRuns:[active]});
  for(const status of ["ENTRY_FACT_PENDING","ENTRY_FACT_CONFLICT","OPERATOR_CLOSE_UNKNOWN","SUBMISSION_UNKNOWN","PROTECTION_INCOMPLETE","ERROR_UNPROTECTED"]){
    const active={...run,status};
    assert.equal(blocksNewExecutionEntry(active),true,status);
    assert.equal(ready(active).canPrepareCanary,false,status);
    assert.throws(()=>assertAccountReadyForNewEntry(empty,[active],{candidateSymbol:"ETHUSDT"}),/禁止准备新订单/,status);
  }
  for(const status of ["ENTRY_PENDING","PARTIALLY_FILLED","OPEN_PROTECTED","TP1_FILLED"]){
    const active={...run,status};
    assert.equal(blocksNewExecutionEntry(active),false,status);
    assert.equal(ready(active).canPrepareCanary,true,status);
    assert.doesNotThrow(()=>assertAccountReadyForNewEntry(empty,[active],{candidateSymbol:"ETHUSDT"}),status);
  }
});
test("TEAM016执行与归属对同一身份/类型/方向/全仓覆盖事实一致",()=>{
  assert.equal(effectivePositionStop(stop,run,position),true);
  assert.equal(classifyExecutionAccountState(account(),[run]).safe,true);
  for(const change of [{symbol:"ETHUSDT"},{clientAlgoId:"external"},{type:"TAKE_PROFIT_MARKET"},{side:"BUY"},{positionSide:"LONG"},
    {quantity:0.1},{quantity:null},{quantity:"NaN"},{reduceOnly:false},{status:"CANCELED"},{status:"FINISHED"}]){
    const candidate={...stop,...change};
    assert.equal(effectivePositionStop(candidate,run,position),false,JSON.stringify(change));
    assert.equal(classifyExecutionAccountState(account(position,candidate),[run]).safe,false,JSON.stringify(change));
  }
  assert.equal(effectivePositionStop({...stop,quantity:null,closePosition:true},run,position),true);
  assert.equal(hasManagedTp1Lifecycle({...run,status:"PROTECTION_INCOMPLETE"}),true);
});
test("TEAM016零/非零仓位缺失或错误positionSide仍未知，不冒充完整空仓",()=>{
  for(const quantity of [0,1])for(const side of [undefined,null,"LONG","SHORT",1,{}]){
    const p={...position,quantity};if(side===undefined)delete p.positionSide;else p.positionSide=side;
    assert.equal(accountProtectionFactsKnown(account(p)),false);
    assert.equal(classifyExecutionAccountState(account(p),[run]).safe,false);
    assert.throws(()=>assertAccountReadyForNewEntry(account(p),[run],{candidateSymbol:"ETHUSDT"}),/无法归属/);
  }
  for(const a of [{},null,{environment:"TESTNET",authority:"BINANCE_TESTNET",positionMode:"ONE_WAY"},account({...position,quantity:null})]){
    assert.equal(accountProtectionFactsKnown(a),false);
    assert.equal(classifyExecutionAccountState(a,[]).safe,false);
  }
});
