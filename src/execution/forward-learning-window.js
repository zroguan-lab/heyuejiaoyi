import { verifyDecisionSnapshot } from '../domain/decision-snapshot.js';
import { executionFillFacts } from './execution-fill-facts.js';
import { FACT_CONFLICT_TERMINAL } from './execution-maintenance.js';

export const FORWARD_WINDOW_KEY='clean_forward_window';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
export function assessForwardLearning(run,window,snapshot=null) {
  if(run?.status===FACT_CONFLICT_TERMINAL||run?.terminalClassification)return{executionQuality:'CONFLICT',learningEligible:false};
  if(!window||run?.forwardWindowId!==window.id||run?.performanceEpochId!==window.epochId||!finite(run?.createdAt)
    ||run.createdAt<window.registeredAt||run.plan?.strategyVersion!==window.strategyVersion||run.plan?.signalModelVersion!==window.signalModelVersion)
    return{executionQuality:'UNKNOWN',learningEligible:false};
  if(run.error||run.executionException||run.entryFactVerification?.status==='CONFLICT')return{executionQuality:'DEGRADED',learningEligible:false};
  const facts=executionFillFacts(run),result=run.result;
  const snapshotValid=verifyDecisionSnapshot(snapshot)&&snapshot.scope==='ENTRY_PRE_SUBMIT'&&snapshot.runId===run.id
    &&snapshot.versions?.epochId===window.epochId&&snapshot.plan?.planHash===run.planHash
    &&snapshot.times?.captureTime>=window.registeredAt&&snapshot.times.captureTime<=run.entryExecution?.submittedAt
    &&Array.isArray(snapshot.completeness?.timingViolations)&&snapshot.completeness.timingViolations.length===0
    &&Array.isArray(snapshot.completeness?.missingFields)&&snapshot.completeness.missingFields.length===0
    &&snapshot.completeness.receivedByDecision===true&&snapshot.completeness.freshnessValidated===true;
  const costsComplete=result?.accountingComplete===true&&finite(result.commission)&&finite(result.fundingPnl)&&finite(result.netPnl)
    &&Array.isArray(result.trades)&&result.trades.length>0&&result.trades.every(t=>finite(t.commission)&&t.commissionAsset==='USDT')
    &&Array.isArray(result.fundingIncome)&&result.fundingIncome.every(f=>f.transactionId!=null&&finite(f.income));
  const eligible=run.status==='CLOSED'&&run.sourceType==='SIGNAL'&&run.performanceEligible!==false&&snapshotValid&&costsComplete
    &&facts.status==='CONFIRMED'&&facts.riskAmount>0;
  return{executionQuality:eligible?'CLEAN':'UNKNOWN',learningEligible:eligible};
}

export function assertResetEpochSignal(record,epoch) {
  if(epoch?.resetMode!=='CONTROLLED_SAFE_RESET')return;
  if(!Number.isFinite(record?.candidate?.triggerTime)||record.candidate.triggerTime<epoch.startedAt)
    throw new Error('SIGNAL_PRECEDES_CONTROLLED_RESET_EPOCH');
}
