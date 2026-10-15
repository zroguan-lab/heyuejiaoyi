import { EventEmitter } from "node:events";
import { advanceTradeTimeline, createSimulatedTrade } from "../domain/trade-lifecycle.js";
import { buildCorrelationMatrix, selectPortfolioCandidates } from "../domain/portfolio.js";
import { buildMarketRegime } from "../domain/market-regime.js";
import {
  buildMarketRadarSnapshot,
  deriveMoverMetrics,
  marketRadarContext,
  marketRadarSourceLabel,
  MARKET_RADAR_SCHEMA_REVISION,
} from "../domain/market-radar.js";
import { selectProductionShadowCandidates, SHADOW_STRATEGY_VERSION } from "../domain/shadow-v2.js";
import {
  analyzeV24SignalSnapshot,
  buildV24StrategySnapshot,
  evaluateV24CandidateSnapshot,
  V24_STRATEGY_SNAPSHOT_METADATA_KEY,
} from "../domain/v2-4-strategy-engine.js";

async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export class ResearchMonitor extends EventEmitter {
  constructor({ primaryExchange, auxiliaryExchange = null, store, notifier = null, config, logger = console }) {
    super();
    this.primaryExchange = primaryExchange;
    this.auxiliaryExchange = auxiliaryExchange;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.strategySnapshot = config?.strategy && config?.shadowV2 && config?.marketRadar
      ? buildV24StrategySnapshot(config)
      : null;
    this.logger = logger;
    this.symbols = [...config.symbols];
    this.universe = [];
    this.marketRadar = null;
    this.latest = new Map();
    this.returnSeries = new Map();
    this.timer = null;
    this.running = false;
    this.state = {
      startedAt: null,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      scanCount: 0,
      errors: {},
      universeError: null,
      radarError: null,
      lastUniverseAttemptAt: null,
      lastUniverseRefreshAt: null,
      rateLimit: null,
    };
  }

  async initialize() {
    if (this.strategySnapshot) {
      await this.store.setMetadata?.(V24_STRATEGY_SNAPSHOT_METADATA_KEY, this.strategySnapshot);
    }
    await this.refreshUniverse();
  }

  async enrichMoverUniverse(rawItems) {
    if (!this.config.marketRadar?.enabled || typeof this.primaryExchange.fetchKlines !== "function") return rawItems;
    const results = await mapWithConcurrency(rawItems, this.config.scanConcurrency, async (item) => {
      const candles = await this.primaryExchange.fetchKlines(
        item.symbol,
        "15m",
        this.config.marketRadar.moverCandleLimit,
      );
      return { ...item, ...deriveMoverMetrics(candles) };
    });
    return results.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      return {
        ...rawItems[index],
        moverDataComplete: false,
        moverDataError: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }

  async refreshUniverse({ force = false } = {}) {
    this.state.lastUniverseAttemptAt = Date.now();
    const cached = await this.store.getMetadata("universe");
    const cachedRadar = await this.store.getMetadata("market_radar");
    const radarEnabled = Boolean(this.config.marketRadar?.enabled);
    const refreshMs = radarEnabled
      ? this.config.marketRadar.refreshMinutes * 60_000
      : this.config.universe.refreshHours * 3_600_000;
    const radarCacheValid = !radarEnabled || (
      cachedRadar?.value?.version === this.config.marketRadar.modelVersion
      && cachedRadar?.value?.schemaRevision === MARKET_RADAR_SCHEMA_REVISION
    );
    if (!force && cached && radarCacheValid && Date.now() - cached.updatedAt < refreshMs) {
      this.universe = cached.value.items;
      this.marketRadar = cachedRadar?.value ?? null;
      this.symbols = this.universe.map((item) => item.symbol);
      this.state.lastUniverseRefreshAt = cached.value.selectedAt ?? cached.updatedAt;
      return this.universe;
    }
    if (!this.config.universe.dynamic || typeof this.primaryExchange.fetchUniverse !== "function") {
      this.universe = this.config.symbols.map((symbol) => ({ symbol, source: "configured" }));
      this.symbols = [...this.config.symbols];
      return this.universe;
    }
    try {
      const rawItems = await this.primaryExchange.fetchUniverse({
        limit: radarEnabled ? this.config.marketRadar.discoverySize : this.config.universe.size,
        minListingDays: this.config.universe.minListingDays,
        maxSpreadBps: this.config.universe.maxSpreadBps,
      });
      if (!rawItems.length) throw new Error("筛选后没有可用标的");
      const moverItems = radarEnabled ? await this.enrichMoverUniverse(rawItems) : rawItems;
      const selectedAt = Date.now();
      this.marketRadar = radarEnabled ? buildMarketRadarSnapshot(moverItems, {
        previousSnapshot: radarCacheValid ? cachedRadar?.value ?? null : null,
        now: selectedAt,
        discoverySize: this.config.marketRadar.discoverySize,
        deepScanSize: this.config.marketRadar.deepScanSize,
        minimumHoldMs: this.config.marketRadar.minimumHoldMinutes * 60_000,
        coreMinimumScore: this.config.marketRadar.coreMinimumScore,
        maxSpreadBps: this.config.universe.maxSpreadBps,
        gainerCount: this.config.marketRadar.gainerCount,
        loserCount: this.config.marketRadar.loserCount,
        rankVelocityCount: this.config.marketRadar.rankVelocityCount,
        volumeShockCount: this.config.marketRadar.volumeShockCount,
        minimumVolumeShockRatio: this.config.marketRadar.minimumVolumeShockRatio,
        compressionCount: this.config.marketRadar.compressionCount,
        boundaryPressureCount: this.config.marketRadar.boundaryPressureCount,
        earlyAccelerationCount: this.config.marketRadar.earlyAccelerationCount,
      }) : null;
      const selectedSymbols = this.marketRadar ? new Set(this.marketRadar.selectedSymbols) : null;
      const items = this.marketRadar
        ? this.marketRadar.items.filter((item) => selectedSymbols.has(item.symbol))
        : rawItems;
      this.universe = items;
      this.symbols = items.map((item) => item.symbol);
      this.state.universeError = null;
      this.state.radarError = null;
      this.state.lastUniverseRefreshAt = selectedAt;
      if (this.marketRadar) {
        await this.store.setMetadata("market_radar", this.marketRadar);
        this.emit("radar", this.marketRadar);
      }
      const universeValue = {
        items,
        selectedAt,
        provider: this.config.primaryProvider,
        radarVersion: this.marketRadar?.version ?? null,
        radarSnapshotId: this.marketRadar?.snapshotId ?? null,
      };
      await this.store.setMetadata("universe", universeValue);
      await this.store.saveUniverseSnapshot(universeValue);
      return items;
    } catch (error) {
      this.state.universeError = error instanceof Error ? error.message : String(error);
      this.state.radarError = radarEnabled ? this.state.universeError : null;
      if (cached?.value?.items?.length) {
        this.universe = cached.value.items;
        this.marketRadar = cachedRadar?.value ?? null;
        this.symbols = this.universe.map((item) => item.symbol);
      } else {
        this.universe = this.config.symbols.map((symbol) => ({ symbol, source: "configured_fallback" }));
        this.symbols = [...this.config.symbols];
      }
      return this.universe;
    }
  }

  async scanSymbol(symbol) {
    const [hourly, fifteen, five] = await Promise.all([
      this.primaryExchange.fetchKlines(symbol, this.config.intervals.trend, this.config.candleLimit),
      this.primaryExchange.fetchKlines(symbol, this.config.intervals.setup, this.config.candleLimit),
      this.primaryExchange.fetchKlines(symbol, this.config.intervals.trigger, this.config.candleLimit),
    ]);
    const universeIndex = this.universe.findIndex((item) => item.symbol === symbol);
    const universeItem = universeIndex >= 0 ? this.universe[universeIndex] : null;
    const radarItem = this.marketRadar?.items?.find((item) => item.symbol === symbol) ?? universeItem;
    const radarContext = marketRadarContext(this.marketRadar, radarItem);
    const analysis = analyzeV24SignalSnapshot({
      symbol,
      hourly,
      fifteen,
      five,
      radar: radarContext,
      universeItem,
      universeIndex,
      universeSize: this.universe.length,
      primarySource: this.config.primaryProvider,
      decisionTime: Date.now(),
    }, {
      strategyConfig: this.config.strategy,
      costsConfig: this.config.costs,
    });
    const hourlyReturns = hourly.slice(-97).map((candle, index, rows) => index === 0 ? null : (candle.close / rows[index - 1].close) - 1).filter(Number.isFinite);
    this.returnSeries.set(symbol, hourlyReturns);
    if (analysis.candidates.length && this.auxiliaryExchange) {
      try {
        const auxiliary = await this.auxiliaryExchange.fetchKlines(symbol, this.config.intervals.setup, 3);
        const primaryPrice = fifteen.at(-1)?.close;
        const auxiliaryPrice = auxiliary.at(-1)?.close;
        analysis.auxiliary = {
          provider: this.config.auxiliaryProvider,
          available: Number.isFinite(auxiliaryPrice),
          price: auxiliaryPrice ?? null,
          deviationBps: Number.isFinite(primaryPrice) && Number.isFinite(auxiliaryPrice) ? Math.abs(primaryPrice - auxiliaryPrice) / primaryPrice * 10_000 : null,
        };
      } catch (error) {
        analysis.auxiliary = { provider: this.config.auxiliaryProvider, available: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    analysis.candidates = analysis.candidates.map((candidate) => ({ ...candidate, auxiliaryCheck: analysis.auxiliary ?? null }));
    this.latest.set(symbol, analysis);
    this.emit("analysis", analysis);
    return analysis;
  }

  async advanceActiveTrades() {
    const active = this.config.execution?.strategySource === "V2_PRODUCTION"
      ? []
      : await this.store.listActiveTrades();
    for (const trade of active) {
      try {
        const { candles, funding } = await this.fetchTradeEvents(trade);
        const updated = advanceTradeTimeline(trade, candles, funding);
        if (JSON.stringify(updated) !== JSON.stringify(trade)) {
          await this.store.saveTrade(updated);
          this.emit("trade", updated);
        }
      } catch (error) {
        this.logger.error(`[trade] ${trade.symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
    const manual = await this.store.listActiveManualTrades();
    for (const item of manual) {
      try {
        const { candles, funding } = await this.fetchTradeEvents(item.trade);
        const updated = advanceTradeTimeline(item.trade, candles, funding);
        if (JSON.stringify(updated) !== JSON.stringify(item.trade)) {
          await this.store.saveManualTrade(updated, item.note);
          this.emit("manualTrade", updated);
        }
      } catch (error) {
        this.logger.error(`[manual] ${item.trade.symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
    const shadow = await (this.store.listActiveShadowTrades?.() ?? []);
    for (const trade of shadow) {
      try {
        const { candles, funding } = await this.fetchTradeEvents(trade);
        const updated = advanceTradeTimeline(trade, candles, funding);
        if (JSON.stringify(updated) !== JSON.stringify(trade)) {
          await this.store.saveShadowTrade(updated);
          this.emit("shadowTrade", updated);
        }
      } catch (error) {
        this.logger.error(`[shadow] ${trade.symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  async buildShadowRegime(analyses) {
    if (!this.config.shadowV2?.enabled) return null;
    try {
      const [btcFourHour, btcHourly] = await Promise.all([
        this.primaryExchange.fetchKlines("BTCUSDT", "4h", this.config.candleLimit),
        this.primaryExchange.fetchKlines("BTCUSDT", "1h", this.config.candleLimit),
      ]);
      return buildMarketRegime({ btcFourHour, btcHourly, analyses, config: this.config.strategy });
    } catch (error) {
      this.logger.error(`[shadow-regime] ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  async shadowEquity() {
    const records = await (this.store.listShadowSignals?.(10_000) ?? []);
    return records.filter((record) => (
      record?.evaluation?.strategyVersion === SHADOW_STRATEGY_VERSION
      && record?.decision?.selected === true
    )).reduce((equity, record) => {
      const trade = record.trade;
      if (!trade || !["CLOSED", "EXPIRED"].includes(trade.status)) return equity;
      return equity + (Number(trade.pnl?.net) || 0);
    }, this.config.portfolio.startingEquity);
  }

  async enrichShadowCandidate(candidate, marketRegime, equity) {
    const pricedCandidate = candidate.order?.style === "ACTIVE_DYNAMIC"
      ? await this.priceCandidate(candidate)
      : candidate;
    let premium = null;
    if (typeof this.primaryExchange.fetchPremiumIndex === "function") {
      try {
        premium = await this.primaryExchange.fetchPremiumIndex(pricedCandidate.symbol);
      } catch (error) {
        this.logger.error(`[shadow-funding] ${pricedCandidate.symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return evaluateV24CandidateSnapshot({
      candidate: pricedCandidate,
      marketRegime,
      premium,
      equity,
      decisionTime: Date.now(),
    }, {
      shadowConfig: this.config.shadowV2,
      marketRadarConfig: this.config.marketRadar,
      costsConfig: this.config.costs,
      portfolioConfig: this.config.portfolio,
    });
  }

  async runShadowAllocation(candidates) {
    if (!this.config.shadowV2?.enabled || typeof this.store.saveShadowDecision !== "function") {
      return { selected: [], rejected: [], selectionMode: "DISABLED" };
    }
    const active = (await this.store.listActiveShadowTrades()).filter((trade) => trade.counterfactual !== true);
    const allocation = selectProductionShadowCandidates(candidates, active, {
      minimumScore: this.config.shadowV2.explorationMinimumScore,
    });
    const createResearchTrade = (candidate, {
      portfolio = "V2_4_3_PREMOVE",
      counterfactual = false,
    } = {}) => {
      const margin = candidate.shadowV2.fixedRiskPlan.targetMargin;
      const trade = createSimulatedTrade(candidate, {
        margin,
        leverage: this.config.portfolio.leverage,
        feeRate: this.config.costs.fallbackFeeRate,
        slippageRate: candidate.order.style === "ACTIVE_DYNAMIC" ? this.config.costs.fallbackSlippageRate : 0,
      });
      trade.portfolio = portfolio;
      trade.experimentTier = candidate.shadowV2.experimentTier;
      trade.qualityObservations = [...(candidate.shadowV2.qualityObservations ?? [])];
      trade.marketRadar = candidate.marketRadar ?? null;
      trade.shadowRiskPercent = candidate.shadowV2.fixedRiskPlan.targetRiskPercent;
      trade.estimatedCostR = Number.isFinite(Number(candidate.shadowV2?.costs?.totalCostR))
        ? Number(candidate.shadowV2.costs.totalCostR)
        : null;
      trade.orderSubmissionAllowed = false;
      trade.counterfactual = counterfactual;
      return trade;
    };
    for (const item of allocation.rejected) {
      const hardReasons = item.candidate.shadowV2?.hardRejectionReasons ?? [];
      const boundaryFilterOnly = item.reason === "V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE"
        && hardReasons.length === 1
        && Number(item.candidate.shadowV2?.score) >= Number(this.config.shadowV2.explorationMinimumScore);
      const trade = boundaryFilterOnly
        ? createResearchTrade(item.candidate, { portfolio: "V2_4_3_BOUNDARY_COUNTERFACTUAL", counterfactual: true })
        : null;
      await this.store.saveShadowDecision(item.candidate, {
        selected: false,
        rejectionReason: item.reason,
        trade,
        counterfactual: Boolean(trade),
      });
    }
    const selected = [];
    for (const candidate of allocation.selected) {
      const tierLabel = candidate.shadowV2.experimentTier === "CORE" ? "核心层" : "探索层";
      const radar = candidate.marketRadar;
      const sources = (radar?.opportunitySources ?? [])
        .filter((source) => source !== "RETAINED")
        .slice(0, 2)
        .map(marketRadarSourceLabel)
        .join("、") || "异动候选";
      const rankText = Number.isFinite(Number(radar?.moverRank)) ? `方向榜第${radar.moverRank}` : "方向排名可用";
      const velocityText = Number(radar?.rankVelocity) > 0 ? `、排名上升${radar.rankVelocity}位` : "";
      const relativeText = Number.isFinite(Number(radar?.relativeStrengthBtc1h))
        ? `、相对BTC${radar.relativeStrengthBtc1h >= 0 ? "+" : ""}${Number(radar.relativeStrengthBtc1h).toFixed(2)}%`
        : "";
      const shadowCandidate = {
        ...candidate,
        strategyVersion: SHADOW_STRATEGY_VERSION,
        experimentTier: candidate.shadowV2.experimentTier,
        entryReason: `${candidate.symbol}因${sources}进入爆发前候选，波动收缩比${Number(candidate.preMove?.compressionRatio ?? 0).toFixed(2)}、距结构边界${Number(candidate.preMove?.boundaryDistanceAtr ?? 0).toFixed(2)}ATR、爆发评分${candidate.preMove?.explosionScore ?? "-"}分、方向评分${candidate.preMove?.directionScore ?? "-"}分，V2.4.3${tierLabel}总评分${candidate.shadowV2.score}分，因此进入后台反事实研究账本。`,
      };
      const trade = createResearchTrade(shadowCandidate);
      await this.store.saveShadowDecision(shadowCandidate, { selected: true, trade });
      selected.push(trade);
      this.emit("shadowSignal", { candidate: shadowCandidate, trade });
      this.logger.info(`[v2.4.3-${candidate.shadowV2.experimentTier.toLowerCase()}] ${candidate.symbol} ${candidate.strategy} ${candidate.direction} score=${candidate.shadowV2.score}`);
    }
    return { ...allocation, selected };
  }

  async fetchTradeEvents(trade) {
    const now = Date.now();
    const gapMinutes = Math.ceil((now - trade.lastProcessedAt) / 60_000);
    const candles = gapMinutes > 450 && typeof this.primaryExchange.fetchHistoricalKlines === "function"
      ? await this.primaryExchange.fetchHistoricalKlines(trade.symbol, this.config.intervals.path, {
        startTime: Math.max(0, trade.lastProcessedAt + 1),
        endTime: now,
        maxCandles: Math.min(1_000_000, Math.max(500, gapMinutes + 10)),
      })
      : await this.primaryExchange.fetchKlines(trade.symbol, this.config.intervals.path, 500);
    const fundingStart = trade.lastFundingAt ?? trade.lastProcessedAt;
    let funding = [];
    if (typeof this.primaryExchange.fetchFundingRates === "function" && now > fundingStart) {
      try {
        funding = await this.primaryExchange.fetchFundingRates(trade.symbol, { startTime: Math.max(0, fundingStart + 1), endTime: now });
      } catch (error) {
        this.logger.error(`[funding] ${trade.symbol}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { candles, funding };
  }

  async priceCandidate(candidate) {
    if (candidate.order.style !== "ACTIVE_DYNAMIC" || typeof this.primaryExchange.fetchBookTicker !== "function") return candidate;
    const book = await this.primaryExchange.fetchBookTicker(candidate.symbol);
    if (book.spreadBps > this.config.universe.maxSpreadBps) throw new Error(`点差 ${book.spreadBps.toFixed(2)} bps 超过上限`);
    const maxBufferRate = this.config.costs.activeLimitMaxBps / 10_000;
    const reference = candidate.direction === "LONG" ? book.askPrice : book.bidPrice;
    const buffer = Math.min((book.askPrice - book.bidPrice) * 0.5, reference * maxBufferRate);
    const entry = candidate.direction === "LONG" ? reference + buffer : reference - buffer;
    const riskDistance = Math.abs(entry - candidate.risk.stopLoss);
    const stopPercent = (riskDistance / entry) * 100;
    if (stopPercent > this.config.strategy.maxStopPercent) throw new Error(`动态入场后止损距离 ${stopPercent.toFixed(2)}% 超限`);
    const sign = candidate.direction === "LONG" ? 1 : -1;
    return {
      ...candidate,
      order: { ...candidate.order, entry },
      risk: {
        ...candidate.risk,
        entry,
        stopPercent,
        takeProfit1: entry + sign * riskDistance * this.config.strategy.takeProfitRR1,
        takeProfit2: entry + sign * riskDistance * this.config.strategy.takeProfitRR2,
      },
      metrics: { ...candidate.metrics, spreadBps: book.spreadBps },
    };
  }

  async scanAll() {
    if (this.running) return { skipped: true, reason: "previous_scan_running" };
    this.running = true;
    this.state.lastScanStartedAt = new Date().toISOString();
    try {
      const rateLimit = this.primaryExchange.rateLimitStatus?.();
      if (rateLimit?.blocked) {
        this.state.rateLimit = {
          blockedUntil: rateLimit.blockedUntil,
          message: `Binance 请求已暂停至 ${new Date(rateLimit.blockedUntil).toISOString()}`,
        };
        this.state.lastScanCompletedAt = new Date().toISOString();
        return { skipped: true, reason: "binance_rate_limited", retryAt: rateLimit.blockedUntil };
      }
      this.state.rateLimit = null;
      const universeCheckInterval = this.config.marketRadar?.enabled
        ? this.config.marketRadar.refreshMinutes * 60_000
        : Math.min(this.config.universe.refreshHours * 3_600_000, 3_600_000);
      if (this.config.universe.dynamic && Date.now() - (this.state.lastUniverseAttemptAt ?? 0) >= universeCheckInterval) {
        await this.refreshUniverse();
      }
      await this.advanceActiveTrades();
      const results = await mapWithConcurrency(this.symbols, this.config.scanConcurrency, (symbol) => this.scanSymbol(symbol));
      const analyses = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const marketRegime = await this.buildShadowRegime(analyses);
      const shadowEquity = this.config.shadowV2?.enabled ? await this.shadowEquity() : null;
      const newCandidates = [];
      for (let index = 0; index < results.length; index += 1) {
        const symbol = this.symbols[index];
        const result = results[index];
        if (result.status === "rejected") {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.latest.delete(symbol);
          this.state.errors[symbol] = { message, at: new Date().toISOString() };
          this.logger.error(`[error] ${symbol}: ${message}`);
          continue;
        }
        delete this.state.errors[symbol];
        for (const rawCandidate of result.value.candidates) {
          const existing = await this.store.getSignal(rawCandidate.id);
          if (existing) continue;
          try {
            const candidate = this.config.shadowV2?.enabled
              ? await this.enrichShadowCandidate(rawCandidate, marketRegime, shadowEquity)
              : rawCandidate;
            if (await this.store.saveCandidate(candidate)) newCandidates.push(candidate);
          } catch (error) {
            this.logger.error(`[candidate] ${rawCandidate.symbol}: ${error instanceof Error ? error.message : error}`);
          }
        }
      }

      const active = await this.store.listActiveTrades();
      const correlations = buildCorrelationMatrix(this.returnSeries);
      const shadowAllocation = await this.runShadowAllocation(newCandidates);
      const selected = [];
      if (this.config.execution?.strategySource === "V2_PRODUCTION") {
        for (const candidate of newCandidates) {
          await this.store.markCandidate(candidate.id, { selected: false, rejectionReason: "V1_EXECUTION_SOURCE_DISABLED" });
        }
      } else {
        const allocation = selectPortfolioCandidates(newCandidates, active, {
          correlations,
          minimumScore: this.config.strategy.minConfidence,
        });
        for (const rejected of allocation.rejected) {
          await this.store.markCandidate(rejected.candidate.id, { selected: false, rejectionReason: rejected.reason });
        }
        for (const rawCandidate of allocation.selected) {
          try {
            const candidate = await this.priceCandidate(rawCandidate);
            await this.store.markCandidate(candidate.id, { selected: true });
            const trade = createSimulatedTrade(candidate, {
              margin: this.config.portfolio.marginPerTrade,
              leverage: this.config.portfolio.leverage,
              feeRate: this.config.costs.fallbackFeeRate,
              slippageRate: candidate.order.style === "ACTIVE_DYNAMIC" ? this.config.costs.fallbackSlippageRate : 0,
            });
            await this.store.saveTrade(trade, candidate);
            selected.push(trade);
            this.emit("portfolioSignal", { candidate, trade });
            void this.notifier?.notify({
              title: `${candidate.symbol} ${candidate.direction === "LONG" ? "买入 / 开多" : "卖出 / 开空"}`,
              body: `${candidate.strategy === "BREAKOUT" ? "趋势突破" : "趋势回调"}｜限价 ${trade.entryPrice}｜止损 ${trade.stopLoss}`,
            });
            this.logger.info(`[portfolio] ${candidate.symbol} ${candidate.strategy} ${candidate.direction} @ ${trade.entryPrice}`);
          } catch (error) {
            await this.store.markCandidate(rawCandidate.id, { selected: false, rejectionReason: `PRICING_FAILED: ${error instanceof Error ? error.message : error}` });
          }
        }
      }
      this.state.scanCount += 1;
      this.state.lastScanCompletedAt = new Date().toISOString();
      return { skipped: false, results, selected, shadowSelected: shadowAllocation.selected };
    } finally {
      this.running = false;
    }
  }

  async start() {
    if (this.timer) return;
    this.state.startedAt = new Date().toISOString();
    await this.initialize();
    await this.scanAll();
    this.timer = setInterval(() => void this.scanAll(), this.config.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot() {
    return {
      status: this.running ? "SCANNING" : "IDLE",
      ...this.state,
      symbols: this.symbols,
      universeSize: this.symbols.length,
      intervals: this.config.intervals,
      pollSeconds: this.config.pollMs / 1000,
      selectionMode: this.config.execution?.strategySource === "V2_PRODUCTION" ? "V2_4_3_PREMOVE_BOUNDARY_FILTER_ALL_ELIGIBLE" : "ALL_ELIGIBLE",
      minimumScore: this.config.execution?.strategySource === "V2_PRODUCTION"
        ? this.config.shadowV2?.minimumScore
        : this.config.strategy.minConfidence,
      executionStrategySource: this.config.execution?.strategySource ?? "V1_ALL_ELIGIBLE",
      strategyContract: this.strategySnapshot ? {
        version: this.strategySnapshot.contractVersion,
        fingerprint: this.strategySnapshot.fingerprint,
        capturedAt: this.strategySnapshot.capturedAt,
      } : null,
      shadowV2: {
        enabled: Boolean(this.config.shadowV2?.enabled),
        mode: "SHADOW_ONLY",
        orderSubmissionAllowed: false,
        demoPromotionEnabled: Boolean(this.config.shadowV2?.executionEnabled),
        strategyVersion: this.config.shadowV2?.strategyVersion ?? SHADOW_STRATEGY_VERSION,
        minimumScore: this.config.shadowV2?.explorationMinimumScore ?? null,
        coreMinimumScore: this.config.shadowV2?.coreMinimumScore ?? null,
        explorationMinimumScore: this.config.shadowV2?.explorationMinimumScore ?? null,
        sampleTarget: this.config.shadowV2?.sampleTarget ?? 100,
        fixedPositionLimit: null,
      },
      marketRadar: this.marketRadar ? structuredClone(this.marketRadar) : null,
      marketRadarConfig: {
        enabled: Boolean(this.config.marketRadar?.enabled),
        requiredForV2: Boolean(this.config.marketRadar?.requiredForV2),
        modelVersion: this.config.marketRadar?.modelVersion ?? null,
        refreshMinutes: this.config.marketRadar?.refreshMinutes ?? null,
        discoverySize: this.config.marketRadar?.discoverySize ?? null,
        deepScanSize: this.config.marketRadar?.deepScanSize ?? null,
        gainerCount: this.config.marketRadar?.gainerCount ?? null,
        loserCount: this.config.marketRadar?.loserCount ?? null,
        rankVelocityCount: this.config.marketRadar?.rankVelocityCount ?? null,
        volumeShockCount: this.config.marketRadar?.volumeShockCount ?? null,
      },
      latest: this.symbols.map((symbol) => this.latest.get(symbol)).filter(Boolean),
    };
  }
}
