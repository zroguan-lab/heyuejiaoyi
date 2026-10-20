---
title: V2.4.3 交易逻辑知识文件
document_type: bot_knowledge_base
language: zh-CN
strategy_release: V2.4.3
signal_model: PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER
demo_strategy: PRE_MOVE_1H_15M_5M_V2_4_3_BOUNDARY_FILTER_DEMO_20261015
strategy_contract: V2_4_3_STRATEGY_CONTRACT_R1
promotion_policy: V2_4_3_BOUNDARY_FILTER_R1
market_radar: MARKET_RADAR_R3_PREMOVE
execution_environment: Binance Demo/Testnet only
updated_at: 2026-10-16
---

# V2.4.3 交易逻辑知识文件

## 1. 文件用途

本文用于让 Grok Bot 理解当前合约交易系统 V2.4.3 的真实运行逻辑，并能稳定回答以下问题：

- 系统如何发现交易标的；
- 系统如何判断 LONG 或 SHORT；
- 哪些信号会被拒绝；
- 评分、成本与 Demo 准入如何衔接；
- Binance Demo 如何入场、止损和止盈；
- 研究账本和真实 Demo 执行有什么区别；
- 当前版本正在验证什么，尚不能证明什么。

本文是系统说明，不是盈利承诺，也不授权 Grok Bot 修改代码、参数、订单或账户。

## 2. Bot 必须遵守的解释规则

1. 必须明确区分“研究账本”和“Binance Demo 实际执行”。
2. 不得把研究仓位的固定风险算法描述成当前 Demo 的实际仓位算法。
3. 不得把雷达入选描述成可以直接下单；雷达只负责缩小候选范围。
4. 不得把高评分描述成已验证的盈利因子；当前评分仍是未完成校准的经验模型。
5. 不得声称 V2.4.3 已经盈利或具备稳定 Edge，除非有足够的独立前向样本支持。
6. 必须把 V2.4.3 描述为 V2.4.2 的单变量实验：只新增 `BOUNDARY_PRESSURE-only` 过滤。
7. 回答具体订单问题时，应优先引用订单的市场来源、方向、评分、成本组、止损、TP1、TP2、MFE、MAE和实际费用。
8. 遇到代码、运行状态与本文冲突时，以当前运行代码、健康接口和交易所事实为准，并明确指出差异。

## 3. 一句话总览

V2.4.3 先用市场雷达寻找可能即将发生波动扩张的高流动性标的，再用 1 小时趋势决定方向、15 分钟结构判断蓄势位置、5 分钟量能与价格压力确认触发；排除只有保留来源或只有结构边界来源的候选，通过评分和成本门槛后，使用受滑点预算约束的 IOC 可成交限价单在 Binance Demo 自动执行。

## 4. 完整决策链

```text
Binance USDT 永续合约市场
  -> 流动性与点差过滤
  -> Top 100 发现池
  -> Market Radar R3
  -> 最多 30 个深度扫描标的
  -> 1H 趋势方向
  -> 15m 波动收缩与结构边界
  -> 5m 量能、净移动和方向压力
  -> PRE_BREAKOUT 候选
  -> V2.4.3 来源过滤
  -> LONG 附加确认
  -> 最终评分与 A/B 分层
  -> 成本准入
  -> 当前绩效纪元校验
  -> Binance Demo 入场
  -> 全仓止损 + TP1/TP2
  -> TP1 后剩余仓位移保本
  -> 费用、Funding、Net R、MFE、MAE与来源组合归因
```

## 5. 市场扫描与标的发现

### 5.1 扫描频率与规模

- 系统主循环每 30 秒检查一次。
- 市场雷达每 5 分钟刷新一次。
- 发现池默认取高流动性合约前 100 个。
- 雷达最多选择 30 个标的进入 1H/15m/5m 深度分析。
- 标的点差必须不高于 20 bps。
- 雷达数据必须来自已收盘的 15 分钟 K 线。

### 5.2 雷达候选来源

| 来源代码 | 中文含义 |
|---|---|
| `RANK_GAINER` | 1小时领涨 |
| `RANK_LOSER` | 1小时领跌 |
| `RANK_VELOCITY` | 涨跌幅排名快速上升 |
| `VOLUME_SHOCK` | 15分钟成交量异常 |
| `VOLATILITY_COMPRESSION` | 波动率收缩 |
| `BOUNDARY_PRESSURE` | 接近结构边界、可能蓄势 |
| `EARLY_ACCELERATION` | 量能开始抬升但价格尚未大幅扩张 |
| `CORE_MARKET` | BTC、ETH 等核心市场 |
| `RETAINED` | 为满足最短观察期而继续保留 |

### 5.3 雷达评分

雷达评分由横截面排名形成，满分 100：

| 组成 | 最高分 |
|---|---:|
| 波动收缩 | 25 |
| 活跃度/量能建设 | 20 |
| 结构边界接近程度 | 20 |
| 排名加速度 | 15 |
| 相对市场强弱 | 10 |
| 早期价格移动 | 5 |
| 可交易性/点差 | 5 |

雷达分数达到 68 且不存在高扩张风险时，可以标为 `CORE`；其他已入选候选标为 `EXPLORATION`。

雷达只负责发现机会，不能单独触发订单。

## 6. V2.4.3 来源过滤

### 6.1 RETAINED-only

`RETAINED` 只表示候选仍在最短观察期内，不是独立交易证据。

如果移除 `RETAINED` 后没有任何来源，候选被拒绝：

```text
V2_4_2_RETAINED_ONLY_NOT_TRADEABLE
```

### 6.2 BOUNDARY_PRESSURE-only

`BOUNDARY_PRESSURE` 只说明价格接近结构边界，不能单独证明会突破。

以下组合被拒绝：

```text
BOUNDARY_PRESSURE
RETAINED + BOUNDARY_PRESSURE
```

拒绝原因：

```text
V2_4_3_BOUNDARY_ONLY_NOT_TRADEABLE
```

以下组合仍可以继续评估：

```text
BOUNDARY_PRESSURE + VOLATILITY_COMPRESSION
BOUNDARY_PRESSURE + EARLY_ACCELERATION
BOUNDARY_PRESSURE + RANK_VELOCITY
BOUNDARY_PRESSURE + VOLUME_SHOCK
BOUNDARY_PRESSURE + RANK_GAINER/RANK_LOSER
```

原则：候选至少还要具备一个除 `RETAINED` 和 `BOUNDARY_PRESSURE` 之外的独立来源。

### 6.3 反事实记录

如果候选满足评分要求，且唯一硬拒绝原因是 `BOUNDARY_PRESSURE-only`：

- 仍在独立反事实账本模拟生命周期；
- 组合名称为 `V2_4_3_BOUNDARY_COUNTERFACTUAL`；
- `selected = false`；
- `orderSubmissionAllowed = false`；
- 不占用 Demo 持仓、保证金或正式绩效。

这使系统可以比较“过滤后正式结果”和“如果没有过滤会发生什么”。

## 7. 1小时趋势方向

系统使用 1H EMA20、EMA50、EMA20斜率、收盘位置和已确认结构共同决定方向。

### 7.1 LONG

必须同时满足：

- EMA20 > EMA50；
- EMA20 最近斜率向上；
- 最新收盘价高于 EMA20；
- 最近确认低点没有继续降低。

### 7.2 SHORT

必须同时满足：

- EMA20 < EMA50；
- EMA20 最近斜率向下；
- 最新收盘价低于 EMA20；
- 最近确认高点没有继续升高。

如果条件不能形成一致方向，则趋势为 `NEUTRAL`，不生成候选。

## 8. PRE_BREAKOUT 爆发前信号

系统当前执行的主要 Setup 是 `PRE_BREAKOUT`，目标是在突破发生前识别蓄势，而不是突破后追价。

### 8.1 15分钟条件

- 使用最近8根已收盘15分钟K线形成结构区间；
- 价格尚未正式突破方向侧结构边界；
- 距方向侧边界必须在 0 至 1.2 ATR 之间；
- 波动收缩比不得高于 1.25；
- 价格在结构中的方向位置不得低于 0.45；
- 爆发评分不得低于 40；
- 方向评分不得低于 48。

### 8.2 爆发评分

爆发评分满分 100：

```text
35% 波动收缩
+ 25% 量能加速
+ 25% 边界接近程度
+ 15% 区间紧密程度
```

### 8.3 方向评分

方向评分满分 100：

```text
30% 1H趋势强度
+ 20% 价格在15m区间中的方向位置
+ 20% 5m方向压力
+ 20% 相对全市场强弱
+ 10% 雷达方向一致性
```

### 8.4 初始候选分数

```text
CandidateScore = 0.55 * ExplosionScore + 0.45 * DirectionScore
```

### 8.5 5分钟方向压力

5分钟确认观察最近4根K线，主要记录：

- 按趋势方向计算的净移动 ATR；
- 连续同方向收盘比例；
- K线实体方向压力；
- 最新实体占 ATR；
- 最新收盘变化占 ATR；
- 最新收盘在本根K线区间中的位置。

## 9. LONG 专用二次确认

为了提高做多成功率，LONG 必须额外满足：

- 市场雷达偏向必须为 `LONG`；
- 市场宽度和 Market Regime 不能明确为 `SHORT`；
- 15分钟量比不低于 1.0；
- 5分钟量能加速不低于 1.0；
- 波动收缩比不高于 1.0；
- 5分钟方向压力不低于 0.55；
- 最新方向实体不低于 0.05 ATR；
- 最新收盘必须继续向上，不能只是持平；
- 最新收盘位置不低于本根K线区间的 0.5。

SHORT 当前不使用完全对称的额外确认。这是当前版本的明确非对称设计，不得擅自解释为遗漏。

## 10. Market Regime

Market Regime 综合：

- BTC 4小时趋势；
- BTC 1小时趋势；
- 当前扫描标的的多空宽度；
- BTC 1小时 ATR 波动率分位。

只有 BTC 4H 与 1H 同向时，Regime 才明确为 LONG 或 SHORT；否则为 `MIXED`。

Regime 对最终评分的贡献：

- 同方向且市场宽度一致：10分；
- 同方向但宽度未确认：约8分；
- MIXED：4分；
- 明确反向：0分。

普通 Regime 冲突主要影响评分和质量观察；LONG 遇到明确 SHORT 环境时会触发额外硬拒绝。

## 11. 最终 V2.4.3 评分

最终评分满分 100：

| 项目 | 最高分 |
|---|---:|
| 爆发质量 | 35 |
| 方向质量 | 25 |
| 市场环境 | 10 |
| 预估交易成本 | 10 |
| 流动性 | 10 |
| 市场雷达 | 10 |

### 11.1 分层

- `CORE`：总分 >= 70，同时雷达必须为 CORE、扩张风险不能为 HIGH，并且雷达/市场方向不能存在关键冲突。
- `EXPLORATION`：总分 >= 55，且没有硬拒绝原因。
- `<55`：拒绝。

### 11.2 常见硬拒绝

- Market Regime 不可用；
- 雷达缺失、版本不一致或标的未被雷达选中；
- RETAINED-only；
- BOUNDARY_PRESSURE-only；
- 爆发或方向数据缺失；
- 已经突破结构边界；
- Funding 数据不可用；
- 成本数据不可用或极端；
- 固定风险研究计划无效；
- LONG 二次确认不通过。

评分模型的 `edgeCalibration` 当前为 `UNCALIBRATED`，`expectedNetR` 当前为空。高分代表证据一致性较高，不等于已经证明期望收益为正。

## 12. 成本估算与 Demo 准入

系统按预计持仓12小时估算：

```text
总成本率 = 往返手续费 + 预估滑点 + 点差 + 预计Funding成本
TotalCostR = 总成本率 / 入场到止损的风险比例
```

成本分组：

- `TotalCostR <= 0.20R`：`NORMAL_COST` 普通成本组；
- `0.20R < TotalCostR <= 0.35R`：`HIGH_COST_EXPLORATION` 高成本探索组；
- `TotalCostR > 0.35R`：禁止进入 Binance Demo；
- Funding 成本超过 `0.20R`：硬拒绝；
- Funding 数据缺失：硬拒绝。

必须同时通过策略评估和 Demo Promotion 成本准入，才能提交订单。

## 13. 自动执行前置条件

信号进入 Binance Demo 前必须满足：

- 当前唯一策略源是 `V2_PRODUCTION`；
- 信号模型严格匹配 V2.4.3；
- 信号属于当前 V2.4.3 绩效纪元；
- 信号已经被研究层选中；
- 状态为 `ENTRY_PENDING`；
- 信号剩余有效期至少30秒；
- 最终评分不低于55；
- 市场雷达版本匹配且标的仍为已选；
- 交易原因完整；
- 同一信号没有已有执行记录；
- 同一币种没有其他活动执行；
- 不存在 `SUBMISSION_UNKNOWN`、`PROTECTION_INCOMPLETE` 或 `ERROR_UNPROTECTED`；
- Binance Demo 账户、权限、持仓模式和订单状态通过对账。

人工金丝雀、V1历史、旧纪元、已结束和已过期信号不能被自动执行。

## 14. 入场订单

PRE_BREAKOUT 使用受滑点预算约束的可成交限价单：

- 模式：`MARKETABLE_LIMIT_IOC`；
- 订单类型：限价单；
- 有效方式：IOC；
- 参考价格：Binance Demo 实时买一/卖一；
- 最大允许不利偏差：10 bps；
- 信号有效期：10分钟，约两根5分钟K线。

LONG 使用卖一价判断能否立即成交，SHORT 使用买一价。若实时盘口已经超出计划价的10 bps预算，则拒绝本次入场：

```text
ENTRY_PRICE_OUTSIDE_SLIPPAGE_BUDGET
```

IOC 未立即成交的剩余数量自动取消。网络超时后按客户端订单号查询，不允许盲目重复发单。

## 15. 仓位与保证金

### 15.1 Binance Demo 实际执行

- 单笔目标保证金：10 USDT；
- 杠杆：10倍；
- 目标名义仓位：约100 USDT；
- 保证金模式：逐仓；
- 持仓模式：单向；
- 同一币种最多一个活动执行；
- 不设置固定总持仓笔数；
- 当前不执行本地总风险或相关性上限；
- 合约精度造成的名义金额偏差必须在允许范围内，默认不超过目标值约5%。

### 15.2 研究账本理论仓位

研究账本另外计算：

```text
目标风险金额 = 当前研究权益 * 0.5%
理论名义仓位 = 目标风险金额 / 止损比例
理论保证金 = 理论名义仓位 / 10
```

该仓位只用于研究比较和历史回测。当前 Binance Demo 实际执行仍使用固定10U保证金，不能把两者混为一谈。

## 16. 止损与止盈

### 16.1 初始止损

对 LONG：

```text
Stop = min(Entry - 1.5 * ATR5m, Recent8BarLow - 0.1 * ATR5m)
```

对 SHORT：

```text
Stop = max(Entry + 1.5 * ATR5m, Recent8BarHigh + 0.1 * ATR5m)
```

止损距离限制：

- 小于0.15%：拒绝，避免噪声止损；
- 大于4%：拒绝，避免风险距离过宽。

### 16.2 止盈

定义：

```text
1R = abs(Entry - Stop)
TP1 = Entry +/- 1.5R
TP2 = Entry +/- 2.5R
```

LONG 使用加号，SHORT 使用减号。

### 16.3 分批退出

- 正常情况下，TP1 平约50%，TP2关闭剩余仓位；
- TP1 成交后，剩余全部仓位的止损移到计划入场价 `run.plan.prices.entry`；这不是实际成交均价，也不保证扣除费用后的净保本。本轮统计修复不改变这个交易规则；
- 新保本止损确认生效后，才撤销原始止损，避免无保护窗口；
- 如果最小数量/最小名义价值不允许安全拆分，则降级为 `SINGLE_TARGET`，只保留TP2；
- 同一根最小路径无法判断止损和止盈先后时，研究回放按止损优先。

## 17. 成交保护与安全冻结

实际成交后必须先建立全仓止损，再建立止盈单。

### 17.1 止损失败

如果止损无法确认：

- 将仓位标记为未保护；
- 自动尝试 reduce-only 平仓；
- 触发紧急停止；
- 禁止所有新入场；
- 该异常执行不进入正常策略绩效。

### 17.2 止盈不完整

止损已存在但止盈未完整时：

- 状态为 `PROTECTION_INCOMPLETE`；
- 保留已有止损；
- 自动执行协调器暂停新的自动入场；不能将这一点直接外推为所有底层手动执行入口具有相同的全局防线；
- 继续重试、恢复和审计。

### 17.3 自动执行协调器暂停新入场的关键状态

```text
SUBMISSION_UNKNOWN
PROTECTION_INCOMPLETE
ERROR_UNPROTECTED
```

紧急停止只阻止新入场和系统自己的等待入场单，不会粗暴撤销现有仓位保护。

## 18. 交易记录与归因

每笔正式订单必须记录：

- 时间、标的、方向和 Setup；
- 一句话开仓原因；
- Signal Model、Demo Strategy和策略纪元；
- 雷达来源组合；
- 雷达排名、排名速度和相对BTC强弱；
- 爆发评分、方向评分和最终评分；
- CORE/EXPLORATION层级；
- 成本组与预估Cost R；
- 计划价、提交价、成交价与实际滑点；
- 止损、TP1、TP2；
- 实际保证金、杠杆、数量和名义价值；
- 手续费、Funding、毛盈亏和净盈亏；
- Net R、MFE、MAE；
- 平仓原因和执行异常。

统计口径：初始实际风险金额 = abs(实际成交均价 - 初始计划止损) × 实际成交数量；Net R = 已结算净盈亏 / 初始实际风险金额。成交均价优先使用入场订单 ID 匹配的完整成交明细；订单聚合字段只有在数量、成交额/均价证据一致时才可作为事实。委托价和计划价不是实际成交价。证据缺失或冲突时指标保持未知，不能回退计划风险伪造净R。

MFE/MAE还需要可信的价格路径。轮询采样不等于完整逐笔行情；只能报告已观测范围。旧记录如果只有受污染的R或资金极值、无法恢复可信价格极值，必须标记无法确认，不填0，也不根据旧R反造价格。报表应展示有效/缺失样本数和覆盖率。统计投影纠正不覆写原始交易流水，不代表策略盈利能力改善。

## 19. V2.4.3 相对 V2.4.2 的变化

唯一策略行为变化：

```text
移除 RETAINED 后，如果候选只剩 BOUNDARY_PRESSURE，禁止进入 Demo。
```

以下内容保持不变：

- Pre-Move评分公式；
- CORE/EXPLORATION阈值；
- LONG二次确认与SHORT逻辑；
- 成本阈值；
- 入场执行方式；
- 止损、TP1、TP2和保本逻辑；
- Demo保证金、杠杆和仓位算法；
- Universe与Market Radar参数。

因此 V2.4.3 必须被视为来源过滤实验，不能把后续结果归因于其他未变化模块。

## 20. 当前验证目标

当前需要等待 V2.4.3 积累独立前向样本，并与反事实账本比较：

- 成交率与未成交取消率；
- 胜率；
- 平均净R；
- Profit Factor；
- 最大回撤；
- LONG与SHORT差异；
- CORE与EXPLORATION差异；
- 普通成本组与高成本探索组差异；
- 不同机会来源组合的期望值；
- MFE/MAE是否显示入场太早、止损太紧或止盈过早。

建议解释样本阶段：

- 少于30笔：只能检查执行和明显异常；
- 30至49笔：可以形成初步假设；
- 50至99笔：可以进行第一轮分组归因，但结论仍需谨慎；
- 100笔及以上：才适合评估版本级胜率、PF、净期望和回撤是否值得继续验证。

## 21. 决策伪代码

```text
for each radar_refresh:
    universe = top_liquid_usdt_perpetuals(limit=100, spread<=20bps)
    radar = rank_by_returns_volume_compression_boundary_velocity_relative_strength(universe)
    deep_scan = radar.select(limit=30)

for each symbol in deep_scan:
    direction = classify_1h_trend(EMA20, EMA50, slope, close_location, pivots)
    if direction == NEUTRAL:
        reject

    premove = analyze_15m_structure_and_5m_pressure(symbol, direction)
    if already_broken:
        reject
    if boundary_distance_atr not in [0, 1.2]:
        reject
    if compression_ratio > 1.25:
        reject
    if directional_range_position < 0.45:
        reject
    if explosion_score < 40 or direction_score < 48:
        reject

    sources = radar.opportunity_sources
    if sources == RETAINED_ONLY:
        reject
    if sources_without_RETAINED == BOUNDARY_PRESSURE_ONLY:
        save_counterfactual_trade_without_order_submission
        reject_demo

    if direction == LONG and not long_confirmation_passed:
        reject

    total_score = score(explosion, direction, regime, cost, liquidity, radar)
    if total_score < 55:
        reject
    tier = CORE if total_score >= 70 and radar_core_eligible else EXPLORATION

    estimated_cost_r = estimate_fee_slippage_spread_funding()
    if estimated_cost_r > 0.35:
        reject_demo
    cohort = NORMAL_COST if estimated_cost_r <= 0.20 else HIGH_COST_EXPLORATION

    if not current_epoch or not account_safe or same_symbol_active:
        do_not_submit

    if live_book_price outside 10bps adverse_budget:
        skip_entry
    else:
        submit_marketable_limit_ioc_to_binance_demo
        if filled:
            confirm_full_stop_first
            place_tp2_close_remaining
            place_tp1_for_half_if_contract_minimums_allow
            after_tp1_confirm_breakeven_stop_then_cancel_original_stop
```

## 22. Grok Bot 推荐回答模板

当用户问“为什么这笔单会/不会执行”时，按以下顺序回答：

```text
结论：执行 / 拒绝 / 等待 / 因安全状态暂停。

1. 标的来源：哪些雷达来源使它进入候选池。
2. 方向证据：1H趋势、15m位置、5m压力。
3. 来源过滤：是否为RETAINED-only或BOUNDARY_PRESSURE-only。
4. 分数与层级：总分、CORE或EXPLORATION。
5. 成本：Cost R、Funding、普通或高成本探索组。
6. 执行：信号是否过期、盘口是否超10bps、同币是否已有仓位。
7. 风控：入场、止损、TP1、TP2和预计最大止损金额。
8. 数据限制：说明该判断是规则解释，还是已由实际订单/日志证实。
```

## 23. 禁止误解

- “进入涨跌幅榜”不等于“立即顺榜交易”。
- “接近边界”不等于“必然突破”。
- “55分以上”不等于“保证盈利”。
- “研究固定风险0.5%”不等于“Demo实际按0.5%风险下单”。
- “没有开单”不一定是系统故障，也可能是没有合格信号、成本超标、盘口超预算或安全校验未通过。
- “没有固定持仓笔数”不等于无限风险；余额、同币唯一、账户状态、保护单和交易所规则仍会限制执行。
- Demo 测试结果不能直接外推到真实资金账户。

## 24. 代码事实源

如需重新核验，优先检查：

- `src/domain/market-radar.js`
- `src/domain/market-structure.js`
- `src/domain/pre-move-strategy.js`
- `src/domain/shadow-v2.js`
- `src/domain/risk.js`
- `src/execution/execution-strategy-source.js`
- `src/execution/entry-order-policy.js`
- `src/execution/canary-plan.js`
- `src/execution/testnet-canary-executor.js`
- `src/application/strategy-execution-coordinator.js`
- `src/config.js`

本文不得替代运行时健康接口、Binance Demo 账户事实和最新策略快照。
