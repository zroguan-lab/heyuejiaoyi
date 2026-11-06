# 团队任务
## TEAM-029 单变量策略候选与可靠性上线

状态：B1 OFFLINE_VERIFIED / NOT_DEPLOYED，整体POLICY_SELECTION_PENDING（2026-11-06 18:50）。用户明确优化下一版查BUG后上线；策略选项待回答，不默认、不叠加。TEAM024 manifest143已核验复制独立候选；执行专家仅候选10文件移植TEAM025/026安全差异，HTTP未夹带因子，旧V243回归保留。执行与总控各445/445，独立QA定向152/152、全量445/445及追加否决/并发/门控夹具通过，候选143恰好10差异/活动143无漂移；首轮环回EACCES保留。根已有V244 exact BP+VC草稿不等于活动版本，策略专家复核固定148中命中23而非草稿19，并复现反事实混组及矛盾eligible信任缺口，待确认策略后单独列文件合同。未改策略/版本纪元/活动库/服务或订单，不人工交易/清锁/强扫/push，三专家结束回合待命。合同tasks/TEAM-029.md；总体尚未策略验收/上线。

TEAM-029发布追加（2026-11-06晚间）：用户已另行授权先提交GitHub，按tasks/TEAM-029.md仅独立分支codex/team-029-reliability归档B1十项可靠性差异及汇总/脱敏清单，独立QA发布树验收后推送。不合并main、不夹带根V244/因子、库或凭据，不代表上线；策略选择仍待定。

## TEAM-028 148笔V2.4.3订单盈利与亏损归因

状态：REPORT_COMPLETE / INDEPENDENT_QA_PASS_LIMITED（2026-11-06）。用户要求已有订单赚钱/亏钱原因总结；固定截止北京时间17:04:11.339、同纪元正式148笔，净-32.46360330U、56盈92亏、PF0.729976、平均实际NetR-0.185674。总控独占只读统计脚本、合同、总结和逐笔附录；策略研究与独立QA两实例均只读实际交付，正式148的505fills/50Funding、快照与摘要独立一致。最终148逐行/47组合机器复核0差异；事后来源/量能/评分分组只形成假设，因果与盈利仍PARTIAL，不当上线验收。浮点73/34/7按独立反例修为72/33/6，BE角色归属、RV排名幅度定义、SHORT非硬门槛及网络反事实措辞均修正并保留反方。未调策略、操作库或账户、重启/解锁/回测/push，专家结束待命。合同tasks/TEAM-028.md，报告acceptance/2026-11-06-TEAM-028-profit-loss-summary.md，全部148索引2026-11-06-TEAM-028-trades.md。

## TEAM-027 DUSK退出归属与原版本恢复

状态：RESTORED / INDEPENDENT_QA_PASS_LIMITED / RUNTIME_PARTIAL（2026-11-02 23:21）。用户明确批准安全前提后备份/短暂停唯一实例/处理单记录/同原包恢复。10个签名GET核清DUSK外部BUY平空305404982/1117及8fills/3Funding；完整双备份与独立19/19/事务反例通过后，停旧23736，仅CAS导入退出身份/来源并人工退出单列，原plan/hash/status/result不造写。审计307927/307928保留完整原记录，原包自然307932结算CLOSED/完整账务净+3.18981497U，未删除交易或原审计。23:15:44同TEAM024单次启动8332/同锁监听；独立QA4→6与总控4→12/同步推进、hold/emergency=false/readiness/effective=true，自然GRIFFAIN空8539 OPEN_PROTECTED/SL双TP均NEW。运行专家因首GET失败和字段提取误差仅PARTIAL，不掩盖；长期网络/自然新仓退出闭环未知。根159/活动143/原569/纪元保持，未加载TEAM025/026/因子、未改策略/配置、不人工交易/强扫/clear/push。本次不是未来自动恢复许可。合同tasks/TEAM-027.md；报告acceptance/2026-11-02-TEAM-027-report.md；runtime marker TEAM027，源码marker TEAM024。专家结束待命。

## TEAM-026 执行可靠性专项

状态：OFFLINE_VERIFIED / NOT_DEPLOYED（2026-11-01 20:29），总体线上稳定性NOT_ACCEPTED。用户优先稳定性并批准离线调度异常边界，原执行专家独占8文件；第二版独立558/558、定向132/132，总控558/558。修复批次旧写覆盖终态、FINISHED后弱非零NEW误放行、严格系统退出证据贯通及可信时间上界、调度异常故障门控/恢复和并发停止广播；第一版future证据FAIL、中途死锁及其他失败保留。根其余151/活动143/旧569/原纪元保持；当前TEAM024未改，未部署/重启/解锁/签名/交易/回填/push。DUSK外部退出未认领，20:23现场扫描推进但hold仍在/effective=false。后续退出取证及上线权限须另确认，不以离线PASS宣称恢复交易或网络根治。合同tasks/TEAM-026.md；报告acceptance/2026-11-01-TEAM-026-report.md。专家本回合结束待命。

## TEAM-025 DUSK原SL提交未知后的恢复分类

状态：OFFLINE_VERIFIED / NOT_DEPLOYED（2026-11-01 00:04）。用户批准非策略修复、现仓自行Demo处置。原执行专家独占executor/adapter及对应test四文件；第一版独立FAIL后修正，独立定向127/127、全量541/541，总控541/541。原ID负事实与空/无效/网络未知分层，独立账户归属核验后才恢复既有缺SL应急；缓存成交证据跨轮保持，冲突NEW不误清除。根155/活动143及旧569/原纪元保持；活动TEAM024未加载修复，不部署/解锁/签名/交易/回填/push。DUSK退出归属仍未闭环，23:59投影零账户但hold/effectivefalse，不冒充恢复。合同tasks/TEAM-025.md；报告acceptance/2026-10-31-TEAM-025-report.md。

## TEAM-024 已执行止损恢复误判的离线修复
状态：DEPLOYED / INDEPENDENT_QA_AND_RUNTIME_PASS_LIMITED（2026-10-30 17:47）。离线根535/535、新干净包独立422/422；用户另行批准后双备份/新鲜零账户/旧账与纪元门槛通过，既有CLI安全clear、17:42:42单次启动新TEAM024 release唯一23736，原cwd/7897代理保持。首次OLD_PID_NOT_EXITED拒绝保留，稍后证实全退出后经独立QA审显式离线续行，未重跑stop或放宽门槛。独立运行scan0→1、QA1→2/同步推进通过，总控最终17:46:42 connected/readiness/effective正常、无emergency/hold、零仓零单/WATCHING。旧560/纪元不变，原TEAM020源保留；根因子未加载、策略未改、不人工交易/强扫/回填/push。自然FINISHED/TP1-BE、新交易完整账务、长期网络稳定和盈利仍未验证。合同tasks/TEAM-024.md；报告acceptance/2026-10-30-TEAM-024-report.md；当前marker TEAM024。

## TEAM-023 低成交量退出失败后的安全恢复
状态：RESTORED / INDEPENDENT_RUNTIME_PASS_LIMITED / INTERMITTENT_HTTP_TIMEOUT_REMAINS。2026-10-30用户要求“为什么停止了，马上恢复”。原TAUSDT低成交退出流程超时触发粘滞紧急停止，后续SL实际退出结算；新鲜真实零仓零单、在线/停机完整备份后，总控原CLI安全clear，02:26:29原TEAM020 release/cwd/纪元/7897代理单次启动唯一49660。旧549及纪元保持，独立QA旧账/源码/实际安全入口PASS，独立运行02:30:15—02:31:28 scan7→9/同步推进/connected/readiness通过、零仓零单/无hold/emergency；但QA两次及最终总控health仍15秒超时，不宣称接口或网络根治。首次停旧退出闸门拒绝保留，证明全退出后显式离线续行且再审，不归因未复现的Count猜测。无业务源码/策略/仓位/配置变更，无人工交易/强扫/回填/因子加载/push，未来自动恢复未授权。合同tasks/TEAM-023.md；报告acceptance/2026-10-30-TEAM-023-report.md；runtime marker TEAM023。

## TEAM-022 原发布包退出诊断与受控恢复
状态：RESTORED / INDEPENDENT_RUNTIME_AND_QA_PASS_LIMITED。2026-10-28用户批准后，新鲜只读账户/备份/单实例闸门通过，22:28:45仅启动一次同TEAM-020 release/cwd/参数/原纪元/7897进程代理，原50508已退出、旧锁归档，新唯一42060。543旧终态及纪元原文不变、备份完整，独立QA38/38及旧账/实际命令/宿主后验PASS_LIMITED，独立运行scan3→5与同步推进；22:33总控scan10/connected/readiness通过、0仓零单/无hold/emergency、WATCHING。原退出触发UNKNOWN，网络未声明根治；首轮QA FAIL、备份名单误分类、日期时区误拒保留并纠正，不放宽新鲜度。无业务源码/策略/配置或原账变化，无人工交易/解锁/强扫/因子接入/push，不新增托管/自动重启。合同tasks/TEAM-022.md；报告acceptance/2026-10-28-TEAM-022-report.md。专家本回合结束待命。

## TEAM-021 长时间无单与代理通道受控加载
状态：DEPLOYED_NETWORK_ROUTE / INDEPENDENT_RUNTIME_PASS_WITH_WARNINGS / INTERMITTENT_NETWORK_REMAINS。10/27 14:43用户批准后同TEAM020源码仅显式进程7897代理覆盖，旧456→唯一50508；在线/确认停机备份完整、533旧终态与纪元不变，QA核账/指纹/实施命令证据通过、独立运行scan1→2及同步/readiness推进，总控14:46最终scan5/账户连接/无锁/零仓零单。新日志仍有账户超时后恢复，未根治所有网络问题。固定02:12—14:29窗口182候选0selected，不是182条可下单；独立当前712历史selected也无合格遗漏，未发现代码反例，不改策略/阈值/仓位/版本/纪元或源码。保留失败检查，未人工交易/解锁/强扫/回填/push，因子保持离线。合同tasks/TEAM-021.md；报告acceptance/2026-10-27-TEAM-021-report.md。

## TEAM-020 长时间无新单只读诊断
状态：DEPLOYED / AUTO_EXECUTION_WATCHING / INDEPENDENT_RUNTIME_PASS_LIMITED。10/27 01:21唯一新PID456加载HEAD66f2541加本次executor修复（SHA A5271CD0…），独立工作区529/529/干净包416/416。原18988退出、双备份完整、530旧终态/纪元保持，独立scan1→3和同步推进/connected/0仓零单/readiness可准备/无锁。活动源码quant-team/backups/TEAM-020-20261027/release，不得当普通备份删或直接启动dirty根源夹带因子。未改策略/成本/仓位/版本/纪元，无人工交易/解锁/强扫/回填或push；历史BONK账务与自然故障恢复前向验证仍待。合同tasks/TEAM-020.md；报告acceptance/2026-10-27-TEAM-020-report.md。

## TEAM-019 Factor Intelligence V1（研究/Shadow）
状态：OFFLINE_CHECKPOINT / PHASE6_GOVERNANCE_PASS_LIMITED / NOT_COMPLETE / DEMO_UNCHANGED。用户最新明确“继续离线因子开发，当前 Demo 保持不动”。候选档案/计划/完整历史重放/不可变持久化/CAS审计与阻断晋级已通过独立因子113/113、全量527/527；总控定向54/54及全量527/527。phase4自动调权/数字提案、phase6可信runner/实际Backtest/OOS/Shadow及phase7最终验收仍未完成。不创建实际用户候选/权重，不访问或迁移本轮活动库/服务/账户，不自行部署/恢复/交易，策略与纪元不改，未push。18:52运行恢复仅历史快照，本批没有重核当前运行。合同tasks/TEAM-019.md；报告acceptance/2026-10-26-TEAM-019-report.md。

## TEAM-018 当前运行异常与非策略修复
状态：DEPLOYED / AUTO_EXECUTION_RESTORED / INDEPENDENT_PASS_LIMITED。2026-10-26非策略修复66f2541，独立154/154、全量414/414；首轮终态漏检FAIL保留并关闭。用户追加批准后13:22受控备份切换54596→18988，13:26扫描7/同步推进、账户连接与BLUR保护完整、hold/emergency=false、effective=true。DYM/CATI/Q自动完成账务，520旧终态及纪元原文不变；NetR为只读投影，原字段null保持。策略/配置不改、无人工交易或主动解锁、未push。残余上游超时与自然全场景仍须观察。合同tasks/TEAM-018.md；报告acceptance/2026-10-26-TEAM-018-report.md。

## TEAM-017 自然退出闭环前向验收
状态：ACTIVE_READONLY_FORWARD_ACCEPTANCE。用户同意先自然TP1→BE→最终账务验收，再恢复单变量研究；不制造订单或放宽门槛，不以止损分支冒充TP1路径。执行/QA/运行专家只读交叉核验，总控留证并定时跟进。策略/运行/原始账不改；通过后仅形成单变量提案，交易规则变化另需批准。合同tasks/TEAM-017.md。

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
