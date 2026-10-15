import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { ResearchStore } from "./infrastructure/research-store.js";
import { BinanceTestnetTradingClient } from "./execution/binance-testnet-trading.js";
import { TestnetCanaryExecutor } from "./execution/testnet-canary-executor.js";
import { ORDER_PERMISSION_METADATA_KEY, probeTestnetOrderPermission } from "./execution/order-permission.js";
import { resolveExecutionAllowedSymbols } from "./execution/execution-symbols.js";

function usage() {
  return [
    "用法:",
    "  npm run canary -- status",
    "  npm run canary -- validate-permission",
    "  npm run canary -- prepare <signalId>",
    "  npm run canary -- prepare-operator [LONG|SHORT]",
    "  npm run canary -- execute <runId> <confirmationCode>",
    "  npm run canary -- close-operator <runId> \"一句话平仓原因\"",
    "  npm run canary -- close-run <runId> \"一句话平仓原因\"",
    "  npm run canary -- refresh-accounting <runId>",
    "  npm run canary -- reconcile [runId]",
    "  npm run canary -- emergency-stop [reason]",
    "  npm run canary -- clear-emergency-stop",
    "",
    "execute 只有在 BINANCE_TESTNET_EXECUTION_ENABLED=true 时才可能发送测试网订单。",
  ].join("\n");
}

function assertDryRunAccountIsClean(account, stage) {
  if (account.environment !== "TESTNET" || account.authority !== "BINANCE_TESTNET") {
    throw new Error(`${stage}: 账户事实源不是 Binance Testnet`);
  }
  if (account.positionMode !== "ONE_WAY") throw new Error(`${stage}: 账户必须保持单向持仓模式`);
  if (account.positions.length > 0) throw new Error(`${stage}: 检测到真实测试网仓位，拒绝权限验证`);
  if (account.openOrders.length > 0) throw new Error(`${stage}: 检测到真实测试网普通挂单，拒绝权限验证`);
  if (account.openAlgoOrders.length > 0) throw new Error(`${stage}: 检测到真实测试网条件挂单，拒绝权限验证`);
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  if (config.marketEnvironment !== "TESTNET") throw new Error("金丝雀执行工具只能连接 Binance Demo/Testnet");
  if (!config.execution.accountReadOnlyEnabled) throw new Error("必须先启用 BINANCE_TESTNET_ACCOUNT_READ_ONLY");
  const store = new ResearchStore(config.databasePath);
  await store.initialize();
  try {
    const executionAllowedSymbols = await resolveExecutionAllowedSymbols(store, config);
    const client = new BinanceTestnetTradingClient({
      baseUrl: config.binanceBaseUrl,
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
      writeEnabled: config.execution.orderSubmissionEnabled,
      allowedSymbols: executionAllowedSymbols,
      timeoutMs: config.requestTimeoutMs,
      recvWindow: config.execution.recvWindow,
    });
    const executor = new TestnetCanaryExecutor({
      client,
      store,
      enabled: config.execution.orderSubmissionEnabled,
      symbol: config.execution.canarySymbol,
      allowedSymbols: executionAllowedSymbols,
      margin: config.execution.canaryMargin,
      leverage: config.execution.canaryLeverage,
      maxNotionalOverageRate: config.execution.maxNotionalOverageRate,
      activeLimitMaxBps: config.costs.activeLimitMaxBps,
      pullbackEntryTtlMs: config.execution.pullbackEntryTtlMs,
      pollMs: config.execution.canaryPollMs,
      strategySource: config.execution.strategySource,
    });
    const [command = "status", first, second] = process.argv.slice(2);
    if (command === "status") {
      const [snapshot, account] = await Promise.all([executor.snapshot(), client.fetchAccountState(config.execution.canarySymbol)]);
      console.log(JSON.stringify({
        ...snapshot,
        account: {
          canTrade: account.canTrade,
          positionMode: account.positionMode,
          positionCount: account.positions.length,
          openOrderCount: account.openOrders.length,
          openAlgoOrderCount: account.openAlgoOrders.length,
          symbolConfig: account.symbolConfig,
        },
      }, null, 2));
      return;
    }
    if (command === "validate-permission") {
      const symbol = config.execution.canarySymbol;
      const before = await client.fetchAccountState(symbol);
      assertDryRunAccountIsClean(before, "验证前");
      let permissionAccepted = false;
      let probeError = null;
      try {
        const attestation = await probeTestnetOrderPermission({
          client,
          symbol,
          targetNotional: config.execution.canaryMargin * config.execution.canaryLeverage,
        });
        await store.setMetadata(ORDER_PERMISSION_METADATA_KEY, attestation);
        permissionAccepted = attestation.accepted === true;
      } catch (error) {
        probeError = error;
      }
      const after = await client.fetchAccountState(symbol);
      assertDryRunAccountIsClean(after, "验证后");
      console.log(JSON.stringify({
        environment: "TESTNET",
        endpoint: "/fapi/v1/order/test",
        submittedToMatchingEngine: false,
        permissionAccepted,
        accountCanTrade: after.canTrade,
        positionsBefore: before.positions.length,
        positionsAfter: after.positions.length,
        ordersBefore: before.openOrders.length + before.openAlgoOrders.length,
        ordersAfter: after.openOrders.length + after.openAlgoOrders.length,
        error: probeError ? {
          name: probeError.name,
          code: probeError.apiCode ?? probeError.code ?? null,
          message: String(probeError.message).slice(0, 220),
        } : null,
      }, null, 2));
      if (probeError) process.exitCode = 1;
      return;
    }
    if (command === "prepare") {
      if (!first) throw new Error("prepare 需要 signalId");
      console.log(JSON.stringify(await executor.prepare(first), null, 2));
      return;
    }
    if (command === "prepare-operator") {
      console.log(JSON.stringify(await executor.prepareOperatorCanary((first ?? "LONG").toUpperCase()), null, 2));
      return;
    }
    if (command === "execute") {
      if (!first || !second) throw new Error("execute 需要 runId 和 confirmationCode");
      console.log(JSON.stringify(await executor.execute(first, second), null, 2));
      return;
    }
    if (command === "close-operator") {
      if (!first || !second) throw new Error("close-operator 需要 runId 和一句话平仓原因");
      console.log(JSON.stringify(await executor.closeOperatorCanary(first, second), null, 2));
      return;
    }
    if (command === "close-run") {
      if (!first || !second) throw new Error("close-run 需要 runId 和一句话平仓原因");
      console.log(JSON.stringify(await executor.closeExecutionRun(first, second), null, 2));
      return;
    }
    if (command === "refresh-accounting") {
      if (!first) throw new Error("refresh-accounting 需要 runId");
      console.log(JSON.stringify(await executor.refreshClosedRunAccounting(first), null, 2));
      return;
    }
    if (command === "reconcile") {
      console.log(JSON.stringify(first ? await executor.reconcile(first) : await executor.reconcileAll(), null, 2));
      return;
    }
    if (command === "emergency-stop") {
      console.log(JSON.stringify(await executor.engageEmergencyStop(first ?? "MANUAL_CLI"), null, 2));
      return;
    }
    if (command === "clear-emergency-stop") {
      console.log(JSON.stringify(await executor.clearEmergencyStop(), null, 2));
      return;
    }
    throw new Error(usage());
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
