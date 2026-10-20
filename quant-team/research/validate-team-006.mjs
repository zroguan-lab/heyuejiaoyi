// Only SELECT on the existing local DB. No Store initialization, env, network, orders or file writes.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateVolumeConfirmation } from '../../src/research/single-variable-validation.js';

const cutoff = Date.now();
const protocol = JSON.parse(readFileSync(new URL('./TEAM-006-volume-confirmation-protocol.json',import.meta.url),'utf8'));
const db = new DatabaseSync(fileURLToPath(new URL('../../data/research.sqlite',import.meta.url)),{readOnly:true});
try {
  db.exec('BEGIN');
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_snapshots'").get();
  if (!exists) {
    console.log(JSON.stringify({protocolId:protocol.protocolId,observedAt:new Date(cutoff).toISOString(),
      status:'NOT_DEPLOYED_SNAPSHOT_SCHEMA_ABSENT',forwardSnapshotCount:null,
      orderSubmissionAllowed:false,promotionAllowed:false,
      reason:'Code/fixture availability is not runtime deployment. Existing mutable history was not backfilled.'},null,2));
  } else {
    // No LIMIT: silently clipping to the latest winners would change the registered population.
    const snapshots=db.prepare('SELECT payload FROM decision_snapshots WHERE captured_at>=? AND captured_at<=? ORDER BY captured_at,snapshot_id')
      .all(Date.parse(protocol.registeredAt),cutoff).map(r=>JSON.parse(r.payload));
    const executions=db.prepare('SELECT payload FROM execution_runs WHERE created_at>=? AND created_at<=? ORDER BY created_at,id')
      .all(Date.parse(protocol.registeredAt),cutoff).map(r=>JSON.parse(r.payload));
    console.log(JSON.stringify(validateVolumeConfirmation({snapshots,executions,protocol,cutoff}),null,2));
  }
} finally { db.exec('ROLLBACK');db.close(); }
