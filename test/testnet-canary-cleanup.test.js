import test from "node:test";

test("TEAM031 CLI awaits only its registered resource cleanup and never asks for account or reconcile", async () => {
  let release, stopped = false, closed = false;
  const gate = new Promise(r => { release = r; });
  const executor = { async stop() { await gate; stopped = true; }, reconcile() { throw Error("must not reconcile"); } };
  const pending = runWithCanaryCleanup({ close() { closed = true; } }, async register => { register(executor); return "original result"; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); assert.equal(await pending, "original result"); assert.equal(stopped, true); assert.equal(closed, true);
});
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync } from "node:fs";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { runWithCanaryCleanup } from "../src/testnet-canary.js";
import { TestnetCanaryExecutor } from "../src/execution/testnet-canary-executor.js";
test("TEAM031 CLI preserves original action failure and reports independent cleanup failure", async () => {
  const original = Error("action original"); let closed = false;
  await assert.rejects(runWithCanaryCleanup({ close() { closed = true; } }, async register => {
    register({ async stop() { throw Error("ownership conflict"); } }); throw original;
  }), error => error === original && /ownership conflict/.test(error.cleanupError.message));
  assert.equal(closed, true);
});
test("TEAM016 CLI成功/失败/未知命令统一释放自己锁且关闭Store",async t=>{
  const root=mkdtempSync(join(tmpdir(),"team016-cli-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const outcome of ["success","failure","unknown"]){
    const path=join(root,outcome+".sqlite");writeFileSync(path,"fixture");let closed=false;
    const store={filePath:path,close(){closed=true;}};
    const executor=new TestnetCanaryExecutor({client:{},store,enabled:false});
    const action=runWithCanaryCleanup(store,async register=>{register(executor);executor.acquireProcessLock();
      assert.equal(existsSync(path+".execution.lock"),true);
      if(outcome!=="success")throw Error(outcome);return "ok";});
    if(outcome==='success')assert.equal(await action,"ok");else await assert.rejects(()=>action,new RegExp(outcome));
    assert.equal(closed,true);assert.equal(existsSync(path+".execution.lock"),false);
  }
  assert.equal(resolve(root).startsWith(resolve(tmpdir())),true);
});
test("TEAM016 CLI构造早期失败仍关闭Store，stop所有者冲突不移除他人锁",async t=>{
  let closed=false;
  await assert.rejects(()=>runWithCanaryCleanup({close(){closed=true;}},async()=>{throw Error('construct failure');}),/construct failure/);
  assert.equal(closed,true);
  const root=mkdtempSync(join(tmpdir(),"team016-owner-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,"fixture.sqlite");writeFileSync(path,"fixture");closed=false;
  const store={filePath:path,close(){closed=true;}},executor=new TestnetCanaryExecutor({client:{},store,enabled:false});
  await assert.rejects(()=>runWithCanaryCleanup(store,async register=>{
    register(executor);executor.acquireProcessLock();writeFileSync(path+".execution.lock",JSON.stringify({pid:99999,token:"other-owner"}));
  }),/所有者.*冲突/);
  assert.equal(closed,true);assert.equal(JSON.parse(readFileSync(path+".execution.lock","utf8")).pid,99999);
  assert.equal(resolve(root).startsWith(resolve(tmpdir())),true);
});
