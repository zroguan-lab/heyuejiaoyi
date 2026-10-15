import { EventEmitter } from "node:events";
import { buildEntryReason } from "../domain/trade-reason.js";
import {
  V1_EXECUTION_SOURCE,
  V2_4_1_DEMO_PROMOTION_POLICY_VERSION,
  V2_4_1_MAX_EXECUTION_COST_R,
  V2_4_MAX_EXECUTION_COST_R,
  V2_4_1_SIGNAL_MODEL_VERSION,
  V2_EXECUTION_SOURCE,
  assessV2DemoPromotion,
  assertExecutionStrategySource,
  projectV2ExecutionSignal,
} from "../execution/execution-strategy-source.js";

const TERMINAL_EXECUTION_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function assessAutomaticExecutionSignal(record, {
  now = Date.now(),
  minimumRemainingMs = 30_000,
  minimumScore = 70,
  strategySource = V1_EXECUTION_SOURCE,
  epochStartedAt = null,
  requiredRadarVersion = null,
} = {}) {
  const source = assertExecutionStrategySource(strategySource);
  const candidate = record?.candidate;
  const trade = record?.trade;
  let promotionDecision = null;
  if (!record?.selected) return { eligible: false, reason: "NOT_SELECTED" };
  if (!candidate || !trade || candidate.id !== trade.signalId) return { eligible: false, reason: "INCOMPLETE_SIGNAL" };
  if (source === V2_EXECUTION_SOURCE) {
    const evaluation = record.evaluation ?? candidate.shadowV2;
    if (record.executionSource !== V2_EXECUTION_SOURCE) return { eligible: false, reason: "WRONG_EXECUTION_SOURCE" };
    if (evaluation?.strategyVersion !== V2_4_1_SIGNAL_MODEL_VERSION) {
      return { eligible: false, reason: "V2_4_1_SIGNAL_MODEL_REQUIRED" };
    }
    if (evaluation?.mode !== "SHADOW_ONLY" || evaluation?.orderSubmissionAllowed !== false || evaluation?.eligible !== true) {
      return { eligible: false, reason: "V2_NOT_ELIGIBLE" };
    }
    promotionDecision = record.promotionDecision
      ?? assessV2DemoPromotion(evaluation, { demoStrategyVersion: candidate.strategyVersion });
    if (!promotionDecision.eligible) {
      return {
        eligible: false,
        reason: promotionDecision.rejectionReasons[0] ?? "V2_DEMO_PROMOTION_REJECTED",
        promotionDecision,
      };
    }
    const validV2Portfolio = trade.portfolio === "V2_4_1_PREMOVE";
    if (!validV2Portfolio || trade.orderSubmissionAllowed !== false) {
      return { eligible: false, reason: "V2_PROMOTION_BOUNDARY_INVALID" };
    }
    if (/V2_[1234]/.test(String(evaluation?.strategyVersion ?? ""))
      && !new Set(["CORE", "EXPLORATION"]).has(evaluation?.experimentTier)) {
      return { eligible: false, reason: "V2_EXPERIMENT_TIER_INVALID" };
    }
    if (requiredRadarVersion) {
      const radar = evaluation?.marketRadar ?? candidate.marketRadar;
      if (radar?.version !== requiredRadarVersion || radar?.selected !== true) {
        return { eligible: false, reason: "MARKET_RADAR_CONTEXT_INVALID" };
      }
    }
  }
  if (candidate.strategy === "OPERATOR_CANARY" || candidate.performanceEligible === false) {
    return { eligible: false, reason: "NOT_STRATEGY_SIGNAL" };
  }
  if (epochStartedAt !== null && epochStartedAt !== undefined && epochStartedAt !== ""
    && Number.isFinite(Number(epochStartedAt)) && Number(candidate.triggerTime) < Number(epochStartedAt)) {
    return { eligible: false, reason: "BEFORE_EXECUTION_EPOCH" };
  }
  if (trade.status !== "ENTRY_PENDING") return { eligible: false, reason: `TRADE_${trade.status ?? "UNKNOWN"}` };
  if (!Number.isFinite(Number(trade.expiresAt)) || Number(trade.expiresAt) - now < minimumRemainingMs) {
    return { eligible: false, reason: "SIGNAL_EXPIRED" };
  }
  const score = Number(candidate.score);
  if (!Number.isFinite(score) || score < minimumScore) return { eligible: false, reason: "SCORE_BELOW_MIN_CONFIDENCE" };
  let entryReason;
  try {
    entryReason = candidate.entryReason ?? buildEntryReason(candidate);
  } catch {
    return { eligible: false, reason: "MISSING_TRADE_REASON" };
  }
  return { eligible: true, signalId: candidate.id, symbol: candidate.symbol, score, entryReason, strategySource: source, promotionDecision };
}

export class StrategyExecutionCoordinator extends EventEmitter {
  constructor({
    monitor,
    executor,
    store,
    enabled = false,
    minimumScore = 70,
    strategySource = V1_EXECUTION_SOURCE,
    epochStartedAt = null,
    requiredRadarVersion = null,
    recoverySweepMs = 30_000,
    now = Date.now,
    logger = console,
  } = {}) {
    super();
    if (!monitor) throw new Error("缺少策略监控器");
    if (!executor) throw new Error("缺少测试网执行器");
    if (!store) throw new Error("缺少策略存储");
    this.monitor = monitor;
    this.executor = executor;
    this.store = store;
    this.enabled = Boolean(enabled);
    this.strategySource = assertExecutionStrategySource(strategySource);
    this.requiredRadarVersion = requiredRadarVersion || null;
    this.epochStartedAt = epochStartedAt !== null && epochStartedAt !== undefined && epochStartedAt !== ""
      && Number.isFinite(Number(epochStartedAt)) ? Number(epochStartedAt) : null;
    if (this.enabled && this.strategySource === V2_EXECUTION_SOURCE && this.epochStartedAt === null) {
      throw new Error("V2 Demo 自动执行缺少有效的绩效纪元起点");
    }
    this.minimumScore = Number(minimumScore);
    if (!Number.isFinite(this.minimumScore) || this.minimumScore < 0 || this.minimumScore > 100) throw new TypeError("自动执行最低评分必须是0-100的数字");
    this.recoverySweepMs = Number(recoverySweepMs);
    if (!Number.isFinite(this.recoverySweepMs) || this.recoverySweepMs < 10) throw new TypeError("自动执行恢复扫描周期必须至少为10毫秒");
    this.now = now;
    this.logger = logger;
    this.started = false;
    this.recoveryTimer = null;
    this.queue = Promise.resolve();
    this.lastDecision = null;
    this.signalEvent = this.strategySource === V2_EXECUTION_SOURCE ? "shadowSignal" : "portfolioSignal";
    this.onStrategySignal = ({ candidate } = {}) => this.enqueueSignal(candidate?.id, this.signalEvent === "shadowSignal" ? "V2_SHADOW_SIGNAL" : "PORTFOLIO_SIGNAL");
    this.onExecution = (run = {}) => {
      if (TERMINAL_EXECUTION_STATUSES.has(run.status)) this.enqueueSweep("EXECUTION_TERMINAL");
    };
  }

  recordDecision(value) {
    this.lastDecision = { ...value, at: this.now() };
    this.emit("decision", structuredClone(this.lastDecision));
    return this.lastDecision;
  }

  enqueue(task) {
    this.queue = this.queue.then(task, task).catch((error) => {
      this.logger.error(`[auto-execution] ${messageOf(error)}`);
      this.recordDecision({ status: "ERROR", reason: messageOf(error) });
    });
    return this.queue;
  }

  enqueueSignal(signalId, trigger = "PORTFOLIO_SIGNAL") {
    if (!this.enabled || !signalId) return this.queue;
    return this.enqueue(() => this.trySignal(signalId, trigger));
  }

  enqueueSweep(trigger = "SWEEP") {
    if (!this.enabled) return this.queue;
    return this.enqueue(() => this.sweep(trigger));
  }

  async getExecutionSignal(signalId) {
    if (typeof this.store.getExecutionSignal === "function") {
      return await this.store.getExecutionSignal(signalId, this.strategySource);
    }
    if (this.strategySource === V1_EXECUTION_SOURCE) return await this.store.getSignal(signalId);
    return projectV2ExecutionSignal(await this.store.getShadowSignal(signalId));
  }

  async listExecutionSignals(limit = 200) {
    if (typeof this.store.listExecutionSignals === "function") {
      return await this.store.listExecutionSignals(this.strategySource, limit);
    }
    if (this.strategySource === V1_EXECUTION_SOURCE) return await this.store.listSignals(limit, { selectedOnly: true });
    return (await this.store.listShadowSignals(limit, { selectedOnly: true })).map(projectV2ExecutionSignal);
  }

  async trySignal(signalId, trigger) {
    const record = await this.getExecutionSignal(signalId);
    const assessment = assessAutomaticExecutionSignal(record, {
      now: this.now(),
      minimumScore: this.minimumScore,
      strategySource: this.strategySource,
      epochStartedAt: this.epochStartedAt,
      requiredRadarVersion: this.requiredRadarVersion,
    });
    if (!assessment.eligible) return this.recordDecision({
      status: "SKIPPED",
      signalId,
      trigger,
      reason: assessment.reason,
      promotionDecision: assessment.promotionDecision ?? record?.promotionDecision ?? null,
    });

    const existing = await this.store.getExecutionRunBySignal(signalId);
    if (existing) return this.recordDecision({ status: "SKIPPED", signalId, trigger, reason: "ALREADY_RECORDED", runId: existing.id });

    const active = await this.store.listActiveExecutionRuns();
    const safetyHold = active.find((run) => ["SUBMISSION_UNKNOWN", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED"].includes(run.status));
    if (safetyHold) {
      return this.recordDecision({ status: "DEFERRED", signalId, trigger, reason: "EXECUTION_SAFETY_HOLD", runId: safetyHold.id });
    }
    const sameSymbol = active.find((run) => run.symbol === assessment.symbol);
    if (sameSymbol) {
      return this.recordDecision({ status: "DEFERRED", signalId, trigger, reason: "SYMBOL_ACTIVE", runId: sameSymbol.id, symbol: assessment.symbol });
    }
    let prepared;
    try {
      prepared = await this.executor.prepare(signalId, { strategySource: this.strategySource });
    } catch (error) {
      const reason = messageOf(error);
      this.logger.error(`[auto-execution] ${assessment.symbol}: ${reason}`);
      return this.recordDecision({
        status: "RETRY_PENDING",
        signalId,
        symbol: assessment.symbol,
        trigger,
        reason,
        retryAfterMs: this.recoverySweepMs,
        promotionDecision: assessment.promotionDecision,
      });
    }
    if (prepared.reused || !prepared.confirmationCode) {
      return this.recordDecision({ status: "SKIPPED", signalId, trigger, reason: "PLAN_NOT_NEW", runId: prepared.run?.id ?? null });
    }
    await this.store.appendExecutionAudit(prepared.run.id, "AUTO_EXECUTION_SELECTED", {
      signalId,
      symbol: prepared.run.symbol,
      trigger,
      strategy: record.candidate.strategy,
      score: assessment.score,
      entryReason: assessment.entryReason,
      strategyVersion: record.candidate.strategyVersion ?? null,
      experimentTier: record.candidate.experimentTier ?? record.evaluation?.experimentTier ?? null,
      qualityObservations: record.evaluation?.qualityObservations ?? [],
      marketEventId: record.candidate.marketEventId ?? null,
      marketRadar: record.evaluation?.marketRadar ?? record.candidate.marketRadar ?? null,
      strategySource: this.strategySource,
      demoPromotion: assessment.promotionDecision,
    }, this.now());
    this.recordDecision({ status: "SUBMITTING", signalId, trigger, runId: prepared.run.id, symbol: prepared.run.symbol });
    const run = await this.executor.execute(prepared.run.id, prepared.confirmationCode);
    return this.recordDecision({ status: "SUBMITTED", signalId, trigger, runId: run.id, symbol: run.symbol, executionStatus: run.status });
  }

  async sweep(trigger = "SWEEP") {
    const initialActive = await this.store.listActiveExecutionRuns();
    const safetyHold = initialActive.find((run) => ["SUBMISSION_UNKNOWN", "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED"].includes(run.status));
    if (safetyHold) return this.recordDecision({ status: "SKIPPED", trigger, reason: "EXECUTION_SAFETY_HOLD", runId: safetyHold.id });
    const records = await this.listExecutionSignals(200);
    const eligible = records
      .map((record) => ({
        record,
        assessment: assessAutomaticExecutionSignal(record, {
          now: this.now(),
          minimumScore: this.minimumScore,
          strategySource: this.strategySource,
          epochStartedAt: this.epochStartedAt,
          requiredRadarVersion: this.requiredRadarVersion,
        }),
      }))
      .filter((item) => item.assessment.eligible)
      .sort((left, right) => {
        const scoreDifference = right.assessment.score - left.assessment.score;
        if (scoreDifference !== 0) return scoreDifference;
        return Number(right.record.candidate.triggerTime ?? 0) - Number(left.record.candidate.triggerTime ?? 0);
      });
    if (!eligible.length) return this.recordDecision({ status: "IDLE", trigger, reason: "NO_ELIGIBLE_SIGNAL" });
    let decision = null;
    for (const item of eligible) {
      decision = await this.trySignal(item.assessment.signalId, trigger);
    }
    return decision ?? this.recordDecision({ status: "IDLE", trigger, reason: "NO_EXECUTABLE_SIGNAL" });
  }

  async start() {
    if (!this.enabled || this.started) return this.snapshot();
    if (!this.executor.enabled) throw new Error("自动策略执行要求测试网订单写入锁已开启");
    this.started = true;
    this.monitor.on(this.signalEvent, this.onStrategySignal);
    this.executor.on("execution", this.onExecution);
    await this.enqueueSweep("STARTUP");
    this.recoveryTimer = setInterval(() => this.enqueueSweep("PERIODIC_RECOVERY"), this.recoverySweepMs);
    this.recoveryTimer.unref?.();
    return this.snapshot();
  }

  async drain() {
    await this.queue;
  }

  stop() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.started) {
      this.monitor.off(this.signalEvent, this.onStrategySignal);
      this.executor.off("execution", this.onExecution);
    }
    this.started = false;
  }

  snapshot() {
    return {
      enabled: this.enabled,
      status: !this.enabled ? "DISABLED" : this.started ? "WATCHING" : "STOPPED",
      strategySource: this.strategySource,
      signalEvent: this.signalEvent,
      performanceEpochStartedAt: this.epochStartedAt,
      requiredRadarVersion: this.requiredRadarVersion,
      positionPolicy: this.strategySource === V2_EXECUTION_SOURCE ? "V2_4_1_PREMOVE_LONG_CONFIRMED_ALL_ELIGIBLE" : "ALL_ELIGIBLE",
      demoPromotionPolicy: this.strategySource === V2_EXECUTION_SOURCE ? {
        version: V2_4_1_DEMO_PROMOTION_POLICY_VERSION,
        normalCostR: V2_4_MAX_EXECUTION_COST_R,
        maximumCostR: V2_4_1_MAX_EXECUTION_COST_R,
        highCostExplorationEnabled: true,
        researchCounterfactualPreserved: true,
      } : null,
      minimumScore: this.minimumScore,
      recoverySweepSeconds: this.recoverySweepMs / 1000,
      lastDecision: this.lastDecision ? structuredClone(this.lastDecision) : null,
    };
  }
}
