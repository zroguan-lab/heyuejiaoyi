import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireExecutionProcessLock } from '../src/execution/entry-fact-process-lock.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'team-011-process-lock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'isolated-fixture.sqlite');
}

test('TEAM-011 offline process lock blocks another process and supports explicit orderly handoff', t => {
  const database = fixture(t);
  const release = acquireExecutionProcessLock(database);
  const lockPath = `${database}.execution.lock`;
  const owned = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(owned.pid, process.pid);
  assert.ok(owned.token);
  const moduleUrl = new URL('../src/execution/entry-fact-process-lock.js', import.meta.url).href;
  const script = `import { acquireExecutionProcessLock } from ${JSON.stringify(moduleUrl)}; try { const release = acquireExecutionProcessLock(process.argv[1]); release(); process.exit(0); } catch { process.exit(23); }`;
  const second = spawnSync(process.execPath, ['--input-type=module', '-e', script, database], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(second.error);
  assert.equal(second.status, 23);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), owned);
  release();
  release();
  assert.equal(existsSync(lockPath), false);
  const next = spawnSync(process.execPath, ['--input-type=module', '-e', script, database], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(next.error);
  assert.equal(next.status, 0);
  assert.equal(existsSync(lockPath), false);
});

test('TEAM-011 stale process lock is never auto-reclaimed using PID or age', t => {
  const database = fixture(t);
  const lockPath = `${database}.execution.lock`;
  const stale = { pid: 2147483647, token: 'stale-offline-fixture', acquiredAt: 1 };
  writeFileSync(lockPath, JSON.stringify(stale));
  assert.throws(() => acquireExecutionProcessLock(database), /单实例锁/);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), stale);
});

test('TEAM-011 a changed lock owner cannot be released by an earlier owner', t => {
  const database = fixture(t);
  const release = acquireExecutionProcessLock(database);
  const lockPath = `${database}.execution.lock`;
  const otherOwner = { pid: process.pid, token: 'different-owner', acquiredAt: 1 };
  writeFileSync(lockPath, JSON.stringify(otherOwner));
  assert.throws(release, /所有者发生冲突/);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), otherOwner);
});

test('TEAM-011 in-memory fixture does not create a process lock', () => {
  const release = acquireExecutionProcessLock(':memory:');
  assert.doesNotThrow(release);
  assert.doesNotThrow(release);
});
