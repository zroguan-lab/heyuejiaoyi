import path from "node:path";
import { loadConfig } from "../src/config.js";
import { loadDotEnv } from "../src/env.js";
import { HistoricalDataCatalog } from "../src/research/historical-data-catalog.js";
import {
  loadHistoricalReplayInputs,
  RESEARCH_CURRENT_METADATA,
  resolveHistoricalReplayWindow,
  STRICT_POINT_IN_TIME_METADATA,
} from "../src/research/historical-market-replay.js";
import { runHistoricalV23PortfolioReplay } from "../src/research/historical-portfolio-replay.js";

function integerArgument(name, fallback, { minimum, maximum }) {
  const raw = process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=")[1];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} 必须是${minimum}到${maximum}的整数`);
  }
  return value;
}

function tradeSummary(trade) {
  return {
    id: trade.id,
    symbol: trade.symbol,
    direction: trade.direction,
    score: trade.signalEvaluation?.score ?? null,
    tier: trade.signalEvaluation?.experimentTier ?? null,
    status: trade.status,
    createdAt: trade.createdAt,
    openedAt: trade.openedAt ?? null,
    closedAt: trade.closedAt ?? null,
    exitReason: trade.exitReason ?? null,
    margin: trade.margin,
    notional: trade.notional,
    riskAmount: trade.riskAmount,
    netPnl: trade.pnl.net,
    netR: trade.pnl.netR,
    costs: trade.costs,
  };
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const catalog = new HistoricalDataCatalog({
    root: path.resolve(process.cwd(), process.env.HISTORICAL_DATA_ROOT ?? "research-data"),
  });
  const points = integerArgument("points", 288, { minimum: 1, maximum: 2_016 });
  const allowCurrent = process.argv.includes("--research-only-current-metadata");
  const full = process.argv.includes("--full");
  const stepMs = Number(config.marketRadar.refreshMinutes) * 60_000;
  const replayWindow = await resolveHistoricalReplayWindow({ catalog, decisionPoints: points, stepMs, config });
  const inputs = await loadHistoricalReplayInputs({
    catalog,
    symbols: replayWindow.symbols,
    startTime: replayWindow.loadStartTime,
    endTime: replayWindow.loadEndTime,
  });
  const endTime = replayWindow.decisionEndTime;
  const decisionTimes = Array.from({ length: points }, (_, index) => endTime - (points - index - 1) * stepMs);
  const result = runHistoricalV23PortfolioReplay({
    ...inputs,
    decisionTimes,
    endTime,
    config,
    metadataPolicy: allowCurrent ? RESEARCH_CURRENT_METADATA : STRICT_POINT_IN_TIME_METADATA,
  });
  const output = full ? result : {
    modelVersion: result.modelVersion,
    period: {
      start: new Date(decisionTimes[0]).toISOString(),
      end: new Date(endTime).toISOString(),
      decisionPoints: decisionTimes.length,
    },
    symbols: inputs.symbols,
    assumptions: result.assumptions,
    promotionEligible: result.promotionEligible,
    researchOnlyReasons: result.researchOnlyReasons,
    metrics: result.metrics,
    dailyEquity: result.dailyEquity,
    tradeSamples: result.trades.slice(-20).map(tradeSummary),
    rejectionSamples: result.rejected.slice(-20),
  };
  console.log(JSON.stringify(output, null, 2));
}

cli().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
