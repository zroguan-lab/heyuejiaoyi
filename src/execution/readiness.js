import { classifyExecutionAccountState } from "./execution-account-ownership.js";

export function assessTestnetReadiness({ account, gateway, credentialsConfigured = false, permissionProbe = null, activeRuns = [] } = {}) {
  const multiPosition = gateway?.positionPolicy === "ALL_ELIGIBLE" || Number(gateway?.maxExchangePositions ?? 1) > 1;
  const onDemandPermissionCheck = gateway?.orderSubmissionEnabled === true
    && gateway?.permissionCheckMode === "ORDER_TEST_PER_SIGNAL"
    && credentialsConfigured;
  const ownership = multiPosition ? classifyExecutionAccountState(account, activeRuns) : null;
  const checks = [
    {
      code: "TESTNET_ONLY",
      passed: gateway?.environment === "TESTNET",
      message: "执行边界必须绑定 Binance Testnet",
    },
    {
      code: "CREDENTIALS_CONFIGURED",
      passed: Boolean(credentialsConfigured),
      message: "测试网 API 凭据必须已配置",
    },
    {
      code: "READ_ONLY_CONNECTED",
      passed: Boolean(account?.enabled && account?.connected),
      message: "测试网只读账户必须连接成功",
    },
    {
      code: "ACCOUNT_CAN_TRADE",
      passed: account?.account?.canTrade === true || permissionProbe?.valid === true || onDemandPermissionCheck,
      message: "测试网账户必须报告可交易，或在每笔信号提交前通过不进撮合的安全订单测试",
    },
    {
      code: "ONE_WAY_MODE",
      passed: account?.positionMode === "ONE_WAY",
      message: "账户必须切换为单向持仓模式",
    },
    ...(multiPosition ? [{
      code: "ACCOUNT_STATE_OWNED",
      passed: ownership.safe,
      message: "账户中的仓位与订单必须全部归属于系统，且每个仓位都有活动止损",
    }] : [
      {
        code: "NO_EXISTING_POSITIONS",
        passed: Array.isArray(account?.positions) && account.positions.length === 0,
        message: "账户必须没有既有测试网持仓",
      },
      {
        code: "NO_EXISTING_ORDERS",
        passed: Array.isArray(account?.openOrders) && account.openOrders.length === 0,
        message: "账户必须没有既有测试网挂单",
      },
      {
        code: "NO_EXISTING_ALGO_ORDERS",
        passed: Array.isArray(account?.openAlgoOrders) && account.openAlgoOrders.length === 0,
        message: "账户必须没有既有测试网条件挂单",
      },
    ]),
    {
      code: "ORDER_LOCK_ACTIVE",
      passed: gateway?.orderSubmissionEnabled === false,
      message: gateway?.orderSubmissionEnabled
        ? "策略测试网写入锁已解锁；仅允许已确认的单币执行计划"
        : "策略测试网写入锁处于关闭状态",
    },
  ];
  const preparationChecks = checks.filter((check) => check.code !== "ORDER_LOCK_ACTIVE");

  return {
    phase: gateway?.orderSubmissionEnabled
      ? "CANARY_ARMED"
      : account?.connected ? "READ_ONLY_VALIDATED" : "READ_ONLY_NOT_CONNECTED",
    canPrepareCanary: preparationChecks.every((check) => check.passed),
    orderSubmissionEnabled: gateway?.orderSubmissionEnabled === true,
    tradePermissionSource: account?.account?.canTrade === true
      ? "ACCOUNT_CAN_TRADE"
      : permissionProbe?.valid === true
        ? "ORDER_TEST_PROBE"
        : onDemandPermissionCheck ? "ORDER_TEST_PER_SIGNAL" : null,
    checks,
    blockedReasons: preparationChecks
      .filter((check) => !check.passed)
      .map(({ code, message }) => ({ code, message })),
    safetyLocks: checks
      .filter((check) => check.code === "ORDER_LOCK_ACTIVE")
      .map(({ code, passed, message }) => ({ code, passed, message })),
    ownership,
  };
}
