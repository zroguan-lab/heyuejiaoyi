import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { BinanceTestnetTradingClient } from "../src/execution/binance-testnet-trading.js";
import { rotateDemoAccountEpoch } from "../src/execution/demo-account-epoch-reset.js";
import { acquireExecutionProcessLock } from "../src/execution/entry-fact-process-lock.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const expectedEpochId = argument("--expected-epoch");
  const operationId = argument("--operation-id");
  if (!expectedEpochId || !operationId) {
    throw new Error("用法: npm run demo:reset-epoch -- --expected-epoch <id> --operation-id <id>");
  }
  if (config.marketEnvironment !== "TESTNET") throw new Error("只允许对 Binance Demo/Testnet 开启账户重置纪元");
  // Hold the same fail-closed lock as the executor from signed account evidence
  // through COMMIT. A preflight exists check alone leaves a start/order race.
  const releaseProcessLock = acquireExecutionProcessLock(config.databasePath);
  let db = null;
  try {
    const client = new BinanceTestnetTradingClient({
      baseUrl: config.binanceBaseUrl,
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
      writeEnabled: false,
      allowedSymbols: [config.execution.canarySymbol],
      timeoutMs: config.requestTimeoutMs,
      recvWindow: config.execution.recvWindow,
    });
    const account = await client.fetchAccountOverview();
    const accountEvidence = {
      environment: account.environment,
      authority: account.authority,
      observedAt: Date.now(),
      positionMode: account.positionMode,
      availableBalance: account.availableBalance,
      totalWalletBalance: account.totalWalletBalance,
      positions: account.positions,
      openOrders: account.openOrders,
      openAlgoOrders: account.openAlgoOrders,
    };
    db = new DatabaseSync(config.databasePath);
    const result = rotateDemoAccountEpoch(db, { expectedEpochId, operationId, accountEvidence });
    console.log(JSON.stringify({
      ...result,
      accountEvidence: {
        environment: accountEvidence.environment,
        authority: accountEvidence.authority,
        observedAt: accountEvidence.observedAt,
        positionMode: accountEvidence.positionMode,
        availableBalance: accountEvidence.availableBalance,
        totalWalletBalance: accountEvidence.totalWalletBalance,
        positionCount: accountEvidence.positions.length,
        openOrderCount: accountEvidence.openOrders.length,
        openAlgoOrderCount: accountEvidence.openAlgoOrders.length,
      },
    }, null, 2));
  } finally {
    db?.close();
    releaseProcessLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
