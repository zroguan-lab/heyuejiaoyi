const USDT_PERPETUAL_SYMBOL = /^[A-Z0-9]{1,16}USDT$/;

export function isExecutionSymbol(value) {
  return typeof value === "string" && USDT_PERPETUAL_SYMBOL.test(value);
}

export function assertExecutionSymbol(value, label = "执行标的") {
  if (!isExecutionSymbol(value)) throw new TypeError(`${label}必须是有效的 USDT 永续合约代码`);
  return value;
}

export async function resolveExecutionAllowedSymbols(store, config) {
  const [cachedUniverse, cachedRadar, activeRuns] = await Promise.all([
    store.getMetadata("universe"),
    store.getMetadata("market_radar"),
    store.listActiveExecutionRuns?.() ?? [],
  ]);
  const universeSymbols = (cachedUniverse?.value?.items ?? []).map((item) => item?.symbol);
  const radarSymbols = (cachedRadar?.value?.items ?? []).map((item) => item?.symbol);
  const activeRunSymbols = activeRuns.map((run) => run?.symbol);
  const symbols = [
    config.execution.canarySymbol,
    ...(config.symbols ?? []),
    ...universeSymbols,
    ...radarSymbols,
    ...activeRunSymbols,
  ].filter(isExecutionSymbol);
  return [...new Set(symbols)];
}
