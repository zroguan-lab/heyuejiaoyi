# 团队任务
## TEAM-016 执行生命周期与恢复入口一致性
状态：COMPLETE / DEPLOYED / PASS_WITH_WARNINGS。2026-10-25修复3a6b347，执行及独立QA113/113、404/404，总控404/404。受控备份停旧11456、唯一新监听/锁54596；独立scan1→2与同步推进，PHA保护完整、readiness/归属通过、停止/安全hold false、自动执行可用。518旧终态及原纪元不变；上游超时与未发生的自然TP1/BE场景仍列限制，未push。冻结策略参数不是长期目标；不混入MFE或盈利因子变化。合同tasks/TEAM-016.md；报告acceptance/2026-10-25-TEAM-016-report.md。

## TEAM-015 TP1后保护恢复误判修复
状态：DEPLOYED / AUTO_EXECUTION_RESTORED / PASS_WITH_WARNINGS。用户2026-10-25要求异常立即修复并明确批准受控恢复。修复9cb2486；执行与独立QA62/62、389/389，第一版FAIL保留。15:23新唯一监听/锁11456，安全解除停止，独立扫描1→3/账户同步推进，PHA保护完整；自然MAGMA开空至止损结算完整（净-3.00545397U），不等于盈利或特殊TP1/BE恢复已前向验证。上游超时/CLI遗留锁/观测缺口保留，517旧终态与原纪元不变。合同tasks/TEAM-015.md；报告acceptance/2026-10-25-TEAM-015-report.md。

## TEAM-014 DEEP仍持仓误清理保护修复
状态：DEPLOYED / AUTO_EXECUTION_RESTORED / RUNTIME_VERIFIED。2026-10-24用户先要求“修复以上问题”，之后明确“马上恢复”。执行与独立QA均70/70、379/379通过；修复提交e3da42b。17:07–17:10受控停旧PID40936、停机备份、安全CLI解锁并启动唯一新PID41444；17:11运行专家独立PASS，扫描/同步推进、0仓0单、停止/安全锁false、下单true，原505条执行及纪元保留。此前审批拒绝和CLI退出遗留锁的真实失败保留在报告，CLI缺陷待另修；自然交易与间歇行情超时继续观察。
执行专家独占executor及其test，实现旧反例复现和修复；独立QA预审/最终复测；运行专家只读预检，均为真实侧边栏聊天。
目标：首次账户快照缺仓不能直接撤SL/TP；清理前需完整归属退出事实与独立新鲜零仓证据；未知时保留保护并阻断新入场，正常退出/Funding等待仍能收敛。
冻结：策略/Score/准入/价格目标/仓位/杠杆/成本/版本；不人工交易、不改旧PnL，不重置纪元。实施阶段不控制服务或解锁。
合同：tasks/TEAM-014.md；验收、部署与真实失败记录：acceptance/2026-10-24-TEAM-014-report.md。本次已由受控重启加载修复，运行PASS不等于盈利验证。

## TEAM-012 Demo账户重置恢复与新绩效纪元
状态：COMPLETE / DEPLOYED / FORWARD_COLLECTION_ACTIVE。2026-10-24用户要求尽快修复并开启新纪元。
结果：新鲜签名账户事实确认ONE_WAY、0持仓/0普通单/0条件单；无撮合权限探针通过。一致性备份、原子迁移、旧6条未知账务审计终态化、新V2.4.3纪元、单实例启动和在线健康验收均完成。
冻结：Score、准入、方向、止盈止损、仓位、杠杆、成本和策略版本未改；没有人工订单动作或强扫。最终370/370通过。部署提交`2dde4f435272503f397aa77d8d4cf7b99210c840`。
合同：tasks/TEAM-012.md；验收：acceptance/2026-10-24-TEAM-012-deployment.md。该完成状态仅代表运行与审计恢复，不代表盈利已验证。

## TEAM-011 / GitHub Issue #1 执行事实与账务修复
状态：OFFLINE_VERIFIED / NOT_DEPLOYED。2026-10-20用户授权代码修改、相关测试、独立QA和PR；禁止部署及账户操作。
实现：ACK多源核验、ENTRY_FACT_CONFLICT隔离、保护优先/余单恢复、严格分页费用/Funding账务、未知盈亏投影、单实例锁。策略、止盈止损参数、保证金、杠杆冻结。
验收：总控全量365/365，独立QA相关144/144，语法与diff检查PASS；旧反例失败及QA阻断修复如实记录。四笔历史未改写、未释放门控，未访问账户/活动库/凭据/封存、未启停服务。
合同：tasks/TEAM-011-development.md；交付：acceptance/2026-10-20-TEAM-011-development.md。PR不等于部署；上线与历史迁移另行授权。

## TEAM-009 不可变SHADOW研究计划观测补齐
状态：OFFLINE_VERIFIED / NOT_DEPLOYED。用户2026-10-19批准只补充研究快照证据，不改变交易判断或订单行为。
范围：为新决策快照增加版本化researchPlan，记录entry/SL/TP/订单TTL/固定风险输入并保持旧V1验证兼容；只改decision snapshot及对应隔离测试。
冻结：策略、Score、准入、止盈止损数值、仓位、杠杆、成本、策略版本和执行状态机；不读写活动库、不启停服务、不交易。
结果：schema V2新增独立researchPlan并保持V1原hash兼容；定向27/27、全量334/334，独立QA最终限定PASS。两轮QA失败证据和舍入误判均保留并修正；冻结文件hash一致。
验收：acceptance/2026-10-19-TEAM-009-report.md、acceptance/2026-10-19-TEAM-009-discussion.md。
合同：tasks/TEAM-009.md。离线测试通过不自动部署；旧49条不得回填，部署后才可注册TEAM-008确认性前向窗口。

## TEAM-008 LONG 15m量能门槛单变量反事实验证
状态：PARTIAL / WAITING_FOR_FORWARD_DATA / INSUFFICIENT_EXECUTABLE_PATHS。用户2026-10-19同意开展研究验证；线上V2.4.3与订单保持不变。
唯一变量：`radar.volumeRatio15m >= 1`；5m `preMove.volumeAcceleration >= 1`及Score、方向、出场、成本、仓位、杠杆全部冻结。
结果：注册前49条不可变LONG种子中，严格单变量后只有2条有效资格差异；注册后确认性LONG为0。两条均缺不可变entry/SL/TP/quantity/risk/path，不能计算反事实PnL、NetR、MFE/MAE或证明放宽更盈利。
交付：tasks/TEAM-008.md、research/TEAM-008-long-radar-volume-protocol.json、research/validate-team-008.mjs、acceptance/2026-10-19-TEAM-008-seed-ledger.json、TEAM-008-seed-report.md、TEAM-008-discussion.md。
下一步需用户另行批准纯观测补齐与受控部署；不授权策略放宽或交易动作。

## TEAM-007 受控部署与单实例交接
状态：COMPLETE / FORWARD_COLLECTION_ACTIVE。用户2026-10-17已明确同意执行受控部署；22:23完成迁移、单实例切换与保护复核。
顺序：账户与保护核实 → 一致性备份 → 数据库迁移演练/迁移 → 单实例重启 → 上线后验收。
冻结：策略、参数、Score、止盈止损、仓位、收益基线及订单行为不变；不人工下单/撤单/平仓，不强制扫描，不打开封存集或读取凭据。
停止条件：交易所状态未知、持仓缺少止损、备份/迁移演练失败、旧实例未完全退出或新实例数量不唯一。
合同：tasks/TEAM-007.md。
验收：acceptance/2026-10-17-TEAM-007-deployment.md。停机点恢复备份位于quant-team/backups/TEAM-007-20261017-2220/research-stop-point.sqlite；未操作订单或修改策略。

## TEAM-006 TP恢复、不可变入场快照与单变量验证
状态：DEPLOYED / FORWARD_COLLECTION_ACTIVE。用户2026-10-17明确“继续”后完成原范围实现与独立验收；随后经TEAM-007受控部署加载，未修改策略或人工操作订单。
结果：最新全量总控及独立QA各326/326，执行/归属55/55、研究统计独立16/16，真实Store—协调器成功及数据库拒绝路径通过。跨run共享成交、嵌套未来时间、审计来源/纪元错配、多ENTRY歧义均关闭。325/325后另复现OPEN_PROTECTED的TP后续失效漏恢复，修复并补回归后才取得326/326；历史失败保留。
运行与研究限制：2026-10-17 22:00:52北京时间的NOT_DEPLOYED_SNAPSHOT_SCHEMA_ABSENT属于部署前事实；22:23后活动库已有decision_snapshots且已采集2条SHADOW_DECISION。尚未积累足够前向样本，也未验证收益改善。协议唯一量能>=1仅用于研究，未加入Demo规则；固定未触碰评价窗口和推断方法仍待后续设计。
交付：acceptance/2026-10-17-TEAM-006-report.md、TEAM-006-discussion.md、TEAM-006-evidence.json、TEAM-006-expert-public-messages.json。记录具体SHA-256、真实专家Turn、沙箱测试失败及修正历史。下一步须用户确认受控部署，再先核实账户保护、备份和单实例交接；没有自动上线授权。
原授权合同：tasks/TEAM-006.md。部署过程见TEAM-007；现有策略规则继续冻结。

## TEAM-005 异常亏损拆解与入场因子初筛
状态：COMPLETE_ANALYSIS / FACTOR_VALIDATION_NOT_PASSED。用户明确“执行下一步”，承接SIREN约−2.51R拆解与入场因子初筛，现有策略不变。
合同：tasks/TEAM-005.md。固定截止2026-10-17T09:00:00Z；执行后端、策略研究、回测统计三个既有专家独立取证，再由总控中转交叉意见。原始数据库只读，专家不写文件，总控仅写quant-team研究证据和报告。
禁区：不改策略、Score、止盈止损、仓位、订单、配置及服务，不读凭据/封存，不运行回测流水线。只读研究结论不等于晋级盈利规则。
结果：7笔已结算净PnL−7.80141165U、均净R−0.76776972，剔除SIREN仅诊断仍负。SIREN金额分解已对账，TP1三次−2021及TP2终态REJECTED已证实；恢复链在拒绝TP2处中断的当前源码控制流由总控隔离fixture复现且执行专家独立复跑PASS，历史退出价差原因仍UNKNOWN。冻结审计支持主要入场字段覆盖；rankVelocity仅2/7，完整路径与历史候选总体不可确认，尚无已验证盈利因子。
交付：acceptance/2026-10-17-TEAM-005-report.md、TEAM-005-discussion.md、TEAM-005-evidence.json，独立专家交付exec/quant/stats及两个可重运行只读/隔离脚本。统计独立限定验收PASS；不代表盈利因子或线上交易验收。
下一阶段候选：Demo条件单触发基准与成交路径核对、TP拒绝后的恢复设计，以及快照年龄/策略量能/方向边界三项单变量研究；代码修复、采样接线或策略实验上线均未自动获准执行。

## TEAM-001 团队部署与只读协作验收
用户授权：保存章程、岗位、技能，开展专家协作并展示讨论；不修改交易策略。
允许写入：AGENTS.md、quant-team/**（仅总控）。专家全部只读。
范围：V2.4.3版本、样本/纪元、来源过滤、执行保护、统计口径、运行健康。
禁区：.env/凭据、封存集、数据库写入、服务启停、交易动作、GitHub发布。
验收：8岗位配置+8技能校验；真实多Agent消息交叉复核；证据和限制落盘；策略/配置哈希一致。
状态：COMPLETE（团队文档/技能部署与限定只读协作验收完成；不代表策略/交易系统所有验收通过）。
验收报告：acceptance/2026-10-16-readonly.md。
讨论记录：acceptance/2026-10-16-discussion.md。
实际实例：/root/evidence_worker（数据、绩效、运行）；/root/research_worker（策略、执行）；/root/methods_worker（回测统计、风险、独立QA）。8岗位分批执行，未宣称8个常驻进程。
结果：9岗位/8技能已配置，8/8官方技能格式校验通过；真实交叉消息和反例已保存；现有风险分母P1已独立复现。未修改策略/配置/订单/数据库，未发布。
后续候选任务（未授权实施）：先修复并对账实际成交价、实际风险及NetR/MFE/MAE口径，再统一BE与安全暂停文档；评分/出场/仓位保持本轮边界。

## TEAM-002 侧边栏独立专家入口
用户已明确同意在交易信号项目创建8个岗位独立聊天，由总控统一调度。
状态：COMPLETE。
范围：创建任务、只读加载岗位和技能、确认待命、记录threadId；不重复运行TEAM-001审计，不开展修复。
总控：01a0de95-140b-78b0-befd-55af63f485a9（量化开发团队总控）。
验收：8个真实threadId、项目归属正确、岗位标题正确、初始化回报完成、无交易变更。
结果：8/8已创建；list_threads核验标题、交易信号projectId及idle状态全部正确；wait_threads取得8/8初始化完成回报，均实际读取对应岗位/技能并待命。证据：acceptance/2026-10-16-sidebar-initialization.json。未创建worktree，未覆盖模型设置，未触发业务审计、策略修改或交易动作。

## TEAM-003 统计与对账修复
状态：OFFLINE_VERIFIED / RUNTIME_BLOCKED。授权原文：“分配下去执行”。
合同：tasks/TEAM-003.md。讨论：acceptance/2026-10-17-TEAM-003-discussion.md。
8个侧边栏专家均已实际派单并交付；执行/统计实施，数据/绩效分别独立对账，QA与风险终审。最终279/279隔离测试通过，当前纪元6/6成交风险匹配、净PnL不变；历史路径0/6可信，保持未知。
验收：acceptance/2026-10-17-TEAM-003-final.md。运行健康/首页GET超时，虽端口监听但加载与自动交易动态状态UNKNOWN；本轮未部署、不自动继续策略实验。
本轮不改交易策略、配置、数据库原记录或订单，不启停服务；新代码完成不自动等于线上进程已加载。

## TEAM-004 超时诊断与安全恢复预检
授权：用户要求“马上执行，遇到什么问题马上和我商量”。
状态：PARTIAL / BROWSER_VERIFIED_RUNNING_WITH_UPSTREAM_TIMEOUTS。
已派运行/执行专家独立只读取证，TCP可连但首页和健康0响应；审计最新14:59:06，本地仍有SQD活动空单与保护缓存，交易所实时状态未知。
后续15:23–15:25浏览器反证显示首页/health可取得响应、扫描1530→1531、账户同步推进、SQD已TP1且剩余2347有BE/TP2。用户条件授权必要可平仓，但未证明持仓影响整体，不触发平仓/重启。仍有上游行情/雷达及间歇账户超时，不作全系统PASS。最新证据：acceptance/2026-10-17-TEAM-004-browser-correction.md；旧diagnosis仅保留原时间窗口事实。
