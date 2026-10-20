# TEAM-009：不可变SHADOW研究计划观测补齐

## 授权

用户于2026-10-19明确批准TEAM-008报告提出的“仅补充研究快照、不改变任何交易判断和订单行为”的观测修复，并要求隔离测试与独立验收。

## 实际目标

让每一条新 `SHADOW_DECISION` 在决策时不可变地保存研究所需的候选计划：方向、计划入场、止损、TP1、TP2、订单类型/样式、TTL、固定风险输入和成本上下文。旧V1快照必须继续通过原hash/schema验证。

## 所有权与事实源

- 快照schema/hash/白名单：`src/domain/decision-snapshot.js`。
- 原始候选计划：决策当时传入builder的 `candidate.risk`、`candidate.order` 与 `evaluation.fixedRiskPlan`。
- 原子落库和不可变触发器：`src/infrastructure/research-store.js`，本任务优先复用现有事务，不迁移、不回填活动库。
- 研究账：新字段只属于研究证据，不能冒充 `ENTRY_PRE_SUBMIT.plan` 或交易所成交。

## 允许写入

- `src/domain/decision-snapshot.js`
- `test/decision-snapshot.test.js`
- 如集成验收必需：`test/research-store.test.js`
- `quant-team/tasks/**`、`quant-team/acceptance/**`、`quant-team/research/**`、`quant-team/TASKS.md`、根`AGENTS.md`

同一业务文件仅总控写入；子Agent只读审查并返回证据。

## 冻结与禁止

不得修改 `shadow-v2.js`、`pre-move-strategy.js`、`risk.js`、`config.js`、执行计划/状态机、Score、准入、止盈止损、仓位、杠杆、成本门槛或策略版本。不得读写活动数据库、读取.env/凭据/封存集、联网、下单、撤单、平仓、解锁、强扫或启停服务。

## 预实现验收信号

1. 新快照使用新schema版本并包含白名单化的`researchPlan`；候选传入对象后续修改不影响快照。
2. `researchPlan`明确区分risk entry与order entry，记录一致性、完整性和缺失项，不用0代替缺失。
3. 旧schema V1真实形状与hash继续可验证；新增字段注入或篡改即使重算hash也拒绝。
4. `SHADOW_DECISION`与`ENTRY_PRE_SUBMIT`原有plan语义保持不变；不改变selected/eligible/orderSubmissionAllowed。
5. 定向测试、ResearchStore内存集成和全量测试通过；由独立QA复核冻结文件hash和负例。

## 部署边界

本任务先完成离线实现与验收。测试通过不等于运行实例已加载；任何重启/单实例交接和上线后只读验收另行报告。部署不得回填旧49条，新的确认性协议只能从部署验收后的时点注册。

## 离线完成记录

2026-10-19 18:16（Asia/Shanghai）：离线实现完成，定向27/27、全量334/334；独立QA在两轮FAIL反例修正后给出限定PASS，冻结文件hash一致。状态为`OFFLINE_VERIFIED / NOT_DEPLOYED`。验收与讨论分别见`../acceptance/2026-10-19-TEAM-009-report.md`和`../acceptance/2026-10-19-TEAM-009-discussion.md`。
