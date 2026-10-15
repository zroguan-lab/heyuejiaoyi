import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "../src/env.js";

test("公共只读进程可从.env只加载白名单变量", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-env-"));
  const file = path.join(root, ".env");
  await writeFile(file, "CODEX_TEST_PUBLIC_ENV=visible\nCODEX_TEST_SECRET_ENV=hidden\n");
  delete process.env.CODEX_TEST_PUBLIC_ENV;
  delete process.env.CODEX_TEST_SECRET_ENV;
  try {
    assert.equal(loadDotEnv(file, { allowedKeys: ["CODEX_TEST_PUBLIC_ENV"] }), true);
    assert.equal(process.env.CODEX_TEST_PUBLIC_ENV, "visible");
    assert.equal(process.env.CODEX_TEST_SECRET_ENV, undefined);
  } finally {
    delete process.env.CODEX_TEST_PUBLIC_ENV;
    delete process.env.CODEX_TEST_SECRET_ENV;
  }
});
