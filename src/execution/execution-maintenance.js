import { createHash } from 'node:crypto';

export const FACT_CONFLICT_TERMINAL = 'FACT_CONFLICT_TERMINAL';
export const RESET_TARGETS = Object.freeze([
  'canary-03be6240ebfa41','canary-17ce3f97c4f896','canary-a0d02816302885','canary-b6c96cf708a5b7',
  'canary-d30304a49bb0ee','canary-ea36aab584f85c','canary-fe635b04fac6c3','canary-55ae2fec0749f5',
]);
export const sha256 = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const requireMaintenance = (condition,code) => {if(!condition)throw new Error(code);};

// Caller must own the execution/maintenance lease before any DDL. Original
// execution columns remain untouched; this flag is a derived index predicate.
export function installMaintenanceSchema(db) {
  const ownsTransaction=!db.isTransaction;
  if(ownsTransaction)db.exec('BEGIN IMMEDIATE');
  try {
  const columns=db.prepare('PRAGMA table_info(execution_runs)').all();
  if(!columns.some(c=>c.name==='maintenance_terminal'))db.exec('ALTER TABLE execution_runs ADD COLUMN maintenance_terminal INTEGER NOT NULL DEFAULT 0 CHECK(maintenance_terminal IN (0,1))');
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_reset_operations (
      operation_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_reset_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES execution_reset_operations(operation_id),
      event_type TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_terminal_classifications (
      run_id TEXT PRIMARY KEY REFERENCES execution_runs(id), operation_id TEXT NOT NULL REFERENCES execution_reset_operations(operation_id),
      classified_at INTEGER NOT NULL, raw_payload_sha256 TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS execution_classification_no_update BEFORE UPDATE ON execution_terminal_classifications
      BEGIN SELECT RAISE(ABORT,'terminal classification is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_classification_no_delete BEFORE DELETE ON execution_terminal_classifications
      BEGIN SELECT RAISE(ABORT,'terminal classification is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_classification_no_replace BEFORE INSERT ON execution_terminal_classifications
      WHEN EXISTS(SELECT 1 FROM execution_terminal_classifications WHERE run_id=NEW.run_id)
      BEGIN SELECT RAISE(ABORT,'terminal classification already exists'); END;
    CREATE TRIGGER IF NOT EXISTS execution_classification_index AFTER INSERT ON execution_terminal_classifications
      BEGIN UPDATE execution_runs SET maintenance_terminal=1 WHERE id=NEW.run_id; END;
    CREATE TRIGGER IF NOT EXISTS execution_classified_no_update BEFORE UPDATE ON execution_runs
      WHEN OLD.maintenance_terminal=1
      BEGIN SELECT RAISE(ABORT,'classified original execution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_classified_no_delete BEFORE DELETE ON execution_runs
      WHEN OLD.maintenance_terminal=1
      BEGIN SELECT RAISE(ABORT,'classified original execution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS execution_classified_no_replace BEFORE INSERT ON execution_runs
      WHEN EXISTS(SELECT 1 FROM execution_terminal_classifications WHERE run_id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'classified original execution is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reset_operation_no_update BEFORE UPDATE ON execution_reset_operations
      BEGIN SELECT RAISE(ABORT,'reset operation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reset_operation_no_delete BEFORE DELETE ON execution_reset_operations
      BEGIN SELECT RAISE(ABORT,'reset operation is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reset_operation_no_replace BEFORE INSERT ON execution_reset_operations
      WHEN EXISTS(SELECT 1 FROM execution_reset_operations WHERE operation_id=NEW.operation_id)
      BEGIN SELECT RAISE(ABORT,'reset operation already exists'); END;
    CREATE TRIGGER IF NOT EXISTS reset_event_no_update BEFORE UPDATE ON execution_reset_events
      BEGIN SELECT RAISE(ABORT,'reset event is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reset_event_no_delete BEFORE DELETE ON execution_reset_events
      BEGIN SELECT RAISE(ABORT,'reset event is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reset_event_no_replace BEFORE INSERT ON execution_reset_events
      WHEN EXISTS(SELECT 1 FROM execution_reset_events WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'reset event already exists'); END;
    CREATE TRIGGER IF NOT EXISTS execution_derived_flag_insert BEFORE INSERT ON execution_runs
      WHEN NEW.maintenance_terminal<>0
      BEGIN SELECT RAISE(ABORT,'maintenance flag requires classification'); END;
    CREATE TRIGGER IF NOT EXISTS execution_derived_flag_update BEFORE UPDATE OF maintenance_terminal ON execution_runs
      WHEN NEW.maintenance_terminal<>0 AND NOT EXISTS(SELECT 1 FROM execution_terminal_classifications WHERE run_id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'maintenance flag requires classification'); END;
    DROP INDEX IF EXISTS execution_runs_single_active_idx;
    DROP INDEX IF EXISTS execution_runs_one_active_symbol_idx;
    CREATE UNIQUE INDEX execution_runs_one_active_symbol_idx ON execution_runs(symbol)
      WHERE maintenance_terminal=0 AND status NOT IN ('CLOSED','CANCELED','REJECTED','FAILED');
  `);
  assertMaintenanceConsistency(db);
  if(ownsTransaction)db.exec('COMMIT');
  }catch(error){if(ownsTransaction)db.exec('ROLLBACK');throw error;}
}

export function assertMaintenanceConsistency(db) {
  const inconsistent=db.prepare(`SELECT r.id FROM execution_runs r LEFT JOIN execution_terminal_classifications c ON c.run_id=r.id
    WHERE (r.maintenance_terminal=1 AND c.run_id IS NULL) OR (r.maintenance_terminal=0 AND c.run_id IS NOT NULL)`).all();
  requireMaintenance(inconsistent.length===0,'MAINTENANCE_OVERLAY_INDEX_CONFLICT');
}

export function effectiveExecutionRun(db,row) {
  if(!row)return null;
  const run=JSON.parse(row.payload);
  const classification=db.prepare('SELECT raw_payload_sha256,payload FROM execution_terminal_classifications WHERE run_id=?').get(run.id);
  if(!classification)return run;
  requireMaintenance(sha256(row.payload)===classification.raw_payload_sha256,'CLASSIFIED_RAW_PAYLOAD_CHANGED');
  return {...run,rawStatus:run.status,status:FACT_CONFLICT_TERMINAL,performanceEligible:false,learningEligible:false,
    executionQuality:'CONFLICT',terminalClassification:JSON.parse(classification.payload),
    result:{reason:FACT_CONFLICT_TERMINAL,accountingComplete:false,netPnl:null,netR:null,realizedPnl:null,commission:null,fundingPnl:null,
      trades:[],fundingIncome:[],ownedOrderIds:[]}};
}

export function rejectClassifiedWrite(db,runId) {
  requireMaintenance(!db.prepare('SELECT 1 FROM execution_terminal_classifications WHERE run_id=?').get(runId),'FACT_CONFLICT_TERMINAL_CANNOT_REOPEN');
}

export function appendResetEvent(db,operationId,eventType,payload,now) {
  db.prepare('INSERT INTO execution_reset_events(operation_id,event_type,created_at,payload) VALUES(?,?,?,?)')
    .run(operationId,eventType,now,JSON.stringify(payload));
}
