# TEAM-004 浏览器反证与条件平仓决定

日期：2026-10-17（上海）。PARTIAL：本地页面与健康已可取得响应、扫描/持仓管理有推进；上游行情/账户仍有超时，未作全系统PASS。

用户回复SQD还在后台、若影响整体可立即平仓。该授权是特定Demo单的条件授权，不代表已经证明持仓造成超时。本轮没有提交任何平仓/撤单/解锁请求，未控制旧进程或修改策略。

## 后续事实与纠正

- 15:22:36总控只读DB，SQD run canary-efd5a8f116de25已于15:22:27更新TP1_FILLED，原stop CANCELED、BE NEW；旧PID11888仍监听。不能把15:06短窗口“未见推进”外推为持续停摆。
- 执行专家15:23:45只读复核：最近POSITION_RECONCILED15:23:25，入场4694、TP1成交2347、剩余2347，BE BUY/reduceOnly NEW数量2347@0.0213，TP2 BUY/closePosition NEW@0.02094。属于近期保存响应，不是直接交易所实时再查询。
- 主控改用Computer Use技能与浏览器只读通道：15:23:47成功打开/api/health（serverTime07:23:47.234Z），scanCount1530、lastScanCompleted15:23:01.145，account connected=true、lastSync15:22:46.696；emergencyStop=false、safetyHold=false、automation WATCHING。
- 浏览器账户快照确认SQD quantity=-2347，BE为NEW、reduceOnly=true、quantity2347、trigger0.0213；TP2 NEW、closePosition=true、trigger0.02094。
- 根页面goto导航等待曾超时，但随后实际AX已完整渲染“合约信号雷达”、V2.4.3与SQD止盈一完成；不能以导航工具等待超时代替页面最终状态。页面15:23:59出现账户同步超时与主行情源不可用，不能隐瞒。
- 第二次浏览器health serverTime15:25:25.918，scanCount1531（前次1530）、lastScanCompleted15:23:59.545；账户connected=true、IDLE、lastSuccessfulSync15:24:54.875、error=null，仓位与保护相同，紧急/安全锁仍false。

结论：当前有浏览器响应、扫描推进与持仓保护管理证据；原命令行TCP/HTTP超时及数据库短窗口停更不足以证明整个服务停机。通道差异、间歇延迟的具体原因尚未定位，不把“诊断通道问题”当作已排他证明的根因。

## 真实残留问题

- health持续有universeError/radarError=timeout，雷达快照15:08:40落后约17分钟；网页在账户两次成功响应之间曾显示只读请求timeout，存在实际上游不稳定。
- 旧服务进程尚未加载TEAM003后端修复：页面新前端可显示“覆盖未知”，旧统计仍显示空集0等旧口径。没有热加载/部署成功声明。
- 已检查离线受控平仓脚本：endpointReachable将HTTP超时视为不可达，不能据此证明旧执行器已退出；而validateCloseTarget要求closePosition全量止损，不适配当前数量型BE保护。不得绕过这些问题执行第二个管理进程。本轮未改脚本或借超时绕过并发检查。

## 决定与下一步

未证明SQD妨碍整体运行，且已有TP1/BE管理推进证据，因此不触发条件平仓，也不盲重启。继续研究上游连接/数据新鲜度与诊断通道差异时，策略与交易权限边界不扩大。需要恢复加载或任何影响现有订单的操作时，再提交具体安全步骤与用户商量。

仅保存本页脱敏聚合，不保存完整账户响应/凭据。没有登录新账户、运行第二执行器或触发扫描。
