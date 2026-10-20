// Read-only local saved-fills research. No env loading, network, production imports or writes.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cutoff = Date.parse('2026-10-17T09:00:00Z');
const root = new URL('../../', import.meta.url);
const db = new DatabaseSync(fileURLToPath(new URL('data/research.sqlite', root)), { readOnly: true });
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const number = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-8);
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse = (row) => row ? JSON.parse(row.payload) : null;
const sourcePaths = ['src/config.js', 'src/domain/pre-move-strategy.js', 'src/domain/market-radar.js',
  'src/domain/shadow-v2.js', 'src/domain/risk.js', 'src/execution/testnet-canary-executor.js',
  'src/application/strategy-execution-coordinator.js', 'src/execution/execution-strategy-source.js'];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(p => [p, createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')]));
const stats = (rows) => {
  const wins = rows.filter(r => r.netPnl > 0), losses = rows.filter(r => r.netPnl < 0);
  const grossProfit = sum(wins.map(r => r.netPnl)), grossLoss = -sum(losses.map(r => r.netPnl));
  const validR = rows.filter(r => r.netR !== null);
  return { n: rows.length, wins: wins.length, losses: losses.length, flat: rows.length - wins.length - losses.length,
    netPnl: sum(rows.map(r => r.netPnl)), winRate: rows.length ? wins.length / rows.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    profitFactorStatus: grossLoss > 0 ? 'FINITE' : grossProfit > 0 ? 'NO_LOSSES_UNBOUNDED' : 'UNDEFINED',
    averageNetR: validR.length ? sum(validR.map(r => r.netR)) / validR.length : null,
    riskWeightedNetR: rows.length && rows.every(r=>r.initialRisk>0) ? sum(rows.map(r=>r.netPnl))/sum(rows.map(r=>r.initialRisk)) : null,
    netRCoverage: { valid: validR.length, total: rows.length },
    commission: rows.every(r => r.commission !== null) ? sum(rows.map(r => r.commission)) : null,
    fundingPnl: rows.every(r => r.fundingPnl !== null) ? sum(rows.map(r => r.fundingPnl)) : null };
};
const grouped = (rows, key) => [...new Set(rows.map(key))].sort().map(group => ({ group, ...stats(rows.filter(r => key(r) === group)), sampleStatus: 'DESCRIPTIVE_ONLY_LOW_SAMPLE' }));
const beforeHashes = sourceHashes();
try {
  db.exec('BEGIN');
  const observedAt = new Date().toISOString();
  const epoch = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='active_strategy_performance_epoch'").get().value);
  if (epoch.startedAt > cutoff) throw new Error('Epoch starts after the fixed cutoff');
  const all = db.prepare('SELECT payload FROM execution_runs WHERE created_at<=? ORDER BY created_at,id').all(cutoff).map(parse);
  const epochRuns = all.filter(r => r.createdAt >= epoch.startedAt && r.sourceType === 'SIGNAL'
    && (r.executionSource ?? r.plan?.executionSource) === epoch.strategySource
    && r.plan?.strategyVersion === epoch.strategyVersion && r.plan?.signalModelVersion === epoch.signalModelVersion);
  const eligible = epochRuns.filter(r => r.performanceEligible !== false);
  // Current mutable rows updated after the cutoff cannot be reconstructed as historical state here.
  const settled = eligible.filter(r => r.status === 'CLOSED' && r.result?.accountingComplete === true
    && r.updatedAt <= cutoff && finite(r.result?.netPnl) !== null);
  const rows = settled.map(r => {
    const trades = r.result.trades ?? [];
    const entry = trades.filter(t => String(t.orderId) === String(r.entryOrder?.orderId)
      && t.symbol === r.symbol && t.side === r.plan.entrySide);
    const owned = new Set((r.result.ownedOrderIds ?? []).map(String));
    const exit = trades.filter(t => owned.has(String(t.orderId)) && t.symbol === r.symbol && t.side === r.plan.exitSide);
    const qty = sum(entry.map(t => Number(t.quantity))), quote = sum(entry.map(t => Number(t.quantity) * Number(t.price)));
    const exitQty = sum(exit.map(t => Number(t.quantity))), exitQuote = sum(exit.map(t => Number(t.quantity) * Number(t.price)));
    const allFillTimesBeforeCutoff = trades.every(t => number(t.time) !== null && Number(t.time) <= cutoff);
    const fillIdsUnique = trades.every(t=>t.id !== null && t.id !== undefined)
      && new Set(trades.map(t=>`${t.symbol}:${t.id}`)).size === trades.length;
    const noUnownedFills = trades.every(t=>owned.has(String(t.orderId)) && t.symbol === r.symbol);
    const funding = Array.isArray(r.result.fundingIncome) ? r.result.fundingIncome : null;
    const fundingTimesBeforeCutoff = funding !== null && funding.every(f=>number(f.time)!==null && Number(f.time)<=cutoff);
    const fundingIdsUnique = funding !== null && funding.every(f=>f.transactionId!==undefined && f.transactionId!==null)
      && new Set(funding.map(f=>`${f.symbol}:${f.transactionId}:${f.incomeType}`)).size===funding.length;
    const entryValid = qty > 0 && near(qty, Number(r.entryOrder?.executedQuantity)) && allFillTimesBeforeCutoff && fillIdsUnique;
    const entryPrice = entryValid ? quote / qty : null;
    const stop = number(r.plan.prices.stopLoss), plannedEntry = number(r.plan.prices.entry);
    const risk = entryValid && stop !== null ? Math.abs(entryPrice - stop) * qty : null;
    const netPnl = r.result.netPnl, commission = finite(r.result.commission), fundingPnl = finite(r.result.fundingPnl);
    const realizedPnl = finite(r.result.realizedPnl);
    const fillCommission = trades.every(t=>finite(t.commission)!==null && t.commissionAsset==='USDT')
      ? sum(trades.map(t=>t.commission)) : null;
    const fillRealizedPnl = trades.every(t=>finite(t.realizedPnl)!==null) ? sum(trades.map(t=>t.realizedPnl)) : null;
    const independentlySummedFunding = funding!==null && funding.every(f=>finite(f.income)!==null && f.asset==='USDT'
      && f.incomeType==='FUNDING_FEE' && f.symbol===r.symbol) ? sum(funding.map(f=>f.income)) : null;
    const audits = db.prepare('SELECT event_type,created_at,payload FROM execution_audit WHERE run_id=? AND created_at<=? ORDER BY created_at,id').all(r.id, cutoff);
    const auto = audits.find(a => a.event_type === 'AUTO_EXECUTION_SELECTED');
    const intent = audits.find(a => a.event_type === 'ENTRY_INTENT_PERSISTED');
    const savedRadar = auto ? parse(auto).marketRadar : null;
    const radar = savedRadar ?? {};
    const radarChronologyPassed = !!auto && !!intent && auto.created_at <= intent.created_at
      && finite(radar.generatedAt) !== null && radar.generatedAt <= auto.created_at
      && finite(radar.moverDataClosedAt) !== null && radar.moverDataClosedAt <= radar.generatedAt;
    const sources = Array.isArray(radar.opportunitySources) ? [...new Set(radar.opportunitySources)].sort() : null;
    const featureNames = ['marketDirection','volumeRatio15m','volumeBuildRatio','compressionRatio',
      'nearestBoundaryAtr','rangePosition','structureWidthAtr','relativeStrengthBtc1h',
      'relativeStrengthEth1h','relativeStrengthMarket1h','return15m','return1h','return4h',
      'rankVelocity','rankPersistence','overextensionRisk','liquidityRank'];
    const features = Object.fromEntries(featureNames.map(k => [k, radarChronologyPassed ? radar[k] ?? null : null]));
    const eventCounts = Object.fromEntries([...new Set(audits.map(a => a.event_type))].map(k => [k, audits.filter(a => a.event_type === k).length]));
    const directionSign = r.plan.direction === 'LONG' ? 1 : -1;
    const exitPrice = exitQty > 0 ? exitQuote / exitQty : null;
    const accountingCompleteAuditAt = audits.find(a=>a.event_type==='CANARY_CLOSED' && parse(a).accountingComplete===true)?.created_at ?? null;
    return { id: r.id, signalId: r.signalId, symbol: r.symbol, direction: r.plan.direction,
      createdAt: r.createdAt, rowLastUpdatedAt: r.updatedAt, accountingCompleteAuditAt, closedAtSaved: r.performance?.closedAt ?? null,
      marketEventId: r.plan.marketEventId ?? null, score: r.plan.score ?? null,
      quantity: entryValid ? qty : null, exitQuantity: exitQty, entryPrice, exitPrice,
      entryFillFirstAt: entry.length ? Math.min(...entry.map(t=>Number(t.time))) : null,
      exitFillLastAt: exit.length ? Math.max(...exit.map(t=>Number(t.time))) : null,
      plannedEntry, stop, initialRisk: risk, netPnl, realizedPnl, commission, fundingPnl,
      netR: risk > 0 ? netPnl / risk : null,
      entryOrderId: r.entryOrder?.orderId ?? null, exitRole: r.result.exitRole ?? null,
      entryFactsMatch: entryValid, exitQuantityMatches: near(exitQty, qty),
      netIdentityMatches: realizedPnl !== null && commission !== null && fundingPnl !== null
        && near(realizedPnl - commission + fundingPnl, netPnl),
      rawFillAccountingMatches: near(fillCommission,commission) && near(fillRealizedPnl,realizedPnl)
        && near(independentlySummedFunding,fundingPnl),
      allFillTimesBeforeCutoff, fillIdsUnique, noUnownedFills, fundingTimesBeforeCutoff, fundingIdsUnique,
      fillCommission, fillRealizedPnl, independentlySummedFunding,
      geometricGrossPnl: entryValid && near(exitQty, qty) ? directionSign * (exitQuote - quote) : null,
      exitBeyondInitialStopAmount: entryValid && near(exitQty, qty) ? directionSign * (stop * qty - exitQuote) : null,
      entryPlannedVsActualDifference: entryValid ? directionSign * (entryPrice - plannedEntry) * qty : null,
      radarChronologyPassed, chronologyDoesNotEstablishFreshness: true,
      radarAgeMsAtEntryIntent: radarChronologyPassed ? intent.created_at-radar.generatedAt : null,
      marketDataAgeMsAtEntryIntent: radarChronologyPassed ? intent.created_at-radar.moverDataClosedAt : null,
      upstreamReceivedAt: null,
      radarAuditAt: auto?.created_at ?? null, entryIntentAt: intent?.created_at ?? null,
      radarGeneratedAt: radar.generatedAt ?? null, moverDataClosedAt: radar.moverDataClosedAt ?? null,
      sourceCombination: sources?.join(' + ') ?? 'MISSING', features,
      legacyExcursionAccepted: false, legacyExcursionReason: 'Historical path lineage not confirmed; do not infer from saved R extrema',
      eventCounts };
  });
  const featureKeys = rows.length ? Object.keys(rows[0].features) : [];
  const coverage = featureKeys.map(key => ({ field: key, source: 'execution_audit.AUTO_EXECUTION_SELECTED.marketRadar',
    valid: rows.filter(r => r.features[key] !== null).length, total: rows.length,
    savedChronologyValid: rows.filter(r => r.radarChronologyPassed && r.features[key] !== null).length }));
  const sorted = [...rows].sort((a,b) => a.accountingCompleteAuditAt - b.accountingCompleteAuditAt || a.id.localeCompare(b.id));
  let equity = epoch.startingEquity, peak = equity, maxDrawdown = 0, maxDrawdownAmount = 0;
  for (const r of sorted) { equity += r.netPnl; peak = Math.max(peak,equity); maxDrawdownAmount = Math.max(maxDrawdownAmount,peak-equity); maxDrawdown = Math.max(maxDrawdown,(peak-equity)/peak); }
  const sirenRow = rows.find(r=>r.id==='canary-a6f5c466164460');
  let sirenForensic = null;
  if (sirenRow) {
    const saved = settled.find(r=>r.id===sirenRow.id);
    const samples = db.prepare('SELECT synced_at,payload FROM testnet_account_snapshots WHERE synced_at>=? AND synced_at<=? ORDER BY synced_at')
      .all(sirenRow.entryFillFirstAt,Math.min(sirenRow.exitFillLastAt,cutoff)).flatMap(row=>{
        const p = parse(row).positions?.find(p=>p.symbol===sirenRow.symbol && number(p.quantity)!==null && Number(p.quantity)!==0);
        return p ? [{ syncedAt:row.synced_at,symbol:p.symbol,quantity:number(p.quantity),entryPrice:number(p.entryPrice),markPrice:number(p.markPrice) }] : [];
      });
    const audit = db.prepare('SELECT created_at,payload FROM execution_audit WHERE run_id=? AND event_type=? AND created_at<=? ORDER BY created_at')
      .all(sirenRow.id,'TAKE_PROFIT_PROTECTION_INCOMPLETE',cutoff);
    const messages = new Map();
    for (const a of audit) {
      const raw = parse(a).message ?? '';
      const label = raw.includes('-2021') ? 'HTTP400_-2021_ORDER_WOULD_IMMEDIATELY_TRIGGER'
        : raw.includes('takeProfit2') && raw.includes('REJECTED') ? 'TP2_NOT_ACTIVE_REJECTED' : 'OTHER_ERROR_REDACTED';
      const v = messages.get(label) ?? {label,count:0,firstAt:a.created_at,lastAt:a.created_at};
      v.count++;v.lastAt=a.created_at;messages.set(label,v);
    }
    sirenForensic = { id:sirenRow.id, scope:'POST_ENTRY_SAMPLED_MARKS_NOT_EXECUTABLE_QUOTES_OR_FULL_PATH',
      initialRisk:sirenRow.initialRisk,exitBeyondInitialStopAmount:sirenRow.exitBeyondInitialStopAmount,
      commission:sirenRow.commission,fundingPnl:sirenRow.fundingPnl,netPnl:sirenRow.netPnl,
      protection:Object.fromEntries(['stop','takeProfit1','takeProfit2','breakEvenStop'].map(role=>{
        const p=saved.protection?.[role];return [role,p?{status:p.status,type:p.type,side:p.side,
          triggerPrice:p.triggerPrice,quantity:p.quantity,actualOrderId:p.actualOrderId??null,updateTime:p.updateTime}:null];
      })),errorGroups:[...messages.values()],sampleCount:samples.length,
      selectedSampledMarks:[...new Map([...samples.slice(0,3),...samples.slice(-2)].map(s=>[s.syncedAt,s])).values()],
      executableBookAtTrigger:null,exactTriggerTime:null,opportunityLossFromMissingTP:null,
      causalClaim:'Mark/actual fill basis needs investigation; samples cannot establish executable profit or trigger latency.' };
  }
  const afterHashes = sourceHashes();
  const result = { observedAt, cutoff: new Date(cutoff).toISOString(), scope: 'LOCAL_SAVED_FILLS_NOT_EXCHANGE_RECONFIRMATION', epoch,
    layers: { allCreatedBeforeCutoff: all.length, currentEpochVersionModelSource: epochRuns.length,
      performanceEligible: eligible.length, settledCompleteBeforeCutoff: settled.length,
      otherCurrentRows: eligible.filter(r => !settled.includes(r)).map(r=>({id:r.id,symbol:r.symbol,
        statusAtObservation:r.status,updatedAt:r.updatedAt,stateAsOfCutoffConfirmed:r.updatedAt<=cutoff})) },
    baseline: stats(rows), sensitivityExcludingSirenDiagnosticOnly: stats(rows.filter(r => r.id !== 'canary-a6f5c466164460')),
    drawdown: { scope:'CLOSED_NET_PNL_BY_FIRST_ACCOUNTING_COMPLETE_AUDIT_NOT_MARK_TO_MARKET',startingEquity:epoch.startingEquity,
      endingEquity:equity,maxDrawdown,maxDrawdownAmount },
    factorCoverage: coverage, groups: { direction:grouped(rows,r=>r.direction),
      marketDirection:grouped(rows,r=>r.features.marketDirection??'MISSING'),
      sourceCombination:grouped(rows,r=>r.sourceCombination) },
    rows, sirenForensic, sourceHashesBefore:beforeHashes, sourceHashesAfter:afterHashes,
    sourceFilesUnchanged: hash(beforeHashes)===hash(afterHashes),
    rawSettledFinancialDigest:hash(settled.map(r=>[r.id,r.result.realizedPnl,r.result.commission,r.result.fundingPnl,r.result.netPnl])) };
  console.log(JSON.stringify(result,null,2));
  if (rows.some(r=>!r.entryFactsMatch||!r.exitQuantityMatches||!r.netIdentityMatches||!r.rawFillAccountingMatches
    ||!r.allFillTimesBeforeCutoff||!r.fillIdsUnique||!r.noUnownedFills||!r.fundingTimesBeforeCutoff||!r.fundingIdsUnique
    ||r.accountingCompleteAuditAt===null||!near(r.geometricGrossPnl,r.realizedPnl))
    || !result.sourceFilesUnchanged) process.exitCode=1;
} finally { db.exec('ROLLBACK'); db.close(); }
