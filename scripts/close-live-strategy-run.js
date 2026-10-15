import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { loadDotEnv } from "../src/env.js";
import { loadConfig } from "../src/config.js";
import { BinanceTestnetTradingClient } from "../src/execution/binance-testnet-trading.js";
import { TestnetCanaryExecutor } from "../src/execution/testnet-canary-executor.js";
import { resolveExecutionAllowedSymbols } from "../src/execution/execution-symbols.js";
import { ResearchStore as LiveResearchStore } from "../src/infrastructure/research-store.js";

const ACTIVE_ALGO_STATUSES = new Set(["NEW", "PENDING", "TRIGGERING"]);
const CLOSEABLE_STATUSES = new Set(["OPEN_PROTECTED", "TP1_FILLED", "PROTECTION_INCOMPLETE", "OPERATOR_CLOSE_SUBMITTING", "OPERATOR_CLOSE_PENDING", "OPERATOR_CLOSE_UNKNOWN"]);
const TERMINAL_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);

export async function endpointReachable(apiUrl) {
  try {
    await fetch(apiUrl, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

function parseArguments(argv) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") {
      apply = true;
      continue;
    }
    if (!value.startsWith("--")) throw new Error(`无法识别参数：${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`参数缺少值：${value}`);
    values.set(value.slice(2), next);
    index += 1;
  }
  return { apply, values };
}

function readRun(databasePath, runId) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload FROM execution_runs WHERE id = ?").get(runId);
    return row ? JSON.parse(row.payload) : null;
  } finally {
    db.close();
  }
}

function approximatelyEqual(left, right, tolerance) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

export function validateCloseTarget({ run, account, expectedSymbol, expectedDirection, expectedQuantity }) {
  if (!run) throw new Error("找不到待平仓执行记录");
  if (run.id === undefined || run.symbol !== expectedSymbol) throw new Error("执行记录标的不符合显式确认");
  if (run.sourceType !== "SIGNAL" || run.performanceEligible !== true) throw new Error("目标不是有效的真实策略信号 run");
  if (!CLOSEABLE_STATUSES.has(run.status)) throw new Error(`执行记录状态 ${run.status} 不允许主动平仓`);
  if (run.plan?.direction !== expectedDirection) throw new Error("执行方向不符合显式确认");
  if (account?.environment !== "TESTNET" || account?.authority !== "BINANCE_TESTNET") throw new Error("账户事实源不是 Binance Demo/Testnet");
  if (account.positionMode !== "ONE_WAY") throw new Error("账户不是单向持仓模式");
  const positions = (account.positions ?? []).filter((position) => position.symbol === expectedSymbol);
  if (positions.length !== 1) throw new Error(`预期 ${expectedSymbol} 恰好一个仓位，实际 ${positions.length}`);
  const position = positions[0];
  const signedQuantity = Number(position.quantity);
  if (expectedDirection === "SHORT" && signedQuantity >= 0) throw new Error("目标不是空头仓位");
  if (expectedDirection === "LONG" && signedQuantity <= 0) throw new Error("目标不是多头仓位");
  const tolerance = Number(run.plan?.rules?.stepSize ?? 0) / 2;
  if (!approximatelyEqual(Math.abs(signedQuantity), expectedQuantity, Math.max(tolerance, 1e-12))) {
    throw new Error(`仓位数量 ${Math.abs(signedQuantity)} 与确认数量 ${expectedQuantity} 不一致`);
  }
  if (position.marginType && String(position.marginType).toUpperCase() !== "ISOLATED") throw new Error("目标仓位不是逐仓模式");
  const stopIds = new Set([run.plan?.clientIds?.stop, run.plan?.clientIds?.breakEvenStop].filter(Boolean).map(String));
  const activeStop = (account.openAlgoOrders ?? []).find((order) => order.symbol === expectedSymbol
    && stopIds.has(String(order.clientAlgoId))
    && order.type === "STOP_MARKET"
    && order.closePosition === true
    && ACTIVE_ALGO_STATUSES.has(order.status));
  if (!activeStop) throw new Error("目标仓位没有可验证的活动全量止损");
  const unknownOrdinary = (account.openOrders ?? []).filter((order) => order.symbol === expectedSymbol
    && order.clientOrderId !== run.plan?.clientIds?.operatorClose);
  if (unknownOrdinary.length) throw new Error("目标标的存在无法归属的普通挂单");
  return {
    runId: run.id,
    symbol: run.symbol,
    direction: run.plan.direction,
    status: run.status,
    signedQuantity,
    expectedQuantity,
    entryOrderId: run.entryOrder?.orderId ?? null,
    activeStopClientAlgoId: activeStop.clientAlgoId,
    activeAlgoOrderCount: (account.openAlgoOrders ?? []).filter((order) => order.symbol === expectedSymbol).length,
  };
}

export function validateCloseRecovery({ run, account, expectedSymbol, expectedDirection, expectedQuantity }) {
  if (!run || run.symbol !== expectedSymbol || run.plan?.direction !== expectedDirection) throw new Error("恢复对象与显式确认不一致");
  if (!String(run.status).startsWith("OPERATOR_CLOSE")) throw new Error("执行记录不处于主动平仓恢复状态");
  if (account?.environment !== "TESTNET" || account?.authority !== "BINANCE_TESTNET" || account.positionMode !== "ONE_WAY") {
    throw new Error("恢复时账户事实源或持仓模式不安全");
  }
  const closeOrder = run.operatorCloseOrder;
  const clientOrderId = run.plan?.clientIds?.operatorClose;
  if (!closeOrder?.orderId || !clientOrderId || closeOrder.clientOrderId !== clientOrderId) throw new Error("恢复时缺少已持久化的唯一平仓订单身份");
  if (closeOrder.status !== "FILLED" || closeOrder.reduceOnly !== true || closeOrder.side !== run.plan?.exitSide) {
    throw new Error("恢复时平仓订单不是已成交的 reduceOnly 退出单");
  }
  const tolerance = Number(run.plan?.rules?.stepSize ?? 0) / 2;
  if (!approximatelyEqual(Number(closeOrder.executedQuantity), expectedQuantity, Math.max(tolerance, 1e-12))) {
    throw new Error("恢复时平仓成交数量与显式确认不一致");
  }
  const residualPositions = (account.positions ?? []).filter((position) => position.symbol === expectedSymbol);
  if (residualPositions.length) throw new Error("恢复前目标仓位仍存在，拒绝仅做账务恢复");
  return {
    runId: run.id,
    symbol: run.symbol,
    direction: run.plan.direction,
    status: run.status,
    recovering: true,
    expectedQuantity,
    closeOrderId: closeOrder.orderId,
    closeClientOrderId: clientOrderId,
  };
}

async function createDatabaseBackup(databasePath, backupRoot) {
  await mkdir(backupRoot, { recursive: true });
  const backupDirectory = await mkdtemp(path.join(backupRoot, "manual-close-bch-"));
  const databaseBackupPath = path.join(backupDirectory, "research-before-close.sqlite");
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, databaseBackupPath);
  } finally {
    source.close();
  }
  return { backupDirectory, databaseBackupPath };
}

async function waitForTerminal(executor, runId, { attempts = 20, intervalMs = 500 } = {}) {
  let run = await executor.reconcile(runId);
  for (let attempt = 1; attempt < attempts && !TERMINAL_STATUSES.has(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    run = await executor.reconcile(runId);
  }
  return run;
}

export async function executeControlledClose({
  runId,
  expectedSymbol,
  expectedDirection,
  expectedQuantity,
  backupRoot,
  apiUrl = "http://127.0.0.1:3000/api/signals",
  confirmation,
  reason,
}) {
  loadDotEnv();
  const config = loadConfig();
  if (config.marketEnvironment !== "TESTNET") throw new Error("受控平仓只能连接 Binance Demo/Testnet");
  if (!config.execution.accountReadOnlyEnabled || !config.execution.orderSubmissionEnabled) throw new Error("测试网读写权限未同时启用");
  if (!reason) throw new Error("受控平仓必须提供 --reason 一句话平仓原因");
  if (confirmation !== `CLOSE_${expectedSymbol}_${runId}`) throw new Error("受控平仓确认口令不匹配");
  if (await endpointReachable(apiUrl)) throw new Error("线上服务仍在运行，拒绝与账户轮询并发写入");

  const runBefore = readRun(config.databasePath, runId);
  if (!runBefore) throw new Error(`找不到执行记录 ${runId}`);
  const allowedSymbols = [...new Set([
    ...(await (async () => {
      const temporaryStore = new LiveResearchStore(config.databasePath);
      await temporaryStore.initialize();
      try {
        return await resolveExecutionAllowedSymbols(temporaryStore, config);
      } finally {
        temporaryStore.close();
      }
    })()),
    runBefore.symbol,
  ])];
  const client = new BinanceTestnetTradingClient({
    baseUrl: config.binanceBaseUrl,
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
    writeEnabled: true,
    allowedSymbols,
    timeoutMs: config.requestTimeoutMs,
    recvWindow: config.execution.recvWindow,
  });
  const accountBefore = await client.fetchAccountState(expectedSymbol);
  const recovering = String(runBefore.status).startsWith("OPERATOR_CLOSE") && Boolean(runBefore.operatorCloseOrder?.orderId);
  const target = recovering
    ? validateCloseRecovery({ run: runBefore, account: accountBefore, expectedSymbol, expectedDirection, expectedQuantity })
    : validateCloseTarget({ run: runBefore, account: accountBefore, expectedSymbol, expectedDirection, expectedQuantity });
  const backupInfo = await createDatabaseBackup(config.databasePath, backupRoot);
  const receiptPath = path.join(backupInfo.backupDirectory, "manual-close-receipt.json");
  const store = new LiveResearchStore(config.databasePath);
  await store.initialize();
  try {
    const executor = new TestnetCanaryExecutor({
      client,
      store,
      enabled: true,
      symbol: config.execution.canarySymbol,
      allowedSymbols,
      margin: config.execution.canaryMargin,
      leverage: config.execution.canaryLeverage,
      maxNotionalOverageRate: config.execution.maxNotionalOverageRate,
      pollMs: config.execution.canaryPollMs,
    });
    let run;
    try {
      run = await executor.closeExecutionRun(runId, reason);
      if (!TERMINAL_STATUSES.has(run.status)) run = await waitForTerminal(executor, runId);
      const accountAfter = await client.fetchAccountState(expectedSymbol);
      const residual = {
        positions: accountAfter.positions.filter((item) => item.symbol === expectedSymbol).length,
        openOrders: accountAfter.openOrders.filter((item) => item.symbol === expectedSymbol).length,
        openAlgoOrders: accountAfter.openAlgoOrders.filter((item) => item.symbol === expectedSymbol).length,
      };
      const receipt = {
        version: 1,
        status: run.status,
        completedAt: new Date().toISOString(),
        target,
        closeOrder: run.operatorCloseOrder ? {
          orderId: run.operatorCloseOrder.orderId,
          clientOrderId: run.operatorCloseOrder.clientOrderId,
          status: run.operatorCloseOrder.status,
          executedQuantity: run.operatorCloseOrder.executedQuantity,
          averagePrice: run.operatorCloseOrder.averagePrice,
          reduceOnly: run.operatorCloseOrder.reduceOnly,
        } : null,
        accounting: run.result ? {
          reason: run.result.reason,
          accountingComplete: run.result.accountingComplete,
          tradeCount: run.result.trades?.length ?? 0,
          ownedOrderIds: run.result.ownedOrderIds ?? [],
          realizedPnl: run.result.realizedPnl,
          commission: run.result.commission,
          netPnl: run.result.netPnl,
        } : null,
        residual,
        databaseBackupPath: backupInfo.databaseBackupPath,
      };
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
      if (!TERMINAL_STATUSES.has(run.status) || residual.positions || residual.openOrders || residual.openAlgoOrders) {
        throw new Error(`受控平仓尚未完成闭环：状态 ${run.status}，残余 ${JSON.stringify(residual)}`);
      }
      return { ...receipt, receiptPath };
    } catch (error) {
      const currentRun = await store.getExecutionRun(runId);
      const receipt = {
        version: 1,
        status: "ATTENTION_REQUIRED",
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        runStatus: currentRun?.status ?? null,
        closeClientOrderId: currentRun?.plan?.clientIds?.operatorClose ?? null,
        closeOrderId: currentRun?.operatorCloseOrder?.orderId ?? null,
        databaseBackupPath: backupInfo.databaseBackupPath,
      };
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
      throw error;
    }
  } finally {
    store.close();
  }
}

async function dryRun({ runId, expectedSymbol, expectedDirection, expectedQuantity }) {
  loadDotEnv();
  const config = loadConfig();
  const run = readRun(config.databasePath, runId);
  const allowedSymbols = [...new Set([config.execution.canarySymbol, ...(config.symbols ?? []), expectedSymbol])];
  const client = new BinanceTestnetTradingClient({
    baseUrl: config.binanceBaseUrl,
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
    writeEnabled: false,
    allowedSymbols,
    timeoutMs: config.requestTimeoutMs,
    recvWindow: config.execution.recvWindow,
  });
  const account = await client.fetchAccountState(expectedSymbol);
  return validateCloseTarget({ run, account, expectedSymbol, expectedDirection, expectedQuantity });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const { apply, values } = parseArguments(process.argv.slice(2));
  const runId = values.get("run-id");
  const expectedSymbol = values.get("expected-symbol");
  const expectedDirection = values.get("expected-direction");
  const expectedQuantity = Number(values.get("expected-quantity"));
  if (!runId || !expectedSymbol || !new Set(["LONG", "SHORT"]).has(expectedDirection) || !Number.isFinite(expectedQuantity) || expectedQuantity <= 0) {
    throw new Error("需要 --run-id、--expected-symbol、--expected-direction LONG|SHORT、--expected-quantity");
  }
  if (!apply) {
    const result = await dryRun({ runId, expectedSymbol, expectedDirection, expectedQuantity });
    console.log(JSON.stringify({ mode: "DRY_RUN", checkedAt: new Date().toISOString(), ready: true, target: result }, null, 2));
  } else {
    const backupRoot = values.get("backup-root");
    if (!backupRoot || !values.get("reason")) throw new Error("--apply 需要 --backup-root 和 --reason");
    const result = await executeControlledClose({
      runId,
      expectedSymbol,
      expectedDirection,
      expectedQuantity,
      backupRoot,
      apiUrl: values.get("api-url") ?? "http://127.0.0.1:3000/api/signals",
      confirmation: values.get("confirm"),
      reason: values.get("reason"),
    });
    console.log(JSON.stringify({ mode: "APPLY", ...result }, null, 2));
  }
}
