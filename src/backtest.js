import { loadConfig } from "./config.js";
import { createMarketDataClient } from "./exchanges/create-client.js";
import { analyzeMarket } from "./domain/strategy.js";
import { loadDotEnv } from "./env.js";
import { pathToFileURL } from "node:url";

export function runBacktest({ candles, symbol, interval, strategyConfig, maxHoldCandles = 48, feeRate = 0.0005, slippageRate = 0.0002 }) {
  const warmup = Math.max(strategyConfig.emaSlow + 3, strategyConfig.rsiPeriod + 3, strategyConfig.atrPeriod + 3, 60);
  const trades = [];
  let equity = 1;
  let equityPeak = 1;
  let maxDrawdown = 0;

  for (let index = warmup; index < candles.length - 1; index += 1) {
    const analysis = analyzeMarket({ symbol, interval, candles: candles.slice(0, index + 1), config: strategyConfig });
    if (analysis.status !== "SIGNAL") continue;
    const { entry, stopLoss, takeProfit1 } = analysis.risk;
    const riskDistance = Math.abs(entry - stopLoss);
    let exitPrice = candles[Math.min(index + maxHoldCandles, candles.length - 1)].close;
    let exitReason = "TIMEOUT";
    let exitIndex = Math.min(index + maxHoldCandles, candles.length - 1);

    for (let future = index + 1; future <= exitIndex; future += 1) {
      const next = candles[future];
      const stopHit = analysis.direction === "LONG" ? next.low <= stopLoss : next.high >= stopLoss;
      const targetHit = analysis.direction === "LONG" ? next.high >= takeProfit1 : next.low <= takeProfit1;
      if (stopHit) {
        exitPrice = stopLoss;
        exitReason = targetHit ? "AMBIGUOUS_STOP_FIRST" : "STOP";
        exitIndex = future;
        break;
      }
      if (targetHit) {
        exitPrice = takeProfit1;
        exitReason = "TAKE_PROFIT_1";
        exitIndex = future;
        break;
      }
    }

    const directionSign = analysis.direction === "LONG" ? 1 : -1;
    const grossMove = directionSign * (exitPrice - entry);
    const tradingCost = entry * (feeRate * 2 + slippageRate * 2);
    const netR = (grossMove - tradingCost) / riskDistance;
    const returnOnEquity = (strategyConfig.riskPerTradePercent / 100) * netR;
    equity *= 1 + returnOnEquity;
    equityPeak = Math.max(equityPeak, equity);
    maxDrawdown = Math.max(maxDrawdown, (equityPeak - equity) / equityPeak);
    trades.push({
      signalTime: analysis.candleCloseTime,
      exitTime: candles[exitIndex].closeTime,
      direction: analysis.direction,
      entry,
      exit: exitPrice,
      exitReason,
      netR: Number(netR.toFixed(3)),
    });
    index = exitIndex;
  }

  const wins = trades.filter((trade) => trade.netR > 0);
  const losses = trades.filter((trade) => trade.netR <= 0);
  const totalWinR = wins.reduce((sum, trade) => sum + trade.netR, 0);
  const totalLossR = Math.abs(losses.reduce((sum, trade) => sum + trade.netR, 0));
  return {
    assumptions: { maxHoldCandles, feeRate, slippageRate, riskPerTradePercent: strategyConfig.riskPerTradePercent, ambiguousCandle: "stop_first" },
    metrics: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRatePercent: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(2)) : 0,
      profitFactor: totalLossR ? Number((totalWinR / totalLossR).toFixed(3)) : null,
      returnPercent: Number(((equity - 1) * 100).toFixed(2)),
      maxDrawdownPercent: Number((maxDrawdown * 100).toFixed(2)),
    },
    trades,
  };
}

async function cli() {
  loadDotEnv();
  const config = loadConfig();
  const symbol = (process.argv[2] ?? config.symbols[0]).toUpperCase();
  const interval = process.argv[3] ?? config.interval;
  const limit = Math.min(1500, Math.max(100, Number.parseInt(process.argv[4] ?? "1000", 10)));
  const exchange = createMarketDataClient(config);
  const candles = await exchange.fetchKlines(symbol, interval, limit);
  const result = runBacktest({ candles, symbol, interval, strategyConfig: config.strategy });
  console.log(JSON.stringify({ symbol, interval, candleCount: candles.length, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
