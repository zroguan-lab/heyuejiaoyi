# TEAM-004 Clash代理路径只读对照

用户确认Clash Verge、规则模式；截图显示系统代理开启、TUN关闭、端口7897。未修改Clash模式、节点、路由、系统代理、交易服务配置或策略。

## 公共无凭据对照（2026-10-17约16:09上海）

相同URL：https://demo-fapi.binance.com/fapi/v1/time。仅GET，不带API Key或签名，不加载.env、不访问账户/订单。

| 诊断工具与路径 | 结果 |
|---|---|
| curl直连（禁用环境代理） | 4.015s连接超时；DNS约0.048s，无TCP/TLS连接完成证据 |
| curl明确使用http://127.0.0.1:7897 | HTTP200，约0.916s，TLS约0.802s |
| Node24.14临时子进程，--use-env-proxy但清空代理环境 | 8.004s TimeoutError |
| Node24.14临时子进程，明确HTTP_PROXY/HTTPS_PROXY7897，NO_PROXY本机 | HTTP200，约0.523s |

Node测试只在临时子进程传入环境，未改变父/系统/运行交易进程环境；不是第二个交易执行器。未关闭证书验证。

## 关键反证：原进程已连接代理

16:10:28只读Get-NetTCPConnection统计3000监听进程PID11888：31条指向本机7897的连接，未见其他本机代理端口，外部443连接数0。只能证明当时已存在通过7897的连接，不能给每个请求判定最终Clash分流或上游节点。

因此：
- 本次明确代理路径可用，直连在测试期限内失败，值得继续查代理链路。
- **不能说现有机器人没有走代理，也不能把加同样HTTP_PROXY当作已证实修复。**旧进程具体环境未读取，未查看Clash命中规则/上游节点。
- 诊断进程及用户/机器持久作用域未见HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY/NODE_USE_ENV_PROXY；不代表旧进程继承环境或启动时.env配置相同。
- 小样本公共校时成功不证明所有签名账户/行情端点或连续负载稳定。实际服务断连的具体原因仍未知。

Node官方24.14文档与本机node --help说明--use-env-proxy在启动时读取HTTP_PROXY、HTTPS_PROXY、NO_PROXY；开系统代理本身不是该进程代理环境的证据。参考：https://nodejs.org/download/release/v24.14.0/docs/api/cli.html#--use-env-proxy 。

下一证据：Clash连接页对demo-fapi.binance.com的命中规则与节点（仅该条，不要订阅链接/控制secret/密钥），以及应用并发/重试时序；未获证据前不切全局、不盲重启、不增加超时假称修复。已派运行专家交叉解释这些反证。
