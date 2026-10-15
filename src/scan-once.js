import { loadConfig } from "./config.js";
import { createMarketDataClient } from "./exchanges/create-client.js";
import { analyzeMarket } from "./domain/strategy.js";
import { loadDotEnv } from "./env.js";

loadDotEnv();
const config = loadConfig();
const exchange = createMarketDataClient(config);

const results = await Promise.all(config.symbols.map(async (symbol) => {
  try {
    const candles = await exchange.fetchKlines(symbol, config.interval, config.candleLimit);
    const analysis = analyzeMarket({ symbol, interval: config.interval, candles, config: config.strategy });
    analysis.source = config.provider;
    return analysis;
  } catch (error) {
    return { symbol, status: "ERROR", message: error instanceof Error ? error.message : String(error) };
  }
}));

console.log(JSON.stringify(results, null, 2));
if (results.every((item) => item.status === "ERROR")) process.exitCode = 1;
