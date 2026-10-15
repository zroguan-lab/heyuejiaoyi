# V2.3 历史雷达重建（RESEARCH-M3）

状态：M3重建引擎已完成（2026-10-04）；全市场数据填充尚未完成。

## 唯一策略来源

历史层不复制涨跌榜、Pre-Move或评分条件。它只把历史事实转换成实时雷达需要的输入：

```text
历史1m原始事实
  -> 只聚合完整且已收盘的5m/15m/1h/4h K线
  -> 决策时点前24h成交额与波动统计
  -> 当时可交易合约筛选
  -> buildMarketRadarSnapshot（与实时相同）
  -> rankVelocity通过前一历史快照计算
  -> runV23StrategyAdapter(HISTORICAL_REPLAY)
```

权威实现位于 `src/research/historical-market-replay.js`。雷达条件仍由 `src/domain/market-radar.js` 拥有，信号与评分仍由 `src/domain/v2-3-strategy-engine.js` 拥有。

## 防未来数据规则

- 聚合K线的收盘时间不得晚于决策时间；
- 缺少任一分钟的周期K线不会被生成；
- Funding只读取决策时间以前已经结算的费率；
- 严格模式只接受决策时间以前采集的合约元数据快照；
- 排名速度只比较当前快照与上一历史快照；
- 统一V2.3历史适配器仍会二次拒绝未来K线和未来雷达时间。

## 历史数据局限

当前Binance目录尚未保存逐时点买一卖一盘口，也没有过去每周的合约快照。因此引擎提供两种明确模式：

1. `POINT_IN_TIME_STRICT`：缺少当时合约快照就失败；只有每个发现池标的都有新鲜历史点差、合约快照未过期，并且独立的数据同步清单声明已完整覆盖当时市场、目录中的合格标的达到配置的Top100深度时，结果才可能 `promotionEligible=true`。单纯凑够100个任意币种不能冒充Top100覆盖。
2. `CURRENT_SNAPSHOT_RESEARCH_ONLY`：允许用当前合约清单研究过去数据，但明确标记幸存者偏差；缺少盘口时使用配置允许的最大点差作为保守代理，结果永远不能晋级。

这两种模式不会混淆。研究结果可以用于发现代码错误和提出假设，不能用于宣称策略已通过历史验证。

## 使用

当前目录的研究级单时点重放：

```powershell
npm run replay:v2.3 -- --research-only-current-metadata
```

连续重建最近12个雷达刷新点，以验证前后快照和排名速度：

```powershell
npm run replay:v2.3 -- --research-only-current-metadata --points=12
```

不加研究标志时使用严格模式；如果合约快照晚于决策时间，命令会以 `HISTORICAL_POINT_IN_TIME_CONTRACT_SNAPSHOT_UNAVAILABLE` 失败，而不是静默偷看未来。

## M3验收标准

1. 不完整周期K线不会进入雷达或策略；
2. 严格模式拒绝未来合约快照；
3. 雷达生成时间、Mover数据时间均不晚于决策时间；
4. 连续历史快照保留前一快照ID并产生排名速度；
5. 所有策略决策均来自 `HISTORICAL_REPLAY` 统一适配器；
6. 幸存者偏差、过期元数据、点差代理或市场覆盖不足任一存在时，`promotionEligible=false`。

## 下一阶段

M4核心已经把逐时点决策扩展为交易与组合回放：限价成交、未成交取消、滑点、手续费、Funding、止损、TP1/TP2、保本移动、同时持仓和权益曲线。下一阶段继续完成180天Top100数据填充、逐时点点差/盘口代理、分层统计、走步验证与封存样本；在覆盖与审计达标前不能打开晋级闸门。
