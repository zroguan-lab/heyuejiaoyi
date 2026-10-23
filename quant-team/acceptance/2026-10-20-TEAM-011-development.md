# TEAM-011 / Issue #1 离线修复验收

状态：**OFFLINE_VERIFIED / NOT_DEPLOYED**。基线 `2e4a2596d7520ca1b772a98ada5dd00fdc275bb7`，分支 `codex/team-011-entry-accounting`。日期：2026-10-20（北京时间）。

任务入口：[GitHub Issue #1](https://github.com/zroguan-lab/heyuejiaoyi/issues/1)，全部正文及评论已读取（评论0条）。合同：`quant-team/tasks/TEAM-011-development.md`。历史四笔证据沿用原只读报告，未重新访问账户、凭据、封存或活动库。

## 修改与事实边界

- 执行器在请求前持久化脱敏凭据身份指纹和提交时间；返回 ACK 保存白名单摘要，不能单独确认成交。后续按相同 clientOrderId GET、归属 fills、当前仓位核验，保存核验时间链与明细状态。
- ACK 持续缺少订单/成交/仓位印证至少120秒且两次核验后进入 `ENTRY_FACT_CONFLICT`；请求失败保持未知，不当作不存在。账户指纹变化、仓位方向/数量/归属冲突立即隔离。该状态非终态，保留门控，禁止绩效确认与新入场；NetPnL/NetR null。
- 仓位已经出现时先以原计划止损价格建立全仓 closePosition 止损，再等待 fills 或取消余单；`remainderPending` 跨重启继续管理余量。小于最小新订单数量的部分成交也先保护，TP数量拆分失败保留止损并进入保护待核。原有低成交比例异常处理和所有价格、比例冻结。
- `userTrades` 按<=7天切片并使用 fromId 翻页，严格正订单ID、symbol/side、数量闭合及逐笔字段校验，去重冲突不完整。未成交条件腿 actualOrderId=0 不作为必需成交。手续费未知/非USDT未折算、Funding失败/缺字段/分页不全均不结算；成功的空数组与异常响应严格区分。
- 前端投影只在 accountingComplete===true 时确认净盈亏/NetR，冲突记录独立计数。新schema未核实ACK不产生实际风险/路径事实；历史观测保持既有来源限制。
- 数据库路径使用原子wx单实例锁；进程内共享Store也互斥。残锁不会凭PID/年龄自动抢占；内存fixture无磁盘锁。

交易所API契约核对：[官方 USDⓈ-M 客户端文档](https://binance.github.io/binance-connector-js/classes/_binance_derivatives-trading-usds-futures.DerivativesTradingUsdsFuturesRestAPI.TradeApi.html)。fromId不能与时间参数同送，客户端同时执行该约束。超过180天成交历史或90天Funding可见性按不完整处理，不把历史缺失当零。

## 真实审查与失败证据

实现：`/root/execution_fix`；回归：`/root/regression_tests`；独立验收：`/root/independent_qa`；总控维护客户端、投影与接线。每文件唯一写入负责人。

修复前新增账务反例实际1通过/4失败：取消腿0、缺Funding API、缺commission、1000条不分页。独立QA随后阻断并推动修复：规范化Funding transactionId、部分成交撤余单超时前保护、身份变化/反向/超量仓位隔离、legacy零仓位不写、非数组响应拒绝、NEW0+真实仓位余量恢复、小额成交TP拆分不得挡住止损。没有把中间失败隐藏成通过。

首次沙箱全量包含临时文件rename EPERM和fixture localhost EACCES；获准后仅对离线测试解除限制，未连接交易所。旧简化mock补齐生产字段（数值ID、归属、费用币种、成交价格/数量/时间、仓位和Funding API），没有降低实现完整性标准。持续未知提交原CANCELED预期更新为冲突隔离；完善成交证据后相应时间/路径观测改为确定值，原缺证据测试仍保留。

## 最终测试与独立验收

- 总控：`npm test`（获准解除测试临时文件/localhost/子进程沙箱限制）**365/365 PASS，0失败/跳过**。
- 总控：`npm run check`、`node --check src/execution/entry-fact-process-lock.js`、`git diff --check`，全部PASS。
- 独立QA：相关9组测试 **144/144 PASS**，最终结论 **PASS（离线实现/相关回归范围）**。独立复现并复测取消失败保护优先、极小partial全仓止损、身份/方向/数量隔离、legacy零写入、15天三切片查询；无剩余功能阻断。
- 新测试：`test/team-011-accounting.test.js` **23/23**，`test/team-011-process-lock.test.js` **4/4**；既有执行器 **47/47**。锁测试仅在临时目录启动短命Node子进程，未启动真实服务。
- 独立QA自己的全量沙箱运行曾有6项环境失败，最终由总控获准复跑全量补齐，未伪称QA自己全量通过。

完整变更文件（业务）：`src/execution/testnet-canary-executor.js`、`entry-fact-process-lock.js`、`binance-testnet-trading.js`、`execution-account-ownership.js`、`execution-fill-facts.js`、`execution-run-projection.js`、`src/application/strategy-execution-coordinator.js`、`src/presentation/strategy-performance.js`、`public/app.js`；测试为新增TEAM-011两文件及对应投影/协调器/归属/绩效/执行器fixture；治理为本报告、开发合同、TASKS台账。

## 历史四笔受控修复方案（本次不执行）

CHZUSDT、TIAUSDT、MAGICUSDT、BUSDT 保持原记录、原审计和未知收益。legacy ACCOUNTING_PENDING 无仓位时 reconcile 只读返回，不写状态/审计、不释放门控。再次取证、追加证据、迁移状态和解锁均需独立受控授权，不随PR或未来启动自动迁移。

## 风险、回滚与未来只读验收

凭据hash仅证明运行凭据上下文，不能证明交易所法律账户身份或解释Demo历史ACK消失原因。分页有上限，超限保持未知。新文件锁不能阻止不使用本实现的旧进程；未来部署必须先证明旧进程退出。崩溃残锁会阻断启动，需在证实无执行器后另行受控处理。

本次不部署、不改库、不启停服务、不下单/撤单/平仓。未部署回滚为撤销PR；未来加载后的回滚需独立授权、备份、旧进程退出与单实例交接，不能直接启动第二实例或删除残锁。

未来经用户授权部署后的只读验收：
1. 核对版本/单实例与备份；读取现有health/signals GET，禁止强扫。
2. 对自然产生的新run核对提交指纹、ACK摘要、GET/fills/仓位核验时间链；查询异常保持未知。
3. 以签名只读GET核对每笔当前持仓及全仓止损、原计划TP/BE，不人工制造测试交易。
4. 只读SELECT复核冲突排除、未结算NetPnL/NetR null、分页数量闭合、Funding及手续费来源。
5. 四笔legacy不自动改变；任何状态释放须独立批准并追加不可变取证记录。

这些步骤仅为未来验收方案，本次未执行；离线通过不等于在线可靠性或盈利性已验证。
