// Pure accounting projection. Never use these observations to gate protection.
const number = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const positive = (v) => number(v) > 0 ? number(v) : null;
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-10, Math.abs(b) * 1e-6);

export function ownedExitFills(run, result = run.result) {
  const ids = new Set([run.operatorCloseOrder?.orderId,
    ...Object.values(run.protection ?? {}).flatMap(o => o && typeof o === "object" ? [o.actualOrderId, o.orderId] : [])
  ].filter(v => v !== null && v !== undefined && v !== "" && String(v) !== "0").map(String));
  const seen = new Set();
  return (result?.trades ?? []).filter(t => {
    if (!ids.has(String(t.orderId)) || t.side !== run.plan?.exitSide || (t.symbol && t.symbol !== run.symbol)) return false;
    const quantity = positive(t.quantity), price = positive(t.price), quote = number(t.quoteQuantity);
    if (!quantity || !price || (quote !== null && !close(quote, quantity * price))) return false;
    const key = t.id == null ? null : String(t.id);
    if (key !== null && seen.has(key)) return false;
    if (key !== null) seen.add(key);
    return true;
  }).sort((a, b) => (number(a.time) ?? Infinity) - (number(b.time) ?? Infinity)
    || Number(a.price) - Number(b.price));
}

export function observeOwnedExitFills(performance, run, result = run.result) {
  const state = { ...performance };
  const facts = executionFillFacts({ ...run, result });
  if (!(facts.riskAmount > 0)) return state;
  const sign = run.plan.direction === "SHORT" ? -1 : 1;
  for (const fill of ownedExitFills(run, result)) {
    const time = number(fill.time), price = positive(fill.price);
    if (time === null || time < state.openedAt) continue;
    const favorable = Math.max(0, sign * (price - facts.entryPrice) * facts.quantity / facts.riskAmount);
    const adverse = Math.max(0, -sign * (price - facts.entryPrice) * facts.quantity / facts.riskAmount);
    if (favorable > Number(state.mfeR ?? 0)) {
      state.mfeR = favorable; state.mfePrice = price; state.timeToMfeMs = time - state.openedAt;
    }
    if (adverse > Number(state.maeR ?? 0)) {
      state.maeR = adverse; state.maePrice = price; state.timeToMaeMs = time - state.openedAt;
    }
    state.observedPriceLow = Math.min(positive(state.observedPriceLow) ?? price, price);
    state.observedPriceHigh = Math.max(positive(state.observedPriceHigh) ?? price, price);
    state.lastObservedAt = Math.max(Number(state.lastObservedAt ?? state.openedAt), time);
    state.samples = Number(state.samples ?? 0) + 1;
  }
  return state;
}

export function executionFillFacts(run) {
  const order = run.entryOrder ?? {};
  const unknown = (reason) => ({ entryPrice: null, quantity: null, riskAmount: null, notional: null, source: null, status: "UNKNOWN", reason });
  if (run.status === "ENTRY_FACT_CONFLICT") return unknown("ENTRY_FACT_CONFLICT");
  if (run.entryFactVerification?.fills?.status === "CONFLICT") return unknown("ENTRY_FILL_IDENTITY_CONFLICT");
  if (run.entryFactVerification
    && !["ORDER_VERIFIED", "FILLS_VERIFIED"].includes(run.entryFactVerification.status)) {
    return unknown("ENTRY_ACK_NOT_VERIFIED");
  }
  if (!order.orderId) return unknown("ENTRY_ORDER_ID_MISSING");
  const fills = (run.result?.trades ?? []).filter((t) => String(t.orderId) === String(order.orderId));
  const expected = positive(order.executedQuantity);
  let quantity, quote, source;
  if (fills.length) {
    const seen = new Set();
    quantity = 0; quote = 0;
    for (const fill of fills) {
      if ((fill.side && fill.side !== run.plan?.entrySide) || (fill.symbol && fill.symbol !== run.symbol)) return unknown("ENTRY_FILL_IDENTITY_CONFLICT");
      if (fill.id != null) {
        if (seen.has(String(fill.id))) return unknown("DUPLICATE_ENTRY_FILL");
        seen.add(String(fill.id));
      }
      const q = positive(fill.quantity), p = positive(fill.price), value = positive(fill.quoteQuantity);
      if (!q || !p || (number(fill.quoteQuantity) !== null && (!value || !close(value, p * q)))) return unknown("ENTRY_FILL_INVALID");
      quantity += q; quote += value ?? p * q;
    }
    if (!expected || !close(quantity, expected)) return unknown("ENTRY_FILL_QUANTITY_INCOMPLETE_OR_CONFLICT");
    source = "ENTRY_ORDER_MATCHED_FILLS";
  } else {
    if (run.entryFactVerification && run.entryFactVerification.status !== "ORDER_VERIFIED") {
      return unknown("ENTRY_ACK_NOT_VERIFIED");
    }
    // Normalized exchange order aggregate must identify the order, side and symbol.
    if (!expected || order.symbol !== run.symbol || order.side !== run.plan?.entrySide) return unknown("VERIFIED_ENTRY_AGGREGATE_MISSING");
    const average = positive(order.averagePrice), cumulative = positive(order.cumulativeQuote);
    if (!cumulative || (average && !close(average * expected, cumulative))) return unknown("ENTRY_AGGREGATE_QUOTE_MISSING_OR_CONFLICT");
    quantity = expected; quote = cumulative; source = "VERIFIED_ORDER_CUMULATIVE_QUOTE";
  }
  const entryPrice = quote / quantity;
  const stop = positive(run.plan?.prices?.stopLoss);
  return { entryPrice, quantity, notional: quote, riskAmount: stop ? Math.abs(entryPrice - stop) * quantity : null,
    source, status: "CONFIRMED", reason: stop ? null : "INITIAL_STOP_MISSING" };
}

export function executionExcursionFacts(run, facts = executionFillFacts(run)) {
  const p = run.performance ?? {};
  const empty = (reason) => ({ mfePnl: null, maePnl: null, mfeR: null, maeR: null, mfePrice: null, maePrice: null,
    source: null, coverage: "UNKNOWN", reason });
  if (!(facts.riskAmount > 0)) return empty("ACTUAL_ENTRY_RISK_UNKNOWN");
  const closedAt = number(p.closedAt);
  const observedAt = number(p.lastObservedAt);
  if (closedAt !== null && observedAt !== null && observedAt > closedAt) return empty("OBSERVATION_AFTER_CLOSE");
  // Old R1 extrema may have been synthesized from legacy R before polling began.
  // Only new raw sample bounds carry sufficient provenance to rebase safely.
  const recoverable = p.factBasis === "ACTUAL_ENTRY_V1" && p.observationSource === "MARK_PRICE_POLL_AND_EXIT_FILLS";
  const low = positive(p.observedPriceLow), high = positive(p.observedPriceHigh);
  const favorable = run.plan.direction === "SHORT" ? low : high;
  const adverse = run.plan.direction === "SHORT" ? high : low;
  if (!recoverable || !favorable || !adverse || high < low || !(number(p.samples) > 0)) return empty("OBSERVED_PRICE_EXTREMA_MISSING");
  const sign = run.plan.direction === "SHORT" ? -1 : 1;
  const mfePnl = Math.max(0, sign * (favorable - facts.entryPrice) * facts.quantity);
  const rawMaePnl = Math.min(0, sign * (adverse - facts.entryPrice) * facts.quantity);
  const maePnl = rawMaePnl === 0 ? 0 : rawMaePnl;
  return { mfePnl, maePnl, mfeR: mfePnl / facts.riskAmount, maeR: maePnl === 0 ? 0 : -maePnl / facts.riskAmount,
    mfePrice: favorable, maePrice: adverse, source: p.observationSource,
    coverage: p.observationCoverage ?? "POLL_SAMPLED_PARTIAL", reason: "SAMPLED_NOT_FULL_MARKET_PATH" };
}
