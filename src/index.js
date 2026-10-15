import { loadConfig } from "./config.js";
import { createMarketDataClient, providerLabel } from "./exchanges/create-client.js";
import { ResearchStore } from "./infrastructure/research-store.js";
import { ResearchMonitor } from "./application/research-monitor.js";
import { WindowsNotifier } from "./infrastructure/windows-notifier.js";
import { createDashboardServer, listen } from "./http/server.js";
import { loadDotEnv } from "./env.js";
import { BinanceTestnetReadOnlyClient } from "./execution/binance-testnet-readonly.js";
import { TestnetExecutionGateway } from "./execution/testnet-execution-gateway.js";
import { TestnetAccountMonitor } from "./application/testnet-account-monitor.js";
import { BinanceTestnetTradingClient } from "./execution/binance-testnet-trading.js";
import { TestnetCanaryExecutor } from "./execution/testnet-canary-executor.js";
import { resolveExecutionAllowedSymbols } from "./execution/execution-symbols.js";
import { StrategyExecutionCoordinator } from "./application/strategy-execution-coordinator.js";
import {
  PERFORMANCE_EPOCH_METADATA_KEY,
  PERFORMANCE_EPOCH_HISTORY_METADATA_KEY,
  V2_DEMO_STRATEGY_VERSION,
  V2_EXECUTION_SOURCE,
  buildPerformanceEpoch,
} from "./execution/execution-strategy-source.js";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const primaryExchange = createMarketDataClient({ ...config, provider: config.primaryProvider });
  const auxiliaryExchange = config.auxiliaryProvider === config.primaryProvider
    ? null
    : createMarketDataClient({ ...config, provider: config.auxiliaryProvider });
  const store = new ResearchStore(config.databasePath);
  await store.initialize();
  let performanceEpoch = (await store.getMetadata(PERFORMANCE_EPOCH_METADATA_KEY))?.value ?? null;
  if (config.execution.autoExecutionEnabled
    && config.execution.strategySource === V2_EXECUTION_SOURCE
    && (performanceEpoch?.strategySource !== V2_EXECUTION_SOURCE || performanceEpoch?.strategyVersion !== V2_DEMO_STRATEGY_VERSION)) {
    const previousEpoch = performanceEpoch;
    const historyRecord = await store.getMetadata(PERFORMANCE_EPOCH_HISTORY_METADATA_KEY);
    const history = Array.isArray(historyRecord?.value) ? historyRecord.value : [];
    if (previousEpoch) {
      await store.setMetadata(PERFORMANCE_EPOCH_HISTORY_METADATA_KEY, [...history, previousEpoch].slice(-50));
    }
    performanceEpoch = buildPerformanceEpoch({
      now: Date.now(),
      startingEquity: config.portfolio.startingEquity,
      strategySource: config.execution.strategySource,
      strategyVersion: V2_DEMO_STRATEGY_VERSION,
      signalModelVersion: config.shadowV2.strategyVersion,
      radarVersion: config.marketRadar.modelVersion,
      previousEpoch,
    });
    await store.setMetadata(PERFORMANCE_EPOCH_METADATA_KEY, performanceEpoch);
    console.info(`[strategy-epoch] 已切换 ${performanceEpoch.id}；旧纪元${previousEpoch?.id ? ` ${previousEpoch.id}` : "不存在"}，历史订单继续保留。`);
  } else if (config.execution.autoExecutionEnabled
    && config.execution.strategySource === V2_EXECUTION_SOURCE
    && performanceEpoch?.strategyVersion === V2_DEMO_STRATEGY_VERSION
    && performanceEpoch?.signalModelVersion !== config.shadowV2.strategyVersion) {
    const previousEpoch = performanceEpoch;
    const historyRecord = await store.getMetadata(PERFORMANCE_EPOCH_HISTORY_METADATA_KEY);
    const history = Array.isArray(historyRecord?.value) ? historyRecord.value : [];
    await store.setMetadata(PERFORMANCE_EPOCH_HISTORY_METADATA_KEY, [...history, previousEpoch].slice(-50));
    performanceEpoch = buildPerformanceEpoch({
      now: Date.now(),
      startingEquity: config.portfolio.startingEquity,
      strategySource: config.execution.strategySource,
      strategyVersion: V2_DEMO_STRATEGY_VERSION,
      signalModelVersion: config.shadowV2.strategyVersion,
      radarVersion: config.marketRadar.modelVersion,
      previousEpoch,
    });
    await store.setMetadata(PERFORMANCE_EPOCH_METADATA_KEY, performanceEpoch);
    console.info(`[strategy-epoch] 信号模型变化，已新建 ${performanceEpoch.id}；旧纪元 ${previousEpoch.id} 已封存。`);
  }
  const notifier = new WindowsNotifier({ enabled: config.notifications.windowsEnabled });
  const monitor = new ResearchMonitor({ primaryExchange, auxiliaryExchange, store, notifier, config });
  await monitor.initialize();
  const executionAllowedSymbols = await resolveExecutionAllowedSymbols(store, config);
  const accountClient = config.execution.accountReadOnlyEnabled
    ? new BinanceTestnetReadOnlyClient({
      baseUrl: config.binanceBaseUrl,
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
      timeoutMs: config.requestTimeoutMs,
      recvWindow: config.execution.recvWindow,
    })
    : null;
  const accountMonitor = new TestnetAccountMonitor({
    client: accountClient,
    store,
    enabled: config.execution.accountReadOnlyEnabled,
    pollMs: config.execution.accountPollMs,
  });
  const tradingClient = config.execution.accountReadOnlyEnabled
    ? new BinanceTestnetTradingClient({
      baseUrl: config.binanceBaseUrl,
      apiKey: process.env.BINANCE_TESTNET_API_KEY,
      apiSecret: process.env.BINANCE_TESTNET_API_SECRET,
      writeEnabled: config.execution.orderSubmissionEnabled,
      allowedSymbols: executionAllowedSymbols,
      timeoutMs: config.requestTimeoutMs,
      recvWindow: config.execution.recvWindow,
    })
    : null;
  const canaryExecutor = tradingClient
    ? new TestnetCanaryExecutor({
      client: tradingClient,
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
      notifier,
      strategySource: config.execution.strategySource,
    })
    : null;
  const executionGateway = config.marketEnvironment === "TESTNET"
    ? new TestnetExecutionGateway({
      environment: config.marketEnvironment,
      orderSubmissionEnabled: config.execution.orderSubmissionEnabled,
      executor: canaryExecutor,
      allowedSymbols: executionAllowedSymbols,
      strategySource: config.execution.strategySource,
      positionPolicy: config.execution.positionPolicy,
    })
    : null;
  monitor.on("radar", (snapshot = {}) => {
    const symbols = Array.isArray(snapshot.items)
      ? snapshot.items.map((item) => item?.symbol).filter(Boolean)
      : Array.isArray(snapshot.selectedSymbols) ? snapshot.selectedSymbols : [];
    if (!symbols.length) return;
    canaryExecutor?.allowSymbols(symbols);
    executionGateway?.allowSymbols(symbols);
  });
  const strategyExecutionCoordinator = canaryExecutor
    ? new StrategyExecutionCoordinator({
      monitor,
      executor: canaryExecutor,
      store,
      enabled: config.execution.autoExecutionEnabled,
      minimumScore: config.execution.strategySource === V2_EXECUTION_SOURCE
        ? config.shadowV2.explorationMinimumScore
        : config.strategy.minConfidence,
      strategySource: config.execution.strategySource,
      epochStartedAt: performanceEpoch?.strategySource === config.execution.strategySource
        ? performanceEpoch.startedAt
        : null,
      requiredRadarVersion: config.execution.strategySource === V2_EXECUTION_SOURCE
        && config.marketRadar.enabled
        && config.marketRadar.requiredForV2
        ? config.marketRadar.modelVersion
        : null,
    })
    : null;
  const server = createDashboardServer({ monitor, accountMonitor, executionGateway, canaryExecutor, strategyExecutionCoordinator, store, config });
  await canaryExecutor?.start();
  await strategyExecutionCoordinator?.start();
  await listen(server, config);

  console.info(`合约信号面板: http://${config.host}:${config.port}`);
  console.info(`主行情源: ${providerLabel(config.primaryProvider)}`);
  console.info(`辅助校验源: ${providerLabel(config.auxiliaryProvider)}`);
  console.info(`行情环境: ${config.marketEnvironment === "TESTNET" ? "Binance Demo / Testnet" : config.marketEnvironment}`);
  console.info(`策略: V2.4.3爆发前信号 · 仅RETAINED及BOUNDARY_PRESSURE-only不可交易 · 做多二次确认 · 成本≤0.20R普通组 / 0.20R-0.35R探索组 · 每 ${config.pollMs / 1000} 秒检查`);
  console.info(`模式: ${config.execution.autoExecutionEnabled ? `DEMO_AUTO_EXECUTION（${config.execution.strategySource}，仅 Binance Demo）` : "RESEARCH_SIGNAL_ONLY"}`);
  console.info(`测试网账户: ${config.execution.accountReadOnlyEnabled ? "CONNECTED" : "DISABLED"}；订单提交: ${config.execution.orderSubmissionEnabled ? "CANARY_ARMED" : "DISABLED"}；自动策略执行: ${config.execution.autoExecutionEnabled ? "WATCHING" : "DISABLED"}`);
  void monitor.start().catch((error) => console.error("[monitor] 启动扫描失败", error));
  void accountMonitor.start().catch((error) => console.error("[testnet-account] 启动失败", error));

  const shutdown = () => {
    console.info("\n正在停止监控…");
    monitor.stop();
    accountMonitor.stop();
    strategyExecutionCoordinator?.stop();
    canaryExecutor?.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
