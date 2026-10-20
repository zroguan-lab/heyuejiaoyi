---
name: runtime-readonly-health
description: 只读检查本地前端、嵌套健康接口、扫描进展和Demo执行健康；不重启、不解锁服务。
---

# runtime-readonly-health

使用前读取../../CHARTER.md、../../WORKFLOW.md及../../STRATEGY_AUTHORITY.md；这些相对路径从本技能目录解析。

只GET /、/api/health，必要时/api/signals。超时设置在30秒以内，不重试风暴；请求失败报告时间、错误和本次无法验证的项目。
字段使用monitor.status/scanCount/lastScanCompletedAt和execution.account.connected/status/lastSuccessfulSyncAt/error，以及execution.emergencyStop.active/safetyHold.active/readiness；不要假设顶层同名字段存在。
至少两次有时间间隔的快照才能支持“扫描在推进”；单次200仅说明接口可响应。区分扫描、账户同步、信号准入、执行写入旗标和完整readiness。
不打印整个健康响应、凭据或原始日志；只保存脱敏聚合。账户0持仓不等于成交闭环已验证。
验收例：HTTP200但account断连，不能报告全部正常；嵌套缺字段标UNKNOWN。

交付按WORKFLOW.md：事实/推断/假设/未知、证据、反方复核、结论和限制。此技能不授予超出当前任务的写入、联网发布或资金权限。
