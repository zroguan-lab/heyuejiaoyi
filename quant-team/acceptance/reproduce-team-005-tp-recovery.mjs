// Isolated diagnostic only: fake client, memory-only store, no credentials, DB or network.
import assert from 'node:assert/strict';
import { TestnetCanaryExecutor } from '../../src/execution/testnet-canary-executor.js';

globalThis.fetch = async () => { throw new Error('NETWORK_DISABLED_IN_FIXTURE'); };
const audit = [], queries = [], placements = [];
let tp2Status = 'NEW';
const client = {
  async queryAlgoOrder(id) {
    queries.push(id);
    if (id==='fixture-sl') return {status:'NEW',algoId:'fixture-sl',side:'SELL',type:'STOP_MARKET'};
    if (id==='fixture-tp2') return {status:tp2Status,algoId:'fixture-tp2',side:'SELL',type:'TAKE_PROFIT_MARKET'};
    return null;
  },
  async placeTakeProfitClose(request) { placements.push(structuredClone(request)); throw new Error('-2021 Order would immediately trigger.'); },
  async placeStopClose() { throw new Error('Existing stop must not be placed again in this fixture'); },
};
const store = {
  async saveExecutionRun() {},
  async appendExecutionAudit(runId,eventType,payload,createdAt) { audit.push({runId,eventType,payload,createdAt}); },
};
const executor = new TestnetCanaryExecutor({client,store,enabled:false,now:()=>1_000_000});
const run = {id:'fixture-team005',symbol:'SIRENUSDT',status:'PROTECTION_INCOMPLETE',
  plan:{direction:'LONG',exitSide:'SELL',prices:{entry:'0.03493',stopLoss:'0.03414',takeProfit1:'0.03613',takeProfit2:'0.03693'},
    rules:{stepSize:1,minQuantity:1,minNotional:5},clientIds:{stop:'fixture-sl',takeProfit1:'fixture-tp1',takeProfit2:'fixture-tp2'},
    orderReasons:{stop:'Fixture stop protects the entire simulated position.',
      takeProfit1:'Fixture TP1 reduces half of the simulated position.',
      takeProfit2:'Fixture TP2 closes the remaining simulated position.'}},protection:{}};

await executor.ensureProtection(run,2862);
assert.equal(run.status,'PROTECTION_INCOMPLETE');
assert.match(run.error,/-2021/);
assert.equal(placements.length,1);
assert.equal(placements[0].clientAlgoId,'fixture-tp1');
const afterFirstAttempt = queries.length;
tp2Status='REJECTED';
await executor.ensureProtection(run,2862);
assert.equal(run.status,'PROTECTION_INCOMPLETE');
assert.match(run.error,/takeProfit2.*REJECTED/);
assert.equal(placements.length,1,'TP1 was not retried after rejected TP2 was encountered');
assert.deepEqual(queries.slice(afterFirstAttempt),['fixture-sl','fixture-tp2']);
assert.equal(audit.filter(a=>a.eventType==='TAKE_PROFIT_PROTECTION_INCOMPLETE').length,2);
console.log(JSON.stringify({status:'REPRODUCED',scope:'ISOLATED_CURRENT_SOURCE_FAKE_CLIENT_ONLY',
  firstFailure:'TP1_-2021',secondFailure:'TP2_REJECTED_BEFORE_TP1_RETRY',
  secondAttemptQueries:queries.slice(afterFirstAttempt),totalMockTPPlacementCalls:placements.length,
  implication:'Confirms current recovery control flow, not exchange rejection cause or historical opportunity PnL.'},null,2));
