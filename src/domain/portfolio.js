function activeSlots(trades) {
  return trades.filter((trade) => ["ENTRY_PENDING", "OPEN", "TP1_FILLED"].includes(trade.status));
}

export function pearsonCorrelation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 3) return 0;
  const a = left.slice(-length);
  const b = right.slice(-length);
  const meanA = a.reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < length; index += 1) {
    const deltaA = a[index] - meanA;
    const deltaB = b[index] - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }
  if (varianceA === 0 || varianceB === 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

export function buildCorrelationMatrix(seriesBySymbol) {
  const entries = seriesBySymbol instanceof Map ? [...seriesBySymbol.entries()] : Object.entries(seriesBySymbol);
  const matrix = {};
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftSymbol, leftSeries] = entries[left];
      const [rightSymbol, rightSeries] = entries[right];
      matrix[`${leftSymbol}:${rightSymbol}`] = pearsonCorrelation(leftSeries, rightSeries);
    }
  }
  return matrix;
}

export function resolveCandidateConflicts(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const group = groups.get(candidate.symbol) ?? [];
    group.push(candidate);
    groups.set(candidate.symbol, group);
  }

  const eligible = [];
  const rejected = [];
  for (const group of groups.values()) {
    const directions = new Set(group.map((candidate) => candidate.direction));
    if (directions.size > 1) {
      rejected.push(...group.map((candidate) => ({ candidate, reason: "WAIT_CONFLICT" })));
      continue;
    }
    const ranked = [...group].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const winner = structuredClone(ranked[0]);
    winner.attributionStrategies = [...new Set(group.map((candidate) => candidate.strategy))];
    eligible.push(winner);
    rejected.push(...ranked.slice(1).map((candidate) => ({ candidate, reason: "SAME_SYMBOL_MERGED" })));
  }
  return { eligible, rejected };
}

export function selectPortfolioCandidates(candidates, activeTrades = [], {
  correlations = {},
  minimumScore = 0,
} = {}) {
  const active = activeSlots(activeTrades);
  const occupiedSymbols = new Set(active.map((trade) => trade.symbol));
  const scored = candidates.filter((candidate) => Number(candidate.score) >= minimumScore);
  const belowThreshold = candidates
    .filter((candidate) => Number(candidate.score) < minimumScore)
    .map((candidate) => ({ candidate, reason: "SCORE_BELOW_MIN_CONFIDENCE" }));
  const available = scored.filter((candidate) => !occupiedSymbols.has(candidate.symbol));
  const alreadyOccupied = scored
    .filter((candidate) => occupiedSymbols.has(candidate.symbol))
    .map((candidate) => ({ candidate, reason: "SYMBOL_ALREADY_ACTIVE" }));
  const { eligible, rejected } = resolveCandidateConflicts(available);

  const remaining = [...eligible];
  const selected = [];
  while (remaining.length) {
    const comparisonTrades = [...active, ...selected];
    const ranked = remaining.map((candidate) => {
      const correlationPenalty = comparisonTrades.reduce((sum, trade) => {
        const keyA = `${candidate.symbol}:${trade.symbol}`;
        const keyB = `${trade.symbol}:${candidate.symbol}`;
        const correlation = correlations[keyA] ?? correlations[keyB] ?? 0;
        const candidateSign = candidate.direction === "LONG" ? 1 : -1;
        const tradeSign = trade.direction === "LONG" ? 1 : -1;
        const effectiveCorrelation = candidateSign * tradeSign * correlation;
        return sum + Math.max(0, effectiveCorrelation) * 12;
      }, 0);
      const costPenalty = Math.max(0, candidate.estimatedCostR ?? 0) * 10;
      const liquidityBonus = Math.max(0, Math.min(5, candidate.liquidityScore ?? 0));
      return { ...candidate, rankScore: Number((candidate.score + liquidityBonus - correlationPenalty - costPenalty).toFixed(3)) };
    }).sort((a, b) => b.rankScore - a.rankScore || a.triggerTime - b.triggerTime);
    const winner = ranked[0];
    selected.push(winner);
    remaining.splice(remaining.findIndex((candidate) => candidate.id === winner.id), 1);
  }
  return {
    selected,
    rejected: [...belowThreshold, ...alreadyOccupied, ...rejected],
    selectionMode: "ALL_ELIGIBLE",
    minimumScore,
  };
}
