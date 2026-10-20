# 专家任务入口与调度

TEAM-002，2026-10-16。用户已同意创建以下8个本地独立聊天，均归属“交易信号”项目。
总控：量化开发团队总控，threadId 01a0de95-140b-78b0-befd-55af63f485a9。

| 岗位 | threadId | 配置 |
|---|---|---|
| 量化策略研究员 | 01a14425-85e4-7490-a627-3fdf759398be | roles/quant-researcher.md；skills/quant-research/SKILL.md |
| 行情与数据工程师 | 01a14425-cf0f-7973-a683-1e37a95676c3 | roles/data-engineer.md；skills/point-in-time-audit/SKILL.md |
| 回测与统计验证专家 | 01a14425-e0dd-70e3-a06e-4455a7175119 | roles/backtest-statistician.md；skills/backtest-validation/SKILL.md |
| 风险管理专家 | 01a14427-e156-7752-992d-1d7eaf49eab4 | roles/risk-manager.md；skills/portfolio-risk-review/SKILL.md |
| 交易执行与后端工程师 | 01a14427-f70c-7bc1-a135-a21bf392cdcd | roles/execution-engineer.md；skills/demo-execution-review/SKILL.md |
| 独立测试与审查专家 | 01a14428-120b-7fd1-930c-af3c95a68cd8 | roles/independent-qa.md；skills/independent-qa/SKILL.md |
| 运行可靠性专家 | 01a14428-27c9-7fe3-a363-ff39b412e8c5 | roles/reliability-engineer.md；skills/runtime-readonly-health/SKILL.md |
| 绩效归因与复盘专家 | 01a14428-3e91-7733-ad8f-76ecaf632f81 | roles/performance-analyst.md；skills/performance-attribution/SKILL.md |

准确初始化状态见REGISTRY.json。这里只读加载规则和技能，不执行TEAM-001问题修复。
总控保留用户授权范围，以真实threadId派单、wait_threads读取结果，再中转专家交叉意见。用户只需在总控任务提出目标；各专家任务可点开查看记录。
新任务数不代表持续并发工作数。独立聊天入口不等于/root/*子Agent实例，也不代表常驻进程或独立权限沙箱。没有新建worktree、修改模型配置或交易设置。
初始化后每位专家结束回合待命，不轮询、不自行监控。后续具体任务仍需明确输入、允许动作、交付和独立审查人。
