# V2.4.3 BOUNDARY_PRESSURE 来源过滤实验

## 实验目标

V2.4.3 是相对 V2.4.2 的单变量实验。唯一策略行为变化是：去除 `RETAINED` 后，如果候选只剩 `BOUNDARY_PRESSURE`，则不得进入 Binance Demo 执行。

V2.3 冻结基线中，`BOUNDARY_PRESSURE` 只有 8 笔，胜率 12.5%、平均净收益 -0.653R、PF 0.235。该样本只能形成实验假设，不能证明整个来源无效，因此本版本不会删除雷达来源或历史记录。

## 精确定义

- `RETAINED`：仅表示雷达保留，不是独立交易来源。
- `BOUNDARY_PRESSURE`：结构边界蓄势来源；单独存在时不能获得交易资格。
- 真实独立来源：除 `RETAINED`、`BOUNDARY_PRESSURE` 外的来源，例如 `VOLATILITY_COMPRESSION`、`EARLY_ACCELERATION`、`RANK_GAINER`、`RANK_VELOCITY`、`RANK_LOSER`、`VOLUME_SHOCK`。

以下组合会被拒绝进入 Demo：

- `BOUNDARY_PRESSURE`
- `RETAINED + BOUNDARY_PRESSURE`

以下组合仍按 V2.4.2 原逻辑评估：

- `BOUNDARY_PRESSURE + VOLATILITY_COMPRESSION`
- `BOUNDARY_PRESSURE + RANK_VELOCITY`
- 任意包含至少一个真实独立来源的组合

拒绝原因固定为 `V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE`。

## 反事实账本

满足评分门槛、且唯一硬拒绝原因是本过滤规则的候选，会继续生成独立反事实交易：

- 组合：`V2_4_3_BOUNDARY_COUNTERFACTUAL`
- `selected = false`
- `orderSubmissionAllowed = false`
- 不占活动持仓、保证金或主组合权益
- 不进入 Demo 自动执行列表

## 冻结项

本实验不改变：

- Pre-Move Score 公式与阈值
- LONG 确认和 SHORT 逻辑
- 成本阈值
- 止损、TP1、TP2、BE 逻辑
- 保证金、杠杆和仓位算法
- Universe 与 Radar 参数
- 生产域名与真实资金安全边界

## 版本与基线

- Signal：`PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER`
- Demo：`PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER_DEMO_20261015`
- Promotion：`V2_4_3_BOUNDARY_FILTER_R1`
- Historical Replay：继续调用与 Live 相同的 V2.4 Strategy Core
- V2.3、V2.4.1、V2.4.2 数据和纪元保持原样，不覆盖、不重写

## 解释限制

该版本用于验证“禁止 BOUNDARY_PRESSURE-only 是否改善样本外表现”。在反事实与正式样本尚不足前，不得据此认定 `BOUNDARY_PRESSURE` 无效，也不得继续修改评分、出场或仓位规则。
