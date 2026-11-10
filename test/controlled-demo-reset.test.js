import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResearchStore } from '../src/infrastructure/research-store.js';
import { RESET_TARGETS, sha256 } from '../src/execution/execution-maintenance.js';
import { createMaintenanceRiskReader } from '../src/execution/maintenance-risk-reader.js';
import { runControlledDemoReset } from '../src/execution/controlled-demo-reset.js';
import { V2_DEMO_STRATEGY_VERSION } from '../src/execution/execution-strategy-source.js';
import { main } from '../scripts/controlled-demo-reset.js';

const KEY='fixture-key',SECRET='fixture-secret',SYMBOLS=['CLANKERUSDT','XRPUSDT','HOMEUSDT','PLAYUSDT','CHRUSDT','1000000MOGUSDT','BULLAUSDT','1000BONKUSDT'];
function inspect(file,action){const db=new DatabaseSync(file,{readOnly:true});try{return action(db);}finally{db.close();}}
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'team038-controlled-'));
  t.after(()=>{const root=resolve(tmpdir());assert(directory.startsWith(root+sep)&&basename(directory).startsWith('team038-controlled-'));rmSync(directory,{recursive:true,force:true});});
  const databasePath=join(directory,'fixture.sqlite'),store=new ResearchStore(databasePath);await store.initialize();
  const epoch={id:'old-epoch',strategySource:'V2_PRODUCTION',strategyVersion:V2_DEMO_STRATEGY_VERSION,signalModelVersion:'fixture-model',startingEquity:500,startedAt:1000};
  await store.setMetadata('active_strategy_performance_epoch',epoch);await store.setMetadata('testnet_execution_emergency_stop',{active:false});
  for(const[id,index]of RESET_TARGETS.map((id,index)=>[id,index])){
    const signalId=`old-${index}`,symbol=SYMBOLS[index];
    await store.saveCandidate({id:signalId,symbol,strategy:'PRE_BREAKOUT',direction:'LONG',triggerTime:1000});
    const plan={symbol,marginEstimate:10,strategyVersion:V2_DEMO_STRATEGY_VERSION,signalModelVersion:'fixture-model',direction:'LONG',entrySide:'BUY',exitSide:'SELL',prices:{entry:'1',stopLoss:'.9'},rules:{stepSize:1,tickSize:.01}};
    await store.createExecutionRun({id,signalId,symbol,status:index===7?'FAILED':'PROTECTION_INCOMPLETE',createdAt:1000,updatedAt:1000,
      sourceType:'SIGNAL',executionSource:'V2_PRODUCTION',performanceEligible:true,plan,planHash:sha256(plan),
      entryFactVerification:{status:index===7?'SUBMISSION_INTENT':'ORDER_VERIFIED',accountFingerprint:sha256(sha256(KEY))}});
    await store.appendExecutionAudit(id,'FIXTURE_ORIGINAL_EVIDENCE',{evidence:'original'},1000);
  }
  const rows=store.db.prepare('SELECT id,status,payload FROM execution_runs ORDER BY id').all();
  const originalColumnsHash=sha256(store.db.prepare('SELECT id,signal_id,symbol,status,created_at,updated_at,payload FROM execution_runs ORDER BY id').all());
  const expectedRunHashes=Object.fromEntries(rows.map(r=>[r.id,sha256(r.payload)]));
  const epochText=store.db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value;
  store.close();
  const lockRaw=JSON.stringify({pid:987654321,token:'fixture-dead-owner',acquiredAt:1});writeFileSync(`${databasePath}.execution.lock`,lockRaw);
  const clock={value:2_000_000},calls=[];
  const context={directory,databasePath,clock,calls,expectedRunHashes,originalColumnsHash,expectedEpochHash:sha256(epochText),expectedExecutionHash:sha256(rows),expectedLockHash:sha256(lockRaw)};
  context.reader=(overrides={})=>createMaintenanceRiskReader({apiKey:KEY,apiSecret:SECRET,now:()=>clock.value,fetchImpl:async(input,options)=>{
    const url=new URL(input);clock.value++;calls.push({path:url.pathname,method:options.method});
    const bodies={'/fapi/v1/time':{serverTime:clock.value},'/fapi/v3/account':{totalWalletBalance:'5000'},'/fapi/v3/positionRisk':[],
      '/fapi/v1/openOrders':[],'/fapi/v1/openAlgoOrders':[],'/fapi/v1/positionSide/dual':{dualSidePosition:false},'/fapi/v1/symbolConfig':[{symbol:{unknown:true}}]};
    return{ok:true,status:200,redirected:false,text:async()=>JSON.stringify(Object.hasOwn(overrides,url.pathname)?overrides[url.pathname]:bodies[url.pathname])};
  }});
  context.args=(extra={})=>({databasePath,operationId:'fixture-reset',expectedRunHashes,expectedExecutionHash:context.expectedExecutionHash,
    expectedEpochHash:context.expectedEpochHash,expectedLockHash:context.expectedLockHash,oldPid:987654321,riskReader:context.reader(),
    backupDirectory:join(directory,'backups'),releaseManifestSha256:sha256('fixture-release'),now:()=>clock.value,
    host:{pid:424242,pidAlive:()=>false,listenerPresent:()=>false},...extra});
  return context;
}

test('TEAM038 formal reset keeps raw rows, appends eight terminal overlays, rotates epoch and only registers truthful observation rules',async t=>{
  const f=await fixture(t),result=await runControlledDemoReset(f.args());
  assert.equal(result.targetCount,8);assert.equal(result.epoch.startingEquity,500);assert.equal(result.epoch.previousEpochId,'old-epoch');
  assert.equal(result.window.epochId,result.epoch.id);assert.equal(result.window.factorModuleDeployed,false);assert.equal(result.startupAuthorized,false);
  assert.equal(f.calls.length,14);assert(f.calls.every(c=>c.method==='GET'));assert.equal(result.finalRiskProofs[0].canTrade,null);
  assert.equal(result.finalRiskProofs[0].configs.unknownSymbols,1);assert(!existsSync(`${f.databasePath}.maintenance.lock`));
  assert(!existsSync(`${f.databasePath}.execution.lock`));
  inspect(f.databasePath,db=>{const raw=db.prepare('SELECT id,status,payload FROM execution_runs ORDER BY id').all();assert.equal(sha256(raw),f.expectedExecutionHash);
    assert.equal(sha256(db.prepare('SELECT id,signal_id,symbol,status,created_at,updated_at,payload FROM execution_runs ORDER BY id').all()),f.originalColumnsHash);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_terminal_classifications').get().n,8);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_runs WHERE maintenance_terminal=1').get().n,8);});
  const store=new ResearchStore(f.databasePath);await store.initialize();
  try{
    assert.equal((await store.listActiveExecutionRuns()).length,0);
    for(const id of RESET_TARGETS){const r=await store.getExecutionRun(id);assert.equal(r.status,'FACT_CONFLICT_TERMINAL');assert.equal(r.performanceEligible,false);assert.equal(r.learningEligible,false);assert.equal(r.result.netPnl,null);}
    const raw=store.db.prepare('SELECT * FROM execution_runs WHERE id=?').get(RESET_TARGETS[0]);
    assert.throws(()=>store.db.prepare('INSERT OR REPLACE INTO execution_runs(id,signal_id,symbol,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?)')
      .run(raw.id,raw.signal_id,raw.symbol,raw.status,raw.created_at,raw.updated_at,'{}'),/immutable/);
    const old=await store.getExecutionRun(RESET_TARGETS[0]);await assert.rejects(store.saveExecutionRun({...old,status:'PREPARED'}),/CANNOT_REOPEN/);
    const duplicate=await store.createExecutionRun({...old,status:'PREPARED'});assert.equal(duplicate.created,false);assert.equal(duplicate.run.status,'FACT_CONFLICT_TERMINAL');
    const next={id:'new-home',signalId:'new-home-signal',symbol:'HOMEUSDT',status:'PREPARED',createdAt:f.clock.value+1,updatedAt:f.clock.value+1,plan:{...old.plan,symbol:'HOMEUSDT'},sourceType:'SIGNAL'};
    await store.saveCandidate({id:next.signalId,symbol:next.symbol,strategy:'PRE_BREAKOUT',direction:'LONG',triggerTime:next.createdAt});
    assert.equal((await store.createExecutionRun(next)).created,true);assert.equal((await store.getExecutionRun(next.id)).learningEligible,false);
  }finally{store.close();}
});

for(const stage of ['beforeCommit','afterCommit','afterLockRetired','beforeGuardRelease'])test(`TEAM038 same operation resumes safely after ${stage} without reclassifying or rotating twice`,async t=>{
  const f=await fixture(t);let failed=false;
  await assert.rejects(runControlledDemoReset(f.args({faultInjection:s=>{if(s===stage&&!failed){failed=true;throw new Error('FIXTURE_INTERRUPTION');}}})),/FIXTURE_INTERRUPTION/);
  assert(existsSync(`${f.databasePath}.maintenance.lock`));
  const firstEpoch=inspect(f.databasePath,db=>JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value).id);
  const recovered=await runControlledDemoReset(f.args());
  if(stage!=='beforeCommit')assert.equal(recovered.epoch.id,firstEpoch);
  inspect(f.databasePath,db=>{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_reset_operations').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_terminal_classifications').get().n,8);
    assert.equal(sha256(db.prepare('SELECT id,status,payload FROM execution_runs ORDER BY id').all()),f.expectedExecutionHash);});
});

test('TEAM038 unknown/nonzero current exposure and fake JSON reader never authorize local isolation',async t=>{
  for(const risk of [[{symbol:'HOMEUSDT',positionSide:'BOTH',positionAmt:'1'}],[{symbol:'HOMEUSDT',positionSide:'BOTH'}]]){
    const f=await fixture(t);await assert.rejects(runControlledDemoReset(f.args({riskReader:f.reader({'/fapi/v3/positionRisk':risk})})),/RISK/);
    inspect(f.databasePath,db=>assert.equal(db.prepare('SELECT COUNT(*) AS n FROM execution_terminal_classifications').get().n,0));
  }
  await assert.rejects(runControlledDemoReset({riskReader:{read:async()=>({counts:{positions:0,ordinaryOrders:0,algoOrders:0}})}}),/LIVE_MAINTENANCE_READER_REQUIRED/);
});

test('TEAM038 live owner and changed original execution lock are hard failures',async t=>{
  const f=await fixture(t);await assert.rejects(runControlledDemoReset(f.args({host:{pid:424242,pidAlive:()=>true,listenerPresent:()=>false}})),/OLD_OWNER/);
  assert.equal(f.calls.length,0);assert(!existsSync(`${f.databasePath}.maintenance.lock`));
  await assert.rejects(runControlledDemoReset(f.args({faultInjection:s=>{if(s==='backupCreated')writeFileSync(`${f.databasePath}.execution.lock`,JSON.stringify({pid:55,token:'other'}));}})),/LOCK_CAS_CHANGED/);
});

test('TEAM038 fresh observations are collected after slow backup checks, never reused from before them',async t=>{
  const f=await fixture(t);const result=await runControlledDemoReset(f.args({faultInjection:s=>{if(s==='backupCreated')f.clock.value+=60_000;}}));
  assert(result.finalRiskProofs[0].startedAt>=2_120_000);assert.equal(result.targetCount,8);
});

test('TEAM038 maintenance command is inert by default',async()=>{
  let accessed=false;const env=new Proxy({},{get(){accessed=true;throw new Error('unexpected credential read');}});
  assert.equal((await main([],{env})).mode,'NOT_EXECUTED');assert.equal(accessed,false);
});

test('TEAM038 a resumed request cannot adopt a changed lock hash/PID or release identity',async t=>{
  const f=await fixture(t);
  await assert.rejects(runControlledDemoReset(f.args({faultInjection:s=>{if(s==='afterCommit')throw new Error('FIXTURE_INTERRUPTION');}})),/FIXTURE_INTERRUPTION/);
  const guard=readFileSync(`${f.databasePath}.maintenance.lock`,'utf8');
  const changed=JSON.stringify({pid:987654321,token:'changed-owner',acquiredAt:2});writeFileSync(`${f.databasePath}.execution.lock`,changed);
  for(const extra of [{expectedLockHash:sha256(changed)},{oldPid:987654320},{releaseManifestSha256:sha256('another-release')}])
    await assert.rejects(runControlledDemoReset(f.args(extra)),/RESUME_REQUEST_CHANGED/);
  assert.equal(readFileSync(`${f.databasePath}.maintenance.lock`,'utf8'),guard);
  assert.equal(readFileSync(`${f.databasePath}.execution.lock`,'utf8'),changed);
});

test('TEAM038 an uncommitted failed backup is preserved but never reused as trusted evidence',async t=>{
  const f=await fixture(t);
  await assert.rejects(runControlledDemoReset(f.args({faultInjection:s=>{if(s==='backupCreated')throw new Error('FIXTURE_INTERRUPTION');}})),/FIXTURE_INTERRUPTION/);
  const oldPath=join(f.directory,'backups',readdirSync(join(f.directory,'backups')).find(n=>n.endsWith('.sqlite')));
  const damaged=new DatabaseSync(oldPath);try{damaged.prepare('UPDATE execution_audit SET payload=? WHERE id=(SELECT MIN(id) FROM execution_audit)').run('{"evidence":"tampered"}');}finally{damaged.close();}
  const recovered=await runControlledDemoReset(f.args());assert(recovered.backups.every(b=>b.path!==oldPath));assert(existsSync(oldPath));
  inspect(oldPath,db=>assert.equal(db.prepare('SELECT payload FROM execution_audit ORDER BY id LIMIT 1').get().payload,'{"evidence":"tampered"}'));
  inspect(f.databasePath,db=>assert.equal(db.prepare('SELECT payload FROM execution_audit ORDER BY id LIMIT 1').get().payload,'{"evidence":"original"}'));
});

test('TEAM038 a committed backup hash cannot be replaced on resume even when counts and execution digest still match',async t=>{
  const f=await fixture(t);
  await assert.rejects(runControlledDemoReset(f.args({faultInjection:s=>{if(s==='afterCommit')throw new Error('FIXTURE_INTERRUPTION');}})),/FIXTURE_INTERRUPTION/);
  const operation=inspect(f.databasePath,db=>JSON.parse(db.prepare('SELECT payload FROM execution_reset_operations').get().payload));
  const damaged=new DatabaseSync(operation.backups[0].path);try{damaged.prepare('UPDATE execution_audit SET payload=? WHERE id=(SELECT MIN(id) FROM execution_audit)').run('{"evidence":"tampered"}');}finally{damaged.close();}
  await assert.rejects(runControlledDemoReset(f.args()),/RESUME_BACKUP_CHANGED/);
  assert(existsSync(`${f.databasePath}.maintenance.lock`));
});
