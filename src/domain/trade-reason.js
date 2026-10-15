const STRATEGY_VERSION = "MTF_1H_15M_5M_V1";

function directionLabel(direction) {
  if (direction === "LONG") return "开仓做多";
  if (direction === "SHORT") return "开仓做空";
  throw new TypeError("交易方向无效");
}

function ensureSentence(value, label = "交易原因") {
  const raw = String(value ?? "");
  if (/[\r\n]/.test(raw)) throw new TypeError(`${label}不能换行`);
  const sentence = raw.replace(/\s+/g, " ").trim();
  if (sentence.length < 12 || sentence.length > 180) throw new TypeError(`${label}必须是12-180字的一句话`);
  return /[。！？.!?]$/.test(sentence) ? sentence : `${sentence}。`;
}

export function buildMarketEventId(triggerTime, intervalMs = 15 * 60_000) {
  const timestamp = Number(triggerTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new TypeError("市场事件时间无效");
  return `market-${Math.floor(timestamp / intervalMs).toString(36)}`;
}

export function buildEntryReason(candidate) {
  if (!candidate?.strategy || !candidate?.direction) throw new TypeError("候选信号缺少策略或方向");
  const action = directionLabel(candidate.direction);
  const score = Number(candidate.score);
  const scoreText = Number.isFinite(score) ? `，评分${Math.round(score)}分` : "";
  if (candidate.strategy === "BREAKOUT") {
    const structure = candidate.direction === "LONG" ? "结构高点" : "结构低点";
    return ensureSentence(`1小时趋势与结构方向一致，15分钟收盘有效突破${structure}${scoreText}，因此${action}`);
  }
  if (candidate.strategy === "PULLBACK") {
    const confirmation = candidate.direction === "LONG" ? "转强" : "转弱";
    return ensureSentence(`1小时趋势保持有效，15分钟回调进入结构区域，5分钟市场结构确认${confirmation}${scoreText}，因此${action}`);
  }
  if (candidate.strategy === "PRE_BREAKOUT") {
    const explosion = Number(candidate.preMove?.explosionScore);
    const direction = Number(candidate.preMove?.directionScore);
    const scoreDetail = Number.isFinite(explosion) && Number.isFinite(direction)
      ? `，爆发评分${Math.round(explosion)}分、方向评分${Math.round(direction)}分`
      : "";
    return ensureSentence(`15分钟波动收缩且价格靠近结构边界，5分钟量能与方向压力开始增强，1小时趋势确认方向${scoreDetail}${scoreText}，因此${action}`);
  }
  if (candidate.strategy === "OPERATOR_CANARY") {
    return ensureSentence(`操作员授权进行Binance Demo技术闭环验证，因此${action}`);
  }
  const facts = Array.isArray(candidate.reasons) ? candidate.reasons.filter(Boolean).slice(0, 2).join("，") : "规则条件成立";
  return ensureSentence(`${facts}${scoreText}，因此${action}`);
}

export function buildOrderReasons({ candidate, prices }) {
  const direction = candidate?.direction;
  const stopLoss = prices?.stopLoss;
  const takeProfit1 = prices?.takeProfit1;
  const takeProfit2 = prices?.takeProfit2;
  const entryReason = buildEntryReason(candidate);
  const invalidation = direction === "LONG" ? "多头结构失效" : "空头结构失效";
  return Object.freeze({
    entry: entryReason,
    stop: ensureSentence(`价格触及${stopLoss}将表示${invalidation}，因此执行全仓止损`),
    takeProfit1: ensureSentence(`价格触及${takeProfit1}将达到第一计划目标，因此按策略执行部分止盈`),
    takeProfit2: ensureSentence(`价格触及${takeProfit2}将达到第二计划目标，因此平掉剩余仓位`),
    breakEvenStop: ensureSentence("第一止盈成交后价格回到入场位将使剩余优势消失，因此按保本规则平仓"),
    operatorClose: null,
  });
}

export function normalizeOperatorCloseReason(reason) {
  return ensureSentence(reason, "主动平仓原因");
}

export function reasonForExitRole(orderReasons, role) {
  const value = orderReasons?.[role];
  return value ? ensureSentence(value, "出场原因") : null;
}

export { STRATEGY_VERSION };
