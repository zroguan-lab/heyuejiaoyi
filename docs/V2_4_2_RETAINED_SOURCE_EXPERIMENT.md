# V2.4.2 RETAINED 来源过滤实验

## 目标

验证雷达最短观察期产生的 `RETAINED` 来源是否只应维持观察连续性，而不应单独构成交易 Edge。

V2.3 的 114 笔冻结基线中，`RETAINED` 来源 5 笔、胜率 0%、平均净收益 -0.980R、PF 0。V2.4.2 因此只修改这一条晋级规则。

## 唯一变更

- `opportunitySources = ["RETAINED"]`：继续保留在雷达深度池和拒绝审计中，但不得进入 Demo。
- `RETAINED` 与任何独立机会来源并存：按原 V2.4.1 规则继续评估。

以下内容全部冻结：

- Pre-Move 评分与阈值；
- LONG 二次确认与 SHORT 准入；
- 0.20R 普通成本组和 0.20R–0.35R 探索组；
- 结构止损、TP1 1.5R、TP2 2.5R、TP1 后保本；
- 保证金、杠杆和执行方式；
- 多仓与执行安全规则。

## 版本边界

- 信号模型：`PRE_MOVE_1H_15M_5M_V2_4_2_RETAINED_FILTER`
- Demo 策略：`PRE_MOVE_1H_15M_5M_V2_4_2_RETAINED_FILTER_DEMO_20261015`
- 晋级策略：`V2_4_2_RETAINED_FILTER_R1`
- V2.4.1 及更早记录保持原版本归属，已有仓位继续由执行恢复层管理。

## 验收

技术验收：

1. 仅 `RETAINED` 候选得到 `V2_4_2_RETAINED_ONLY_NOT_TRADEABLE`；
2. `RETAINED + VOLATILITY_COMPRESSION` 等组合不被本规则误杀；
3. Live 与 Historical Replay 使用同一策略合同；
4. 完整自动测试与语法检查通过；
5. 启动后创建新的 V2.4.2 绩效纪元，旧版本不混入。

研究验收：

- 独立累计 V2.4.2 OOS/Forward 已结束样本；
- 与 V2.4.1 冻结基线比较 PF、平均 Net R、最大回撤及被过滤样本反事实结果；
- 未达到至少 100 笔样本前，不宣布策略形成稳定正期望。

