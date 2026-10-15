import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WindowsNotifier } from "../src/infrastructure/windows-notifier.js";

test("Windows通知使用参数数组启动固定脚本，不通过shell拼接内容", async () => {
  let call;
  const spawnImpl = (file, args, options) => {
    call = { file, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const notifier = new WindowsNotifier({ platform: "win32", spawnImpl });
  const result = await notifier.notify({ title: "BTC & <LONG>", body: "100; Stop-Process" });
  assert.equal(result.delivered, true);
  assert.equal(call.file, "powershell.exe");
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.args.includes("100; Stop-Process"), true);
  assert.equal(call.options.shell, undefined);
});
