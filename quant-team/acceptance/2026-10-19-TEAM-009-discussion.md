# TEAM-009 专家讨论记录

时间：2026-10-19（Asia/Shanghai）

## 总控

采用架构优先预检：研究计划是证据schema，不是策略或执行计划。选择新增独立`researchPlan`而不扩写真实执行`plan`；builder缺源时必须保存null与不完整标记，不能因观测失败阻断原决策事务。

## 策略研究 / 执行审查

- 明确字段血缘来自决策时candidate.risk/order与evaluation.fixedRiskPlan；候选价格和理论数量不能冒充撮合价或实际仓位。
- 要求risk entry与order entry分别保存；缺源不使用默认500U/0.5%重建。
- 指出测试fixture的stopPercent和targetRiskPercent单位错误；总控已修正。
- 最终复核确认一致性校验没有进入交易准入、没有抛错或回写输入，给出限定PASS。

## 独立测试与审查

第一轮结论为FAIL，而非默认同意：

- risk.valid=false仍complete=true；
- decisionTime缺失仍声称TTL有效；
- 未知订单类型/样式仍完整；
- 固定风险数字互相矛盾仍sizingValid；
- 标准ID校验可能误拒旧V1自定义ID。

总控修正后，第二轮仍为FAIL：真实上游按不同精度舍入，观测层从已舍入stopRate反推导致合法计划被误判。QA给出entry=100、stop=99.87654321的纯函数反例。

总控改为舍入区间传播并加入高精度权益/风险比例联动回归后，QA最终PASS：快照14/14、内存Store原子性1/1、冻结9文件hash一致。

## 共同结论

这次只补齐未来研究证据，不能改善当前胜率或净收益。上线后仍需等待新的、不可变且结果可对齐的前向样本，才能判断15m量能门槛对LONG入场是否有正向净期望。任何放宽或收紧交易条件仍需独立证据和用户另行批准。
