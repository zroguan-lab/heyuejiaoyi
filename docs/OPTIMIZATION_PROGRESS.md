# 策略优化进度

## P0 MFE/MAE

status: `COMPLETE`

behavior_changed: `false`。只增加成交后的研究观测与归因，不改变筛选、下单、止盈、止损、BE、成本或仓位逻辑。

tests: 多单、空单、TP1 后继续统计、STOP_FIRST、Replay/Trade Lifecycle 一致性、Demo 执行闭环与实际成交风险分母。

result: 模拟交易、Historical Replay 与可归因 Binance Demo 交易统一输出 `mfeR`、`maeR`、极值价格、各里程碑耗时、止损前/TP1 前路径、持仓分钟和 5 分钟柱数。MAE 统一为正数风险幅度；初始风险 R 以入场成交价到初始止损的距离定义。

## P1 V2.4.3 Boundary Filter

status: `COMPLETE`

behavior_changed: `true`，且只有一个策略变量：去除 `RETAINED` 后仅剩 `BOUNDARY_PRESSURE` 的候选不再进入 Demo 执行。

baseline: V2.4.2 保持冻结；V2.3 的 114 笔正式基线不覆盖、不重算。

forward_sample: 新版本样本从独立 V2.4.3 performance epoch 统计；代码在安全重启后自动创建并归档上一纪元。

counterfactual: 被本规则单独过滤且达到研究评分门槛的候选进入 `V2_4_3_BOUNDARY_COUNTERFACTUAL`，不占主组合资源，不得下单。

## P2 Source Attribution

status: `COMPLETE`

behavior_changed: `false`。只增加研究报表和 Dashboard 折叠区。

tests: 完整、排序后的来源组合；保留 `RETAINED`；10 笔正式观察门槛；小样本标记；PF、平均 Net R、MFE/MAE、成本与持仓时间归因。

result: 每个完整 source combination 输出 `trades`、`winRate`、`avgNetR`、`profitFactor`、`maxDrawdownContributionR`、`avgMfeR`、`avgMaeR`、`avgCostR`、`avgHoldingMinutes`。少于 10 笔固定标记 `LOW_SAMPLE`，不能自动生成交易规则。

## 本轮验收

- version: `V2.4.3`
- strategyVersion: `PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER`
- full_test: `253/253 PASS`
- syntax_check: `PASS`
- live_replay_contract: Live 与 Historical Replay 均调用 `v2-4-strategy-engine.js` 的统一 V2.4.3 合同
- production_domain: 保持禁用
- real_funds: 未启用
- score_exit_sizing: 全部冻结
- rollback: `b413f33`（V2.4.2 RETAINED 来源过滤基线）

本轮到 P2 为止；P3 Feature Attribution 未开始。
