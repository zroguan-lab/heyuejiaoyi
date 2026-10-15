import { createHash } from "node:crypto";
import { tradeBelongsToEpoch } from "../execution/execution-strategy-source.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Number(number.toFixed(digits));
}

function dateKey(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "UNKNOWN";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function median(values) {
  const ordered = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function scoreBand(score) {
  const value = finiteNumber(score, -Infinity);
  if (value >= 70) return "70+";
  if (value >= 65) return "65-69";
  if (value >= 60) return "60-64";
  if (value >= 55) return "55-59";
  return "BELOW_55";
}

function maximumDrawdown(trades, startingEquity) {
  let equity = startingEquity;
  let peak = startingEquity;
  let maximumAmount = 0;
  let maximumPercent = 0;
  let troughTradeId = null;
  for (const trade of [...trades].sort((left, right) => left.closedAt - right.closedAt || left.id.localeCompare(right.id))) {
    equity += finiteNumber(trade.netPnl, 0);
    peak = Math.max(peak, equity);
    const amount = peak - equity;
    const percent = peak > 0 ? (amount / peak) * 100 : 0;
    if (percent > maximumPercent) {
      maximumAmount = amount;
      maximumPercent = percent;
      troughTradeId = trade.id;
    }
  }
  return {
    amountUsdt: round(maximumAmount),
    percent: round(maximumPercent, 4),
    troughTradeId,
  };
}

function streaks(trades) {
  let currentWins = 0;
  let currentLosses = 0;
  let maximumWins = 0;
  let maximumLosses = 0;
  for (const trade of [...trades].sort((left, right) => left.closedAt - right.closedAt || left.id.localeCompare(right.id))) {
    const pnl = finiteNumber(trade.netPnl, 0);
    if (pnl > 0) {
      currentWins += 1;
      currentLosses = 0;
      maximumWins = Math.max(maximumWins, currentWins);
    } else if (pnl < 0) {
      currentLosses += 1;
      currentWins = 0;
      maximumLosses = Math.max(maximumLosses, currentLosses);
    } else {
      currentWins = 0;
      currentLosses = 0;
    }
  }
  return { maximumWins, maximumLosses };
}

export function summarizeV23DemoTrades(trades = [], { startingEquity = 500 } = {}) {
  const netPnl = trades.map((trade) => finiteNumber(trade.netPnl, 0));
  const netR = trades.map((trade) => finiteNumber(trade.netR)).filter(Number.isFinite);
  const winners = trades.filter((trade) => finiteNumber(trade.netPnl, 0) > 0);
  const losers = trades.filter((trade) => finiteNumber(trade.netPnl, 0) < 0);
  const grossProfit = winners.reduce((sum, trade) => sum + finiteNumber(trade.netPnl, 0), 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + finiteNumber(trade.netPnl, 0), 0));
  const winnerR = winners.map((trade) => finiteNumber(trade.netR)).filter(Number.isFinite);
  const loserR = losers.map((trade) => finiteNumber(trade.netR)).filter(Number.isFinite);
  const totalNetPnl = netPnl.reduce((sum, value) => sum + value, 0);
  const averageWinnerR = winnerR.length ? winnerR.reduce((sum, value) => sum + value, 0) / winnerR.length : null;
  const averageLoserR = loserR.length ? loserR.reduce((sum, value) => sum + value, 0) / loserR.length : null;
  const holdingMinutes = trades
    .map((trade) => finiteNumber(trade.openedAt) !== null && finiteNumber(trade.closedAt) !== null
      ? (trade.closedAt - trade.openedAt) / 60_000
      : null)
    .filter(Number.isFinite);
  const initialRisk = trades.map((trade) => finiteNumber(trade.riskAmount)).filter((value) => value !== null && value > 0);
  const streak = streaks(trades);
  return {
    tradeCount: trades.length,
    wins: winners.length,
    losses: losers.length,
    breakeven: trades.length - winners.length - losers.length,
    winRate: trades.length ? round(winners.length / trades.length, 6) : 0,
    totalNetPnlUsdt: round(totalNetPnl),
    averageNetPnlUsdt: trades.length ? round(totalNetPnl / trades.length) : 0,
    grossProfitUsdt: round(grossProfit),
    grossLossUsdt: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    totalNetR: round(netR.reduce((sum, value) => sum + value, 0), 4),
    averageNetR: netR.length ? round(netR.reduce((sum, value) => sum + value, 0) / netR.length, 4) : 0,
    averageWinnerR: averageWinnerR === null ? null : round(averageWinnerR, 4),
    averageLoserR: averageLoserR === null ? null : round(averageLoserR, 4),
    payoffRatioR: averageWinnerR !== null && averageLoserR !== null && averageLoserR < 0
      ? round(averageWinnerR / Math.abs(averageLoserR), 4)
      : null,
    startingEquityUsdt: round(startingEquity),
    endingEquityUsdt: round(startingEquity + totalNetPnl),
    returnOnStartingEquityPercent: startingEquity > 0 ? round((totalNetPnl / startingEquity) * 100, 4) : null,
    maximumDrawdown: maximumDrawdown(trades, startingEquity),
    maximumConsecutiveWins: streak.maximumWins,
    maximumConsecutiveLosses: streak.maximumLosses,
    averageInitialRiskUsdt: initialRisk.length
      ? round(initialRisk.reduce((sum, value) => sum + value, 0) / initialRisk.length)
      : null,
    minimumInitialRiskUsdt: initialRisk.length ? round(Math.min(...initialRisk)) : null,
    maximumInitialRiskUsdt: initialRisk.length ? round(Math.max(...initialRisk)) : null,
    medianHoldingMinutes: median(holdingMinutes) === null ? null : round(median(holdingMinutes), 2),
    averageHoldingMinutes: holdingMinutes.length
      ? round(holdingMinutes.reduce((sum, value) => sum + value, 0) / holdingMinutes.length, 2)
      : null,
  };
}

function groupedAttribution(trades, keySelector, { startingEquity, order = [] } = {}) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = String(keySelector(trade) ?? "UNKNOWN");
    const values = grouped.get(key) ?? [];
    values.push(trade);
    grouped.set(key, values);
  }
  const orderIndex = new Map(order.map((key, index) => [key, index]));
  return [...grouped.entries()]
    .map(([key, values]) => ({ key, ...summarizeV23DemoTrades(values, { startingEquity }) }))
    .sort((left, right) => {
      const leftIndex = orderIndex.has(left.key) ? orderIndex.get(left.key) : Infinity;
      const rightIndex = orderIndex.has(right.key) ? orderIndex.get(right.key) : Infinity;
      return leftIndex - rightIndex || right.tradeCount - left.tradeCount || left.key.localeCompare(right.key);
    });
}

function multiValueAttribution(trades, valuesSelector, { startingEquity } = {}) {
  const grouped = new Map();
  for (const trade of trades) {
    const values = [...new Set((valuesSelector(trade) ?? []).filter(Boolean).map(String))];
    for (const key of values.length ? values : ["NONE"]) {
      const items = grouped.get(key) ?? [];
      items.push(trade);
      grouped.set(key, items);
    }
  }
  return [...grouped.entries()]
    .map(([key, values]) => ({ key, ...summarizeV23DemoTrades(values, { startingEquity }) }))
    .sort((left, right) => right.tradeCount - left.tradeCount || left.key.localeCompare(right.key));
}

function profitConcentration(trades, keySelector) {
  const positiveTrades = trades.filter((trade) => finiteNumber(trade.netPnl, 0) > 0);
  const grossProfit = positiveTrades.reduce((sum, trade) => sum + finiteNumber(trade.netPnl, 0), 0);
  const grouped = new Map();
  for (const trade of positiveTrades) {
    const key = String(keySelector(trade) ?? "UNKNOWN");
    grouped.set(key, (grouped.get(key) ?? 0) + finiteNumber(trade.netPnl, 0));
  }
  const entries = [...grouped.entries()]
    .map(([key, profit]) => ({ key, profitUsdt: round(profit), share: grossProfit > 0 ? round(profit / grossProfit, 6) : 0 }))
    .sort((left, right) => right.profitUsdt - left.profitUsdt || left.key.localeCompare(right.key));
  return { grossProfitUsdt: round(grossProfit), top: entries[0] ?? null, entries };
}

function sampleHash(trades) {
  const sample = [...trades]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((trade) => ({
      id: trade.id,
      signalId: trade.signalId,
      symbol: trade.symbol,
      closedAt: trade.closedAt,
      netPnl: round(trade.netPnl, 10),
      netR: round(trade.netR, 10),
      commission: round(trade.commission, 10),
      fundingPnl: round(trade.fundingPnl, 10),
    }));
  return `sha256:${createHash("sha256").update(JSON.stringify(sample)).digest("hex")}`;
}

function accountingEvidence(trades) {
  const mismatches = [];
  for (const trade of trades) {
    const expected = finiteNumber(trade.realizedPnl, 0) - finiteNumber(trade.commission, 0) + finiteNumber(trade.fundingPnl, 0);
    if (Math.abs(expected - finiteNumber(trade.netPnl, 0)) > 1e-8) {
      mismatches.push({ id: trade.id, expectedNetPnl: round(expected, 10), actualNetPnl: round(trade.netPnl, 10) });
    }
  }
  return { checked: trades.length, mismatchCount: mismatches.length, mismatches };
}

export function buildV23DemoBaseline({
  trades = [],
  epoch,
  strategyFingerprint = null,
  asOf = Date.now(),
  generatedAt = Date.now(),
  timeZone = DEFAULT_TIME_ZONE,
  minimumForwardDays = 30,
  minimumSamples = 100,
} = {}) {
  if (!epoch?.id || !epoch?.strategyVersion || !Number.isFinite(Number(epoch?.startedAt))) {
    throw new TypeError("V2.3基线归因缺少有效绩效纪元");
  }
  const cutoff = finiteNumber(asOf);
  if (cutoff === null) throw new TypeError("V2.3基线归因截止时间无效");
  const epochTrades = trades.filter((trade) => tradeBelongsToEpoch(trade, epoch));
  const closedBeforeCutoff = epochTrades.filter((trade) => trade.status === "CLOSED" && finiteNumber(trade.closedAt) !== null && trade.closedAt <= cutoff);
  const selected = closedBeforeCutoff.filter((trade) => (
    trade.sourceType === "SIGNAL"
    && trade.performanceEligible !== false
    && trade.accountingComplete === true
    && finiteNumber(trade.netPnl) !== null
    && finiteNumber(trade.netR) !== null
  )).sort((left, right) => left.closedAt - right.closedAt || left.id.localeCompare(right.id));
  if (!selected.length) throw new Error("V2.3基线归因没有合格已结算交易");

  const startingEquity = finiteNumber(epoch.startingEquity, 500);
  const overall = summarizeV23DemoTrades(selected, { startingEquity });
  const forwardDays = (cutoff - Number(epoch.startedAt)) / DAY_MS;
  const symbolConcentration = profitConcentration(selected, (trade) => trade.symbol);
  const eventConcentration = profitConcentration(selected, (trade) => trade.marketEventId);
  const commission = selected.reduce((sum, trade) => sum + finiteNumber(trade.commission, 0), 0);
  const funding = selected.reduce((sum, trade) => sum + finiteNumber(trade.fundingPnl, 0), 0);
  const realized = selected.reduce((sum, trade) => sum + finiteNumber(trade.realizedPnl, 0), 0);
  const entrySlippage = selected.reduce((sum, trade) => sum + finiteNumber(trade.entrySlippageCost, 0), 0);
  const gateChecks = {
    minimumSamples: { passed: selected.length >= minimumSamples, actual: selected.length, required: minimumSamples },
    minimumForwardDays: { passed: forwardDays >= minimumForwardDays, actual: round(forwardDays, 4), required: minimumForwardDays },
    profitFactor: { passed: finiteNumber(overall.profitFactor, 0) >= 1.2, actual: overall.profitFactor, required: 1.2 },
    averageNetR: { passed: overall.averageNetR > 0.1, actual: overall.averageNetR, required: ">0.10" },
    maximumDrawdown: { passed: overall.maximumDrawdown.percent < 10, actual: overall.maximumDrawdown.percent, required: "<10%" },
    symbolProfitConcentration: {
      passed: finiteNumber(symbolConcentration.top?.share, 0) < 0.2,
      actual: symbolConcentration.top?.share ?? 0,
      required: "<20%",
    },
    marketEventProfitConcentration: {
      passed: finiteNumber(eventConcentration.top?.share, 0) < 0.25,
      actual: eventConcentration.top?.share ?? 0,
      required: "<25%",
    },
  };

  return {
    schemaVersion: 1,
    modelVersion: "V2_3_DEMO_PROFITABILITY_BASELINE_R1",
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    asOf: cutoff,
    asOfIso: new Date(cutoff).toISOString(),
    timeZone,
    authority: {
      source: "SQLITE_EXECUTION_RUNS",
      accountingBasis: "BINANCE_DEMO_CLOSED_NET_PNL",
      strategyFingerprint,
      note: "交易所成交、手续费与Funding为Demo执行事实；归因层不改写交易事实。",
    },
    epoch: structuredClone(epoch),
    sample: {
      selectionRules: [
        "CURRENT_V2_3_PERFORMANCE_EPOCH",
        "SOURCE_TYPE_SIGNAL",
        "PERFORMANCE_ELIGIBLE",
        "STATUS_CLOSED",
        "ACCOUNTING_COMPLETE",
        "FINITE_NET_PNL_AND_NET_R",
        "CLOSED_AT_OR_BEFORE_AS_OF",
      ],
      epochTradeCount: epochTrades.length,
      closedBeforeCutoffCount: closedBeforeCutoff.length,
      selectedTradeCount: selected.length,
      firstClosedAt: selected[0].closedAt,
      firstClosedAtIso: new Date(selected[0].closedAt).toISOString(),
      lastClosedAt: selected.at(-1).closedAt,
      lastClosedAtIso: new Date(selected.at(-1).closedAt).toISOString(),
      forwardObservationDays: round(forwardDays, 4),
      sampleHash: sampleHash(selected),
      tradeIds: selected.map((trade) => trade.id),
    },
    overall,
    accounting: {
      realizedPnlUsdt: round(realized),
      commissionUsdt: round(commission),
      fundingPnlUsdt: round(funding),
      netPnlUsdt: round(realized - commission + funding),
      estimatedEntrySlippageCostUsdt: round(entrySlippage),
      reconciliation: accountingEvidence(selected),
    },
    attribution: {
      experimentTier: groupedAttribution(selected, (trade) => trade.experimentTier, {
        startingEquity,
        order: ["CORE", "EXPLORATION", "UNKNOWN"],
      }),
      direction: groupedAttribution(selected, (trade) => trade.direction, {
        startingEquity,
        order: ["LONG", "SHORT", "UNKNOWN"],
      }),
      scoreBand: groupedAttribution(selected, (trade) => scoreBand(trade.score), {
        startingEquity,
        order: ["55-59", "60-64", "65-69", "70+", "BELOW_55"],
      }),
      marketDirection: groupedAttribution(selected, (trade) => trade.marketRadar?.marketDirection, {
        startingEquity,
        order: ["LONG", "SHORT", "MIXED", "UNKNOWN"],
      }),
      costQuality: groupedAttribution(selected, (trade) => trade.qualityObservations?.includes("COST_R_ABOVE_CORE_BUDGET")
        ? "ABOVE_CORE_BUDGET"
        : "WITHIN_CORE_BUDGET", {
        startingEquity,
        order: ["WITHIN_CORE_BUDGET", "ABOVE_CORE_BUDGET"],
      }),
      radarDirectionQuality: groupedAttribution(selected, (trade) => trade.qualityObservations?.includes("RADAR_DIRECTION_CONFLICT")
        ? "CONFLICT_OBSERVED"
        : "NO_CONFLICT_OBSERVED", {
        startingEquity,
        order: ["NO_CONFLICT_OBSERVED", "CONFLICT_OBSERVED"],
      }),
      primaryOpportunitySource: groupedAttribution(selected, (trade) => trade.marketRadar?.opportunitySources?.[0], { startingEquity }),
      opportunitySourceMembership: multiValueAttribution(selected, (trade) => trade.marketRadar?.opportunitySources, { startingEquity }),
      radarTagMembership: multiValueAttribution(selected, (trade) => trade.marketRadar?.tags, { startingEquity }),
      qualityObservationMembership: multiValueAttribution(selected, (trade) => trade.qualityObservations, { startingEquity }),
      exitRole: groupedAttribution(selected, (trade) => trade.exitRole, { startingEquity }),
      symbol: groupedAttribution(selected, (trade) => trade.symbol, { startingEquity }),
      closeDay: groupedAttribution(selected, (trade) => dateKey(trade.closedAt, timeZone), { startingEquity }),
    },
    concentration: {
      symbolProfit: symbolConcentration,
      marketEventProfit: eventConcentration,
    },
    profitabilityGate: {
      eligible: Object.values(gateChecks).every((item) => item.passed),
      checks: gateChecks,
      verdict: "FAILED_CURRENT_V2_3_PROFITABILITY_GATE",
      note: "达到样本数量不等于形成稳定Edge；仍需满足时间跨度、成本后期望、回撤和集中度要求。",
    },
  };
}

function percent(value) {
  const number = finiteNumber(value, 0);
  return `${(number * 100).toFixed(1)}%`;
}

function metricTable(items) {
  const rows = items.map((item) => `| ${item.key} | ${item.tradeCount} | ${percent(item.winRate)} | ${item.totalNetPnlUsdt.toFixed(3)} | ${item.averageNetR.toFixed(3)}R | ${item.profitFactor === null ? "∞" : item.profitFactor.toFixed(3)} |`);
  return [
    "| 分组 | 样本 | 胜率 | 净收益(U) | 平均Net R | PF |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows,
  ].join("\n");
}

function checkTable(checks) {
  return [
    "| 闸门 | 结果 | 当前值 | 要求 |",
    "|---|---|---:|---:|",
    ...Object.entries(checks).map(([key, item]) => `| ${key} | ${item.passed ? "通过" : "未通过"} | ${typeof item.actual === "number" ? round(item.actual, 4) : item.actual} | ${item.required} |`),
  ].join("\n");
}

function findGroup(items, key) {
  return items.find((item) => item.key === key) ?? summarizeV23DemoTrades([]);
}

export function renderV23DemoBaselineMarkdown(report) {
  const normalCost = findGroup(report.attribution.costQuality, "WITHIN_CORE_BUDGET");
  const highCost = findGroup(report.attribution.costQuality, "ABOVE_CORE_BUDGET");
  const core = findGroup(report.attribution.experimentTier, "CORE");
  const exploration = findGroup(report.attribution.experimentTier, "EXPLORATION");
  const score = report.attribution.scoreBand;
  return `# V2.3 Binance Demo前向盈利基线归因

状态：正式基线已冻结；当前盈利闸门未通过。  
报告版本：\`${report.modelVersion}\`  
策略版本：\`${report.epoch.strategyVersion}\`  
策略指纹：\`${report.authority.strategyFingerprint ?? "UNKNOWN"}\`  
样本截止：${report.asOfIso}  
样本哈希：\`${report.sample.sampleHash}\`

## 口径

本报告只纳入当前V2.3绩效纪元内，由真实策略信号驱动、允许计入绩效、已经平仓且Binance Demo账务完整的交易。净收益以交易所成交回报为事实，已经扣除手续费并计入Funding。未成交取消、人工技术验证、旧策略、未平仓和账务未完成记录全部排除。

冻结样本共${report.sample.selectedTradeCount}笔，覆盖${report.sample.forwardObservationDays}天；首笔平仓时间为${report.sample.firstClosedAtIso}，末笔为${report.sample.lastClosedAtIso}。

## 总体结果

| 指标 | 结果 |
|---|---:|
| 已结算样本 | ${report.overall.tradeCount} |
| 胜/负/平 | ${report.overall.wins}/${report.overall.losses}/${report.overall.breakeven} |
| 胜率 | ${percent(report.overall.winRate)} |
| 净收益 | ${report.overall.totalNetPnlUsdt.toFixed(4)} U |
| 期末研究权益 | ${report.overall.endingEquityUsdt.toFixed(4)} U |
| 收益率 | ${report.overall.returnOnStartingEquityPercent.toFixed(4)}% |
| Profit Factor | ${report.overall.profitFactor.toFixed(4)} |
| 平均Net R | ${report.overall.averageNetR.toFixed(4)}R |
| 平均盈利/亏损 | ${report.overall.averageWinnerR.toFixed(4)}R / ${report.overall.averageLoserR.toFixed(4)}R |
| R盈亏比 | ${report.overall.payoffRatioR.toFixed(4)} |
| 最大回撤 | ${report.overall.maximumDrawdown.amountUsdt.toFixed(4)} U / ${report.overall.maximumDrawdown.percent.toFixed(4)}% |
| 最大连续亏损 | ${report.overall.maximumConsecutiveLosses}笔 |
| 单笔初始风险范围 | ${report.overall.minimumInitialRiskUsdt.toFixed(4)}–${report.overall.maximumInitialRiskUsdt.toFixed(4)} U |
| 中位持仓时间 | ${report.overall.medianHoldingMinutes.toFixed(2)}分钟 |

结论：V2.3已经从旧版本的大幅负期望改善到接近盈亏平衡，但PF仍低于1、平均Net R仍为负，因此尚未证明具有正Edge。

## 账务归因

| 项目 | 金额(U) |
|---|---:|
| 价格已实现盈亏 | ${report.accounting.realizedPnlUsdt.toFixed(4)} |
| 手续费 | -${report.accounting.commissionUsdt.toFixed(4)} |
| Funding | ${report.accounting.fundingPnlUsdt.toFixed(4)} |
| 最终净收益 | ${report.accounting.netPnlUsdt.toFixed(4)} |
| 估算入场滑点成本 | ${report.accounting.estimatedEntrySlippageCostUsdt.toFixed(4)} |

账务重算${report.accounting.reconciliation.checked}笔，差异${report.accounting.reconciliation.mismatchCount}笔。
估算入场滑点成本为负值时，表示整体实际成交价优于计划入场价，不是额外亏损。

## A/B层归因

${metricTable(report.attribution.experimentTier)}

核心层目前${core.tradeCount}笔、PF ${core.profitFactor?.toFixed(3) ?? "∞"}；探索层${exploration.tradeCount}笔、PF ${exploration.profitFactor?.toFixed(3) ?? "∞"}。核心层样本太少，不能据此直接关闭探索层或宣称核心层有效。

## 多空归因

${metricTable(report.attribution.direction)}

## 评分归因

${metricTable(score)}

评分区间没有表现出稳定单调关系，因此当前总分更适合作为证据一致性记录，尚不能被视为已校准的Edge概率。

## 成本归因

${metricTable(report.attribution.costQuality)}

正常成本组${normalCost.tradeCount}笔，平均${normalCost.averageNetR.toFixed(3)}R、PF ${normalCost.profitFactor?.toFixed(3) ?? "∞"}；高成本组${highCost.tradeCount}笔，平均${highCost.averageNetR.toFixed(3)}R、PF ${highCost.profitFactor?.toFixed(3) ?? "∞"}。这是当前最强且具有经济解释的首个单变量实验候选，但仍需样本外验证，不能直接把同一批样本的观察当作最终规则。

## 市场环境归因

${metricTable(report.attribution.marketDirection)}

## 主要机会来源归因

${metricTable(report.attribution.primaryOpportunitySource)}

机会来源差异只能用于形成假设。分组较小且来自不足四天的同一市场阶段，不能据此同时删除多个来源。

## 出场结果归因

${metricTable(report.attribution.exitRole)}

## 盈利集中度

- 最大单币盈利贡献：${report.concentration.symbolProfit.top?.key ?? "无"}，占总毛盈利${percent(report.concentration.symbolProfit.top?.share ?? 0)}。
- 最大单一市场事件盈利贡献：${report.concentration.marketEventProfit.top?.key ?? "无"}，占总毛盈利${percent(report.concentration.marketEventProfit.top?.share ?? 0)}。

## 正式盈利闸门

${checkTable(report.profitabilityGate.checks)}

最终判定：**未通过**。114笔已经满足最低数量，但观察期不足30天、PF和平均Net R未达标。当前盈利集中度通过闸门，仍需在更长时间和更多市场环境中复核。该结论禁止用于真实资金晋级。

## 下一步

1. 保持这114笔和样本哈希作为不可变V2.3对照组。
2. M5继续完成288/288数据完整性验证，不把它误当作盈利验证。
3. 第一个候选实验只修改一个变量：测试\`预估成本R > 0.20\`是否应成为拒绝条件。
4. 使用历史样本外回放和新的Demo前向样本验证候选规则；不使用本基线同一批数据宣布实验成功。
5. 在至少30天、多种市场环境以及成本后PF≥1.2、平均Net R>0.10R之前，不晋级真实资金。
`;
}
