import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerLabel } from "../exchanges/create-client.js";
import { randomUUID } from "node:crypto";
import { createManualTrade } from "../domain/trade-lifecycle.js";
import { assessTestnetReadiness } from "../execution/readiness.js";
import { projectExecutionRuns } from "../execution/execution-run-projection.js";
import { buildExecutionSummary, buildStrategyPerformance } from "../presentation/strategy-performance.js";
import { buildShadowPerformance } from "../presentation/shadow-performance.js";
import {
  PERFORMANCE_EPOCH_METADATA_KEY,
  V2_EXECUTION_SOURCE,
  projectV2ExecutionSignal,
  tradeBelongsToEpoch,
} from "../execution/execution-strategy-source.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(projectRoot, "public");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function setBaseHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
}

function sendJson(response, statusCode, value) {
  setBaseHeaders(response);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求内容不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}

export function createDashboardServer({ monitor, accountMonitor = null, executionGateway = null, canaryExecutor = null, strategyExecutionCoordinator = null, store, config, logger = console }) {
  const eventClients = new Set();
  const broadcast = (event, value) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const response of eventClients) response.write(payload);
  };
  const onAnalysis = (analysis) => broadcast("analysis", analysis);
  const onPortfolioSignal = (value) => broadcast("portfolio", value);
  const onTrade = (trade) => broadcast("trade", trade);
  const onManualTrade = (trade) => broadcast("manualTrade", trade);
  const onShadowTrade = (trade) => broadcast("shadowTrade", trade);
  const onShadowSignal = (value) => broadcast("shadowSignal", value);
  const onRadar = (value) => broadcast("marketRadar", value);
  const onAccount = (account) => broadcast("testnetAccount", account);
  const onExecution = (execution) => broadcast("testnetExecution", execution);
  monitor.on("analysis", onAnalysis);
  monitor.on("portfolioSignal", onPortfolioSignal);
  monitor.on("trade", onTrade);
  monitor.on("manualTrade", onManualTrade);
  monitor.on("shadowTrade", onShadowTrade);
  monitor.on("shadowSignal", onShadowSignal);
  monitor.on("radar", onRadar);
  accountMonitor?.on("account", onAccount);
  canaryExecutor?.on("execution", onExecution);
  const executionStatus = async () => {
    const gateway = executionGateway?.snapshot() ?? {
      environment: config.marketEnvironment,
      mode: "DISABLED",
      orderSubmissionEnabled: false,
      cancelEnabled: false,
      emergencyStopAvailable: false,
    };
    const account = accountMonitor?.snapshot() ?? {
      enabled: false,
      connected: false,
      environment: "TESTNET",
      mode: "READ_ONLY",
      orderSubmissionEnabled: false,
      status: "DISABLED",
    };
    const permissionProbe = canaryExecutor?.permissionStatus ? await canaryExecutor.permissionStatus() : null;
    const activeRuns = await (store.listActiveExecutionRuns?.() ?? []);
    const emergencyStop = (await store.getMetadata?.("testnet_execution_emergency_stop"))?.value ?? { active: false };
    const unsafeRun = activeRuns.find((run) => [
      "SUBMISSION_UNKNOWN",
      "PROTECTION_INCOMPLETE",
      "ERROR_UNPROTECTED",
      "OPERATOR_CLOSE_UNKNOWN",
    ].includes(run.status));
    const safetyHold = unsafeRun
      ? { active: true, runId: unsafeRun.id, status: unsafeRun.status }
      : { active: false, runId: null, status: null };
    const rawCapacity = await (store.getExecutionCapacity?.() ?? null);
    const capacity = rawCapacity ? {
      ...rawCapacity,
      strategySource: config.execution?.strategySource ?? null,
      positionPolicy: config.execution?.positionPolicy ?? rawCapacity.positionPolicy,
    } : null;
    return {
      gateway,
      account,
      permissionProbe,
      emergencyStop,
      safetyHold,
      effectiveOrderSubmissionEnabled: Boolean(gateway.orderSubmissionEnabled && !emergencyStop.active && !safetyHold.active),
      capacity,
      automation: strategyExecutionCoordinator?.snapshot() ?? { enabled: false, status: "DISABLED", lastDecision: null },
      readiness: assessTestnetReadiness({
        account,
        gateway,
        credentialsConfigured: Boolean(config.execution?.credentialsConfigured),
        permissionProbe,
        activeRuns,
      }),
    };
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/api/health") {
        const mode = config.execution?.autoExecutionEnabled ? "DEMO_AUTO_EXECUTION" : "RESEARCH_SIGNAL_ONLY";
        sendJson(response, 200, {
          ok: true,
          mode,
          marketEnvironment: config.marketEnvironment,
          primaryExchange: providerLabel(config.primaryProvider),
          auxiliaryExchange: providerLabel(config.auxiliaryProvider),
          serverTime: new Date().toISOString(),
          monitor: monitor.snapshot(),
          execution: await executionStatus(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/signals") {
        const [records, executionRuns, shadowRecords, performanceEpochRecord] = await Promise.all([
          store.listSignals(200),
          store.listExecutionRuns?.(1000) ?? [],
          store.listShadowSignals?.(1000) ?? [],
          store.getMetadata?.(PERFORMANCE_EPOCH_METADATA_KEY) ?? null,
        ]);
        const executionSignalRecords = [
          ...records,
          ...shadowRecords.map(projectV2ExecutionSignal).filter(Boolean),
        ];
        const execution = await executionStatus();
        const livePositions = new Map((execution.account?.positions ?? []).map((position) => [position.symbol, position]));
        const allProjectedTrades = projectExecutionRuns(executionRuns, executionSignalRecords)
          .filter((trade) => trade.sourceType === "SIGNAL")
          .map((trade) => {
            const position = trade.terminal ? null : livePositions.get(trade.symbol);
            if (!position) return trade;
            return {
              ...trade,
              unrealizedPnl: Number.isFinite(Number(position.unrealizedPnl)) ? Number(position.unrealizedPnl) : trade.unrealizedPnl,
              markPrice: Number.isFinite(Number(position.markPrice)) ? Number(position.markPrice) : null,
              liquidationPrice: Number.isFinite(Number(position.liquidationPrice)) ? Number(position.liquidationPrice) : null,
              exchangePositionQuantity: Number.isFinite(Number(position.quantity)) ? Number(position.quantity) : null,
            };
          });
        const performanceEpoch = performanceEpochRecord?.value ?? null;
        const epochLedgerTrades = performanceEpoch
          ? allProjectedTrades.filter((trade) => tradeBelongsToEpoch(trade, performanceEpoch))
          : allProjectedTrades;
        const epochPerformanceTrades = epochLedgerTrades.filter((trade) => trade.performanceEligible);
        const historicalPerformanceTrades = allProjectedTrades.filter((trade) => trade.performanceEligible);
        const demoTrades = epochLedgerTrades.slice(0, 100);
        const strategyPerformance = buildStrategyPerformance(epochPerformanceTrades, {
          startingEquity: performanceEpoch?.startingEquity ?? config.portfolio?.startingEquity,
          sampleTarget: config.shadowV2?.sampleTarget ?? 100,
        });
        const strategyExecutionSummary = buildExecutionSummary(epochLedgerTrades);
        const historicalStrategyPerformance = buildStrategyPerformance(historicalPerformanceTrades, {
          startingEquity: config.portfolio?.startingEquity,
        });
        const autoExecutionEnabled = Boolean(config.execution?.autoExecutionEnabled);
        const v2Active = config.execution?.strategySource === V2_EXECUTION_SOURCE;
        const activeExecutionSignalIds = new Set(executionRuns
          .filter((run) => !new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]).has(run.status))
          .map((run) => run.signalId));
        const terminalExecutionSignalIds = new Set(executionRuns
          .filter((run) => new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]).has(run.status))
          .map((run) => run.signalId));
        const currentShadowRecords = shadowRecords.filter((item) => (
          item.evaluation?.strategyVersion === config.shadowV2?.strategyVersion
          && (!performanceEpoch || Number(item.candidate?.triggerTime) >= Number(performanceEpoch.startedAt))
          && (!config.marketRadar?.requiredForV2
            || item.evaluation?.marketRadar?.version === config.marketRadar.modelVersion
            || activeExecutionSignalIds.has(item.candidate?.id))
        ));
        const activePortfolio = v2Active
          ? currentShadowRecords.filter((item) => (
            item.decision?.selected && !terminalExecutionSignalIds.has(item.candidate?.id)
          ))
            .map(projectV2ExecutionSignal)
          : records.filter((item) => item.selected && !terminalExecutionSignalIds.has(item.candidate?.id));
        sendJson(response, 200, {
          mode: autoExecutionEnabled ? "DEMO_AUTO_EXECUTION" : "RESEARCH_SIGNAL_ONLY",
          marketEnvironment: config.marketEnvironment,
          disclaimer: autoExecutionEnabled
            ? `仅在 Binance Demo 执行新产生且仍有效的 ${v2Active ? "V2.4.2 Pre-Move保留源过滤与分层成本准入" : "V1"} 组合信号；不会连接真实资金账户。`
            : "仅供研究与风险监控；策略信号不会触发自动下单。",
          monitor: monitor.snapshot(),
          execution,
          portfolio: activePortfolio,
          candidates: records.filter((item) => !item.selected),
          demoTrades,
          strategyPerformance,
          strategyExecutionSummary,
          historicalStrategyPerformance,
          performanceEpoch,
          v2Experiment: v2Active ? {
            strategyVersion: config.shadowV2?.strategyVersion,
            coreMinimumScore: config.shadowV2?.coreMinimumScore,
            explorationMinimumScore: config.shadowV2?.explorationMinimumScore,
            sampleTarget: config.shadowV2?.sampleTarget,
            fixedPositionLimit: null,
            totalRiskLimitEnforced: false,
            correlationLimitEnforced: false,
            marketRadar: {
              enabled: Boolean(config.marketRadar?.enabled),
              required: Boolean(config.marketRadar?.requiredForV2),
              version: config.marketRadar?.modelVersion ?? null,
              discoverySize: config.marketRadar?.discoverySize ?? null,
              deepScanSize: config.marketRadar?.deepScanSize ?? null,
              refreshMinutes: config.marketRadar?.refreshMinutes ?? null,
              gainerCount: config.marketRadar?.gainerCount ?? null,
              loserCount: config.marketRadar?.loserCount ?? null,
              rankVelocityCount: config.marketRadar?.rankVelocityCount ?? null,
              volumeShockCount: config.marketRadar?.volumeShockCount ?? null,
            },
          } : null,
          shadowPortfolio: currentShadowRecords.filter((item) => (
            item.decision?.selected && !terminalExecutionSignalIds.has(item.candidate?.id)
          )),
          shadowCandidates: currentShadowRecords.filter((item) => !item.decision?.selected),
          shadowPerformance: buildShadowPerformance(currentShadowRecords, { startingEquity: config.portfolio?.startingEquity }),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/history") {
        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        sendJson(response, 200, { items: await store.listSignals(Number.isFinite(requestedLimit) ? requestedLimit : 100) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/universe-history") {
        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "52", 10);
        sendJson(response, 200, { items: await store.listUniverseSnapshots(Number.isFinite(requestedLimit) ? requestedLimit : 52) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/execution/status") {
        sendJson(response, 200, {
          ...(await executionStatus()),
          canary: canaryExecutor ? await canaryExecutor.snapshot() : null,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/execution/runs") {
        sendJson(response, 200, { items: await store.listExecutionRuns(100) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/manual-trades") {
        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
        sendJson(response, 200, { items: await store.listManualTrades(Number.isFinite(requestedLimit) ? requestedLimit : 100) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/manual-trades") {
        const body = await readJsonBody(request);
        const signal = await store.getSignal(String(body.signalId ?? ""));
        if (!signal?.selected) {
          const error = new Error("只能记录已进入模拟组合的信号");
          error.statusCode = 400;
          throw error;
        }
        let trade;
        try {
          trade = createManualTrade(signal.candidate, {
            id: randomUUID(),
            fillPrice: Number(body.fillPrice),
            quantity: Number(body.quantity),
            feeRate: config.costs.fallbackFeeRate,
          });
        } catch (error) {
          if (error instanceof TypeError) error.statusCode = 400;
          throw error;
        }
        const record = await store.saveManualTrade(trade, body.note ?? "");
        sendJson(response, 201, { item: record });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
          symbols: config.symbols,
          intervals: config.intervals,
          primaryProvider: config.primaryProvider,
          auxiliaryProvider: config.auxiliaryProvider,
          marketEnvironment: config.marketEnvironment,
          pollSeconds: config.pollMs / 1000,
          strategy: config.strategy,
          universe: config.universe,
          marketRadar: config.marketRadar,
          portfolio: config.portfolio,
          shadowV2: config.shadowV2 ?? { enabled: false, executionEnabled: false },
          execution: config.execution ?? { accountReadOnlyEnabled: false, orderSubmissionEnabled: false },
          executionEnabled: Boolean(config.execution?.orderSubmissionEnabled),
          realMoneyExecutionEnabled: false,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/scan") {
        const result = await monitor.scanAll();
        sendJson(response, result.skipped ? 409 : 200, { ...result, monitor: monitor.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        setBaseHeaders(response);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
        eventClients.add(response);
        request.on("close", () => eventClients.delete(response));
        return;
      }

      const staticFile = staticFiles.get(url.pathname);
      if (request.method === "GET" && staticFile) {
        const [fileName, contentType] = staticFile;
        const content = await readFile(path.join(publicRoot, fileName));
        setBaseHeaders(response);
        response.writeHead(200, { "content-type": contentType, "cache-control": "no-cache" });
        response.end(content);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      logger.error("[http]", error);
      if (!response.headersSent) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        sendJson(response, statusCode, { error: statusCode < 500 ? error.message : "Internal server error" });
      }
      else response.end();
    }
  });

  server.on("close", () => {
    monitor.off("analysis", onAnalysis);
    monitor.off("portfolioSignal", onPortfolioSignal);
    monitor.off("trade", onTrade);
    monitor.off("manualTrade", onManualTrade);
    monitor.off("shadowTrade", onShadowTrade);
    monitor.off("shadowSignal", onShadowSignal);
    monitor.off("radar", onRadar);
    accountMonitor?.off("account", onAccount);
    canaryExecutor?.off("execution", onExecution);
    for (const response of eventClients) response.end();
    eventClients.clear();
  });

  return server;
}

export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}
