import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { BinanceTestnetTradingClient, TESTNET_ORIGIN } from "../../src/execution/binance-testnet-trading.js";

const TARGET_RUN_IDS = Object.freeze([
  "canary-c4391d56e84765",
  "canary-e97a7a9e055072",
  "canary-e20009b1aa9f50",
  "canary-5adea23ec1d05c",
]);

const ALLOWED_PATHS = new Set([
  "/fapi/v1/time",
  "/fapi/v1/order",
  "/fapi/v1/userTrades",
  "/fapi/v1/income",
  "/fapi/v1/algoOrder",
  "/fapi/v3/positionRisk",
  "/fapi/v1/openOrders",
  "/fapi/v1/openAlgoOrders",
]);

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label}响应不是数组`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}响应不是对象`);
  return value;
}

function safeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    code: error?.apiCode ?? error?.code ?? null,
    causeCode: error?.cause?.code ?? error?.cause?.cause?.code ?? null,
  };
}

function positiveId(value) {
  const normalized = String(value ?? "");
  return /^\d+$/.test(normalized) && normalized !== "0" ? normalized : null;
}

function stringId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function summarizeOrder(order) {
  if (!order || typeof order !== "object") return null;
  return {
    symbol: order.symbol ?? null,
    orderId: positiveId(order.orderId),
    clientOrderId: stringId(order.clientOrderId),
    side: order.side ?? null,
    type: order.type ?? null,
    status: order.status ?? null,
    originalQuantity: finite(order.origQty ?? order.originalQuantity),
    executedQuantity: finite(order.executedQty ?? order.executedQuantity ?? order.cumQty),
    averagePrice: finite(order.avgPrice ?? order.averagePrice),
    cumulativeQuote: finite(order.cumQuote ?? order.cumulativeQuote),
    reduceOnly: order.reduceOnly === true || order.reduceOnly === "true",
    updateTime: finite(order.updateTime ?? order.time),
  };
}

function summarizeTrade(row) {
  return {
    id: stringId(row?.id),
    orderId: positiveId(row?.orderId),
    symbol: row?.symbol ?? null,
    side: row?.side ?? null,
    price: finite(row?.price),
    quantity: finite(row?.qty ?? row?.quantity),
    quoteQuantity: finite(row?.quoteQty ?? row?.quoteQuantity),
    commission: finite(row?.commission),
    commissionAsset: row?.commissionAsset ?? null,
    realizedPnl: finite(row?.realizedPnl),
    time: finite(row?.time),
  };
}

function summarizeIncome(row) {
  return {
    symbol: row?.symbol ?? null,
    incomeType: row?.incomeType ?? null,
    income: finite(row?.income),
    asset: row?.asset ?? null,
    time: finite(row?.time),
    transactionId: stringId(row?.tranId ?? row?.transactionId),
    tradeId: stringId(row?.tradeId),
  };
}

function summarizeAlgo(order) {
  if (!order || typeof order !== "object") return null;
  return {
    symbol: order.symbol ?? null,
    algoId: positiveId(order.algoId),
    clientAlgoId: stringId(order.clientAlgoId),
    side: order.side ?? null,
    type: order.orderType ?? order.type ?? null,
    status: order.algoStatus ?? order.status ?? null,
    quantity: finite(order.quantity),
    actualQuantity: finite(order.actualQty ?? order.actualQuantity),
    actualOrderId: positiveId(order.actualOrderId),
    actualPrice: finite(order.actualPrice),
    triggerPrice: finite(order.triggerPrice),
    updateTime: finite(order.updateTime ?? order.createTime),
  };
}

function candidateClientAlgoIds(run) {
  const values = new Set();
  const add = (value) => {
    const id = stringId(value);
    if (id) values.add(id);
  };
  for (const [key, value] of Object.entries(run?.plan?.clientIds ?? {})) {
    if (/stop|tp|break|algo/i.test(key)) add(value);
  }
  for (const protection of Object.values(run?.protection ?? {})) {
    if (!protection || typeof protection !== "object") continue;
    add(protection.clientAlgoId);
    add(protection.originalClientAlgoId);
    for (const id of protection.clientAlgoIds ?? []) add(id);
    for (const item of protection.history ?? []) add(item?.clientAlgoId);
  }
  return [...values];
}

function loadLocalEvidence() {
  const db = new DatabaseSync(resolve("data/research.sqlite"), { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN;");
    const statement = db.prepare("SELECT payload FROM execution_runs WHERE id = ?");
    const runs = TARGET_RUN_IDS.map((id) => {
      const row = statement.get(id);
      if (!row) throw new Error(`缺少目标执行记录: ${id}`);
      return JSON.parse(row.payload);
    });
    const permissionRow = db.prepare("SELECT value, updated_at AS updatedAt FROM metadata WHERE key = ?")
      .get("binance_testnet_order_test_permission");
    db.exec("COMMIT;");
    return {
      runs,
      permissionAttestation: permissionRow ? {
        value: JSON.parse(permissionRow.value),
        updatedAt: finite(permissionRow.updatedAt),
      } : null,
    };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

const nativeFetch = globalThis.fetch;
async function getOnlyFetch(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = String(init.method ?? (typeof input === "object" ? input.method : "GET") ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error("TEAM-011诊断网络层拒绝非GET请求");
  if (url.origin !== TESTNET_ORIGIN) throw new Error("TEAM-011诊断网络层拒绝非Demo域名");
  if (!ALLOWED_PATHS.has(url.pathname)) throw new Error("TEAM-011诊断网络层拒绝非白名单端点");
  return await nativeFetch(input, { ...init, redirect: "error" });
}

async function capture(label, operation) {
  try {
    return { label, ok: true, value: await operation() };
  } catch (error) {
    return { label, ok: false, error: safeError(error) };
  }
}

async function main() {
  if (!process.env.BINANCE_TESTNET_API_KEY || !process.env.BINANCE_TESTNET_API_SECRET) {
    throw new Error("TEAM-011诊断缺少Demo只读签名凭据");
  }

  const { runs, permissionAttestation } = loadLocalEvidence();
  const symbols = [...new Set(runs.map((run) => run.symbol))];
  const client = new BinanceTestnetTradingClient({
    baseUrl: TESTNET_ORIGIN,
    apiKey: process.env.BINANCE_TESTNET_API_KEY,
    apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
    writeEnabled: false,
    allowedSymbols: symbols,
    timeoutMs: 15_000,
    recvWindow: 5_000,
    fetchImpl: getOnlyFetch,
  });

  const report = {
    authority: "BINANCE_DEMO_SIGNED_GET",
    capturedAt: Date.now(),
    networkGuard: { origin: TESTNET_ORIGIN, method: "GET_ONLY", paths: [...ALLOWED_PATHS] },
    runs: [],
    credentialBinding: {
      attestationPresent: Boolean(permissionAttestation?.value),
      matchesCurrentCredential: Boolean(permissionAttestation?.value?.credentialHash)
        && permissionAttestation.value.credentialHash === client.credentialFingerprint,
      verifiedAt: finite(permissionAttestation?.value?.verifiedAt),
      expiresAt: finite(permissionAttestation?.value?.expiresAt),
      metadataUpdatedAt: finite(permissionAttestation?.updatedAt),
    },
  };

  if (process.argv.includes("--credential-binding-only")) {
    process.stdout.write(`TEAM_011_BINDING=${JSON.stringify(report.credentialBinding)}\n`);
    return;
  }

  for (const run of runs) {
    const entryOrderId = positiveId(run?.entryOrder?.orderId);
    const entryClientOrderId = stringId(run?.entryOrder?.clientOrderId ?? run?.plan?.clientIds?.entry);
    const algoClientIds = candidateClientAlgoIds(run);
    const item = {
      runId: run.id,
      symbol: run.symbol,
      localStatus: run.status,
      createdAt: finite(run.createdAt),
      entry: { orderId: entryOrderId, clientOrderId: entryClientOrderId },
      localExpectedAlgoClientIds: algoClientIds,
      checks: {},
    };

    item.checks.entryOrder = await capture("entryOrder", async () => summarizeOrder(requireObject(await client.signedRequest(
      "GET", "/fapi/v1/order", { symbol: run.symbol, orderId: entryOrderId },
    ), "entryOrder")));
    item.checks.entryOrderByClientId = await capture("entryOrderByClientId", async () => summarizeOrder(requireObject(await client.signedRequest(
      "GET", "/fapi/v1/order", { symbol: run.symbol, origClientOrderId: entryClientOrderId },
    ), "entryOrderByClientId")));
    item.checks.entryTrades = await capture("entryTrades", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v1/userTrades", {
        symbol: run.symbol, orderId: entryOrderId, limit: 1000,
      });
      return requireArray(rows, "entryTrades").map(summarizeTrade);
    });
    item.checks.entryWindowTrades = await capture("entryWindowTrades", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v1/userTrades", {
        symbol: run.symbol,
        startTime: Math.max(0, Number(run.createdAt) - 5 * 60_000),
        endTime: Number(run.createdAt) + 30 * 60_000,
        limit: 1000,
      });
      return requireArray(rows, "entryWindowTrades").map(summarizeTrade);
    });

    const algos = [];
    for (const clientAlgoId of algoClientIds) {
      const checked = await capture(`algo:${clientAlgoId}`, async () => summarizeAlgo(requireObject(await client.signedRequest(
        "GET", "/fapi/v1/algoOrder", { clientAlgoId },
      ), `algo:${clientAlgoId}`)));
      algos.push(checked);
    }
    item.checks.algos = algos;

    const actualOrderIds = [...new Set(algos
      .filter((result) => result.ok)
      .map((result) => positiveId(result.value?.actualOrderId))
      .filter(Boolean))];
    const exitTrades = [];
    for (const orderId of actualOrderIds) {
      exitTrades.push(await capture(`exitTrades:${orderId}`, async () => {
        const rows = await client.signedRequest("GET", "/fapi/v1/userTrades", {
          symbol: run.symbol, orderId, limit: 1000,
        });
        return requireArray(rows, `exitTrades:${orderId}`).map(summarizeTrade);
      }));
    }
    item.checks.exitTrades = exitTrades;

    item.checks.funding = await capture("funding", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v1/income", {
        symbol: run.symbol,
        incomeType: "FUNDING_FEE",
        startTime: Math.max(0, Number(run.createdAt) - 60_000),
        endTime: Date.now(),
        limit: 1000,
      });
      return requireArray(rows, "funding").map(summarizeIncome);
    });
    item.checks.position = await capture("position", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v3/positionRisk", { symbol: run.symbol });
      return requireArray(rows, "position").map((position) => ({
        symbol: position.symbol ?? null,
        quantity: finite(position.positionAmt),
        entryPrice: finite(position.entryPrice),
        markPrice: finite(position.markPrice),
        unrealizedPnl: finite(position.unRealizedProfit ?? position.unrealizedProfit),
        updateTime: finite(position.updateTime),
      }));
    });
    item.checks.openOrders = await capture("openOrders", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v1/openOrders", { symbol: run.symbol });
      return requireArray(rows, "openOrders").map(summarizeOrder);
    });
    item.checks.openAlgoOrders = await capture("openAlgoOrders", async () => {
      const rows = await client.signedRequest("GET", "/fapi/v1/openAlgoOrders", {
        algoType: "CONDITIONAL", symbol: run.symbol,
      });
      return requireArray(rows, "openAlgoOrders").map(summarizeAlgo);
    });
    report.runs.push(item);
    process.stdout.write(`TEAM_011_RUN=${JSON.stringify(item)}\n`);
  }

  process.stdout.write(`TEAM_011_DONE=${JSON.stringify({
    authority: report.authority,
    capturedAt: report.capturedAt,
    runCount: report.runs.length,
    networkGuard: report.networkGuard,
    credentialBinding: report.credentialBinding,
  })}\n`);
}

main().catch((error) => {
  console.error(JSON.stringify({ failed: true, error: safeError(error) }));
  process.exitCode = 1;
});
