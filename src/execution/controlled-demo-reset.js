import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, unlinkSync, mkdirSync, realpathSync, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { installMaintenanceSchema, RESET_TARGETS, FACT_CONFLICT_TERMINAL, sha256, requireMaintenance as need, appendResetEvent } from './execution-maintenance.js';
import { assertFreshZeroRisk, maintenanceReaderFingerprint } from './maintenance-risk-reader.js';
import { FORWARD_WINDOW_KEY } from './forward-learning-window.js';
import { buildPerformanceEpoch } from './execution-strategy-source.js';

const running=new Set(),HEX=/^[a-f0-9]{64}$/i;
const nativeHost={pid:process.pid,pidAlive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw new Error('PID_STATE_UNKNOWN');}},
  listenerPresent(){return new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:3000});
    socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',e=>{socket.destroy();resolve(e.code==='ECONNREFUSED'?false:null);});socket.setTimeout(1000,()=>{socket.destroy();resolve(null);});});}};
async function fileHash(file){const h=createHash('sha256');for await(const part of createReadStream(file))h.update(part);return h.digest('hex');}
function readOperation(file,id){const db=new DatabaseSync(file,{readOnly:true});try{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_reset_operations'").get())return null;
  const row=db.prepare('SELECT payload FROM execution_reset_operations WHERE operation_id=?').get(id);return row?JSON.parse(row.payload):null;
}finally{db.close();}}
function databaseSummary(db){
  const rows=db.prepare('SELECT id,status,payload FROM execution_runs ORDER BY id').all();
  const epoch=db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const tableCounts=Object.fromEntries(tables.map(t=>[t.name,db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replaceAll('"','""')}"`).get().n]));
  return{rawExecutionHash:sha256(rows),executionRows:rows.length,epochHash:epoch?sha256(epoch.value):null,tableCounts};
}
async function consistentBackup(file,destination,expected,fault){
  // No uncommitted file is an authority. Each attempt uses new paths; only a
  // committed operation's recorded hashes can authorize reuse on resume.
  need(!existsSync(destination),'UNCOMMITTED_BACKUP_MUST_BE_NEW');
  {const source=new DatabaseSync(file,{readOnly:true});let begun=false;try{
    source.exec('PRAGMA query_only=ON');source.exec('BEGIN');begun=true;
    const frozen=databaseSummary(source);
    need(frozen.rawExecutionHash===expected.rawExecutionHash&&frozen.epochHash===expected.epochHash
      &&JSON.stringify(frozen.tableCounts)===JSON.stringify(expected.tableCounts),'BACKUP_SOURCE_SNAPSHOT_CHANGED');
    await backup(source,destination);
  }finally{if(begun)source.exec('ROLLBACK');source.close();}}
  fault?.('backupCreated');
  const check=new DatabaseSync(destination,{readOnly:true});let summary;
  try{check.exec('PRAGMA query_only=ON');check.exec('BEGIN');
    need(check.prepare('PRAGMA integrity_check').all().every(r=>r.integrity_check==='ok'),'BACKUP_INTEGRITY_FAILED');
    need(check.prepare('PRAGMA foreign_key_check').all().length===0,'BACKUP_FK_FAILED');summary=databaseSummary(check);
    need(summary.rawExecutionHash===expected.rawExecutionHash&&summary.epochHash===expected.epochHash,'BACKUP_BASELINE_CHANGED');
    need(JSON.stringify(summary.tableCounts)===JSON.stringify(expected.tableCounts),'BACKUP_TABLE_COUNTS_CHANGED');
  }finally{if(check.isTransaction)check.exec('ROLLBACK');check.close();}
  return{path:destination,sha256:await fileHash(destination),...summary,integrity:'ok',foreignKeyViolations:0};
}
function getLockState(file,expectedHash,oldPid,archive){
  if(existsSync(file)){const raw=readFileSync(file,'utf8');need(sha256(raw)===expectedHash,'EXECUTION_LOCK_CAS_CHANGED');
    let value;try{value=JSON.parse(raw);}catch{throw new Error('EXECUTION_LOCK_FORMAT_UNKNOWN');}
    need(value.pid===oldPid&&typeof value.token==='string'&&value.token.length>0,'EXECUTION_LOCK_OWNER_CHANGED');
    need(!existsSync(archive),'EXECUTION_AND_RETIRED_LOCK_BOTH_PRESENT');return'OLD_PRESENT';}
  need(existsSync(archive)&&sha256(readFileSync(archive,'utf8'))===expectedHash,'EXECUTION_LOCK_MISSING_OR_UNKNOWN');return'RETIRED';
}
async function assertOffline(host,oldPid){need(await host.pidAlive(oldPid)===false,'OLD_OWNER_ALIVE_OR_UNKNOWN');need(await host.listenerPresent()===false,'LISTENER_ALIVE_OR_UNKNOWN');}
async function maintenanceGuard(file,operationId,requestIdentityHash,host){
  const token=randomUUID(),payload=JSON.stringify({pid:host.pid,operationId,requestIdentityHash,token});
  if(existsSync(file)){
    const raw=readFileSync(file,'utf8');let previous;try{previous=JSON.parse(raw);}catch{throw new Error('MAINTENANCE_OWNER_UNKNOWN');}
    need(previous.operationId===operationId,'OTHER_MAINTENANCE_OPERATION');
    need(previous.requestIdentityHash===requestIdentityHash,'MAINTENANCE_RESUME_REQUEST_CHANGED');
    need(previous.pid===host.pid||await host.pidAlive(previous.pid)===false,'MAINTENANCE_OWNER_ALIVE_OR_UNKNOWN');
    const temporary=`${file}.${token}.next`,fd=openSync(temporary,'wx');try{writeFileSync(fd,payload);}finally{closeSync(fd);}
    need(readFileSync(file,'utf8')===raw,'MAINTENANCE_LOCK_CAS_CHANGED');renameSync(temporary,file);
  }else{const fd=openSync(file,'wx');try{writeFileSync(fd,payload);}finally{closeSync(fd);}}
  return()=>{need(readFileSync(file,'utf8')===payload,'MAINTENANCE_LOCK_CAS_CHANGED');unlinkSync(file);};
}
function validateTargets(db,expected){
  need(expected&&Object.keys(expected).length===RESET_TARGETS.length&&RESET_TARGETS.every(id=>HEX.test(expected[id]??'')),'EXACT_EIGHT_TARGET_HASHES_REQUIRED');
  const rows=RESET_TARGETS.map(id=>{const r=db.prepare('SELECT id,status,payload FROM execution_runs WHERE id=?').get(id);
    need(r&&sha256(r.payload)===expected[id],'TARGET_RAW_CAS_CHANGED');return r;});
  const otherActive=db.prepare("SELECT id FROM execution_runs WHERE status NOT IN ('CLOSED','CANCELED','REJECTED','FAILED')").all().filter(r=>!RESET_TARGETS.includes(r.id));
  need(otherActive.length===0,'NON_TARGET_ACTIVE_EXECUTION');return rows;
}
function assertKeyBinding(rows,fingerprint){const known=rows.map(r=>JSON.parse(r.payload).entryFactVerification?.accountFingerprint);
  need(known.length===rows.length&&known.every(v=>typeof v==='string'&&HEX.test(v)&&v===fingerprint),'MAINTENANCE_ACCOUNT_KEY_BINDING_UNKNOWN');}
function setMetadata(db,key,value,at){db.prepare('INSERT INTO metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,JSON.stringify(value),at);}
async function freshPair(reader,now){const a=await reader.read(),b=await reader.read();assertFreshZeroRisk(a,now());assertFreshZeroRisk(b,now());
  need(a!==b&&b.startedAt>=a.observedAt&&b.observedAt>a.observedAt,'INDEPENDENT_ZERO_OBSERVATIONS_REQUIRED');return[a,b];}

// Formal entry: owns a maintenance exclusion barrier, obtains LIVE read-only
// observations itself after backups, then CAS-appends classifications and epoch.
// Static plan JSON supplies expected hashes only and can never supply risk proof.
export async function runControlledDemoReset({databasePath,operationId,expectedRunHashes,expectedExecutionHash,expectedEpochHash,expectedLockHash,oldPid,
  riskReader,backupDirectory,releaseCommit=null,releaseManifestSha256,now=Date.now,host=nativeHost,faultInjection}={}) {
  const fingerprint=maintenanceReaderFingerprint(riskReader);
  need(typeof operationId==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(operationId)&&HEX.test(expectedExecutionHash??'')&&HEX.test(expectedEpochHash??'')&&HEX.test(expectedLockHash??'')
    &&HEX.test(releaseManifestSha256??'')&&Number.isSafeInteger(oldPid)&&oldPid>0,'MAINTENANCE_REQUEST_INVALID');
  const file=realpathSync(databasePath),directory=resolve(backupDirectory),lock=`${file}.execution.lock`,guard=`${file}.maintenance.lock`,archive=join(directory,`${operationId}-execution-lock.retired`);
  const requestIdentityHash=sha256({operationId,file,directory,oldPid,expectedLockHash,expectedEpochHash,expectedExecutionHash,
    expectedRunHashes:RESET_TARGETS.map(id=>[id,expectedRunHashes?.[id]]),releaseCommit,releaseManifestSha256});
  need(!running.has(file),'MAINTENANCE_ALREADY_RUNNING');running.add(file);
  let db=null,releaseGuard=null,pair=null,operation=null;
  try{
    const previous=readOperation(file,operationId);
    if(previous)need(previous.requestIdentityHash===requestIdentityHash&&previous.expectedLockHash===expectedLockHash&&previous.oldPid===oldPid,'RESUME_REQUEST_CHANGED');
    if(previous&&!existsSync(guard)&&existsSync(archive)) {
      need(previous.expectedLockHash===expectedLockHash&&sha256(readFileSync(archive,'utf8'))===expectedLockHash,'COMPLETED_OPERATION_LOCK_CONFLICT');
      return{operationId,alreadyCommitted:true,noActionsTaken:true,epoch:previous.epoch,window:previous.window,
        note:'NO_CURRENT_ACCOUNT_OR_STARTUP_PROOF_FROM_IDEMPOTENT_RECEIPT',startupAuthorized:false};
    }
    await assertOffline(host,oldPid);
    mkdirSync(directory,{recursive:true});
    const lockState=getLockState(lock,expectedLockHash,oldPid,archive);
    need(previous||lockState==='OLD_PRESENT','LOCK_RETIRED_WITHOUT_OPERATION');
    releaseGuard=await maintenanceGuard(guard,operationId,requestIdentityHash,host);
    await assertOffline(host,oldPid);getLockState(lock,expectedLockHash,oldPid,archive);
    faultInjection?.('guardAcquired');
    db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');
    const targets=validateTargets(db,expectedRunHashes);assertKeyBinding(targets,fingerprint);
    if(!previous){
      const summary=databaseSummary(db);need(summary.rawExecutionHash===expectedExecutionHash,'EXECUTION_SET_CAS_CHANGED');need(summary.epochHash===expectedEpochHash,'OLD_EPOCH_CAS_CHANGED');
      const attempt=randomUUID();
      const online=await consistentBackup(file,join(directory,`${operationId}-${attempt}-online.sqlite`),summary,faultInjection);
      const cutover=await consistentBackup(file,join(directory,`${operationId}-${attempt}-cutover.sqlite`),summary,faultInjection);
      pair=await freshPair(riskReader,now);
      await assertOffline(host,oldPid);need(getLockState(lock,expectedLockHash,oldPid,archive)==='OLD_PRESENT','OLD_LOCK_ALREADY_RETIRED');
      db.exec('BEGIN IMMEDIATE');
      try{
        validateTargets(db,expectedRunHashes);need(databaseSummary(db).rawExecutionHash===summary.rawExecutionHash,'EXECUTION_SET_CHANGED_AFTER_BACKUP');
        const epochRow=db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get();
        need(epochRow&&sha256(epochRow.value)===expectedEpochHash,'OLD_EPOCH_CAS_CHANGED');
        const oldEpoch=JSON.parse(epochRow.value),at=now();
        for(const proof of pair)assertFreshZeroRisk(proof,at);
        const stop=db.prepare("SELECT value FROM metadata WHERE key='testnet_execution_emergency_stop'").get();
        need(!stop||JSON.parse(stop.value).active===false,'EMERGENCY_STOP_REQUIRES_FORMAL_CLEAR');
        installMaintenanceSchema(db);
        const epoch={...buildPerformanceEpoch({now:at,startingEquity:500,strategySource:oldEpoch.strategySource,strategyVersion:oldEpoch.strategyVersion,
          signalModelVersion:oldEpoch.signalModelVersion,radarVersion:oldEpoch.radarVersion,previousEpoch:oldEpoch}),id:`SAFE_RESET_${operationId}_${at}`,
          resetMode:'CONTROLLED_SAFE_RESET',resetReason:'CONTROLLED_SAFE_RESET',resetStartedAt:at,accountCleanConfirmedAt:pair[1].observedAt,
          oldPerformancePreserved:true,releaseIdentity:{baseCommit:releaseCommit,candidateManifestSha256:releaseManifestSha256,overlay:'TEAM038_FROM_TEAM031_V2_NOT_EXACT_BASE_COMMIT'}};
        const window={id:`CLEAN_FORWARD_WINDOW_${operationId}`,epochId:epoch.id,registeredAt:at,strategyVersion:oldEpoch.strategyVersion,
          signalModelVersion:oldEpoch.signalModelVersion,executionQualityStates:['CLEAN','DEGRADED','CONFLICT','UNKNOWN'],
          learningRules:{quality:'CLEAN',accountingComplete:true,actualRiskKnown:true,immutableSnapshotValid:true,noLookAhead:true,costsComplete:true},
          factorModuleDeployed:false};
        operation={operationId,requestIdentityHash,expectedRunHashes,expectedExecutionHash,expectedEpochHash,expectedLockHash,oldPid,createdAt:at,oldEpochRaw:epochRow.value,
          originalSummary:summary,backups:[online,cutover],epoch,window,liveRiskProofs:pair};
        db.prepare('INSERT INTO execution_reset_operations(operation_id,created_at,payload) VALUES(?,?,?)').run(operationId,at,JSON.stringify(operation));
        for(const target of targets){const classification={classification:FACT_CONFLICT_TERMINAL,operationId,classifiedAt:at,rawPayloadSha256:expectedRunHashes[target.id],
          rawStatus:target.status,performanceEligible:false,learningEligible:false,netPnl:null,netR:null,reason:'USER_AUTHORIZED_CONFLICT_ISOLATION_NO_HISTORICAL_PNL_RECONSTRUCTION'};
          db.prepare('INSERT INTO execution_terminal_classifications(run_id,operation_id,classified_at,raw_payload_sha256,payload) VALUES(?,?,?,?,?)')
            .run(target.id,operationId,at,expectedRunHashes[target.id],JSON.stringify(classification));
          db.prepare('INSERT INTO execution_audit(run_id,event_type,created_at,payload) VALUES(?,?,?,?)').run(target.id,FACT_CONFLICT_TERMINAL,at,JSON.stringify(classification));}
        const historyRow=db.prepare("SELECT value FROM metadata WHERE key='strategy_performance_epoch_history'").get();
        const history=historyRow?JSON.parse(historyRow.value):[];need(Array.isArray(history),'OLD_EPOCH_HISTORY_UNKNOWN');
        setMetadata(db,'strategy_performance_epoch_history',history.some(e=>e.id===oldEpoch.id)?history:[...history,{...oldEpoch,endedAt:at,endReason:'CONTROLLED_SAFE_RESET',resetOperationId:operationId}],at);
        setMetadata(db,'active_strategy_performance_epoch',epoch,at);setMetadata(db,FORWARD_WINDOW_KEY,window,at);
        appendResetEvent(db,operationId,'DB_COMMITTED_LOCK_PENDING',{targetCount:8,oldEpochHash:expectedEpochHash,newEpochId:epoch.id,windowId:window.id},at);
        faultInjection?.('beforeCommit');for(const proof of pair)assertFreshZeroRisk(proof,now());
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      faultInjection?.('afterCommit');
    }else{
      operation=previous;
      need(previous.expectedExecutionHash===expectedExecutionHash&&previous.expectedEpochHash===expectedEpochHash&&RESET_TARGETS.every(id=>previous.expectedRunHashes[id]===expectedRunHashes[id]),'RESUME_REQUEST_CHANGED');
      need(JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value).id===previous.epoch.id,'RESUME_EPOCH_CHANGED');
      for(const saved of previous.backups)need(await fileHash(saved.path)===saved.sha256,'RESUME_BACKUP_CHANGED');
      need(db.prepare('SELECT COUNT(*) AS n FROM execution_terminal_classifications WHERE operation_id=?').get(operationId).n===8,'RESUME_CLASSIFICATION_INCOMPLETE');
      pair=await freshPair(riskReader,now);
    }
    for(const proof of pair)assertFreshZeroRisk(proof,now());
    await assertOffline(host,oldPid);
    const state=getLockState(lock,expectedLockHash,oldPid,archive);
    if(state==='OLD_PRESENT')renameSync(lock,archive);
    faultInjection?.('afterLockRetired');
    db.exec('BEGIN IMMEDIATE');try{appendResetEvent(db,operationId,'LOCK_RETIRED_RESOURCES_FINALIZING',{retiredLockSha256:expectedLockHash},now());db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    db.close();db=null;
    faultInjection?.('beforeGuardRelease');releaseGuard();releaseGuard=null;
    return{operationId,applied:!previous,resumed:!!previous,targetCount:8,backups:operation.backups,epoch:operation.epoch,window:operation.window,
      finalRiskProofs:pair,retiredLockSha256:expectedLockHash,maintenanceGuardReleased:true,
      startupAuthorized:false,note:'ROOT_MUST_RECHECK_FRESH_RISK_AND_START_EXACT_QA_CANDIDATE_ONCE'};
  }finally{db?.close();running.delete(file);/* failure intentionally retains the maintenance barrier and old/retired lock evidence */}
}
