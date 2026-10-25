// Pure facts shared by execution, account ownership and readiness. No I/O.
export const ACTIVE_ALGO_STATUSES = new Set(["NEW", "PENDING", "TRIGGERING"]);
const NEW_ENTRY_SAFETY_HOLD_STATUSES = new Set([
  "SUBMISSION_UNKNOWN", "ENTRY_FACT_PENDING", "ENTRY_FACT_CONFLICT",
  "PROTECTION_INCOMPLETE", "ERROR_UNPROTECTED", "OPERATOR_CLOSE_UNKNOWN",
]);
export const blocksNewExecutionEntry = run => NEW_ENTRY_SAFETY_HOLD_STATUSES.has(run?.status);
const number = value => value === null || value === undefined || String(value).trim() === "" || typeof value === "boolean"
  || !["number", "string"].includes(typeof value)
  || !Number.isFinite(Number(value)) ? null : Number(value);

export function hasManagedTp1Lifecycle(run) {
  return run.status === "TP1_FILLED" || ["BREAKEVEN_PENDING", "BREAKEVEN_ACTIVE"].includes(run.protection?.phase)
    || Boolean(run.protection?.breakEvenStop) || run.protection?.managedRecovery?.postTp1 === true;
}

export function protectionOrderKnown(order, run, role) {
  const ids = [run.plan?.clientIds?.[role], ...(run.protection?.tpRecovery?.[role]?.ids ?? [])].filter(Boolean).map(String);
  const type = ["stop", "breakEvenStop"].includes(role) ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
  return Boolean(order) && ids.includes(String(order.clientAlgoId ?? "")) && order.symbol === run.symbol
    && order.type === type && order.side === run.plan?.exitSide
    && (!order.positionSide || order.positionSide === "BOTH");
}

export function effectivePositionStop(order, run, position) {
  const role = String(order?.clientAlgoId ?? "") === String(run.plan?.clientIds?.breakEvenStop ?? "") ? "breakEvenStop" : "stop";
  if (!protectionOrderKnown(order, run, role) || !ACTIVE_ALGO_STATUSES.has(order.status)) return false;
  const signed = number(position?.quantity ?? position?.positionAmt), remaining = signed === null ? null : Math.abs(signed);
  if (!(remaining > 0) || (position?.symbol && position.symbol !== run.symbol)
    || (position?.positionSide && position.positionSide !== "BOTH")
    || (signed > 0 ? "LONG" : "SHORT") !== run.plan?.direction) return false;
  if (order.closePosition === true) return true;
  const quantity = number(order.quantity), tolerance = Math.max(0, number(run.plan?.rules?.stepSize) ?? 0) / 2;
  return order.reduceOnly === true && quantity > 0 && quantity + tolerance >= remaining;
}

export function accountProtectionFactsKnown(account) {
  return account?.environment === "TESTNET" && account.authority === "BINANCE_TESTNET" && account.positionMode === "ONE_WAY"
    && Array.isArray(account.positions) && Array.isArray(account.openOrders) && Array.isArray(account.openAlgoOrders)
    && account.positions.every(p => typeof p?.symbol === "string" && p.symbol.length > 0
      && p.positionSide === "BOTH" && number(p.quantity ?? p.positionAmt) !== null)
    && [...account.openOrders, ...account.openAlgoOrders].every(o => o && typeof o.symbol === "string" && o.symbol.length > 0)
    && new Set(account.positions.map(p => p.symbol)).size === account.positions.length;
}

export function isMultiPositionPolicy(gateway) {
  return ["ALL_ELIGIBLE", "V2_4_3_PREMOVE_BOUNDARY_FILTER_ALL_ELIGIBLE"].includes(gateway?.positionPolicy)
    || Number(gateway?.maxExchangePositions ?? 1) > 1;
}

export function positionPolicyKnown(gateway) {
  return gateway?.positionPolicy == null || ["ALL_ELIGIBLE", "V2_4_3_PREMOVE_BOUNDARY_FILTER_ALL_ELIGIBLE"].includes(gateway.positionPolicy);
}
