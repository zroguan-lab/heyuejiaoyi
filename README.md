# 合约量化研究系统

这是一个本地运行的加密货币永续合约信号、模拟组合与 Binance Demo 验证系统。当前唯一运行版本是 `V2.4.1`：Pre-Move信号先寻找波动收缩且靠近结构边界的标的；LONG还需通过雷达方向、15分钟与5分钟量能、收缩有效性和5分钟收盘确认。预估总成本不超过0.20R进入普通组，0.20R至0.35R进入高成本探索组，超过0.35R拒绝Demo入场。被拒绝信号仍留在后台反事实研究账本，生产交易域名始终不可用。V2.4及更早版本仅保留为冻结基线和既有订单的历史归属，不再产生新候选或新订单。

## 当前能力

- Binance USDⓈ-M 永续合约作为主行情事实源，Hyperliquid 只做辅助价格核验，主源失败时不会静默切换。
- 每5分钟先从100个高流动性USDT永续中，用已收盘15分钟K线计算收益、波动收缩、量能抬升、结构边界距离、排名速度和相对强弱，再选择最多30个标的进行深度扫描；每次换池保留 SQLite 历史快照。
- 1小时趋势决定方向，15分钟收缩与边界位置判断是否处于爆发前窗口，5分钟量能和方向压力确认是否允许提前布局。
- V2.4.1只生成 `PRE_BREAKOUT LONG/SHORT` 新信号；V2.4及更早版本冻结为历史，不再成为新订单来源。
- 爆发前信号使用受10bps不利滑点上限约束的主动IOC限价，信号在2根5分钟K线后失效。
- 高吞吐 Demo 组合：500 USDT 研究本金、单笔约 10 USDT 逐仓保证金、10 倍杠杆；所有达到评分门槛、预估总成本不超过0.35R且通过执行校验的不同标的信号都进入测试，并按普通成本组/高成本探索组独立留痕，不设置固定持仓笔数。
- 面向多仓的请求控制：执行对账复用一份账户快照，K 线按收盘周期缓存；Binance 418/429 会在行情、账户和交易客户端间共享暂停窗口，防止重复请求延长封禁。
- 止损使用结构与 ATR，TP1 为 1.5R 平半仓，随后止损移动到保本，TP2 为 2.5R。
- 记录手续费、滑点、资金费率、毛收益和净收益；成交路径优先使用 1 分钟 K 线，仍无法判定时按止损优先。
- SQLite 保存候选、入选/拒绝原因、模拟交易生命周期和标的池快照；这些研究审计默认不在主界面展示。
- 签名读取 Binance 测试网账户、持仓模式、全账户普通挂单、Algo 条件单和目标合约配置，并将脱敏快照投影到 SQLite；交易所返回值是测试网执行状态的事实源。
- 白名单 USDT 永续信号执行支持同标的唯一活动计划、限价入场、部分成交后撤余单、全仓止损、两级止盈、TP1 后无缝切换保本止损、订单幂等、重启恢复和手续费/资金费/盈亏审计。
- 每个正式 Demo 入场和保护订单都在提交前固化一句话交易原因；原因、策略版本、评分和市场事件批次进入执行计划哈希，主动平仓也必须显式提供原因。
- 自动协调器只接受刚进入模拟组合、状态为等待入场且剩余有效期不少于 30 秒的真实策略信号；旧信号、人工技术验证、已成交和已过期记录不会追单。
- 执行就绪检查会阻止生产域名、无交易权限、双向持仓、既有仓位、普通挂单或条件挂单进入试单阶段。
- 本地网页、SSE 实时更新、Windows 桌面通知与提示音。主界面只展示策略驱动的 Binance Demo 交易流水，人工技术验证与研究审计不混入绩效。
- V1、V2.1、V2.2、V2.3与V2.4执行已经停用并只保留历史；当前 `shadow_signals`、候选评分、Demo晋级和新订单全部使用V2.4.1版本标识。
- V2.4.1使用双层实验：70分及以上为A级核心层，55–69分为B级探索层。LONG新增执行确认闸门；未确认LONG仍留在反事实研究账本，不进入Demo。SHORT评分、结构止损和1.5R/2.5R止盈保持V2.4不变。
- Demo阶段不因相关性或本地总风险预算截断不同标的样本，也不设置固定总持仓笔数；同一标的唯一、交易所余额、单向持仓和保护单安全约束继续生效。
- 主绩效按A级/B级以及 `PRE_BREAKOUT LONG`、`PRE_BREAKOUT SHORT` 独立统计，同时保留V2.2四类历史分组，并显示首批100笔已结算可比较样本进度。

## 安全边界

系统没有对外开放交易所下单或撤单 HTTP 接口。交易客户端只允许精确域名 `https://demo-fapi.binance.com` 和当前监控标的白名单；默认 `BINANCE_TESTNET_EXECUTION_ENABLED=false` 时，所有签名写请求在本地直接拒绝。解锁后也只开放经过列举的限价单、Algo 保护单、单笔撤单、逐仓和杠杆设置，不提供账户级全撤或生产域名路径。

本地“模拟组合”与 Binance 测试网账户严格分账：前者由研究策略和 SQLite 生命周期驱动；后者以 Binance 返回的订单与持仓为事实源。系统不会认领、平掉或修改测试网中原本存在的仓位。

`.env` 已被 `.gitignore` 排除。不要把密钥粘贴到聊天、日志、截图或源码中。测试网与真实账户必须长期使用不同密钥，且将权限限制为任务真正需要的最小集合。

## 启动

要求 Node.js 24 或更新版本，无第三方 npm 依赖。

```powershell
Copy-Item .env.example .env
npm start
```

打开 <http://127.0.0.1:3000>。运行测试和语法检查：

```powershell
npm test
npm run check
```

如果 Binance 域名被本机 DNS、代理、防火墙或地区网络策略阻断，页面会明确显示主行情源不可用，并停止产生新信号；系统不会改用辅助源伪装成主源。

Node.js 不会自动沿用 Windows 的“系统代理”开关。本项目启动命令会读取 `.env` 中的 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`；使用 Clash 等本地代理时应填写其本机 HTTP/混合端口，并始终把 `127.0.0.1,localhost` 放入 `NO_PROXY`，避免本地面板流量绕行代理。

## 关键配置

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `PRIMARY_MARKET_PROVIDER` | `binance` | 主行情事实源 |
| `AUXILIARY_MARKET_PROVIDER` | `hyperliquid` | 辅助核验源，不参与故障接管 |
| `DYNAMIC_UNIVERSE` | `true` | 启用动态标的池 |
| `UNIVERSE_SIZE` | `30` | V2.4爆发前候选深度池上限；允许20–40 |
| `UNIVERSE_REFRESH_HOURS` | `168` | 每周刷新标的池 |
| `POLL_SECONDS` | `30` | 实时扫描间隔 |
| `SIMULATED_EQUITY_USDT` | `500` | 模拟本金 |
| `MARGIN_PER_TRADE_USDT` | `10` | 每笔模拟保证金 |
| `LEVERAGE` | `10` | 模拟杠杆 |
| `FALLBACK_TAKER_FEE_RATE` | `0.0005` | 无精确费率时的单边费率 |
| `FALLBACK_SLIPPAGE_RATE` | `0.0002` | 主动限价的保守滑点假设 |
| `WINDOWS_NOTIFICATIONS` | `true` | Windows 本地通知 |
| `SHADOW_V2_ENABLED` | `true` | 启用独立 V2 评分与研究账本；该域自身不会开启交易权限 |
| `SHADOW_V2_CORE_MIN_SCORE` | `70` | V2.4 A级核心层最低评分 |
| `SHADOW_V2_EXPLORATION_MIN_SCORE` | `55` | V2.4 B级探索层最低评分 |
| `SHADOW_V2_SAMPLE_TARGET` | `100` | 首批可比较已结算样本目标 |
| `SHADOW_V2_RISK_PERCENT` | `0.5` | V2.4 本地研究账本单笔目标风险百分比；Demo订单仍使用统一10U目标保证金 |
| `SHADOW_V2_MAX_COST_R` | `0.2` | 成本质量评分归零的参考值，不再单独硬拒绝 |
| `SHADOW_V2_EXTREME_COST_R` | `0.35` | 极端成本硬拒绝边界 |
| `BINANCE_TESTNET_ACCOUNT_READ_ONLY` | `false` | 启用测试网签名只读账户同步 |
| `BINANCE_TESTNET_ACCOUNT_POLL_SECONDS` | `60` | 账户只读同步间隔 |
| `BINANCE_TESTNET_RECV_WINDOW_MS` | `5000` | 签名请求接收窗口 |
| `BINANCE_TESTNET_EXECUTION_ENABLED` | `false` | Binance Demo 写入总锁 |
| `BINANCE_TESTNET_AUTO_EXECUTION_ENABLED` | `false` | 自动执行新产生的合格模拟组合信号；依赖写入总锁 |
| `BINANCE_TESTNET_EXECUTION_STRATEGY` | `V1_ALL_ELIGIBLE` | 自动执行唯一来源；生产切换值为 `V2_PRODUCTION` |
| `BINANCE_TESTNET_CANARY_SYMBOL` | `BTCUSDT` | 人工技术验证使用的默认标的，不限制策略信号标的 |
| `BINANCE_TESTNET_CANARY_MARGIN_USDT` | `10` | 金丝雀目标保证金，当前配置强制为 10 |
| `BINANCE_TESTNET_CANARY_LEVERAGE` | `10` | 金丝雀杠杆，当前配置强制为 10 |
| `BINANCE_TESTNET_CANARY_POLL_SECONDS` | `15` | 批量执行状态对账间隔；最小 5 秒，避免随持仓数放大请求量 |
| `BINANCE_TESTNET_MAX_NOTIONAL_OVERAGE_RATE` | `0.05` | 为满足交易所精度和两级止盈允许的最大名义价值上浮 |
| `BINANCE_RESEARCH_BASE_URL` | `https://fapi.binance.com` | 历史研究专用公共只读行情域名；不读取Demo密钥，也没有交易端点 |
| `HISTORICAL_DATA_ROOT` | `research-data` | 内容寻址的历史原始数据目录；与Demo SQLite隔离 |

完整示例见 `.env.example`。运行时配置会校验数值范围。

## Binance Demo 策略执行

只读查看执行与账户状态：

```powershell
npm run canary -- status
```

只验证 API 密钥的合约交易权限（调用 Binance `/fapi/v1/order/test`，不会进入撮合、不会产生订单或仓位）：

```powershell
npm run canary -- validate-permission
```

执行器只接受仍在等待成交、已进入模拟组合且属于当前动态标的池白名单的信号。`prepare` 只生成并持久化不可变计划，不发送订单：

```powershell
npm run canary -- prepare <signalId>
```

真正提交必须同时满足：测试网环境、账户可交易或当前信号通过不进撮合的安全订单测试、单向持仓、账户内现有仓位和订单都能归属于系统且均有活动止损、同标的没有其他活动执行记录、计划未过期、交易原因已固化、写入总锁开启，以及一次性确认码正确。自动模式不设置固定持仓笔数；实际可用余额不足时由交易前校验或 Binance Demo 拒绝，并留下明确审计记录。

紧急停止只阻止新入场并撤销系统自己的未成交入场单；提交结果未知的订单即使延迟出现，也会在恢复查询后撤销。已有仓位的保护单不会被账户级粗暴全撤，持仓、挂单或未结束记录存在时也不能解除紧急停止：

```powershell
npm run canary -- emergency-stop MANUAL
```

## 回测与验证

V2.3已经建立统一策略契约：实时扫描和后续历史重放必须调用同一个策略引擎，且历史适配器发现未来K线或未来雷达数据时会直接拒绝。当前运行配置会生成不含密钥的稳定指纹并写入SQLite metadata。可用下面命令查看当前脱敏快照：

```powershell
npm run snapshot:v2.3
```

M0/M1的权威边界、当前基线指纹和未完成范围见 [V2.3策略基线与历史重放契约](docs/V2_3_STRATEGY_BASELINE.md)。当前研究路线统一使用 `RESEARCH-M2/M3/M4/M5`；旧版多仓发布的 M3 统一称为 `EXEC-M3`，避免和历史雷达重建混淆。其已被当前 Demo 执行层吸收，旧源码与发布资料仅保留在 `backups/legacy-exec-m3-source-20261004.zip` 中。

V2.3已冻结首批114笔Binance Demo正式前向盈利基线，仅包含当前绩效纪元内、由策略信号驱动且账务完整的已平仓订单。可使用 `npm run report:v2.3-demo` 按冻结截止时间重现相同样本；人类可读结论见 [114笔V2.3 Demo盈利基线归因](docs/V2_3_DEMO_PROFITABILITY_BASELINE.md)，机器可读产物为 `research-data/v2-3-demo-baseline-114.json`。该报告不替代M5严格历史走步验证。

M7的第一个单变量实验是 [V2.4 Demo成本门控](docs/V2_4_COST_GATE_EXPERIMENT.md)：V2.4沿用冻结对照组的信号规则、评分、止损和1.5R/2.5R止盈，仅新增预估总成本不得超过0.20R的Demo硬门；高成本候选仍保留反事实模拟结果。

M2已经建立独立历史数据目录，M6又加入逐时点全市场成交额排名、买一卖一与点差快照。原始事实按UTC月份分区，压缩对象以SHA-256内容寻址；同一分区更新会生成新修订并保留旧对象。同步使用生产市场的公共只读接口，不加载Demo API密钥，也不会调用任何订单端点。先用小范围进行数据金丝雀：

```powershell
npm run data:sync -- BTCUSDT 1
npm run data:snapshot
npm run data:sync-top -- 10 1 0
# 后续批次必须复用首批输出的 selectionSnapshot.capturedAt
npm run data:sync-top -- 10 1 10 <snapshotCapturedAt>
npm run data:audit
```

第一个命令同步最近1天BTC数据；第二个只保存当前全市场快照；第三个按已封存流动性排名同步Top10最近1天。后续排名批次必须传入首批输出的 `selectionSnapshot.capturedAt`，以固定同一榜单和同一分钟时间窗；缺少该参数时命令会拒绝运行。天数允许1–180，单批最多50个标的。审计会核对对象哈希、OHLC结构、1分钟连续性、全市场快照结构、买一卖一与点差一致性、首尾覆盖和冲突记录。完整的数据所有权与边界见 [历史数据目录](docs/HISTORICAL_DATA_CATALOG.md)。

M3历史雷达重建会从1分钟事实确定性生成5m、15m、1h和4h闭合K线，再调用与实时系统相同的 `buildMarketRadarSnapshot` 和V2.3历史适配器。严格模式要求决策时点以前已经存在的合约与全市场快照；M6采集开始之前的时段仍缺少这些事实，只能显式运行研究模式：

```powershell
npm run replay:v2.3 -- --research-only-current-metadata
```

增加 `--points=12` 可连续重建最近12个雷达时点并观察排名速度。研究模式采用最大允许点差作为保守代理，并将 `promotionEligible` 固定为 `false`。如果目录覆盖不足100个当时合格标的，也不能把结果称为历史Top100回测。详细边界见 [V2.3历史雷达重建](docs/HISTORICAL_RADAR_REPLAY.md)。

M4可继续把逐时点V2.3决策回放成限价成交/取消、止损、TP1/TP2、手续费、滑点、Funding、多仓组合及500U权益曲线：

```powershell
npm run replay:portfolio -- --points=288
```

增加 `--full` 可输出逐笔事件、拒绝记录和完整权益曲线。当前IOC使用下一分钟开盘价检查滑点边界，缺少历史盘口与队列位置，因此结果只用于研究，详细边界见 [V2.3历史交易与组合回放](docs/HISTORICAL_PORTFOLIO_REPLAY.md)。

M5走步验证默认封存最后20%样本，并输出数据覆盖、分层表现和晋级闸门：

```powershell
npm run validate:v2.3 -- --research-only-current-metadata --points=288
```

增加 `--stability` 可验证三组邻近阈值。封存集只有在策略与参数冻结后才能用明确口令打开，具体协议见 [V2.3走步验证与封存样本](docs/V2_3_VALIDATION_M5.md)。

逐时点榜单和盘口不能倒填。独立公共只读采集器默认每5分钟保存一次全市场快照、每天保存一次合约规则，并将状态写入 `research-data/fact-collector-status.json`：

```powershell
npm run data:collect-facts
```

只验证一次采集链路可增加 `-- --once`。Node启动前只读取不含密钥的 `.env.public` 以建立代理，运行后再从 `.env` 白名单加载公共行情、目录与频率变量；Demo API密钥不会进入该进程。采集器只允许 `https://fapi.binance.com`，不调用账户或订单接口，并与线上Demo交易进程相互隔离。

旧版多周期回测仍可从 Binance 分页获取 1h、15m、5m、1m K 线及资金费率。它不代表V2.3结果；V2.3盈利能力在历史全市场覆盖完成前仍以独立前向Demo纪元为主要依据。下面命令回测 BTCUSDT 最近 30 天；第二个参数可改为 7–180 天：

```powershell
npm run backtest -- BTCUSDT 30
```

也可以传入逗号分隔的多个标的，按“全部合格信号”策略共同回测（最多 50 个）：

```powershell
npm run backtest -- BTCUSDT,ETHUSDT,SOLUSDT 30
```

标的和区间越多，需要下载的 1 分钟数据越多；建议先用 3 个标的检查配置，再分批扩大样本。

输出包括：

- 模拟组合、突破/回调策略、多/空方向的独立结果；
- 成交率、过期率、胜率、Profit Factor、毛/净收益、成本、净 R、回撤；
- 每个扩展窗口实际运行后的样本外结果，而不只是验证区间方案；
- 最后 20% 数据的封存测试区间，默认保持未打开；
- 晋级闸门：至少100笔样本外/前向已结束交易、平均净R大于0.10R、PF不低于1.2、最大回撤低于10%、单一币种利润占比低于20%、单一市场事件低于25%，并要求封存集最终验证；
- 邻近参数稳定性可使用导出的 `evaluateParameterStability` 统一评估，不能只报告最优单点。

封存集不应参与调参。旧版单周期回测仅为兼容保留，可运行 `npm run backtest:legacy`。

## 本地 API

| 接口 | 用途 |
| --- | --- |
| `GET /api/health` | 服务、行情源与扫描状态 |
| `GET /api/signals` | 当前候选、活动执行组合、V2研究账本、当前绩效纪元与历史绩效 |
| `GET /api/history?limit=100` | 信号审计记录 |
| `GET /api/universe-history?limit=52` | 历史标的池快照 |
| `GET /api/manual-trades` | 手动跟单记录 |
| `POST /api/manual-trades` | 记录实际成交价与数量，不会下单 |
| `GET /api/config` | 脱敏运行参数，不返回任何 API 密钥 |
| `GET /api/execution/status` | 测试网只读账户、锁定的执行网关和下一阶段就绪检查 |
| `GET /api/execution/runs` | Demo 策略执行状态与审计投影；不能通过 HTTP 发单 |
| `POST /api/scan` | 手动触发扫描 |
| `GET /api/events` | SSE 实时事件 |

服务默认只监听 `127.0.0.1`。在增加身份验证、TLS 和访问频率限制前，不应暴露到局域网或公网。

## 项目结构

```text
src/exchanges/       主/辅助行情适配、历史分页、资金费率
src/domain/          市场结构、策略、组合选择、交易生命周期
src/domain/v2-3-strategy-engine.js  V2.3实时/历史统一策略契约与未来数据防线
src/application/     动态标的池与实时扫描编排
src/research/        独立历史数据目录、不可变对象、同步与缺口审计
src/research/historical-market-replay.js  历史多周期聚合、逐时点雷达与统一V2.3适配
src/research/historical-portfolio-replay.js  V2.3历史订单生命周期、组合账与权益曲线
src/research/v2-3-validation.js  V2.3走步窗口、封存样本、分层统计与晋级闸门
src/execution/       测试网客户端、合约规则、执行状态机、幂等恢复与安全锁
src/infrastructure/  SQLite 审计存储与 Windows 通知
src/http/            本地 API 与事件流
src/research-backtest.js  多周期研究回测与验证计划
scripts/sync-historical-data.js  公共只读历史数据同步与目录审计
scripts/collect-historical-facts.js  独立逐时点全市场事实采集器
scripts/replay-v2-3-history.js  历史目录单时点V2.3重放金丝雀
public/              本地研究面板
test/                完全离线的自动测试
```

设计边界与进入自动交易前的缺口见 [架构与安全边界](docs/ARCHITECTURE.md)。
