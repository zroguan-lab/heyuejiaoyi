---
name: performance-attribution
description: 对正式Demo、研究和反事实分别核算净绩效、MFE/MAE及来源组合；用于归因和复盘，不修改台账。
---

# performance-attribution

使用前读取../../CHARTER.md、../../WORKFLOW.md及../../STRATEGY_AUTHORITY.md；这些相对路径从本技能目录解析。

选择当前strategyVersion+signalModel+epoch+sourceType=SIGNAL，再分正式成交、结算完成、绩效合格及执行异常；报告每层排除数。研究和反事实永远单列。
净盈亏按成交账实际费用/Funding处理；实际成交价已体现滑点时，不再次从净PnL扣滑点。使用actualRiskAmount计算净R；缺失手续费/R/来源/MFE不填0。
按完整排序去重来源组合保留RETAINED归因，同时另给独立来源视图；不要以单个来源出现就把组合收益因果归给它。
输出样本量、胜率、PF、净R、回撤口径、费用、MFE/MAE覆盖率；PF无亏损不能伪造有限高值。10笔仅代表FORMAL_OBSERVATION，不是显著性。
阶段性少样本不晋级盈利规律；经验先记假设，注明适用环境和反证。本轮不读取/写入Excel，不回写交易理由。
验收例：当前正式0笔但反事实有交易时，结论应为“暂无当前正式盈利证据”。

交付按WORKFLOW.md：事实/推断/假设/未知、证据、反方复核、结论和限制。此技能不授予超出当前任务的写入、联网发布或资金权限。
