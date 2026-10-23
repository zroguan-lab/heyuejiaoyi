# TEAM-012 Demo账户重置恢复与新纪元验收

状态：**COMPLETE / DEPLOYED / FORWARD_COLLECTION_ACTIVE**  
日期：2026-10-24（北京时间）  
代码分支：`codex/team-011-entry-accounting`  
部署提交：`2dde4f435272503f397aa77d8d4cf7b99210c840`

## 结论

Binance Demo账户重置后的本地遗留门控已按审计边界处理，V2.4.3新前向绩效纪元已经开启，唯一服务实例已恢复扫描与Demo自动执行。此次没有修改Score、准入、方向、止盈止损、仓位、杠杆、成本门槛或策略版本，也没有人工下单、撤单、平仓或强制扫描。部署成功不代表策略已经盈利。

## 部署前事实与备份

- 服务停机：3000端口无监听，执行锁不存在。
- 活动库：`PRAGMA quick_check=ok`，外键问题0。
- 一致性备份：`quant-team/backups/TEAM-012-20261024-000729/research-pre-epoch.sqlite`。
- 备份SHA-256：`79696F2F5222795D6DB6F2405BE0438FE642E221D82E752482F862F8560CFD7B`。
- 备份计数：execution_runs 494、execution_audit 210277、decision_snapshots 1259，与停机点活动库一致。
- 旧活动纪元：`V2.4.3-20261015203537`。
- 旧非终态run：AUSDT `OPERATOR_CLOSE_UNKNOWN`；CHZUSDT、CTSIUSDT、TIAUSDT、MAGICUSDT、BUSDT共5条`ACCOUNTING_PENDING`。
- 旧紧急停止：`ACTIVE_STOP_MISSING`，归属AUSDT旧run。

## 交易所账户与权限证据

迁移工具在获取执行器同源`wx`独占锁后，通过Binance Demo签名只读GET重新核验：

- authority=`BINANCE_TESTNET`，positionMode=`ONE_WAY`；
- availableBalance=5000U；
- 0持仓、0普通挂单、0条件挂单；
- 账户证据时间与事务提交相差7毫秒，满足60秒新鲜度门槛；
- 脱敏证据hash：`00419956d8026596dafe8d4c9a3256bfecac05be057e974e0c9610e660385206`。

此前独立执行`/fapi/v1/order/test`权限探针：`permissionAccepted=true`、`submittedToMatchingEngine=false`，探针前后均为0仓位、0订单。Binance账户字段`canTrade=false`仍按项目既有规则由每笔信号前安全探针复核，没有把该异常字段隐瞒或改写。

## 原子迁移结果

新纪元：`V2.4.3-20261023161504-631`，起点`1792772104631`。

- 保持`V2_PRODUCTION`、V2.4.3执行版本、V2.4.3信号模型、`MARKET_RADAR_R3_PREMOVE`和策略账startingEquity=500不变。
- 500是冻结的策略绩效基线；交易所5000U余额只作为账户基线，两者不混算账户收益率。
- 旧纪元去重封存并记录`DEMO_ACCOUNT_RESET`结束原因。
- 6条旧run均追加`ACCOUNT_RESET_RECONCILED`审计，审计保存迁移前完整run、payload hash、旧状态和证据hash。
- 6条旧run转为`FAILED / ACCOUNT_RESET_SUPERSEDED`，排除绩效，`netPnl=null`、`netR=null`、`accountingComplete=false`。
- 活动run变为0；紧急停止在同一事务内以`ACCOUNT_RESET_RECONCILED`证据解除。
- 迁移后`quick_check=ok`、外键问题0、执行锁正常释放。

## 实现与测试

新增受控模块和脚本：

- `src/execution/demo-account-epoch-reset.js`
- `scripts/rotate-demo-account-epoch.js`
- `test/demo-account-epoch-reset.test.js`
- `npm run demo:reset-epoch`

安全性质：签名GET至数据库COMMIT全程持有与执行器相同的进程锁；CAS校验旧纪元；只允许两类已知旧状态；账户不干净、未知活动状态、证据过期/未来、纪元或幂等证据漂移均失败关闭；历史、run审计、新纪元和紧急停止在一个事务中提交。

验证结果：

- 定向重置与进程锁测试：9/9通过；
- 最终完整测试：370/370通过，0失败、0跳过；
- `npm run check`通过；`git diff --check`通过。

独立QA先发现“仅检查锁文件仍存在GET到COMMIT竞态”，总控修为实际持锁；随后QA又要求幂等状态漂移、证据hash和证据新鲜度反例，均补齐后才给离线PASS。失败意见没有被隐瞒。

## 在线验收

- 父进程PID 26552；唯一3000监听PID 40936；执行锁PID 40936，与监听一致。
- `GET /api/health`返回200，mode=`DEMO_AUTO_EXECUTION`。
- scanCount从启动时0推进到3，最新状态IDLE且完成时间推进。
- Binance Demo账户连接成功、同步时间推进；0持仓、0普通单、0条件单。
- emergencyStop=false、safetyHold=false、activeRuns=0。
- effectiveOrderSubmissionEnabled=true，automation=`WATCHING`，绩效起点与新纪元一致。
- 错误日志为空；没有人工制造交易。

## 回滚与残余风险

- 新纪元尚无自然订单或仓位时，可受控停机后恢复停机点备份。
- 新纪元一旦出现订单、持仓或新审计，禁止直接恢复旧数据库；应先冻结新入场，在当前库完成保护与对账，再决定代码回退。
- 当前只证明运行和安全边界恢复，不证明V2.4.3具有正期望或长期盈利能力。
- 本次未把三份既有未跟踪TEAM-011诊断材料混入提交，避免未经复核的证据随部署提交。

## 团队讨论摘要

- 数据/绩效岗位：仅换active epoch不够；必须同时隔离6条旧run，策略账500与账户余额5000分开。
- 运行/风险岗位：旧紧急停止和6条非终态会阻止安全恢复；必须先账户清空、备份、迁移，再单实例启动。
- 独立QA：两次提出阻断反例，分别关闭进程竞态和伪幂等/陈旧证据问题；最终接受370/370的离线实现。
- 总控：以Binance Demo为实时账户事实源、SQLite为意图与审计事实源；旧未知收益不回填，新纪元只接收边界后的自然数据。

