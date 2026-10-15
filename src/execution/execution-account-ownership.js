const TERMINAL_STATUSES = new Set(["CLOSED", "CANCELED", "REJECTED", "FAILED"]);
const ACTIVE_ALGO_STATUSES = new Set(["NEW", "PENDING", "TRIGGERING"]);
const ENTRY_MAY_EXIST_STATUSES = new Set([
  "ENTRY_SUBMITTING",
  "SUBMISSION_UNKNOWN",
  "ENTRY_PENDING",
  "PARTIALLY_FILLED",
  "PROTECTION_PENDING",
  "PROTECTION_INCOMPLETE",
  "OPEN_PROTECTED",
  "TP1_FILLED",
  "ERROR_UNPROTECTED",
  "OPERATOR_CLOSE_SUBMITTING",
  "OPERATOR_CLOSE_PENDING",
  "OPERATOR_CLOSE_UNKNOWN",
  "PROTECTION_CLEANUP_PENDING",
]);
const PROTECTION_MAY_EXIST_STATUSES = new Set([
  "PROTECTION_PENDING",
  "PROTECTION_INCOMPLETE",
  "OPEN_PROTECTED",
  "TP1_FILLED",
  "ERROR_UNPROTECTED",
  "OPERATOR_CLOSE_SUBMITTING",
  "OPERATOR_CLOSE_PENDING",
  "OPERATOR_CLOSE_UNKNOWN",
  "PROTECTION_CLEANUP_PENDING",
  "ACCOUNTING_PENDING",
]);

function claim(map, id, run, kind, conflicts) {
  if (!id) return;
  const key = String(id);
  const previous = map.get(key);
  if (previous && previous.id !== run.id) {
    conflicts.push({ kind, identity: key, runIds: [previous.id, run.id] });
    return;
  }
  map.set(key, run);
}

function hasEntrySubmissionEvidence(run) {
  return Boolean(run?.entryOrder?.orderId)
    || Number(run?.entryOrder?.executedQuantity ?? 0) > 0
    || ENTRY_MAY_EXIST_STATUSES.has(run?.status);
}

function expectedDirection(run) {
  return run?.plan?.direction ?? null;
}

function actualDirection(position) {
  const quantity = Number(position?.quantity);
  if (quantity > 0) return "LONG";
  if (quantity < 0) return "SHORT";
  return null;
}

function isValidStop(order, run, position) {
  const structurallyValid = Boolean(order)
    && ACTIVE_ALGO_STATUSES.has(order.status)
    && order.symbol === run.symbol
    && order.type === "STOP_MARKET"
    && order.side === run.plan?.exitSide;
  if (!structurallyValid) return false;
  if (order.closePosition === true) return true;
  const protectedQuantity = Number(order.quantity);
  const positionQuantity = Math.abs(Number(position?.quantity));
  const quantityTolerance = Number(run.plan?.rules?.stepSize ?? 0) / 2;
  return order.reduceOnly === true
    && Number.isFinite(protectedQuantity)
    && protectedQuantity > 0
    && Number.isFinite(positionQuantity)
    && protectedQuantity + quantityTolerance >= positionQuantity;
}

export function classifyExecutionAccountState(account, activeRuns = []) {
  const runs = activeRuns.filter((run) => run && !TERMINAL_STATUSES.has(run.status));
  const conflicts = [];
  const unknown = [];
  const missingStops = [];
  const symbolClaims = new Map();
  const ordinaryClaims = new Map();
  const algoClaims = new Map();

  for (const run of runs) {
    claim(symbolClaims, run.symbol, run, "SYMBOL", conflicts);
    if (hasEntrySubmissionEvidence(run)) claim(ordinaryClaims, run.plan?.clientIds?.entry, run, "CLIENT_ORDER_ID", conflicts);
    if (run.operatorCloseOrder?.orderId || String(run.status).startsWith("OPERATOR_CLOSE")) {
      claim(ordinaryClaims, run.plan?.clientIds?.operatorClose, run, "CLIENT_ORDER_ID", conflicts);
    }
    if (PROTECTION_MAY_EXIST_STATUSES.has(run.status) || Object.values(run.protection ?? {}).some((value) => value && typeof value === "object")) {
      for (const role of ["stop", "breakEvenStop", "takeProfit1", "takeProfit2"]) {
        claim(algoClaims, run.plan?.clientIds?.[role], run, "CLIENT_ALGO_ID", conflicts);
      }
    }
  }

  const positions = [];
  for (const position of account?.positions ?? []) {
    const run = symbolClaims.get(position.symbol);
    const direction = actualDirection(position);
    if (!run || !hasEntrySubmissionEvidence(run)) {
      unknown.push({ kind: "POSITION", symbol: position.symbol, quantity: position.quantity });
      continue;
    }
    if (direction && expectedDirection(run) !== direction) {
      conflicts.push({
        kind: "POSITION_DIRECTION",
        symbol: position.symbol,
        runId: run.id,
        expected: expectedDirection(run),
        actual: direction,
      });
      continue;
    }
    if (position.marginType && String(position.marginType).toUpperCase() !== "ISOLATED") {
      conflicts.push({
        kind: "POSITION_MARGIN_MODE",
        symbol: position.symbol,
        runId: run.id,
        expected: "ISOLATED",
        actual: String(position.marginType).toUpperCase(),
      });
      continue;
    }
    const expectedLeverage = Number(run.plan?.leverage);
    const actualLeverage = position.leverage === null || position.leverage === undefined || position.leverage === ""
      ? Number.NaN
      : Number(position.leverage);
    if (Number.isFinite(expectedLeverage) && Number.isFinite(actualLeverage) && expectedLeverage !== actualLeverage) {
      conflicts.push({
        kind: "POSITION_LEVERAGE",
        symbol: position.symbol,
        runId: run.id,
        expected: expectedLeverage,
        actual: actualLeverage,
      });
      continue;
    }
    const maximumQuantity = Number(run.entryOrder?.executedQuantity ?? run.plan?.quantity);
    const quantityTolerance = Number(run.plan?.rules?.stepSize ?? 0) / 2;
    if (Number.isFinite(maximumQuantity) && Math.abs(Number(position.quantity)) > maximumQuantity + quantityTolerance) {
      conflicts.push({
        kind: "POSITION_QUANTITY",
        symbol: position.symbol,
        runId: run.id,
        maximum: maximumQuantity,
        actual: Math.abs(Number(position.quantity)),
      });
      continue;
    }
    positions.push({ item: position, runId: run.id });
  }

  const ordinaryOrders = [];
  for (const order of account?.openOrders ?? []) {
    const run = ordinaryClaims.get(String(order.clientOrderId ?? ""));
    if (!run || order.symbol !== run.symbol) {
      unknown.push({ kind: "ORDER", symbol: order.symbol, clientOrderId: order.clientOrderId ?? null, orderId: order.orderId ?? null });
      continue;
    }
    ordinaryOrders.push({ item: order, runId: run.id });
  }

  const algoOrders = [];
  for (const order of account?.openAlgoOrders ?? []) {
    const run = algoClaims.get(String(order.clientAlgoId ?? ""));
    if (!run || order.symbol !== run.symbol) {
      unknown.push({ kind: "ALGO_ORDER", symbol: order.symbol, clientAlgoId: order.clientAlgoId ?? null, algoId: order.algoId ?? null });
      continue;
    }
    algoOrders.push({ item: order, runId: run.id });
  }

  for (const ownedPosition of positions) {
    const run = runs.find((item) => item.id === ownedPosition.runId);
    const stopIds = new Set([
      run?.plan?.clientIds?.stop,
      run?.plan?.clientIds?.breakEvenStop,
    ].filter(Boolean).map(String));
    const stop = (account?.openAlgoOrders ?? []).find((order) => stopIds.has(String(order.clientAlgoId)) && isValidStop(order, run, ownedPosition.item));
    if (!stop) missingStops.push({ runId: run.id, symbol: run.symbol });
  }

  return {
    safe: unknown.length === 0 && conflicts.length === 0 && missingStops.length === 0,
    owned: { positions, ordinaryOrders, algoOrders },
    unknown,
    conflicts,
    missingStops,
  };
}

export function assertAccountReadyForNewEntry(account, activeRuns, { candidateSymbol, candidateRunId = null } = {}) {
  if (account?.environment !== "TESTNET" || account?.authority !== "BINANCE_TESTNET") {
    throw new Error("账户事实源不是 Binance Testnet");
  }
  if (account.positionMode !== "ONE_WAY") throw new Error("测试网账户不是单向持仓");
  const uncertainSubmission = activeRuns.find((run) => run.id !== candidateRunId && run.status === "SUBMISSION_UNKNOWN");
  if (uncertainSubmission) throw new Error(`执行记录 ${uncertainSubmission.id} 的入场提交结果未知，禁止准备新订单`);
  const sameSymbol = activeRuns.find((run) => run.id !== candidateRunId
    && !TERMINAL_STATUSES.has(run.status)
    && run.symbol === candidateSymbol);
  if (sameSymbol) throw new Error(`标的 ${candidateSymbol} 已有未结束的测试网执行记录 ${sameSymbol.id}`);
  const classification = classifyExecutionAccountState(account, activeRuns);
  if (classification.conflicts.length) throw new Error("测试网账户存在相互冲突的执行归属");
  if (classification.unknown.length) throw new Error("测试网账户存在系统无法归属的仓位或订单");
  if (classification.missingStops.length) throw new Error("测试网账户存在没有活动止损的仓位");
  return classification;
}

export { ACTIVE_ALGO_STATUSES, ENTRY_MAY_EXIST_STATUSES, TERMINAL_STATUSES };
