import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildDecisionSnapshot } from '../src/domain/decision-snapshot.js';
import { validateVolumeConfirmation } from '../src/research/single-variable-validation.js';

const protocol=JSON.parse(readFileSync(new URL('../quant-team/research/TEAM-006-volume-confirmation-protocol.json',import.meta.url),'utf8'));
const base=Date.parse('2026-10-18T00:00:00Z'),cutoff=base+60_000;
function fixture(id,volume,exitPrice=102,{selected=true}={}) {
  const epoch={id:protocol.performanceEpochId,startedAt:Date.parse('2026-10-15T20:35:37Z'),
    strategyVersion:protocol.demoStrategyVersion,signalModelVersion:protocol.signalModelVersion,strategySource:'V2_PRODUCTION'};
  const candidate={id,symbol:'BTCUSDT',direction:'LONG',strategy:'PRE_BREAKOUT',strategyVersion:protocol.signalModelVersion,
    triggerTime:base,observedAt:base+1,receivedAt:base+2,score:70,preMove:{modelVersion:protocol.signalModelVersion,volumeAcceleration:volume}};
  const evaluation={strategyVersion:protocol.signalModelVersion,evaluatedAt:base+3,eligible:true,score:70,costs:{totalCostR:0.1}};
  const decision={selected,counterfactual:false,decidedAt:base+10};
  const plan={strategyVersion:protocol.demoStrategyVersion,signalModelVersion:protocol.signalModelVersion,
    direction:'LONG',entrySide:'BUY',exitSide:'SELL',prices:{entry:'100',stopLoss:'99',takeProfit1:'101.5',takeProfit2:'102.5'}};
  const planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const shadow=buildDecisionSnapshot({candidate,evaluation,decision,epoch,recordedAt:base+10});
  const entry=buildDecisionSnapshot({candidate,evaluation,decision,epoch,scope:'ENTRY_PRE_SUBMIT',runId:`run-${id}`,
    executionSource:'V2_PRODUCTION',environment:'BINANCE_DEMO',executionScore:70,plan,planHash,planCreatedAt:base+15,recordedAt:base+20});
  const gross=exitPrice-100,commission=0.1;
  const run={id:`run-${id}`,signalId:id,symbol:'BTCUSDT',sourceType:'SIGNAL',executionSource:'V2_PRODUCTION',performanceEligible:true,
    status:'CLOSED',createdAt:base+15,updatedAt:base+500,plan,planHash,entryExecution:{submittedAt:base+30},
    entryOrder:{orderId:`entry-${id}`,executedQuantity:1},protection:{},
    result:{accountingComplete:true,realizedPnl:gross,commission,fundingPnl:0,netPnl:gross-commission,
      ownedOrderIds:[`entry-${id}`,`exit-${id}`],fundingIncome:[],trades:[
        {id:`fill-entry-${id}`,orderId:`entry-${id}`,symbol:'BTCUSDT',side:'BUY',price:100,quantity:1,commission:0.05,commissionAsset:'USDT',realizedPnl:0,time:base+40},
        {id:`fill-exit-${id}`,orderId:`exit-${id}`,symbol:'BTCUSDT',side:'SELL',price:exitPrice,quantity:1,commission:0.05,commissionAsset:'USDT',realizedPnl:gross,time:base+400},
      ]}};
  return {candidate,evaluation,decision,epoch,shadow,entry,run};
}
const validate=(snapshots=[],executions=[],overrides={})=>validateVolumeConfirmation({snapshots,executions,protocol,cutoff,...overrides});

test('单变量验证空样本返回等待，缺失不是0且永远没有自动交易或晋级权限',()=>{
  const r=validate();assert.equal(r.status,'WAITING_FOR_FORWARD_IMMUTABLE_SNAPSHOTS');
  assert.equal(r.conditionalFormalCohort.baseline.netPnl,null);assert.equal(r.promotionAllowed,false);
  assert.equal(r.orderSubmissionAllowed,false);assert.equal(r.causalNetImprovement,null);
});
test('量能固定阈值1仅生成有明确范围的正式成交队列诊断',()=>{
  const a=fixture('low',0.8,99),b=fixture('high',1.2,102);
  const r=validate([a.shadow,a.entry,b.shadow,b.entry],[a.run,b.run]);
  assert.equal(r.population.uniqueEligibleSignals,2);assert.equal(r.population.candidateRetained,1);
  assert.equal(r.conditionalFormalCohort.baseline.trades,2);
  assert.ok(Math.abs(r.conditionalFormalCohort.baseline.netPnl-0.8)<1e-10);
  assert.equal(r.conditionalFormalCohort.retained.netPnl,1.9);
  assert.equal(r.status,'DESCRIPTIVE_COHORT_ONLY_NOT_PROFIT_VALIDATED');assert.equal(r.statisticalSignificance,null);
});
test('eligible但未selected的候选保留，未成交结果不能当作0或过滤收益',()=>{
  const a=fixture('occupied',1.2,102,{selected:false});const r=validate([a.shadow],[]);
  assert.equal(r.population.uniqueEligibleSignals,1);assert.equal(r.population.eligibleButNotSelected,1);
  assert.equal(r.outcomeMissing.NO_FORMAL_EXECUTION_OUTCOME,1);assert.equal(r.conditionalFormalCohort.baseline.netPnl,null);
});
test('量能缺失与真实0分开统计',()=>{
  const a=fixture('missing',null),b=fixture('zero',0);const r=validate([a.shadow,b.shadow],[]);
  assert.equal(r.population.variableMissing,1);assert.equal(r.population.variableKnown,1);assert.equal(r.population.candidateFiltered,1);
});
test('hash篡改、注册前、未来输入和跨纪元快照均排除并给原因',()=>{
  const a=fixture('tamper',1.1);const tamper=structuredClone(a.shadow);tamper.preMove.volumeAcceleration=99;
  const old=buildDecisionSnapshot({candidate:{...a.candidate,id:'old',triggerTime:Date.parse(protocol.registeredAt)-1},evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,recordedAt:base+10});
  const future=buildDecisionSnapshot({candidate:{...a.candidate,id:'future',receivedAt:base+100},evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,recordedAt:base+10});
  const other=buildDecisionSnapshot({candidate:{...a.candidate,id:'other'},evaluation:a.evaluation,decision:a.decision,epoch:{...a.epoch,id:'other'},recordedAt:base+10});
  const r=validate([tamper,old,future,other]);assert.equal(r.population.uniqueEligibleSignals,0);
  assert.equal(r.exclusions.SNAPSHOT_HASH_OR_SCHEMA_INVALID,1);assert.equal(r.exclusions.NOT_FORWARD_AFTER_REGISTRATION,1);
  assert.equal(r.exclusions.SNAPSHOT_TIMING_VIOLATION,1);assert.equal(r.exclusions.VERSION_OR_EPOCH_MISMATCH,1);
});
test('完全相同快照幂等，冲突ID不选择对结果有利的版本',()=>{
  const a=fixture('duplicate',1.1);const good=validate([a.shadow,a.shadow]);assert.equal(good.population.uniqueEligibleSignals,1);
  const conflict=buildDecisionSnapshot({candidate:{...a.candidate,preMove:{volumeAcceleration:9}},evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,recordedAt:base+10,snapshotId:a.shadow.snapshotId});
  const r=validate([a.shadow,conflict]);assert.equal(r.exclusions.CONFLICTING_SNAPSHOT_ID,1);assert.equal(r.population.uniqueEligibleSignals,0);
});
test('执行前快照缺失、晚于提交或决策量能不一致均不能匹配正式结果',()=>{
  const a=fixture('match',1.1);
  assert.equal(validate([a.shadow],[a.run]).outcomeMissing.ENTRY_PLAN_SNAPSHOT_MISSING_OR_MISMATCH,1);
  const late=buildDecisionSnapshot({candidate:a.candidate,evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,scope:'ENTRY_PRE_SUBMIT',runId:a.run.id,
    executionSource:'V2_PRODUCTION',environment:'BINANCE_DEMO',plan:a.run.plan,planHash:a.run.planHash,planCreatedAt:a.run.createdAt,recordedAt:base+50});
  assert.equal(validate([a.shadow,late],[a.run]).outcomeMissing.ENTRY_SNAPSHOT_NOT_BEFORE_SUBMISSION,1);
  const changed=buildDecisionSnapshot({candidate:{...a.candidate,preMove:{volumeAcceleration:2}},evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,scope:'ENTRY_PRE_SUBMIT',runId:a.run.id,
    executionSource:'V2_PRODUCTION',environment:'BINANCE_DEMO',plan:a.run.plan,planHash:a.run.planHash,planCreatedAt:a.run.createdAt,recordedAt:base+20});
  assert.equal(validate([a.shadow,changed],[a.run]).outcomeMissing.DECISION_ENTRY_CONTEXT_MISMATCH,1);
});
test('开放结果右删失，截止后成交、重复成交和费用缺失拒绝估算',()=>{
  for(const mode of ['OPEN','FUTURE','DUPLICATE','COST_MISSING']) {
    const a=fixture(mode,1.1);if(mode==='OPEN')a.run.status='OPEN_PROTECTED';
    if(mode==='FUTURE')a.run.result.trades[1].time=cutoff+1;
    if(mode==='DUPLICATE')a.run.result.trades.push(structuredClone(a.run.result.trades[1]));
    if(mode==='COST_MISSING')a.run.result.trades[0].commission=null;
    const r=validate([a.shadow,a.entry],[a.run]);assert.equal(r.conditionalFormalCohort.baseline.trades,0);assert.equal(r.conditionalFormalCohort.baseline.netPnl,null);
  }
});
test('未修改实际账户净PnL，保护异常保留正式诊断但不变成盈利因子证据',()=>{
  const a=fixture('tp-rejected',1.1,98);a.run.protection.takeProfit2={status:'REJECTED'};
  const before=JSON.stringify(a.run);const r=validate([a.shadow,a.entry],[a.run]);
  assert.equal(r.conditionalFormalCohort.executionExceptionCount,1);assert.equal(r.conditionalFormalCohort.baseline.netPnl,-2.1);
  assert.equal(JSON.stringify(a.run),before);assert.equal(r.promotionAllowed,false);
});
test('不能把其他阈值或有下单能力的协议冒充已注册单变量试验',()=>{
  assert.throws(()=>validate([],[],{protocol:{...protocol,variable:{...protocol.variable,threshold:1.5}}}),/协议/);
  assert.throws(()=>validate([],[],{protocol:{...protocol,orderSubmissionAllowed:true}}),/协议/);
});

test('独立统计反例：未来triggerTime和错误evaluation版本均不能入队',()=>{
  const a=fixture('future-trigger',1.1);
  const future=buildDecisionSnapshot({candidate:{...a.candidate,triggerTime:cutoff+1},evaluation:a.evaluation,
    decision:a.decision,epoch:a.epoch,recordedAt:base+10});
  const wrong=buildDecisionSnapshot({candidate:{...a.candidate,id:'wrong-evaluation'},evaluation:{...a.evaluation,strategyVersion:'WRONG_EVALUATION'},
    decision:a.decision,epoch:a.epoch,recordedAt:base+10});
  const r=validate([future,wrong]);assert.equal(r.population.uniqueEligibleSignals,0);
  assert.equal(r.exclusions.TRIGGER_AFTER_DECISION_OR_CUTOFF,1);assert.equal(r.exclusions.VERSION_OR_EPOCH_MISMATCH,1);
});

test('独立统计反例：同run多份入场快照必须歧义拒绝，不随输入顺序挑选有利结果',()=>{
  const a=fixture('ambiguous',1.1);
  const another=buildDecisionSnapshot({candidate:{...a.candidate,preMove:{volumeAcceleration:0.1}},evaluation:a.evaluation,
    decision:a.decision,epoch:a.epoch,scope:'ENTRY_PRE_SUBMIT',runId:a.run.id,executionSource:'V2_PRODUCTION',environment:'BINANCE_DEMO',
    plan:a.run.plan,planHash:a.run.planHash,recordedAt:base+20,snapshotId:'another-entry-identity'});
  for(const entries of [[a.entry,another],[another,a.entry]]) {
    const r=validate([a.shadow,...entries],[a.run]);assert.equal(r.conditionalFormalCohort.baseline.trades,0);
    assert.equal(r.outcomeMissing.AMBIGUOUS_ENTRY_SNAPSHOTS_FOR_RUN,1);
  }
});

test('独立QA反例：市场环境及其嵌套K线来自决策之后必须排除，已知未来资金费日程不混作泄漏',()=>{
  const a=fixture('nested-future',1.1);
  for(const marketRegime of [{decidedAt:cutoff+1},{btc1h:{candleCloseTime:cutoff+1}},{btc4h:{candleCloseTime:cutoff+1}}]) {
    const s=buildDecisionSnapshot({candidate:a.candidate,evaluation:{...a.evaluation,marketRegime},decision:a.decision,epoch:a.epoch,recordedAt:base+10});
    const r=validate([s]);assert.equal(r.population.uniqueEligibleSignals,0);
    assert.equal((r.exclusions.NESTED_MARKET_INPUT_AFTER_DECISION??0)+(r.exclusions.SNAPSHOT_TIMING_VIOLATION??0),1);
  }
  const scheduled=buildDecisionSnapshot({candidate:a.candidate,evaluation:{...a.evaluation,costs:{totalCostR:0.1,premium:{nextFundingTime:cutoff+1000}}},
    decision:a.decision,epoch:a.epoch,recordedAt:base+10});
  assert.equal(validate([scheduled]).population.uniqueEligibleSignals,1);
});

test('独立统计反例：shadow事后保存、未来提交和旧run搭配前向快照不得形成收益诊断',()=>{
  const a=fixture('timeline',1.1);
  const post=buildDecisionSnapshot({candidate:a.candidate,evaluation:a.evaluation,decision:a.decision,epoch:a.epoch,recordedAt:base+550});
  assert.equal(validate([post,a.entry],[a.run]).outcomeMissing.SHADOW_SNAPSHOT_NOT_BEFORE_RUN,1);
  const submitted=structuredClone(a.run);submitted.entryExecution.submittedAt=cutoff+1;
  assert.equal(validate([a.shadow,a.entry],[submitted]).outcomeMissing.LOCAL_EXECUTION_TIME_INVALID,1);
  const old=structuredClone(a.run);old.createdAt=Date.parse(protocol.registeredAt)-1000;
  assert.equal(validate([a.shadow,a.entry],[old]).outcomeMissing.RUN_NOT_FORWARD_AFTER_REGISTRATION,1);
});

test('独立统计反例：跨run共享订单、成交或Funding时全部排除，不重复计收益或依赖输入顺序',()=>{
  for(const mode of ['ALL_FILLS','ORDER','FILL','FUNDING']) {
    const a=fixture(`owner-a-${mode}`,1.1),b=fixture(`owner-b-${mode}`,1.2);
    if(mode==='ALL_FILLS') {
      b.run.entryOrder=structuredClone(a.run.entryOrder);
      b.run.result=structuredClone(a.run.result);
    }
    if(mode==='ORDER') b.run.result.ownedOrderIds.push(a.run.result.ownedOrderIds[0]);
    if(mode==='FILL') b.run.result.trades[1].id=a.run.result.trades[1].id;
    if(mode==='FUNDING') for(const x of [a,b]) {
      x.run.result.fundingIncome=[{symbol:'BTCUSDT',asset:'USDT',incomeType:'FUNDING_FEE',income:0.1,time:base+300,transactionId:'shared-funding'}];
      x.run.result.fundingPnl=0.1;x.run.result.netPnl+=0.1;
    }
    const snapshots=[a.shadow,a.entry,b.shadow,b.entry];
    for(const executions of [[a.run,b.run],[b.run,a.run]]) {
      const r=validate(snapshots,executions);
      assert.equal(r.conditionalFormalCohort.baseline.trades,0,mode);
      assert.equal(r.conditionalFormalCohort.baseline.netPnl,null,mode);
      assert.equal(r.outcomeMissing.CROSS_RUN_ACCOUNTING_OWNERSHIP_CONFLICT,2,mode);
      assert.deepEqual([...r.accountingOwnership.conflictingRunIds].sort(),[a.run.id,b.run.id].sort());
    }
  }
});

test('跨run归属检查：同一run重复提供不增加样本；其他币种相同成交编号不误判同一成交',()=>{
  const a=fixture('same-run',1.1);
  assert.equal(validate([a.shadow,a.entry],[a.run,structuredClone(a.run)]).conditionalFormalCohort.baseline.trades,1);
  const b=fixture('other-symbol',1.2);
  b.candidate.symbol='ETHUSDT';b.run.symbol='ETHUSDT';
  b.run.result.trades.forEach((t,i)=>{t.symbol='ETHUSDT';t.id=a.run.result.trades[i].id;});
  b.shadow=buildDecisionSnapshot({candidate:b.candidate,evaluation:b.evaluation,decision:b.decision,epoch:b.epoch,recordedAt:base+10});
  b.entry=buildDecisionSnapshot({candidate:b.candidate,evaluation:b.evaluation,decision:b.decision,epoch:b.epoch,
    scope:'ENTRY_PRE_SUBMIT',runId:b.run.id,executionSource:'V2_PRODUCTION',environment:'BINANCE_DEMO',
    plan:b.run.plan,planHash:b.run.planHash,planCreatedAt:b.run.createdAt,recordedAt:base+20});
  assert.equal(validate([a.shadow,a.entry,b.shadow,b.entry],[a.run,b.run]).conditionalFormalCohort.baseline.trades,2);
});
