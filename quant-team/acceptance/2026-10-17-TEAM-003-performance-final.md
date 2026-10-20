TEAM-003｜绩效独立复验｜2026-10-17 12:29:47（北京时间）

**PASS：当前本地成交风险、NetR、资金保留及覆盖率核对通过。历史路径恢复仍为UNKNOWN。**

使用只读SQLite事务，独立按原始fills计算成交均价、`风险=|Σ成交额−初始止损×Σ数量|`、`NetR=净PnL/风险`，再与当前投影及研究报表比较，未运行总控验收脚本。

- 全部434条；当前纪元 `V2.4.3-20261015203537` 共7条，历史427条隔离。
- 当前6条结算完成，6/6独立公式与投影一致；BCH取消记录风险、NetR、净PnL均为null。
- 净PnL合计 **−8.73467273 USDT**；平均NetR **−1.116642453009**，与报表一致。
- 风险核对：原PLAY **0.52785**、COLLECT **0.52106**、新增PLAY **0.53919**。
- 434条资金字段散列保持：`169739d425f076e33f28fd5a61cfdafc194dd3672d1ec46bb39844adca12f1e3`。
- 净PnL、NetR、手续费、Funding覆盖率均 **6/6**；MFE及MAE均 **0/6有效、6/6缺失**，报表均保留null。

来源组合独立分组与报表一致，每组均1笔、`LOW_SAMPLE`：

| 完整来源组合 | 净PnL |
|---|---:|
| RANK_LOSER + RETAINED + VOLATILITY_COMPRESSION | −0.62811217 |
| EARLY_ACCELERATION + RANK_LOSER + VOLUME_SHOCK | +0.52897793 |
| RANK_VELOCITY + VOLATILITY_COMPRESSION + VOLUME_SHOCK | −0.62135713 |
| BOUNDARY_PRESSURE + RANK_GAINER + VOLATILITY_COMPRESSION | −5.67807921 |
| VOLATILITY_COMPRESSION | −1.63659300 |
| BOUNDARY_PRESSURE + RETAINED + VOLATILITY_COMPRESSION | −0.69950915 |

独立来源视图移除上述两组的RETAINED后仍各1笔；来源重叠不能解释为单来源因果收益，组回撤也不能相加。

**旧MFE/MAE置空是在剔除无法确认的污染指标，不代表策略退化。** 当前保存证据无法恢复完整历史路径；未来出场分析需积累具有来源与时间边界的新采样，并继续区分采样路径与完整路径。统计纠正不能算作盈利提升，当前晋级门槛未通过。

范围限制：本次结论针对本地保存成交和离线纯投影；未重新确认交易所状态、未验证线上加载状态，也不替代订单决策冻结审查。全程未写文件或数据库，未操作服务及交易。
