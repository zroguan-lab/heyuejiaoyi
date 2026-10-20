# TEAM-006 TP恢复修复、不可变决策/入场快照、单变量验证

用户2026-10-17明确授权：“先处理已复现的止盈恢复问题，补齐不可变入场快照，再开展单变量验证”。本合同细化实施边界，覆盖历史任务中的只读限制。

## 目标和冻结项

1. 修复TEAM-005复现的TP2终态REJECTED阻断TP1恢复及重复报错；保持全仓有效止损优先、未知提交先查询、保护订单幂等、真实成交归属与TP1后BE安全顺序。
2. 在决策产生与正式执行前保存脱敏、不可变、带版本/纪元/时间/血缘/完整性及哈希的特征快照，覆盖入选和拒绝，避免只记录已成交赢家或用可变shadow结果回填历史。
3. 以前向快照为资格基础，建立并运行一个单变量研究验证入口（先量能>=1相对自然基准，其他假设登记但不并行调参），无自动下单权限；数据不足返回WAITING/INSUFFICIENT，不伪造盈利。只可使用部署后真实前向记录，不拿旧mutable payload补成新证据。

冻结：Score/信号准入/市场环境判别/来源过滤/价格目标/止损TP1TP2BE的价格与比例/仓位杠杆/成本门槛/策略版本及纪元均不变。TP恢复属于执行修复，允许对已知终态失败的保护腿作有界、可审计恢复，不允许把已越目标直接改成市价平仓，不自动调价或取消有效止损。任何无法在这些约束内修复的情况先报告。

## 权限和文件所有权

- 执行后端专家：可修改`src/execution/testnet-canary-executor.js`及`test/testnet-canary-executor.test.js`，新增专用TP恢复helper/test须先报告路径。保留TEAM-003既有修改；不修改请求参数模块或canary-plan/策略域。只运行fake client/内存测试，不连接交易所。
- 执行文件范围追加：`src/execution/execution-account-ownership.js`及`test/execution-account-ownership.test.js`，仅让明确持久化、属于本run的TP替代ID纳入既有严格归属规则。不得按同币、前缀或宽泛正则认领外部订单；跨run冲突检查、止损校验不变。原因：原归属器仅认plan.clientIds，替代保护单会被误判外部订单。
- 数据工程师：可修改`src/infrastructure/research-store.js`，新增`src/domain/decision-snapshot.js`、`test/decision-snapshot.test.js`、修改`test/research-store.test.js`。提供写一次/读回/校验接口，在saveShadowDecision中接线不可变决策事件并与mutable行写入原子一致；只在临时或内存测试库初始化，不打开活动库写连接、不迁移原库。
- 总控：修改`src/application/strategy-execution-coordinator.js`及对应test接线执行前快照；必要新建纯研究验证模块/独立脚本及test（先登记路径），写quant-team治理/协议/验收。修改调用接口只为可靠快照采集和无交易研究，不改变现有交易筛选与订单参数。快照写入失败不可默默丢失后仍宣称可验证，明确失败行为并测试。
- 总控研究文件已登记：`src/research/single-variable-validation.js`、`test/single-variable-validation.test.js`、`quant-team/research/validate-team-006.mjs`、`quant-team/research/TEAM-006-volume-confirmation-protocol.json`。仅纯计算/只读CLI与隔离fixture，不接线上策略入口，不持有下单能力。
- 独立QA：全程不写被审业务文件；读取差异、运行隔离测试，审查真实修复、快照不可变性/并发幂等/时间泄漏/隐私和策略冻结。
- 回测统计专家后续审查单变量验证协议/脚本，按明确派单只读，不运行封存或在线流水线。

若需要修改以上未列文件，先向总控申请精确路径；总控可在用户本轮功能范围内协调所有权，但不得扩展交易行为或运行权限。所有文件使用apply_patch。新快照只白名单字段，不序列化整份账户、凭据、confirmationCode或签名。

## 不授权操作

不启停/重启现有服务、不解锁或触发扫描、不提交/取消/平仓任何线上订单、不读.env/密钥、不打开封存/holdout、不安装交易依赖、不向GitHub发布。活动SQLite只readOnly SELECT；新schema迁移代码仅在fixture验收。实际部署前需确认持仓与单实例切换风险，再与用户确认。测试通过不等于新代码已加载或前向实验已采样。

## 实施和验收顺序

A. TP恢复：重现旧反例；独立TP腿恢复不互相阻断；终态失败与未知提交分类；有限重试/退避且审计不洪泛；不重复创建已活动/已成交的保护腿；新ID必须可查询、重启可恢复、成交归属可审计；有效止损始终不撤。全路径含TP1已部分成交、TP2结束及未知错误反例。

B. 快照：schema版本、snapshotId、scope、signalId/runId、策略/模型/纪元、decision/observed/trigger/radar生成/K线截止/上游接收时间（缺失null）、三种不同评分、方向边界/最近边界、量能字段/完整来源及成本、决策/拒绝理由、研究/正式环境、缺失和哈希。不得将closedAt<=decisionAt当已收到证据；保存时序与新鲜度分开。写后不能UPDATE/DELETE，重复相同写入幂等，冲突显式报错或新事件而非覆盖。

C. 单变量：冻结一份协议和注册时刻/版本，量能字段固定preMove.volumeAcceleration阈值1，仅研究不改变Demo准入。保存全集/拒绝/未成交/右删失/执行异常；基线和变体使用相同执行与费用假设，缺可成交路径不能估计被过滤机会PnL。先完成计算/泄漏/空样本/反例fixture验收，再以已存在的合格前向快照运行读取（无则报告等待），不伪装回测成功或自动晋级。

最终交付真实专家讨论、离线测试、冻结文件哈希、未部署/数据限制、恢复和迁移风险。需服务操作或策略变化时停止该步并向用户明确请求，不停止其他可安全完成的代码与验证。
