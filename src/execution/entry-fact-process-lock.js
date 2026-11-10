import { openSync, readFileSync, writeFileSync, closeSync, unlinkSync, realpathSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// Fail closed after a crash: a stale lock needs an explicit, offline operator
// handoff. A timeout or a reused PID is never evidence that an owner is dead.
export function acquireExecutionProcessLock(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath === ":memory:") return () => {};
  let databasePath;
  try { databasePath = realpathSync(filePath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    databasePath = resolve(filePath);
  }
  const lockPath = `${databasePath}.execution.lock`;
  if (existsSync(`${databasePath}.maintenance.lock`)) throw new Error('受控维护仍持有数据库，禁止启动执行实例');
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("执行数据库已有单实例锁；必须先完成受控进程交接，禁止并行执行器");
    throw error;
  }
  // Only PID, random ownership token and time are stored, never credentials.
  try {
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() }));
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(lockPath, "utf8"));
    if (current.token !== token || current.pid !== process.pid) throw new Error("单实例锁所有者发生冲突，拒绝释放");
    unlinkSync(lockPath);
    released = true;
  };
}

const storeLeases=new WeakMap();
export function acquireStoreExecutionLease(store) {
  if(storeLeases.has(store))return;
  storeLeases.set(store,acquireExecutionProcessLock(store.filePath));
}
export function borrowStoreExecutionLease(store) {
  if(!storeLeases.has(store))throw new Error('Store does not own an execution lease');
  // The database owner releases only after close. Executor stop cannot expose an
  // unlocked, still-open Store. Another Store never receives this capability.
  return ()=>{};
}
export function releaseStoreExecutionLease(store) {
  const release=storeLeases.get(store);if(!release)return;
  release();storeLeases.delete(store);
}
