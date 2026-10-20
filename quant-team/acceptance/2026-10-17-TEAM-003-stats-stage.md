已补充 `evidenceProgress`，并通过 **15/15隔离测试**。原 `sampleProgress` 结构保持兼容。

gate字段准确含义：

| 字段 | 通过条件 |
|---|---|
| `minimumSamples` | 正式结算笔数达到target |
| `completeNetR` | 正式结算样本非空，且每笔NetR有效 |
| `completeNetPnl` | eligible CLOSED非空，且全部已完成结算、具有效平仓时间和净PnL |
| `positiveAverageNetR` | 有效NetR均值大于0 |
| `profitFactor` | PF有限且≥1.2；无亏损时PF为null，此项不通过 |
| `maxDrawdown` | 已结算净PnL曲线回撤小于10% |

前端请分别显示：

- `sampleProgress.remaining`：还需新增的正式结算笔数。
- `evidenceProgress.missingNetR`：正式结算样本中待补证的R笔数。
- `evidenceProgress.pendingClosedAccounting`：CLOSED中尚未完整结算的笔数。
- `evidenceProgress.complete`：PnL结算及NetR完整性均满足；不代表收益条件通过。

100笔仅1笔有效R时，应显示“笔数已达标，99笔NetR缺失”，不能仅显示“还需0笔”。

分母已测试：`coverage`限正式结算样本；`closedTradeCoverage`及来源归因覆盖全部eligible CLOSED；开放、排除和非SIGNAL记录不混入。待独立QA复核，未验证线上加载。

---

TEAM-003 B项实施完成（2026-10-17），待独立QA复核。

修改仅限两个 presentation 文件及对应测试：

- 平均NetR空集为 `null`；真实0仍有效。
- 统一 `coverage.<metric> = { total, valid, missing, coverage }`，比例范围0–1，空分母为null。
- 顶层 `coverage` 对应正式结算样本；`closedTradeCoverage` 对应全部符合条件的CLOSED样本。
- OOS复核闸门增加 `completeNetR`、`completeNetPnl`；100笔仅1笔有效R不能通过。
- 来源组合保留缺R的CLOSED记录及完整RETAINED来源；缺PnL不补0，不进入胜率分母。
- PF无亏损为null，附 `profitFactorReason`。
- 新增 `groupMaxDrawdownR`，缺R时为null；旧字段保留并标记deprecated，明确组曲线不可相加。
- MFE/MAE、成本、持仓时间及路径时间均附覆盖信息；指标存在不能证明历史路径完整。

隔离测试 **14/14通过**，`git diff --check` 通过。未改交易协调器、评分或成本准入；未操作数据库、服务或交易，未commit/push。

限制：未做线上加载验证或真实账目对账。另发现授权范围外的 `shadow-performance.js` 自身仍有缺值补0逻辑，未修改；共享归因函数兼容测试通过。
