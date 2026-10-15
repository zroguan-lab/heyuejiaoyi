import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionAllowedSymbols } from "../src/execution/execution-symbols.js";

test("动态雷达换池后仍把所有活动执行标的保留在交易白名单", async () => {
  const store = {
    async getMetadata(key) {
      if (key === "universe") return { value: { items: [{ symbol: "BTCUSDT" }] } };
      if (key === "market_radar") return { value: { items: [{ symbol: "ETHUSDT" }] } };
      return null;
    },
    async listActiveExecutionRuns() {
      return [{ symbol: "GTCUSDT", status: "OPEN_PROTECTED" }];
    },
  };
  const symbols = await resolveExecutionAllowedSymbols(store, {
    symbols: ["SOLUSDT"],
    execution: { canarySymbol: "BTCUSDT" },
  });
  assert.deepEqual(symbols, ["BTCUSDT", "SOLUSDT", "ETHUSDT", "GTCUSDT"]);
});
