# 当前策略事实源（2026-10-16建立）

本文用于路由证据，不复制一套可漂移的策略规则，也不改变任何策略。
- 信号版本、Demo版本、成本提升：src/execution/execution-strategy-source.js。
- 参数与环境覆盖规则：src/config.js；运行时用脱敏 /api/health 核验。未经允许不读取 .env。
- 形态与方向：src/domain/pre-move-strategy.js、market-structure.js。
- 来源筛选：src/domain/market-radar.js、shadow-v2.js。
- 风控价格：src/domain/risk.js；实际Demo仓位见src/index.js、execution/canary-plan.js。
- 执行与保护：src/application/strategy-execution-coordinator.js、src/execution/testnet-canary-executor.js。
- 当前实验说明：docs/V2_4_3_BOUNDARY_SOURCE_EXPERIMENT.md。
- 对外学习文件：docs/GROK_BOT_V2_4_3_TRADING_LOGIC.md，仅是说明，不能覆盖代码。
- 账户事实：Binance Demo；本轮通过现有健康接口快照观察，不直接调用签名交易接口。
- 意图、执行账与审计：data/research.sqlite，只读连接。
- 研究模拟、反事实与正式成交必须分别统计；创建时刻、策略版本、信号模型和绩效纪元共同匹配。

已知文档冲突：复盘/AGENTS.md、复盘/README.md以及docs/ARCHITECTURE.md的部分段落仍引用旧V2.3/V2.4规则或旧成本门槛。遵守局部写入规则，不静默采用旧基线作为当前交易事实。本轮不修改该目录，冲突进入验收缺陷清单；后续专门任务按原目录规则同步。

TEAM-001历史交叉核验证据（2026-10-16）：学习文件曾将TP1后BE写成实际入场价，而当时执行器使用run.plan.prices.entry（计划入场价）。TEAM-003（2026-10-17）已纠正学习文件说明；未改变BE交易规则。有入场滑点时剩余仓位在计划价触发不一定毛保本，费用/Funding还会进一步影响净值。

TEAM-001历史数据反证（2026-10-16，非当前样本量）：当时执行器在averagePrice缺失时回退委托price，投影优先保存的actualRiskAmount，2条CLOSED按entry orderId匹配fills重算不一致。原报告P1保留，不改写历史证据。

TEAM-003（2026-10-17）：执行观测与投影统一到src/execution/execution-fill-facts.js；实际风险、NetR及路径指标必须有来源和缺失说明。只读基线为当前纪元7条（6笔结算、1笔无成交取消），本地fills可确认风险6/6，完整历史路径0/6；详见acceptance/2026-10-17-TEAM-003-data-baseline.md与最终验收。统计源码修复不等于现有服务已加载；运行验收独立报告。实际risk非空本身不是正确性证据，不能用修正文档代替成交对账。
