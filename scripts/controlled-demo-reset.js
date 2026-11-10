// Explicit maintenance entry. Default/import never reads credentials, files or DB.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createMaintenanceRiskReader } from '../src/execution/maintenance-risk-reader.js';
import { runControlledDemoReset } from '../src/execution/controlled-demo-reset.js';

export async function main(args=process.argv.slice(2),{env=process.env,host,now=Date.now,fetchImpl=globalThis.fetch}={}) {
  if(args[0]!=='apply')return{mode:'NOT_EXECUTED',startupAuthorized:false};
  try{
    const values={};
    for(let i=1;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1]||Object.hasOwn(values,args[i]))throw new Error('MAINTENANCE_ARGUMENTS_INVALID');values[args[i]]=args[i+1];}
    const required=['--plan','--database','--backups','--operation','--lock-sha','--old-pid','--release-manifest-sha'];
    if(required.some(k=>!values[k])||Object.keys(values).some(k=>![...required,'--base-commit'].includes(k)))throw new Error('MAINTENANCE_ARGUMENTS_INVALID');
    const plan=JSON.parse(readFileSync(resolve(values['--plan']),'utf8'));
    if(plan.task!=='TEAM-038'||!Array.isArray(plan.targets))throw new Error('MAINTENANCE_PLAN_INVALID');
    const reader=createMaintenanceRiskReader({apiKey:env.BINANCE_TESTNET_API_KEY,apiSecret:env.BINANCE_TESTNET_API_SECRET,fetchImpl,now});
    return await runControlledDemoReset({databasePath:resolve(values['--database']),backupDirectory:resolve(values['--backups']),operationId:values['--operation'],
      expectedRunHashes:Object.fromEntries(plan.targets.map(t=>[t.id,t.rawPayloadSha256])),expectedExecutionHash:plan.allRawIdStatusPayloadSha256,
      expectedEpochHash:plan.previousEpochRawSha256,expectedLockHash:values['--lock-sha'],oldPid:Number(values['--old-pid']),
      releaseManifestSha256:values['--release-manifest-sha'],releaseCommit:values['--base-commit']??null,riskReader:reader,now,...(host?{host}:{})});
  }catch(error){return{mode:'MAINTENANCE_STOPPED',code:/^[A-Z0-9_]{1,100}$/.test(error?.message)?error.message:'MAINTENANCE_FAILED',
    startupAuthorized:false,note:'PRESERVE_GUARD_AND_OPERATION_EVIDENCE; RESUME_SAME_OPERATION_WITH_FRESH_READER'};}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await main();process.stdout.write(JSON.stringify(result)+'\n');if(result.mode==='MAINTENANCE_STOPPED')process.exitCode=2;
}
