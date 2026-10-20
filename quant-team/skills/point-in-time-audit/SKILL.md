---
name: point-in-time-audit
description: 审计行情、快照与交易账的数据血缘、时点可用性和覆盖；用于只读数据核验，不做历史补洞。
---

# point-in-time-audit

使用前读取../../CHARTER.md、../../WORKFLOW.md及../../STRATEGY_AUTHORITY.md；这些相对路径从本技能目录解析。

先确认表/字段和数据集范围，再使用readOnly连接、SELECT和小范围聚合。禁止调用ResearchStore.initialize；不要读取holdout或sealed数据。
区分event_time、close_time、observed_at、decision_time；要求决策仅使用当时已收盘且已到达的数据，不只检查K线收盘时间。
分别统计epoch/strategy/signalModel/sourceType/status/accountingComplete/performanceEligible/filledQuantity，不能把所有execution_runs当正式成交。
查询缺失值、重复、时间倒序、来源缺失与版本不匹配；活动数据库用同一只读事务取得自洽快照，记录采样时间。
验收例：正式0笔、研究有记录时正确分账；数据库被锁或字段缺失必须报UNKNOWN而不是0。

交付按WORKFLOW.md：事实/推断/假设/未知、证据、反方复核、结论和限制。此技能不授予超出当前任务的写入、联网发布或资金权限。
