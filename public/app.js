const elements = {
  pulse: document.querySelector("#pulse"),
  systemLabel: document.querySelector("#system-label"),
  modeMark: document.querySelector("#mode-mark"),
  modeMessage: document.querySelector("#mode-message"),
  sourceFooter: document.querySelector("#source-footer"),
  executionFooter: document.querySelector("#execution-footer"),
  executionLock: document.querySelector("#execution-lock"),
  accountConnection: document.querySelector("#account-connection"),
  accountWallet: document.querySelector("#account-wallet"),
  accountPositions: document.querySelector("#account-positions"),
  accountOrders: document.querySelector("#account-orders"),
  accountPositionMode: document.querySelector("#account-position-mode"),
  accountReadiness: document.querySelector("#account-readiness"),
  executionCapacity: document.querySelector("#execution-capacity"),
  executionMargin: document.querySelector("#execution-margin"),
  canaryRunStatus: document.querySelector("#canary-run-status"),
  accountMessage: document.querySelector("#account-message"),
  lastScan: document.querySelector("#last-scan"),
  marketCount: document.querySelector("#market-count"),
  activeCount: document.querySelector("#active-count"),
  demoNetPnl: document.querySelector("#demo-net-pnl"),
  demoPnlLabel: document.querySelector("#demo-pnl-label"),
  demoTradeCount: document.querySelector("#demo-trade-count"),
  radarUpdated: document.querySelector("#radar-updated"),
  radarDirection: document.querySelector("#radar-direction"),
  radarDiscovery: document.querySelector("#radar-discovery"),
  radarDeepScan: document.querySelector("#radar-deep-scan"),
  radarRefresh: document.querySelector("#radar-refresh"),
  radarActivity: document.querySelector("#radar-activity"),
  radarLeaders: document.querySelector("#radar-leaders"),
  radarLaggards: document.querySelector("#radar-laggards"),
  performanceStartingEquity: document.querySelector("#performance-starting-equity"),
  performanceCurrentEquity: document.querySelector("#performance-current-equity"),
  performanceTotalPnl: document.querySelector("#performance-total-pnl"),
  performanceTradeCount: document.querySelector("#performance-trade-count"),
  performanceChartFrame: document.querySelector("#performance-chart-frame"),
  performanceChart: document.querySelector("#performance-chart"),
  performanceChartTooltip: document.querySelector("#performance-chart-tooltip"),
  performanceChartEmpty: document.querySelector("#performance-chart-empty"),
  performanceChartLabel: document.querySelector("#performance-chart-label"),
  performanceAccountingNote: document.querySelector("#performance-accounting-note"),
  performanceBasis: document.querySelector("#performance-basis"),
  sampleProgressText: document.querySelector("#sample-progress-text"),
  sampleProgressBar: document.querySelector("#sample-progress-bar"),
  sampleValidationStatus: document.querySelector("#sample-validation-status"),
  tierSummary: document.querySelector("#tier-summary"),
  segmentSummary: document.querySelector("#segment-summary"),
  excursionResearchNote: document.querySelector("#excursion-research-note"),
  excursionResearchSummary: document.querySelector("#excursion-research-summary"),
  sourceCombinationSummary: document.querySelector("#source-combination-summary"),
  chartMetricControl: document.querySelector("#chart-metric-control"),
  chartRangeControl: document.querySelector("#chart-range-control"),
  scanMeta: document.querySelector("#scan-meta"),
  candidateCount: document.querySelector("#candidate-count"),
  signalGrid: document.querySelector("#signal-grid"),
  portfolioGrid: document.querySelector("#portfolio-grid"),
  portfolioTitle: document.querySelector("#portfolio-title"),
  demoTradesBody: document.querySelector("#demo-trades-body"),
  scanButton: document.querySelector("#scan-button"),
  notifyButton: document.querySelector("#notify-button"),
  soundToggle: document.querySelector("#sound-toggle"),
};

const priceFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 8 });
const moneyFormatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pnlFormatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const timeFormatter = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const expandedTradeIds = new Set();
const chartState = { metric: "equity", range: 30, performance: null, executionSummary: null, visiblePoints: [] };
const chartMetrics = {
  equity: { key: "equity", label: "策略权益", baseline: (performance) => performance.startingEquity },
  daily: { key: "dailyNetPnl", label: "每日净盈亏", baseline: () => 0 },
  cumulative: { key: "cumulativeNetPnl", label: "累计净盈亏", baseline: () => 0 },
};

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatPrice(value) { return Number.isFinite(value) ? priceFormatter.format(value) : "—"; }
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : timeFormatter.format(date);
}
function signedMoney(value) {
  if (!Number.isFinite(value)) return "—";
  const normalized = Object.is(value, -0) || Math.abs(value) < 0.0000005 ? 0 : value;
  return `${normalized >= 0 ? "+" : ""}${pnlFormatter.format(normalized)} U`;
}

function plainMoney(value) {
  return Number.isFinite(value) ? `${moneyFormatter.format(value)} U` : "—";
}

function chartNumber(value) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return moneyFormatter.format(value);
}

function shortDate(date) {
  const parts = String(date ?? "").split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(date ?? "—");
}

function statusLabel(status) {
  return ({ CANDIDATE: "候选", REJECTED: "未入选", ENTRY_PENDING: "等待成交", OPEN: "持仓中", TP1_FILLED: "已止盈一", CLOSED: "已结束", EXPIRED: "未成交过期" })[status] ?? status ?? "—";
}

function executionStatusLabel(status) {
  return ({
    PREPARED: "等待最终确认", CONFIGURING: "配置账户", ENTRY_SUBMITTING: "提交入场",
    SUBMISSION_UNKNOWN: "提交结果未知", ENTRY_PENDING: "等待成交", PARTIALLY_FILLED: "部分成交",
    PROTECTION_PENDING: "建立保护", PROTECTION_INCOMPLETE: "保护不完整", OPEN_PROTECTED: "持仓已保护",
    TP1_FILLED: "止盈一完成", ERROR_UNPROTECTED: "未保护异常", CLOSED: "执行完成",
    OPERATOR_CLOSE_SUBMITTING: "提交平仓", OPERATOR_CLOSE_PENDING: "等待平仓",
    OPERATOR_CLOSE_UNKNOWN: "平仓结果未知", PROTECTION_CLEANUP_PENDING: "清理保护单",
    ACCOUNTING_PENDING: "等待成交账务",
    ENTRY_FACT_PENDING: "等待入场事实核验", ENTRY_FACT_CONFLICT: "入场事实冲突（已隔离）",
    CANCELED: "未成交取消", REJECTED: "已拒绝", FAILED: "执行失败",
  })[status] ?? status ?? "未准备";
}

function orderStatusLabel(status) {
  return ({ NEW: "生效", PENDING: "等待触发", TRIGGERING: "触发中", FILLED: "已成交", CANCELED: "已取消", EXPIRED: "已失效", REJECTED: "已拒绝" })[status] ?? status ?? "待建立";
}

function playTone() {
  if (!elements.soundToggle.checked) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 740;
  gain.gain.setValueAtTime(0.07, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.35);
}

function notifyPortfolioSignal(payload) {
  const candidate = payload.candidate;
  if (Notification.permission === "granted") {
    new Notification(`${candidate.symbol} ${candidate.direction === "LONG" ? "买入 / 开多" : "卖出 / 开空"}`, {
      body: `${candidate.strategy === "PRE_BREAKOUT" ? "爆发前布局" : candidate.strategy === "BREAKOUT" ? "趋势突破" : "趋势回调"} · 入场 ${formatPrice(payload.trade.entryPrice)} · 止损 ${formatPrice(payload.trade.stopLoss)}`,
      tag: candidate.id,
    });
  }
  playTone();
}

function renderCandidateCard(candidate, { trade = null } = {}) {
  const tone = candidate.direction === "LONG" ? "long" : "short";
  const label = candidate.direction === "LONG" ? "买入 · 开多" : "卖出 · 开空";
  const risk = candidate.risk ?? {};
  return `<article class="signal-card ${tone}">
    <div class="card-head"><div><span class="symbol">${escapeHtml(candidate.symbol.replace(/USDT$/, ""))}</span><span class="pair-suffix">/ USDT PERP</span></div><span class="direction">${label}</span></div>
    <div class="strategy-line"><span>${candidate.strategy === "PRE_BREAKOUT" ? "爆发前布局" : candidate.strategy === "BREAKOUT" ? "趋势突破" : "趋势回调"}${candidate.experimentTier ? ` · ${candidate.experimentTier === "CORE" ? "A级核心" : "B级探索"}` : ""}</span><b>${candidate.score}/100</b></div>
    <p class="signal-message">${escapeHtml((candidate.reasons ?? [])[0] ?? "规则候选")}</p>
    <div class="levels">
      <div class="level"><span>限价入场</span><b>${formatPrice(trade?.entryPrice ?? candidate.order?.entry ?? risk.entry)}</b></div>
      <div class="level stop"><span>止损</span><b>${formatPrice(risk.stopLoss)}</b></div>
      <div class="level target"><span>止盈1 / 2</span><b>${formatPrice(risk.takeProfit1)} / ${formatPrice(risk.takeProfit2)}</b></div>
    </div>
    <div class="indicator-strip"><span>${escapeHtml(candidate.triggerInterval)}</span><span>ATR ${candidate.metrics?.atrPercent ?? "—"}%</span><span>VOL ${candidate.metrics?.volumeRatio ?? "—"}x</span>${candidate.marketRadar ? `<span class="radar-badge">雷达 ${escapeHtml(candidate.marketRadar.radarTier)} · ${escapeHtml(candidate.marketRadar.radarScore)}</span>` : ""}${trade ? `<span>${statusLabel(trade.status)}</span>` : ""}</div>
  </article>`;
}

function radarDirectionLabel(direction) {
  return ({ LONG: "多头扩散", SHORT: "空头扩散", MIXED: "多空混合" })[direction] ?? "—";
}

function renderRadarRows(items = [], metric) {
  if (!items.length) return "<p>暂无可比较数据</p>";
  return items.slice(0, 5).map((item) => {
    const value = metric === "velocity"
      ? Number.isFinite(item.rankVelocity) ? `↑${item.rankVelocity}位` : "—"
      : Number.isFinite(item.return1h) ? `${item.return1h >= 0 ? "+" : ""}${item.return1h.toFixed(2)}%` : "—";
    const tone = metric === "velocity" ? "positive" : Number(item.return1h) >= 0 ? "positive" : "negative";
    const volume = Number.isFinite(item.volumeRatio15m) ? ` · 量${item.volumeRatio15m.toFixed(2)}x` : "";
    return `<div><span>${escapeHtml(item.symbol.replace(/USDT$/, ""))}<small>${escapeHtml(item.radarTier)} · ${escapeHtml(item.bias)}${escapeHtml(volume)}</small></span><b class="${tone}">${escapeHtml(value)}</b></div>`;
  }).join("");
}

function renderMarketRadar(monitor) {
  const radar = monitor.marketRadar;
  const config = monitor.marketRadarConfig ?? {};
  elements.radarRefresh.textContent = config.refreshMinutes ? `${config.refreshMinutes} 分钟` : "—";
  if (!radar) {
    elements.radarDirection.textContent = "等待快照";
    elements.radarDiscovery.textContent = "—";
    elements.radarDeepScan.textContent = "—";
    elements.radarUpdated.textContent = monitor.radarError ? `雷达异常：${monitor.radarError}` : "等待首次雷达快照";
    return;
  }
  elements.radarDirection.textContent = radarDirectionLabel(radar.market?.breadth?.direction);
  elements.radarDiscovery.textContent = `${radar.discoverySize ?? 0} 个`;
  elements.radarDeepScan.textContent = `${radar.deepScanSize ?? 0} 个`;
  elements.radarUpdated.textContent = `快照 ${escapeHtml(radar.snapshotId)} · ${formatTime(radar.generatedAt)}`;
  elements.radarActivity.innerHTML = renderRadarRows(radar.rankVelocityLeaders, "velocity");
  elements.radarLeaders.innerHTML = renderRadarRows(radar.leaders, "change");
  elements.radarLaggards.innerHTML = renderRadarRows(radar.laggards, "change");
}

function renderDemoTrades(items, performance = null) {
  const finalizedCount = Number.isFinite(performance?.finalizedTradeCount)
    ? performance.finalizedTradeCount
    : items.filter((trade) => trade.status === "CLOSED" && trade.accountingComplete === true).length;
  elements.demoTradeCount.textContent = `${items.length} 笔真实流水 · ${finalizedCount} 笔绩效样本`;
  if (!items.length) {
    const totalNetPnl = Number.isFinite(performance?.totalNetPnl) ? performance.totalNetPnl : null;
    elements.demoNetPnl.textContent = totalNetPnl === null ? "—" : signedMoney(totalNetPnl);
    elements.demoNetPnl.className = totalNetPnl === null ? "" : totalNetPnl >= 0 ? "metric-positive" : "metric-negative";
    elements.demoTradesBody.innerHTML = '<tr><td colspan="8" class="empty-cell">暂无策略驱动的 Demo 订单；新信号成交后会自动出现在这里</td></tr>';
    return;
  }
  const totalNetPnl = Number.isFinite(performance?.totalNetPnl)
    ? performance.totalNetPnl
    : items.filter((trade) => trade.status === "CLOSED" && trade.accountingComplete === true && Number.isFinite(trade.netPnl))
      .reduce((total, trade) => total + trade.netPnl, 0);
  elements.demoNetPnl.textContent = signedMoney(totalNetPnl);
  elements.demoNetPnl.className = totalNetPnl >= 0 ? "metric-positive" : "metric-negative";
  elements.demoTradesBody.innerHTML = items.map((trade) => {
    const strategyLabel = `${trade.strategy === "PRE_BREAKOUT" ? "爆发前" : trade.strategy === "BREAKOUT" ? "突破" : trade.strategy === "PULLBACK" ? "回调" : "策略信号"}${trade.experimentTier ? ` · ${trade.experimentTier === "CORE" ? "A级" : "B级"}` : ""}`;
    const directionLabel = trade.direction === "SHORT" ? "卖出 · 开空" : "买入 · 开多";
    const closed = trade.status === "CLOSED";
    const pnlValue = closed ? trade.netPnl : trade.unrealizedPnl;
    const pnlClass = Number.isFinite(pnlValue) ? (pnlValue >= 0 ? "pnl-positive" : "pnl-negative") : "";
    const pnlDetail = closed
      ? `已实现 ${signedMoney(trade.realizedPnl)} · 手续费 ${Number.isFinite(trade.commission) ? pnlFormatter.format(trade.commission) : "—"} U`
      : "当前未实现盈亏";
    const protection = trade.protection ?? {};
    const protectionLabel = trade.quantity
      ? `止损 ${orderStatusLabel(protection.breakEvenStop ?? protection.stop)} · TP1 ${orderStatusLabel(protection.takeProfit1)} · TP2 ${orderStatusLabel(protection.takeProfit2)}`
      : `入场单 ${orderStatusLabel(trade.entryOrderStatus)}`;
    const actualMargin = Number.isFinite(trade.actualMarginEstimate) ? trade.actualMarginEstimate : null;
    const plannedMargin = Number.isFinite(trade.marginEstimate ?? trade.marginTarget) ? (trade.marginEstimate ?? trade.marginTarget) : null;
    const displayedMargin = actualMargin ?? plannedMargin;
    const marginDetail = `${actualMargin !== null ? "实际" : "计划"} · ${trade.leverage ?? "—"}x · ${trade.marginMode === "ISOLATED" ? "逐仓" : trade.marginMode === "CROSSED" ? "全仓" : "—"}${actualMargin !== null && plannedMargin !== null && Math.abs(actualMargin - plannedMargin) >= 0.01 ? ` · 目标 ${moneyFormatter.format(plannedMargin)} U` : ""}`;
    const detailRows = [
      `评分 ${Number.isFinite(trade.score) ? `${trade.score}/100` : "—"}`,
      trade.entryReason ? `开仓原因 ${trade.entryReason}` : null,
      trade.marketEventId ? `市场事件 ${trade.marketEventId}` : null,
      trade.strategyVersion ? `策略版本 ${trade.strategyVersion}` : null,
      trade.experimentTier ? `实验层级 ${trade.experimentTier === "CORE" ? "A级核心层" : "B级探索层"}` : null,
      trade.costCohort ? `执行成本组 ${trade.costCohort === "NORMAL_COST" ? "普通成本组（≤0.20R）" : "高成本探索组（0.20R–0.35R）"}` : null,
      trade.qualityObservations?.length ? `质量观察 ${trade.qualityObservations.join("、")}` : null,
      trade.marketRadar ? `雷达 ${trade.marketRadar.version} · 快照 ${trade.marketRadar.snapshotId} · ${trade.marketRadar.radarTier} ${trade.marketRadar.radarScore}分 · 偏向 ${trade.marketRadar.bias}` : null,
      `止损 ${formatPrice(trade.stopLoss)} · 止盈 ${formatPrice(trade.takeProfit1)} / ${formatPrice(trade.takeProfit2)}`,
      trade.entryExecutionMode ? `入场执行 ${trade.entryExecutionMode} · ${trade.entryTimeInForce ?? "—"}` : null,
      Number.isFinite(trade.plannedEntryPrice) || Number.isFinite(trade.submittedLimitPrice)
        ? `入场价格 计划 ${formatPrice(trade.plannedEntryPrice)} · 委托 ${formatPrice(trade.submittedLimitPrice)}${Number.isFinite(trade.entryPrice) ? ` · 成交 ${formatPrice(trade.entryPrice)}` : ""}`
        : null,
      Number.isFinite(trade.entrySlippageBps) ? `实际入场滑点 ${trade.entrySlippageBps >= 0 ? "+" : ""}${trade.entrySlippageBps.toFixed(2)} bps` : null,
      Number.isFinite(trade.entrySpreadBps) ? `提交时点差 ${trade.entrySpreadBps.toFixed(2)} bps` : null,
      Number.isFinite(trade.entryWaitMs) ? `入场等待 ${(trade.entryWaitMs / 1000).toFixed(1)} 秒` : null,
      trade.entryCancellationReason ? `撤单原因 ${trade.entryCancellationReason}` : null,
      trade.entryFactStatus ? `成交事实 ${trade.entryFactStatus} · ${trade.entryFactSource ?? trade.entryFactReason ?? "来源未知"}` : null,
      trade.entryVerificationStatus ? `入场核验 ${trade.entryVerificationStatus} · 成交明细 ${trade.entryFillsStatus ?? "待核实"}` : null,
      Number.isFinite(trade.actualRisk) ? `初始实际风险 ${pnlFormatter.format(trade.actualRisk)} U（不等于保证金或保证最大亏损）` : trade.entryFactStatus ? "初始实际风险未知；净R不作确认" : null,
      Number.isFinite(trade.netR) ? `净结果 ${trade.netR >= 0 ? "+" : ""}${trade.netR.toFixed(3)}R` : null,
      Number.isFinite(trade.mfeR) && Number.isFinite(trade.maeR) ? `持仓波动 MFE ${trade.mfeR.toFixed(3)}R · MAE ${trade.maeR.toFixed(3)}R` : null,
      trade.excursionCoverage ? `路径覆盖 ${trade.excursionCoverage} · ${trade.excursionSource ?? trade.excursionReason ?? "来源未知"}；不代表完整行情路径` : null,
      Number.isFinite(trade.entrySlippageCost) ? `入场滑点影响 ${signedMoney(-trade.entrySlippageCost)}` : null,
      Number.isFinite(trade.fundingPnl) ? `资金费 ${signedMoney(trade.fundingPnl)}` : null,
      trade.entryOrderId ? `Binance 入场订单 ${trade.entryOrderId}` : null,
      trade.exitOrderIds?.length ? `Binance 出场订单 ${trade.exitOrderIds.join(", ")}` : null,
      trade.performanceEligible === false ? `绩效处理 已排除（${trade.executionException ?? "执行异常样本"}）` : null,
      trade.error ? `执行异常 ${trade.error}` : null,
      Number.isFinite(trade.markPrice) ? `实时标记价 ${formatPrice(trade.markPrice)}${Number.isFinite(trade.liquidationPrice) ? ` · 强平价 ${formatPrice(trade.liquidationPrice)}` : ""}` : null,
      trade.accountingComplete === false ? "成交账务仍在对账，暂不确认净盈亏" : null,
      trade.exitReason ? `平仓原因 ${trade.exitReason}` : trade.resultReason ? `结束原因 ${trade.resultReason}` : null,
    ].filter(Boolean);
    return `<tr>
      <td><span class="cell-primary">${formatTime(trade.openedAt ?? trade.updatedAt)}</span><small>${trade.closedAt ? `平仓 ${formatTime(trade.closedAt)}` : "尚未平仓"}</small></td>
      <td><span class="cell-primary">${escapeHtml(trade.symbol)}</span><small>${strategyLabel}${Number.isFinite(trade.score) ? ` · ${trade.score}/100` : ""}</small></td>
      <td class="${trade.direction === "SHORT" ? "tag-short" : "tag-long"}">${directionLabel}</td>
      <td><span class="cell-primary">${formatPrice(trade.quantity)} ${escapeHtml(trade.symbol.replace(/USDT$/, ""))}</span><small>${formatPrice(trade.entryPrice)}${Number.isFinite(trade.exitPrice) ? ` → ${formatPrice(trade.exitPrice)}` : ""}</small></td>
      <td><span class="cell-primary">${Number.isFinite(trade.notional) ? moneyFormatter.format(trade.notional) : "—"} U</span><small>成交名义价值</small></td>
      <td><span class="cell-primary">${displayedMargin !== null ? moneyFormatter.format(displayedMargin) : "—"} U</span><small>${marginDetail}</small></td>
      <td><span class="cell-primary">${escapeHtml(executionStatusLabel(trade.status))}</span><small>${escapeHtml(protectionLabel)}</small><details class="trade-details" data-run-id="${escapeHtml(trade.id)}" ${expandedTradeIds.has(trade.id) ? "open" : ""}><summary>查看执行明细</summary><p>${detailRows.map((row) => escapeHtml(row)).join("<br>")}</p></details></td>
      <td class="${pnlClass}"><span class="cell-primary">${signedMoney(pnlValue)}</span><small>${pnlDetail}</small></td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".trade-details").forEach((details) => details.addEventListener("toggle", () => {
    if (details.open) expandedTradeIds.add(details.dataset.runId);
    else expandedTradeIds.delete(details.dataset.runId);
  }));
}

function hideChartTooltip() {
  elements.performanceChartTooltip.hidden = true;
}

function showChartTooltip(target) {
  const point = chartState.visiblePoints[Number(target.dataset.pointIndex)];
  if (!point) return;
  const frame = elements.performanceChartFrame;
  const left = (Number(target.dataset.chartX) / 1000) * frame.clientWidth;
  const top = (Number(target.dataset.chartY) / 330) * frame.clientHeight;
  const tooltip = elements.performanceChartTooltip;
  tooltip.innerHTML = `<strong>${escapeHtml(point.date)}</strong>
    <span>当日净盈亏 <b>${signedMoney(point.dailyNetPnl)}</b></span><br>
    <span>累计净盈亏 ${signedMoney(point.cumulativeNetPnl)}</span><br>
    <span>策略权益 ${plainMoney(point.equity)}</span><br>
    <span>平仓 ${point.tradeCount} 笔 · 胜 ${point.wins} · 负 ${point.losses}</span><br>
    <span>手续费 ${plainMoney(point.commission)} · 资金费 ${signedMoney(point.fundingPnl)}</span>`;
  tooltip.style.left = `${Math.max(105, Math.min(frame.clientWidth - 105, left))}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.transform = top < 115 ? "translate(-50%, 12px)" : "translate(-50%, calc(-100% - 12px))";
  tooltip.hidden = false;
}

function renderPerformance(performance, executionSummary = chartState.executionSummary) {
  chartState.performance = performance ?? null;
  chartState.executionSummary = executionSummary ?? null;
  const startingEquity = Number(performance?.startingEquity);
  const currentEquity = Number(performance?.currentEquity);
  const totalNetPnl = Number(performance?.totalNetPnl);
  const finalizedCount = Number(performance?.finalizedTradeCount) || 0;
  const pendingCount = Number(performance?.pendingTradeCount) || 0;
  elements.performanceStartingEquity.textContent = plainMoney(startingEquity);
  elements.performanceCurrentEquity.textContent = plainMoney(currentEquity);
  elements.performanceCurrentEquity.className = Number.isFinite(currentEquity) && Number.isFinite(startingEquity)
    ? currentEquity >= startingEquity ? "metric-positive" : "metric-negative"
    : "";
  elements.performanceTotalPnl.textContent = signedMoney(totalNetPnl);
  elements.performanceTotalPnl.className = Number.isFinite(totalNetPnl) ? totalNetPnl >= 0 ? "metric-positive" : "metric-negative" : "";
  elements.performanceTradeCount.textContent = `${finalizedCount} 笔`;
  elements.performanceAccountingNote.textContent = executionSummary
    ? `在途 ${executionSummary.open ?? 0} · 待对账 ${executionSummary.accountingPending ?? 0} · 入场冲突 ${executionSummary.entryFactConflict ?? 0} · 未成交取消 ${executionSummary.canceledUnfilled ?? 0} · 排除 ${executionSummary.excluded ?? 0} · 执行失败 ${executionSummary.failed ?? 0} · 未知 ${executionSummary.submissionUnknown ?? 0}`
    : pendingCount
      ? `不含未平仓浮盈亏 · ${pendingCount} 笔在途/待对账`
      : "不含未平仓浮盈亏";
  renderExperimentPerformance(performance);
  renderResearchAttribution(performance);

  const metric = chartMetrics[chartState.metric];
  const allPoints = Array.isArray(performance?.points) ? performance.points : [];
  const visiblePoints = chartState.range === "all" ? allPoints : allPoints.slice(-chartState.range);
  chartState.visiblePoints = visiblePoints;
  elements.performanceChartLabel.textContent = metric.label;
  elements.chartMetricControl.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.chartMetric === chartState.metric));
  });
  elements.chartRangeControl.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.chartRange === String(chartState.range)));
  });

  hideChartTooltip();
  if (!visiblePoints.length || finalizedCount === 0) {
    elements.performanceChart.replaceChildren();
    elements.performanceChartEmpty.hidden = false;
    return;
  }
  elements.performanceChartEmpty.hidden = true;
  const width = 1000;
  const height = 330;
  const margin = { top: 28, right: 24, bottom: 46, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseline = Number(metric.baseline(performance));
  const values = visiblePoints.map((point) => Number(point[metric.key])).filter(Number.isFinite);
  const domainValues = Number.isFinite(baseline) ? [...values, baseline] : values;
  let minimum = Math.min(...domainValues);
  let maximum = Math.max(...domainValues);
  const span = maximum - minimum;
  const padding = span === 0 ? Math.max(Math.abs(maximum) * 0.01, 1) : span * 0.12;
  minimum -= padding;
  maximum += padding;
  const xAt = (index) => visiblePoints.length === 1
    ? margin.left + plotWidth / 2
    : margin.left + (index / (visiblePoints.length - 1)) * plotWidth;
  const yAt = (value) => margin.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const coordinates = visiblePoints.map((point, index) => ({ x: xAt(index), y: yAt(Number(point[metric.key])) }));
  const linePath = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${coordinates.at(-1).x.toFixed(2)},${(margin.top + plotHeight).toFixed(2)} L${coordinates[0].x.toFixed(2)},${(margin.top + plotHeight).toFixed(2)} Z`;
  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = margin.top + ratio * plotHeight;
    const value = maximum - ratio * (maximum - minimum);
    return `<line class="chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${y}" y2="${y}"></line><text class="chart-axis-label" x="${margin.left - 12}" y="${y + 3}" text-anchor="end">${escapeHtml(chartNumber(value))}</text>`;
  }).join("");
  const labelStep = Math.max(1, Math.ceil(visiblePoints.length / 6));
  const xLabels = visiblePoints.map((point, index) => (index % labelStep === 0 || index === visiblePoints.length - 1)
    ? `<text class="chart-axis-label" x="${xAt(index)}" y="${height - 18}" text-anchor="middle">${escapeHtml(shortDate(point.date))}</text>`
    : "").join("");
  const zeroLine = minimum < 0 && maximum > 0
    ? `<line class="chart-grid chart-zero" x1="${margin.left}" x2="${width - margin.right}" y1="${yAt(0)}" y2="${yAt(0)}"></line>`
    : "";
  const points = coordinates.map((point, index) => {
    const item = visiblePoints[index];
    return `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="4" tabindex="0" role="button" data-point-index="${index}" data-chart-x="${point.x}" data-chart-y="${point.y}" aria-label="${escapeHtml(`${item.date}，${metric.label} ${plainMoney(item[metric.key])}`)}"><title>${escapeHtml(`${item.date} · ${metric.label} ${plainMoney(item[metric.key])}`)}</title></circle>`;
  }).join("");
  elements.performanceChart.innerHTML = `<defs><linearGradient id="performance-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c9ff3d" stop-opacity=".18"></stop><stop offset="100%" stop-color="#c9ff3d" stop-opacity="0"></stop></linearGradient></defs>${gridLines}${zeroLine}<path class="chart-area" d="${areaPath}"></path><path class="chart-series" d="${linePath}"></path>${xLabels}${points}`;
  elements.performanceChart.querySelectorAll(".chart-point").forEach((point) => {
    point.addEventListener("mouseenter", () => showChartTooltip(point));
    point.addEventListener("mouseleave", hideChartTooltip);
    point.addEventListener("focus", () => showChartTooltip(point));
    point.addEventListener("blur", hideChartTooltip);
  });
}

function coverageLabel(coverage) {
  if (!coverage || !Number.isFinite(coverage.total) || !Number.isFinite(coverage.valid)) return "覆盖未知";
  const percent = Number.isFinite(coverage.coverage) ? `${(coverage.coverage * 100).toFixed(1)}%` : "—";
  return `${coverage.valid}/${coverage.total} 有效 · 缺失 ${coverage.missing ?? "—"} · ${percent}`;
}

function renderExperimentPerformance(performance) {
  const progress = performance?.sampleProgress ?? { target: 100, finalized: 0, remaining: 100, completionPercent: 0 };
  const percent = Number.isFinite(Number(progress.completionPercent)) ? Math.max(0, Math.min(100, Number(progress.completionPercent))) : 0;
  elements.sampleProgressText.textContent = `${progress.finalized ?? 0} / ${progress.target ?? 100}`;
  elements.sampleProgressBar.style.width = `${percent}%`;
  const gate = performance?.validationGate;
  const evidence = performance?.coverage?.netR;
  const blockers = [];
  if (gate?.checks?.completeNetR === false) blockers.push(`净R证据不完整（${coverageLabel(evidence)}）`);
  if (gate?.checks?.completeNetPnl === false) blockers.push("仍有已平仓账务未结算");
  if ((progress.remaining ?? 100) > 0) blockers.push(`还需 ${progress.remaining ?? 100} 笔已结算样本`);
  elements.sampleValidationStatus.textContent = gate?.eligible
    ? "样本与统计门槛已满足，等待样本外复核；不代表实盘准入"
    : `${blockers.length ? blockers.join(" · ") : "统计门槛未通过"} · 当前仅作观察`;
  const formatSummaryCard = (item) => `<article>
    <span>${escapeHtml(item.label)}</span>
    <strong>${item.finalizedTradeCount ?? 0} 笔</strong>
    <small>胜率 ${Number.isFinite(item.winRate) ? `${(item.winRate * 100).toFixed(1)}%` : "—"} · 平均 ${Number.isFinite(item.averageNetR) ? `${item.averageNetR.toFixed(3)}R` : "—"} · PF ${Number.isFinite(item.profitFactor) ? item.profitFactor.toFixed(2) : "—"}<br>净R ${escapeHtml(coverageLabel(item.coverage?.netR))}</small>
  </article>`;
  elements.tierSummary.innerHTML = [...(performance?.tiers ?? []), ...(performance?.costCohorts ?? [])].map(formatSummaryCard).join("");
  elements.segmentSummary.innerHTML = (performance?.segments ?? []).map(formatSummaryCard).join("");
}

function renderResearchAttribution(performance) {
  const research = performance?.researchAttribution ?? {};
  const excursion = research.excursion ?? {};
  const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
  const duration = (value) => Number.isFinite(value) ? `${(value / 60_000).toFixed(1)} 分钟` : "—";
  elements.excursionResearchNote.textContent = excursion.closedTrades
    ? `已平仓 ${excursion.closedTrades} 笔 · 止损样本 ${excursion.stopTrades ?? 0} 笔 · MFE ${coverageLabel(excursion.coverage?.mfeR)} · MAE ${coverageLabel(excursion.coverage?.maeR)}。覆盖率仅表示指标可用，不代表完整行情路径；仅用于研究。`
    : "等待已结算交易形成 MFE / MAE 研究样本。";
  const metrics = [
    ["止损单 MFE 中位数", Number.isFinite(excursion.stopMedianMfeR) ? `${excursion.stopMedianMfeR.toFixed(3)}R` : "—"],
    ["盈利单 MAE 中位数", Number.isFinite(excursion.winnerMedianMaeR) ? `${excursion.winnerMedianMaeR.toFixed(3)}R` : "—"],
    ["止损前 MFE < 0.2R", percent(excursion.stopMfeBelow0_2RRatio)],
    ["止损前 MFE > 0.5R", percent(excursion.stopMfeAbove0_5RRatio)],
    ["止损前 MFE > 1.0R", percent(excursion.stopMfeAbove1RRatio)],
    ["到 MFE 中位时间", duration(excursion.medianTimeToMfeMs)],
    ["到止损中位时间", duration(excursion.medianTimeToStopMs)],
    ["BE 止损样本", `${excursion.breakEvenStopMfeDistribution?.count ?? 0} 笔`],
  ];
  elements.excursionResearchSummary.innerHTML = metrics
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const combinations = research.opportunitySources?.combinations ?? [];
  elements.sourceCombinationSummary.innerHTML = combinations.length
    ? combinations.slice(0, 12).map((item) => `<article>
      <span>${escapeHtml(item.combination)}</span>
      <strong>${item.trades} 笔 · ${escapeHtml(item.sampleStatus)}</strong>
      <small>胜率 ${percent(item.winRate)} · 平均 ${Number.isFinite(item.avgNetR) ? `${item.avgNetR.toFixed(3)}R` : "—"} · PF ${Number.isFinite(item.profitFactor) ? item.profitFactor.toFixed(2) : "—"}<br>净PnL ${escapeHtml(coverageLabel(item.coverage?.netPnl))}<br>净R ${escapeHtml(coverageLabel(item.coverage?.netR))}<br>MFE ${Number.isFinite(item.avgMfeR) ? item.avgMfeR.toFixed(2) : "—"}R · MAE ${Number.isFinite(item.avgMaeR) ? item.avgMaeR.toFixed(2) : "—"}R · 成本 ${Number.isFinite(item.avgCostR) ? item.avgCostR.toFixed(3) : "—"}R · 持仓 ${Number.isFinite(item.avgHoldingMinutes) ? item.avgHoldingMinutes.toFixed(1) : "—"}分钟<br>MFE ${escapeHtml(coverageLabel(item.coverage?.mfeR))} · MAE ${escapeHtml(coverageLabel(item.coverage?.maeR))}<br>组内独立最大回撤 ${Number.isFinite(item.groupMaxDrawdownR) ? `${item.groupMaxDrawdownR.toFixed(3)}R` : "—"}（不可相加为组合贡献）</small>
    </article>`).join("")
    : '<div class="empty-state">等待来源组合形成已结算样本</div>';
}

function render(data) {
  const monitor = data.monitor;
  const activePortfolio = (data.portfolio ?? []).filter((item) => ["ENTRY_PENDING", "OPEN", "TP1_FILLED"].includes(item.trade?.status));
  const currentCandidates = (monitor.latest ?? []).flatMap((analysis) => analysis.candidates ?? []);
  const isTestnet = data.marketEnvironment === "TESTNET";
  elements.sourceFooter.textContent = `主源：Binance${isTestnet ? " Demo/Testnet" : ""} · 辅助校验：Hyperliquid · 突破与回调独立归因`;
  const execution = data.execution ?? {};
  const gateway = execution.gateway ?? {};
  const automation = execution.automation ?? {};
  const emergencyStop = execution.emergencyStop ?? { active: false };
  const safetyHold = execution.safetyHold ?? { active: false };
  const executionHalted = Boolean(emergencyStop.active || safetyHold.active);
  const submissionEnabled = Boolean(execution.effectiveOrderSubmissionEnabled);
  const autoWatching = automation.enabled && automation.status === "WATCHING" && !executionHalted;
  const v2Execution = automation.strategySource === "V2_PRODUCTION";
  elements.modeMark.textContent = emergencyStop.active ? "Demo 紧急停止" : safetyHold.active ? "Demo 安全暂停" : autoWatching ? `${v2Execution ? "V2.4.3 " : "V1 "}Demo 自动执行` : isTestnet ? "测试网研究模式" : "研究模式";
  const testnetAccount = execution.account ?? {};
  const readiness = execution.readiness ?? {};
  const capacity = execution.capacity ?? {};
  const latestStrategyTrade = (data.demoTrades ?? [])[0] ?? null;
  const connected = Boolean(testnetAccount.connected);
  elements.executionLock.textContent = emergencyStop.active ? "紧急停止 · 禁止新订单" : safetyHold.active ? `执行安全暂停 · ${executionStatusLabel(safetyHold.status)}` : autoWatching ? "Demo 自动执行监听中" : gateway.orderSubmissionEnabled ? "策略测试执行已解锁" : "下单关闭 · 待最终确认";
  elements.executionLock.className = `execution-lock ${submissionEnabled ? "danger" : "safe"}`;
  elements.modeMessage.textContent = emergencyStop.active
    ? `检测到执行安全异常（${emergencyStop.reason ?? "UNKNOWN"}），系统已冻结所有新订单并优先处置异常仓位。`
    : safetyHold.active
    ? `执行流水 ${safetyHold.runId ?? "—"} 处于${executionStatusLabel(safetyHold.status)}，新订单暂停，交易所事实对账完成后自动恢复。`
    : autoWatching
    ? v2Execution
      ? "V2.4.3先寻找爆发前标的；仅靠RETAINED或去除RETAINED后仅剩BOUNDARY_PRESSURE的候选保留研究但不会下单。评分、方向、止盈止损、仓位与成本规则保持V2.4.2不变。"
      : "系统会把所有达到评分门槛、仍有效且通过执行校验的 V1 信号提交到 Binance Demo；真实资金账户始终不可用。"
    : gateway.orderSubmissionEnabled
      ? "策略信号测试网执行已解锁；只有已进入组合并通过确认的单笔计划可以提交。"
    : "系统继续生成策略信号与模拟组合；Binance Demo 写入锁当前关闭。";
  elements.executionFooter.textContent = `本地模拟组合 ≠ Binance 测试网账户 · ${emergencyStop.active ? "Demo 紧急停止" : safetyHold.active ? "Demo 安全暂停" : autoWatching ? "仅 Demo 自动执行" : `策略测试执行${gateway.orderSubmissionEnabled ? "已解锁" : "默认锁定"}`}`;
  elements.accountConnection.textContent = executionHalted ? "安全冻结" : !testnetAccount.enabled ? "未启用" : connected ? (gateway.orderSubmissionEnabled ? "Demo 已连接" : "只读已连接") : testnetAccount.status === "SYNCING" ? "同步中" : "连接异常";
  elements.accountWallet.textContent = connected && Number.isFinite(testnetAccount.account?.totalWalletBalance)
    ? `${moneyFormatter.format(testnetAccount.account.totalWalletBalance)} U`
    : "—";
  elements.accountPositions.textContent = connected ? String(testnetAccount.positions?.length ?? 0) : "—";
  elements.accountOrders.textContent = connected
    ? String((testnetAccount.openOrders?.length ?? 0) + (testnetAccount.openAlgoOrders?.length ?? 0))
    : "—";
  elements.accountPositionMode.textContent = testnetAccount.positionMode === "ONE_WAY" ? "单向" : testnetAccount.positionMode === "HEDGE" ? "双向" : "—";
  elements.accountReadiness.textContent = readiness.canPrepareCanary
    ? readiness.tradePermissionSource === "ORDER_TEST_PER_SIGNAL" ? "按信号预检" : "条件通过"
    : "已阻止";
  elements.executionCapacity.textContent = Number.isFinite(capacity.activeRuns)
    ? `${capacity.activeRuns} 笔`
    : "—";
  elements.executionMargin.textContent = Number.isFinite(capacity.reservedMargin)
    ? `${moneyFormatter.format(capacity.reservedMargin)} U`
    : "—";
  elements.canaryRunStatus.textContent = executionStatusLabel(latestStrategyTrade?.status);
  const readinessMessage = (readiness.blockedReasons ?? []).map((item) => item.message).join("；");
  elements.accountMessage.textContent = emergencyStop.active
    ? `执行紧急停止：${emergencyStop.reason ?? "UNKNOWN"}${emergencyStop.runId ? `；关联流水 ${emergencyStop.runId}` : ""}。新订单保持冻结，异常仓位处置完成并核对账户后才能恢复。`
    : safetyHold.active
    ? `安全暂停：${safetyHold.runId ?? "—"} 为${executionStatusLabel(safetyHold.status)}；系统会继续对账，但不会提交新的入场单。`
    : testnetAccount.error
    ? `只读同步失败：${testnetAccount.error}`
    : readinessMessage
      ? `进入单币测试前需处理：${readinessMessage}${connected ? `；最近同步 ${formatTime(testnetAccount.lastSuccessfulSyncAt)}` : ""}。`
    : connected
      ? readiness.tradePermissionSource === "ORDER_TEST_PER_SIGNAL"
        ? `最近同步 ${formatTime(testnetAccount.lastSuccessfulSyncAt)}；每笔新信号提交前都会执行一次不进撮合的权限预检。`
        : `最近同步 ${formatTime(testnetAccount.lastSuccessfulSyncAt)}；交易所账户是测试网订单与持仓的事实源。`
      : "本区读取 Binance 测试网账户；上方模拟组合仍是独立的本地记录。";
  elements.marketCount.textContent = String(monitor.universeSize ?? monitor.symbols.length);
  elements.activeCount.textContent = String(activePortfolio.length);
  elements.demoPnlLabel.textContent = v2Execution ? "V2.4.3 Demo 净盈亏" : "Demo 净盈亏";
  elements.portfolioTitle.textContent = v2Execution ? "V2.4.3 Pre-Move 可执行信号" : "策略组合信号";
  elements.performanceBasis.textContent = data.performanceEpoch
    ? `当前纪元 ${data.performanceEpoch.id ?? "V2"} · 从 ${formatTime(data.performanceEpoch.startedAt)} 起重新计算 · 旧版本历史仍保留`
    : "仅统计已平仓且账务完成的策略订单 · 北京时间归属交易日";
  elements.scanMeta.textContent = v2Execution
    ? `每 ${monitor.pollSeconds} 秒检查 · 雷达池 ${monitor.marketRadar?.deepScanSize ?? monitor.universeSize ?? "—"} · B级 ${data.v2Experiment?.explorationMinimumScore ?? "—"}+ / A级 ${data.v2Experiment?.coreMinimumScore ?? "—"}+ · 不设固定总持仓笔数`
    : `每 ${monitor.pollSeconds} 秒检查 · 评分门槛 ${monitor.minimumScore ?? "—"} · 所有合格信号均进入Demo执行`;
  elements.candidateCount.textContent = String(currentCandidates.length);
  elements.lastScan.textContent = monitor.lastScanCompletedAt ? `更新 ${formatTime(monitor.lastScanCompletedAt)}` : "等待首次扫描";
  elements.portfolioGrid.innerHTML = activePortfolio.length
    ? activePortfolio.map((record) => renderCandidateCard(record.candidate, { trade: record.trade })).join("")
    : '<div class="empty-state">暂无进入模拟组合的信号</div>';
  elements.signalGrid.innerHTML = currentCandidates.length
    ? currentCandidates.slice(0, 12).map((candidate) => renderCandidateCard(candidate)).join("")
    : '<div class="empty-state">当前没有满足硬规则的候选信号</div>';
  renderDemoTrades(data.demoTrades ?? [], data.strategyPerformance ?? null);
  renderMarketRadar(monitor);
  renderPerformance(data.strategyPerformance ?? null, data.strategyExecutionSummary ?? null);
  const errorCount = Object.keys(monitor.errors ?? {}).length;
  elements.pulse.className = `pulse ${executionHalted || errorCount || monitor.universeError ? "error" : "online"}`;
  elements.systemLabel.textContent = emergencyStop.active ? "Demo 执行已紧急停止" : safetyHold.active ? "Demo 执行安全暂停" : monitor.universeError ? "主行情源不可用" : errorCount ? `${errorCount} 个市场异常` : monitor.status === "SCANNING" ? "正在扫描" : "监控正常";
}

async function refresh() {
  try {
    const response = await fetch("/api/signals", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    elements.pulse.className = "pulse error";
    elements.systemLabel.textContent = "连接中断";
    elements.lastScan.textContent = error.message;
  }
}

elements.notifyButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    elements.notifyButton.textContent = "浏览器不支持通知";
    return;
  }
  const permission = await Notification.requestPermission();
  elements.notifyButton.textContent = permission === "granted" ? "桌面通知已开启" : "通知未授权";
});

elements.scanButton.addEventListener("click", async () => {
  elements.scanButton.disabled = true;
  elements.scanButton.textContent = "扫描中…";
  try {
    await fetch("/api/scan", { method: "POST" });
    await refresh();
  } finally {
    elements.scanButton.disabled = false;
    elements.scanButton.textContent = "立即扫描";
  }
});

elements.chartMetricControl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-chart-metric]");
  if (!button || !chartMetrics[button.dataset.chartMetric]) return;
  chartState.metric = button.dataset.chartMetric;
  renderPerformance(chartState.performance);
});

elements.chartRangeControl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-chart-range]");
  if (!button) return;
  chartState.range = button.dataset.chartRange === "all" ? "all" : Number(button.dataset.chartRange);
  renderPerformance(chartState.performance);
});

const events = new EventSource("/api/events");
events.addEventListener("analysis", () => void refresh());
events.addEventListener("trade", () => void refresh());
events.addEventListener("shadowTrade", () => void refresh());
events.addEventListener("shadowSignal", () => void refresh());
events.addEventListener("marketRadar", () => void refresh());
events.addEventListener("testnetAccount", () => void refresh());
events.addEventListener("testnetExecution", () => void refresh());
events.addEventListener("portfolio", (event) => {
  notifyPortfolioSignal(JSON.parse(event.data));
  void refresh();
});
events.addEventListener("error", () => { elements.systemLabel.textContent = "正在重连"; });
void refresh();
setInterval(refresh, 15_000);
