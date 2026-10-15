export class ExecutionDisabledError extends Error {
  constructor(action) {
    super(`测试网执行尚未启用，拒绝操作: ${action}`);
    this.name = "ExecutionDisabledError";
    this.code = "EXECUTION_DISABLED";
  }
}

export class TestnetExecutionGateway {
  constructor({
    environment,
    orderSubmissionEnabled = false,
    executor = null,
    allowedSymbols = ["BTCUSDT"],
    strategySource = null,
    positionPolicy = "ALL_ELIGIBLE",
  } = {}) {
    if (environment !== "TESTNET") throw new Error("执行网关只能绑定 Binance TESTNET 环境");
    if (orderSubmissionEnabled && !executor) throw new Error("启用测试网订单提交时必须提供执行器");
    this.environment = environment;
    this.orderSubmissionEnabled = Boolean(orderSubmissionEnabled);
    this.executor = executor;
    this.allowedSymbols = [...new Set(allowedSymbols)];
    this.strategySource = strategySource;
    this.positionPolicy = positionPolicy;
  }

  snapshot() {
    return {
      environment: this.environment,
      mode: this.orderSubmissionEnabled ? "CANARY_ARMED" : "CANARY_LOCKED",
      orderSubmissionEnabled: this.orderSubmissionEnabled,
      cancelEnabled: this.orderSubmissionEnabled,
      emergencyStopAvailable: Boolean(this.executor),
      allowedSymbols: this.allowedSymbols,
      strategySource: this.strategySource,
      positionPolicy: this.positionPolicy,
      permissionCheckMode: "ORDER_TEST_PER_SIGNAL",
    };
  }

  allowSymbols(symbols = []) {
    if (!Array.isArray(symbols)) throw new TypeError("动态执行白名单必须是数组");
    const merged = new Set(this.allowedSymbols);
    for (const symbol of symbols) merged.add(symbol);
    this.allowedSymbols = [...merged];
    return this.allowedSymbols;
  }

  async submitOrder({ runId, confirmationCode } = {}) {
    if (!this.orderSubmissionEnabled || !this.executor) throw new ExecutionDisabledError("submitOrder");
    return await this.executor.execute(runId, confirmationCode);
  }

  async emergencyStop(reason = "MANUAL") {
    if (!this.executor) throw new ExecutionDisabledError("emergencyStop");
    return await this.executor.engageEmergencyStop(reason);
  }

  async cancelOrder() { throw new ExecutionDisabledError("cancelOrder：仅允许执行器按已审计订单撤单"); }
  async cancelAllOrders() { throw new ExecutionDisabledError("cancelAllOrders：禁止账户级全撤"); }
}
