import path from "node:path";
import {
  V1_EXECUTION_SOURCE,
  V2_EXECUTION_SOURCE,
  assertExecutionStrategySource,
} from "./execution/execution-strategy-source.js";

const ALLOWED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M",
]);

function numberFromEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  return value;
}

function booleanFromEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(true|1|yes)$/i.test(raw)) return true;
  if (/^(false|0|no)$/i.test(raw)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function symbolsFromEnv() {
  const symbols = (process.env.MONITOR_SYMBOLS ?? "BTCUSDT,ETHUSDT,SOLUSDT")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) throw new Error("MONITOR_SYMBOLS 至少要包含一个交易对");
  for (const symbol of symbols) {
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new Error(`无效交易对: ${symbol}`);
  }
  return [...new Set(symbols)];
}

export function loadConfig() {
  const primaryProvider = (process.env.PRIMARY_MARKET_PROVIDER ?? process.env.MARKET_PROVIDER ?? "binance").toLowerCase();
  const auxiliaryProvider = (process.env.AUXILIARY_MARKET_PROVIDER ?? "hyperliquid").toLowerCase();
  for (const [name, provider] of [["PRIMARY_MARKET_PROVIDER", primaryProvider], ["AUXILIARY_MARKET_PROVIDER", auxiliaryProvider]]) {
    if (!new Set(["binance", "okx", "hyperliquid"]).has(provider)) {
      throw new Error(`${name} 只能是 hyperliquid、binance 或 okx`);
    }
  }
  const interval = process.env.MONITOR_INTERVAL ?? "15m";
  if (!ALLOWED_INTERVALS.has(interval)) throw new Error(`不支持的 MONITOR_INTERVAL: ${interval}`);

  const emaFast = numberFromEnv("EMA_FAST", 20, { min: 2, max: 200 });
  const emaSlow = numberFromEnv("EMA_SLOW", 50, { min: 3, max: 500 });
  if (emaFast >= emaSlow) throw new Error("EMA_FAST 必须小于 EMA_SLOW");
  const binanceBaseUrl = (process.env.BINANCE_FUTURES_BASE_URL ?? "https://fapi.binance.com").replace(/\/$/, "");
  const marketEnvironment = primaryProvider === "binance"
    ? (/demo|testnet/i.test(binanceBaseUrl) ? "TESTNET" : "PRODUCTION")
    : "PUBLIC_MARKET_DATA";
  const testnetAccountReadOnly = booleanFromEnv("BINANCE_TESTNET_ACCOUNT_READ_ONLY", false);
  const testnetOrderSubmission = booleanFromEnv("BINANCE_TESTNET_EXECUTION_ENABLED", false);
  const testnetAutoExecution = booleanFromEnv("BINANCE_TESTNET_AUTO_EXECUTION_ENABLED", false);
  const testnetExecutionStrategy = assertExecutionStrategySource(
    process.env.BINANCE_TESTNET_EXECUTION_STRATEGY ?? V1_EXECUTION_SOURCE,
  );
  const shadowV2Enabled = booleanFromEnv("SHADOW_V2_ENABLED", true);
  const shadowV2CoreMinimumScore = process.env.SHADOW_V2_CORE_MIN_SCORE !== undefined
    ? numberFromEnv("SHADOW_V2_CORE_MIN_SCORE", 70, { min: 0, max: 100 })
    : numberFromEnv("SHADOW_V2_MIN_SCORE", 70, { min: 0, max: 100 });
  const shadowV2ExplorationMinimumScore = numberFromEnv("SHADOW_V2_EXPLORATION_MIN_SCORE", 55, { min: 0, max: 100 });
  if (shadowV2ExplorationMinimumScore >= shadowV2CoreMinimumScore) {
    throw new Error("SHADOW_V2_EXPLORATION_MIN_SCORE 必须低于 SHADOW_V2_CORE_MIN_SCORE");
  }
  const testnetCredentialsConfigured = Boolean(process.env.BINANCE_TESTNET_API_KEY && process.env.BINANCE_TESTNET_API_SECRET);
  if (testnetAccountReadOnly && marketEnvironment !== "TESTNET") throw new Error("测试网只读账户只能连接 Binance Demo/Testnet 行情环境");
  if (testnetAccountReadOnly && !testnetCredentialsConfigured) throw new Error("已启用测试网只读账户，但缺少 BINANCE_TESTNET_API_KEY 或 BINANCE_TESTNET_API_SECRET");
  if (testnetOrderSubmission && marketEnvironment !== "TESTNET") throw new Error("订单提交只能连接 Binance Demo/Testnet 环境");
  if (testnetOrderSubmission && !testnetAccountReadOnly) throw new Error("启用订单提交前必须启用测试网账户同步");
  if (testnetOrderSubmission && !testnetCredentialsConfigured) throw new Error("启用订单提交前必须配置测试网 API 凭据");
  if (testnetAutoExecution && !testnetOrderSubmission) throw new Error("启用自动策略执行前必须开启测试网订单提交");
  if (testnetAutoExecution && testnetExecutionStrategy === V2_EXECUTION_SOURCE && !shadowV2Enabled) {
    throw new Error("V2 自动执行要求 SHADOW_V2_ENABLED=true");
  }
  const canarySymbol = (process.env.BINANCE_TESTNET_CANARY_SYMBOL ?? "BTCUSDT").toUpperCase();
  if (!/^[A-Z0-9]{1,16}USDT$/.test(canarySymbol)) throw new Error("测试网人工金丝雀标的必须是 USDT 永续合约");
  const universeSize = Math.trunc(numberFromEnv("UNIVERSE_SIZE", 30, { min: 20, max: 40 }));
  const radarDiscoverySize = Math.trunc(numberFromEnv("MARKET_RADAR_DISCOVERY_SIZE", 100, { min: universeSize, max: 300 }));

  return Object.freeze({
    provider: primaryProvider,
    primaryProvider,
    auxiliaryProvider,
    marketEnvironment,
    symbols: symbolsFromEnv(),
    interval,
    pollMs: numberFromEnv("POLL_SECONDS", 30, { min: 5, max: 3600 }) * 1000,
    candleLimit: Math.trunc(numberFromEnv("CANDLE_LIMIT", 300, { min: emaSlow + 10, max: 1500 })),
    host: process.env.HOST ?? "127.0.0.1",
    port: Math.trunc(numberFromEnv("PORT", 3000, { min: 1, max: 65535 })),
    binanceBaseUrl,
    okxBaseUrl: (process.env.OKX_BASE_URL ?? "https://openapi.okx.com").replace(/\/$/, ""),
    hyperliquidBaseUrl: (process.env.HYPERLIQUID_BASE_URL ?? "https://api.hyperliquid.xyz").replace(/\/$/, ""),
    requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", 10_000, { min: 1000, max: 60_000 }),
    storePath: path.resolve(process.cwd(), process.env.SIGNAL_STORE_PATH ?? "data/signals.jsonl"),
    databasePath: path.resolve(process.cwd(), process.env.RESEARCH_DATABASE_PATH ?? "data/research.sqlite"),
    scanConcurrency: Math.trunc(numberFromEnv("SCAN_CONCURRENCY", 5, { min: 1, max: 20 })),
    intervals: Object.freeze({ trend: "1h", setup: "15m", trigger: "5m", path: "1m" }),
    universe: Object.freeze({
      dynamic: (process.env.DYNAMIC_UNIVERSE ?? "true").toLowerCase() !== "false",
      size: universeSize,
      refreshHours: numberFromEnv("UNIVERSE_REFRESH_HOURS", 168, { min: 1, max: 720 }),
      minListingDays: numberFromEnv("UNIVERSE_MIN_LISTING_DAYS", 90, { min: 0, max: 3650 }),
      maxSpreadBps: numberFromEnv("UNIVERSE_MAX_SPREAD_BPS", 20, { min: 1, max: 500 }),
    }),
    marketRadar: Object.freeze({
      enabled: booleanFromEnv("MARKET_RADAR_ENABLED", true),
      modelVersion: "MARKET_RADAR_R3_PREMOVE",
      discoverySize: radarDiscoverySize,
      deepScanSize: universeSize,
      refreshMinutes: numberFromEnv("MARKET_RADAR_REFRESH_MINUTES", 5, { min: 5, max: 240 }),
      minimumHoldMinutes: numberFromEnv("MARKET_RADAR_MINIMUM_HOLD_MINUTES", 30, { min: 0, max: 1440 }),
      coreMinimumScore: numberFromEnv("MARKET_RADAR_CORE_MIN_SCORE", 68, { min: 0, max: 100 }),
      requiredForV2: booleanFromEnv("MARKET_RADAR_REQUIRED_FOR_V2", true),
      moverCandleLimit: Math.trunc(numberFromEnv("MARKET_RADAR_MOVER_CANDLE_LIMIT", 33, { min: 21, max: 96 })),
      gainerCount: Math.trunc(numberFromEnv("MARKET_RADAR_GAINER_COUNT", 15, { min: 1, max: 30 })),
      loserCount: Math.trunc(numberFromEnv("MARKET_RADAR_LOSER_COUNT", 15, { min: 1, max: 30 })),
      rankVelocityCount: Math.trunc(numberFromEnv("MARKET_RADAR_RANK_VELOCITY_COUNT", 10, { min: 0, max: 30 })),
      volumeShockCount: Math.trunc(numberFromEnv("MARKET_RADAR_VOLUME_SHOCK_COUNT", 10, { min: 0, max: 30 })),
      minimumVolumeShockRatio: numberFromEnv("MARKET_RADAR_MIN_VOLUME_SHOCK_RATIO", 1.2, { min: 1, max: 20 }),
      compressionCount: Math.trunc(numberFromEnv("MARKET_RADAR_COMPRESSION_COUNT", 15, { min: 0, max: 40 })),
      boundaryPressureCount: Math.trunc(numberFromEnv("MARKET_RADAR_BOUNDARY_PRESSURE_COUNT", 15, { min: 0, max: 40 })),
      earlyAccelerationCount: Math.trunc(numberFromEnv("MARKET_RADAR_EARLY_ACCELERATION_COUNT", 10, { min: 0, max: 40 })),
    }),
    portfolio: Object.freeze({
      startingEquity: numberFromEnv("SIMULATED_EQUITY_USDT", 500, { min: 10, max: 10_000_000 }),
      marginPerTrade: numberFromEnv("MARGIN_PER_TRADE_USDT", 10, { min: 1, max: 100_000 }),
      leverage: Math.trunc(numberFromEnv("LEVERAGE", 10, { min: 1, max: 125 })),
      selectionMode: "ALL_ELIGIBLE",
      marginMode: "ISOLATED",
      positionMode: "ONE_WAY",
    }),
    shadowV2: Object.freeze({
      enabled: shadowV2Enabled,
      strategyVersion: "PRE_MOVE_1H_15M_5M_V2_4_2_RETAINED_FILTER",
      executionEnabled: testnetAutoExecution && testnetExecutionStrategy === V2_EXECUTION_SOURCE,
      minimumScore: shadowV2ExplorationMinimumScore,
      coreMinimumScore: shadowV2CoreMinimumScore,
      explorationMinimumScore: shadowV2ExplorationMinimumScore,
      sampleTarget: Math.trunc(numberFromEnv("SHADOW_V2_SAMPLE_TARGET", 100, { min: 20, max: 10_000 })),
      targetRiskPercent: numberFromEnv("SHADOW_V2_RISK_PERCENT", 0.5, { min: 0.05, max: 5 }),
      maxTotalRiskPercent: numberFromEnv("SHADOW_V2_MAX_TOTAL_RISK_PERCENT", 2, { min: 0.1, max: 20 }),
      portfolioLimitsEnforced: false,
      fixedPositionLimit: null,
      maxCostR: numberFromEnv("SHADOW_V2_MAX_COST_R", 0.2, { min: 0, max: 2 }),
      maxFundingCostR: numberFromEnv("SHADOW_V2_MAX_FUNDING_COST_R", 0.1, { min: 0, max: 2 }),
      extremeCostR: numberFromEnv("SHADOW_V2_EXTREME_COST_R", 0.35, { min: 0.01, max: 3 }),
      extremeFundingCostR: numberFromEnv("SHADOW_V2_EXTREME_FUNDING_COST_R", 0.2, { min: 0.01, max: 3 }),
      expectedHoldingHours: numberFromEnv("SHADOW_V2_EXPECTED_HOLDING_HOURS", 12, { min: 1, max: 168 }),
      breakoutMaxDistanceAtr: numberFromEnv("SHADOW_V2_BREAKOUT_MAX_DISTANCE_ATR", 0.8, { min: 0.1, max: 5 }),
      breakoutMaxBodyAtr: numberFromEnv("SHADOW_V2_BREAKOUT_MAX_BODY_ATR", 1.2, { min: 0.1, max: 5 }),
      breakoutExtremeDistanceAtr: numberFromEnv("SHADOW_V2_BREAKOUT_EXTREME_DISTANCE_ATR", 1.5, { min: 0.1, max: 10 }),
      breakoutExtremeBodyAtr: numberFromEnv("SHADOW_V2_BREAKOUT_EXTREME_BODY_ATR", 2, { min: 0.1, max: 10 }),
      pullbackMaxDepthAtr: numberFromEnv("SHADOW_V2_PULLBACK_MAX_DEPTH_ATR", 0.6, { min: 0.1, max: 3 }),
      pullbackMaxTriggerDistanceAtr: numberFromEnv("SHADOW_V2_PULLBACK_MAX_TRIGGER_DISTANCE_ATR", 0.8, { min: 0.1, max: 3 }),
      pullbackExtremeDepthAtr: numberFromEnv("SHADOW_V2_PULLBACK_EXTREME_DEPTH_ATR", 1.5, { min: 0.1, max: 10 }),
      pullbackExtremeTriggerDistanceAtr: numberFromEnv("SHADOW_V2_PULLBACK_EXTREME_TRIGGER_DISTANCE_ATR", 1.5, { min: 0.1, max: 10 }),
      maxEffectiveCorrelation: numberFromEnv("SHADOW_V2_MAX_CORRELATION", 0.75, { min: 0, max: 1 }),
      maxCorrelatedPositions: Math.trunc(numberFromEnv("SHADOW_V2_MAX_CORRELATED_POSITIONS", 2, { min: 1, max: 20 })),
      preMoveHardMinimumExplosionScore: numberFromEnv("V2_4_HARD_MIN_EXPLOSION_SCORE", 35, { min: 0, max: 100 }),
      preMoveHardMinimumDirectionScore: numberFromEnv("V2_4_HARD_MIN_DIRECTION_SCORE", 42, { min: 0, max: 100 }),
      longMinimumVolumeRatio15m: numberFromEnv("V2_4_1_LONG_MIN_VOLUME_RATIO_15M", 1, { min: 0, max: 20 }),
      longMinimumVolumeAcceleration: numberFromEnv("V2_4_1_LONG_MIN_VOLUME_ACCELERATION_5M", 1, { min: 0, max: 20 }),
      longMaximumCompressionRatio: numberFromEnv("V2_4_1_LONG_MAX_COMPRESSION_RATIO", 1, { min: 0.1, max: 3 }),
      longMinimumDirectionalPressure: numberFromEnv("V2_4_1_LONG_MIN_DIRECTIONAL_PRESSURE", 0.55, { min: 0, max: 1 }),
      longMinimumLatestBodyAtr: numberFromEnv("V2_4_1_LONG_MIN_LATEST_BODY_ATR", 0.05, { min: 0, max: 3 }),
      longMinimumLatestCloseChangeAtr: numberFromEnv("V2_4_1_LONG_MIN_LATEST_CLOSE_CHANGE_ATR", 0, { min: -1, max: 3 }),
      longMinimumLatestCloseLocation: numberFromEnv("V2_4_1_LONG_MIN_LATEST_CLOSE_LOCATION", 0.5, { min: 0, max: 1 }),
    }),
    costs: Object.freeze({
      fallbackFeeRate: numberFromEnv("FALLBACK_TAKER_FEE_RATE", 0.0005, { min: 0, max: 0.01 }),
      fallbackSlippageRate: numberFromEnv("FALLBACK_SLIPPAGE_RATE", 0.0002, { min: 0, max: 0.01 }),
      activeLimitMaxBps: numberFromEnv("ACTIVE_LIMIT_MAX_BPS", 10, { min: 1, max: 100 }),
    }),
    notifications: Object.freeze({
      windowsEnabled: (process.env.WINDOWS_NOTIFICATIONS ?? "true").toLowerCase() !== "false",
    }),
    execution: Object.freeze({
      accountReadOnlyEnabled: testnetAccountReadOnly,
      credentialsConfigured: testnetCredentialsConfigured,
      orderSubmissionEnabled: testnetOrderSubmission,
      autoExecutionEnabled: testnetAutoExecution,
      strategySource: testnetExecutionStrategy,
      accountPollMs: numberFromEnv("BINANCE_TESTNET_ACCOUNT_POLL_SECONDS", 60, { min: 15, max: 3600 }) * 1000,
      recvWindow: numberFromEnv("BINANCE_TESTNET_RECV_WINDOW_MS", 5_000, { min: 1_000, max: 60_000 }),
      canaryPollMs: numberFromEnv("BINANCE_TESTNET_CANARY_POLL_SECONDS", 15, { min: 5, max: 60 }) * 1000,
      canarySymbol,
      canaryMargin: numberFromEnv("BINANCE_TESTNET_CANARY_MARGIN_USDT", 10, { min: 10, max: 10 }),
      canaryLeverage: Math.trunc(numberFromEnv("BINANCE_TESTNET_CANARY_LEVERAGE", 10, { min: 10, max: 10 })),
      maxNotionalOverageRate: numberFromEnv("BINANCE_TESTNET_MAX_NOTIONAL_OVERAGE_RATE", 0.05, { min: 0, max: 0.1 }),
      pullbackEntryTtlMs: numberFromEnv("PULLBACK_ENTRY_TTL_SECONDS", 180, { min: 30, max: 900 }) * 1000,
      positionPolicy: testnetExecutionStrategy === V2_EXECUTION_SOURCE ? "V2_4_2_PREMOVE_RETAINED_FILTER_ALL_ELIGIBLE" : "ALL_ELIGIBLE",
      initialAllowedSymbols: Object.freeze([canarySymbol]),
    }),
    strategy: Object.freeze({
      emaFast,
      emaSlow,
      rsiPeriod: Math.trunc(numberFromEnv("RSI_PERIOD", 14, { min: 2, max: 100 })),
      atrPeriod: Math.trunc(numberFromEnv("ATR_PERIOD", 14, { min: 2, max: 100 })),
      volumePeriod: 20,
      minConfidence: numberFromEnv("MIN_CONFIDENCE", 70, { min: 50, max: 100 }),
      atrStopMultiplier: numberFromEnv("ATR_STOP_MULTIPLIER", 1.5, { min: 0.5, max: 10 }),
      minStopPercent: numberFromEnv("MIN_STOP_PERCENT", 0.15, { min: 0.01, max: 5 }),
      maxStopPercent: numberFromEnv("MAX_STOP_PERCENT", 4, { min: 0.1, max: 20 }),
      takeProfitRR1: numberFromEnv("TAKE_PROFIT_RR_1", 1.5, { min: 0.5, max: 10 }),
      takeProfitRR2: numberFromEnv("TAKE_PROFIT_RR_2", 2.5, { min: 1, max: 20 }),
      riskPerTradePercent: numberFromEnv("RISK_PER_TRADE_PERCENT", 1, { min: 0.1, max: 5 }),
      breakoutBufferAtr: numberFromEnv("BREAKOUT_BUFFER_ATR", 0.05, { min: 0, max: 1 }),
      pullbackZoneAtr: numberFromEnv("PULLBACK_ZONE_ATR", 0.25, { min: 0.05, max: 2 }),
      pullbackTriggerBufferAtr: numberFromEnv("PULLBACK_TRIGGER_BUFFER_ATR", 0.03, { min: 0, max: 1 }),
      preMoveMaxBoundaryDistanceAtr: numberFromEnv("V2_4_MAX_BOUNDARY_DISTANCE_ATR", 1.2, { min: 0.1, max: 3 }),
      preMoveMaxCompressionRatio: numberFromEnv("V2_4_MAX_COMPRESSION_RATIO", 1.25, { min: 0.3, max: 3 }),
      preMoveMinimumExplosionScore: numberFromEnv("V2_4_MIN_EXPLOSION_SCORE", 40, { min: 0, max: 100 }),
      preMoveMinimumDirectionScore: numberFromEnv("V2_4_MIN_DIRECTION_SCORE", 48, { min: 0, max: 100 }),
    }),
  });
}

export { ALLOWED_INTERVALS };
