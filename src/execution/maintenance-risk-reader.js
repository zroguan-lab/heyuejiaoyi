import { createHash, createHmac } from 'node:crypto';

const ORIGIN='https://demo-fapi.binance.com';
const PATHS=['/fapi/v1/time','/fapi/v3/account','/fapi/v3/positionRisk','/fapi/v1/openOrders','/fapi/v1/openAlgoOrders','/fapi/v1/positionSide/dual','/fapi/v1/symbolConfig'];
const readers=new WeakMap();
const fail=code=>{throw new Error(code);};
const number=v=>(typeof v==='number'||typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v))&&Number.isFinite(Number(v))?Number(v):null;
const hash=v=>createHash('sha256').update(v).digest('hex');

// No file/config/env input or static evidence mode. Only fixed Demo GETs.
// fetchImpl/clock are DI seams for isolated tests; production defaults to fetch.
export function createMaintenanceRiskReader({apiKey,apiSecret,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof apiKey!=='string'||!apiKey||typeof apiSecret!=='string'||!apiSecret||typeof fetchImpl!=='function')fail('MAINTENANCE_READER_CREDENTIALS_REQUIRED');
  let requests=0,poisoned=false,createdAt=null,inFlight=false;
  const reader=Object.freeze({async read(){
    if(inFlight)fail('MAINTENANCE_READER_CONCURRENT_READ');
    inFlight=true;
    try {
    createdAt??=now();
    if(poisoned||requests+7>30)fail('MAINTENANCE_READER_BUDGET_OR_BLOCK');
    const began=now(),raw=[],trace=[];let offset=0;
    for(const path of PATHS) {
      if(requests>=30)fail('MAINTENANCE_READER_BUDGET_OR_BLOCK');
      if(now()-createdAt>=90_000)fail('MAINTENANCE_READER_DEADLINE');
      const url=new URL(path,ORIGIN),isTime=path===PATHS[0];
      if(path===PATHS[4])url.searchParams.set('algoType','CONDITIONAL');
      if(!isTime){url.searchParams.set('recvWindow','5000');url.searchParams.set('timestamp',String(Math.trunc(now()+offset)));
        url.searchParams.set('signature',createHmac('sha256',apiSecret).update(url.searchParams.toString()).digest('hex'));}
      const start=now(),controller=new AbortController();let timer;
      requests++;
      try {
        const work=(async()=>{
          const response=await fetchImpl(url,{method:'GET',redirect:'error',cache:'no-store',headers:isTime?{accept:'application/json'}:{accept:'application/json','X-MBX-APIKEY':apiKey},signal:controller.signal});
          if(response?.status===418||response?.status===429){poisoned=true;fail('MAINTENANCE_READER_RATE_STOP');}
          if(response?.redirected)fail('MAINTENANCE_READER_REDIRECT');
          const text=await response.text();if(typeof text!=='string'||Buffer.byteLength(text)>2_000_000)fail('MAINTENANCE_READER_BODY_UNKNOWN');
          let body;try{body=JSON.parse(text);}catch{fail('MAINTENANCE_READER_JSON_UNKNOWN');}
          if(body?.code===-1003){poisoned=true;fail('MAINTENANCE_READER_RATE_STOP');}
          if(response.ok!==true||typeof body?.code==='number'&&body.code<0)fail('MAINTENANCE_READER_HTTP_UNKNOWN');
          return body;
        })();
        const body=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('MAINTENANCE_READER_TIMEOUT'));},Math.min(8_000,90_000-(now()-createdAt)));})]);
        if(now()<start||now()-start>8_000||now()-createdAt>=90_000)fail('MAINTENANCE_READER_TIME_UNKNOWN');
        if(isTime){if(!Number.isSafeInteger(body?.serverTime)||body.serverTime<=0)fail('MAINTENANCE_SERVER_TIME_UNKNOWN');offset=body.serverTime-now();}
        raw.push(body);trace.push({path,requestStartedAt:start,responseReceivedAt:now(),success:true});
      }catch(error){throw new Error(/^MAINTENANCE_[A-Z_]+$/.test(error?.message)?error.message:'MAINTENANCE_GET_UNKNOWN');}
      finally{clearTimeout(timer);}
    }
    const positions=raw[2],ordinary=raw[3],algos=raw[4];
    if(!Array.isArray(positions)||!Array.isArray(ordinary)||!Array.isArray(algos)||raw[5]?.dualSidePosition!==false
      ||!raw[1]||typeof raw[1]!=='object'||!Array.isArray(raw[6]))fail('MAINTENANCE_RISK_SCOPE_UNKNOWN');
    const positionKnown=positions.every(p=>p&&typeof p.symbol==='string'&&p.symbol.length>0&&p.positionSide==='BOTH'&&number(p.positionAmt)!==null);
    const orderKnown=(xs,id,client)=>xs.every(o=>o&&typeof o.symbol==='string'&&o.symbol.length>0
      &&(typeof o[id]==='string'&&/^[1-9][0-9]*$/.test(o[id])||Number.isSafeInteger(o[id])&&o[id]>0)&&typeof o[client]==='string'&&o[client].length>0);
    if(!positionKnown||new Set(positions.map(p=>p.symbol)).size!==positions.length||!orderKnown(ordinary,'orderId','clientOrderId')||!orderKnown(algos,'algoId','clientAlgoId'))fail('MAINTENANCE_RISK_IDENTITY_UNKNOWN');
    return {environment:'TESTNET',origin:ORIGIN,positionMode:'ONE_WAY',scope:'FULL_ACCOUNT_UNFILTERED',startedAt:began,observedAt:now(),requests:trace,
      counts:{positions:positions.filter(p=>number(p.positionAmt)!==0).length,ordinaryOrders:ordinary.length,algoOrders:algos.length},
      permissionKnown:typeof raw[1].canTrade==='boolean',canTrade:typeof raw[1].canTrade==='boolean'?raw[1].canTrade:null,
      configs:{responseLength:raw[6].length,unknownSymbols:raw[6].filter(c=>typeof c?.symbol!=='string'||!/^[A-Z0-9][A-Z0-9_]{0,63}$/.test(c.symbol)).length},
      limitation:'ZERO_EXPOSURE_MAINTENANCE_ONLY_NOT_ONLINE_READINESS_PERMISSION'};
    }finally{inFlight=false;}
  }});
  readers.set(reader,{fingerprint:hash(hash(apiKey))});return reader;
}
export function maintenanceReaderFingerprint(reader){const value=readers.get(reader);if(!value)fail('LIVE_MAINTENANCE_READER_REQUIRED');return value.fingerprint;}

export function assertFreshZeroRisk(proof,now) {
  const timestamp=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
  if(proof?.environment!=='TESTNET'||proof.origin!==ORIGIN||proof.scope!=='FULL_ACCOUNT_UNFILTERED'||proof.positionMode!=='ONE_WAY'
    ||!timestamp(now)||!timestamp(proof.startedAt)||!timestamp(proof.observedAt)||proof.observedAt<proof.startedAt||proof.observedAt>now||now-proof.startedAt>45_000
    ||!Array.isArray(proof.requests)||proof.requests.length!==7||PATHS.some((p,i)=>proof.requests[i]?.path!==p||proof.requests[i].success!==true
      ||!timestamp(proof.requests[i].requestStartedAt)||!timestamp(proof.requests[i].responseReceivedAt)
      ||proof.requests[i].requestStartedAt<proof.startedAt||proof.requests[i].responseReceivedAt<proof.requests[i].requestStartedAt||proof.requests[i].responseReceivedAt>proof.observedAt)
    ||proof.counts?.positions!==0||proof.counts?.ordinaryOrders!==0||proof.counts?.algoOrders!==0)fail('FRESH_DOUBLE_ZERO_RISK_REQUIRED');
}
