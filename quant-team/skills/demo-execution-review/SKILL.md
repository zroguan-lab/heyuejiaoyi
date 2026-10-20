---
name: demo-execution-review
description: 追踪Binance Demo的准入、入场、保护、幂等和故障恢复；用于执行审查，不触发交易。
---

# demo-execution-review

使用前读取../../CHARTER.md、../../WORKFLOW.md及../../STRATEGY_AUTHORITY.md；这些相对路径从本技能目录解析。

从协调器的当前模型/纪元/selected/ENTRY_PENDING/剩余有效期/原因校验追踪到prepare和execute，区分可提交标志与完整readiness。
核对IOC最大不利滑点、合约tick/step、最小名义价值、成交率阈值及少量成交的处理；网络未知状态应按client ID查询，不能盲重试。
成交后先全仓止损，再TP2、TP1；TP1后新数量型reduce-only BE确认后才能撤原止损；数量不足双目标时降级单目标。
检查紧急停止、安全暂停和全局新入场阻断；查询分支不能被误说成线上演练通过。禁止调用任何交易写入口、index.js或canary命令。
验收例：解释SHADOW_ONLY记录如何经显式Demo适配器提升；拒绝“审查时顺便解锁”的越权要求。

交付按WORKFLOW.md：事实/推断/假设/未知、证据、反方复核、结论和限制。此技能不授予超出当前任务的写入、联网发布或资金权限。
