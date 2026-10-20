# TEAM-007 受控部署与单实例交接验收

时间：2026-10-17 22:13–22:23（Asia/Shanghai）

## 结论

PASS。TEAM-006已验收代码完成受控加载：活动库迁移成功，旧实例退出后只启动一个新实例；新实例扫描与账户同步推进，两笔Demo持仓的交易所保护在重启后仍完整。未修改交易策略、参数、Score、止盈止损或仓位，未人工下单、撤单、平仓或强制扫描。

PASS只说明本次部署和保护交接通过，不说明V2.4.3已经盈利，也不说明量能单变量实验已经达到统计门槛。

## 部署前阻断与解除

- 22:14两次健康读取均显示扫描服务仍响应，但账户同步停在22:08:22，错误为Binance Testnet连续两次超时；缓存中PARTI与ZEREBRO均有保护意图，但当时不能作为实时交易所事实。
- Clash本地HTTP/混合端口7897访问Binance Demo公共ping得到HTTP 200，约0.53秒。
- 22:19:32使用现有Demo凭据执行签名只读GET，不打印凭据：确认PARTI -3405和ZEREBRO -1740均在仓；PARTI有全仓SL、TP1和全仓TP2，ZEREBRO已有剩余1740的BE止损和全仓TP2。保护未知阻断因此解除。

## 备份与迁移演练

### 在线预备份

- 路径：`quant-team/backups/TEAM-007-20261017-2218/research-predeploy.sqlite`
- SHA-256：`62786A5D9C4FC46D0C6E6C07B6E93592D30793FCA9FB81F6265307BFFDD3B51F`
- SQLite `integrity_check=ok`。
- 计数：signals 6906、shadow_signals 6063、execution_runs 440、execution_audit 180225、testnet_account_snapshots 11559、metadata 11。

### 隔离迁移演练

- 路径：`quant-team/backups/TEAM-007-20261017-2218/research-migration-rehearsal.sqlite`
- 新增decision_snapshots表、2个索引和3个不可变触发器。
- 原业务表计数保持不变，decision_snapshots为0；更新和删除探针均被不可变触发器拒绝；`integrity_check=ok`。

### 停机点恢复备份

- 路径：`quant-team/backups/TEAM-007-20261017-2220/research-stop-point.sqlite`
- SHA-256：`44270A0A2031287E9C23067252C1357A2FFBC72689B867A4F281742C2EA230B5`
- `integrity_check=ok`，`foreign_key_check=0`。
- 计数：signals 6906、shadow_signals 6063、execution_runs 440、execution_audit 180233、testnet_account_snapshots 11560、metadata 11。
- 活动执行：PARTI OPEN_PROTECTED、ZEREBRO TP1_FILLED。

## 单实例交接

- 部署前唯一监听：PID 11888，node.exe，启动于2026-10-16 04:35:13，命令身份包含`src/index.js`。
- 首次停止命令的Wait-Process回执不可靠，因此没有直接启动第二实例；二次核验确认PID 11888不存在且3000端口无监听。
- 活动库迁移后完整性与外键检查通过，原业务计数及两笔活动状态不变，decision_snapshots结构完整。
- 新实例：启动器PID 52056，唯一监听PID 16244；启动日志明确为V2.4.3、DEMO_AUTO_EXECUTION、V2_PRODUCTION、30秒扫描，stderr为空。

## 上线后验收

- 22:22:07：健康接口200；monitor scanCount=1、lastScanCompletedAt=22:22:02；账户connected=true、lastSuccessfulSyncAt=22:21:48；emergencyStop=false、safetyHold=false。
- 22:23:22：scanCount=3、lastScanCompletedAt=22:23:16；账户同步推进到22:22:54；自动执行WATCHING，最近决策NO_ELIGIBLE_SIGNAL。
- 活动库已产生2条`SHADOW_DECISION`不可变快照，`quick_check=ok`；PARTI保持OPEN_PROTECTED，ZEREBRO保持TP1_FILLED。
- 22:23:54签名只读GET再次确认：PARTI -3405对应SL+TP1+TP2；ZEREBRO -1740对应BE止损+TP2；共5个条件保护单，无普通挂单。
- 3000端口只有一个监听者PID 16244。

## 已知限制与透明记录

- Demo账户`canTrade=false`，系统通过每笔安全订单测试路径判断交易权限；本次没有触发测试订单或新订单。
- 健康接口readiness中的“已有仓位/已有条件单”检查为false是持仓存在的预期事实，不等于保护失败；实时保护以签名只读GET结果为准。
- 一次临时健康探针为缩短Node连接驻留使用`process.exit(0)`，退出时打印libuv assertion；该探针不是服务进程。随后唯一监听、健康推进及签名账户快照均通过，未观察到服务影响。
- 当前只有2条前向决策快照，不足以判断量能因子、胜率或期望值。下一阶段不得因部署成功而提前调整Score、止盈止损或仓位。

## 回滚点

若后续发现迁移相关结构错误，先停止唯一新实例并确认没有SQLite写入者，再使用停机点备份恢复；不得将备份主库与当前WAL/SHM混用。任何恢复动作需再次核实交易所持仓与保护。

## 独立终审

独立测试与审查专家于22:25–22:28只读复核后给出限定PASS：停机点SHA、备份及活动库完整性/外键、业务计数、快照结构、旧新PID与单监听均匹配；健康GET 200，scanCount已推进至9，账户同步新鲜，紧急停止与安全暂停均为false。其本地与服务同步摘要确认PARTI、ZEREBRO两笔状态及5个保护单、无普通挂单。专家没有直接调用交易所签名接口；总控在22:23:54已另行完成签名只读复核。
