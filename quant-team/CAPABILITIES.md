# 能力与依赖登记

状态定义：AVAILABLE=工具可调用；CONFIGURED=已写岗位/技能；VERIFIED=指定案例实测通过；PARTIAL=只覆盖部分；DEFERRED=当前任务不需要；BLOCKED=当前任务依赖且不可用。
日期：2026-10-16。部署完成后以验收报告为实测证据，不能沿用旧会话结论。

## 资源
- 多Agent：提供创建、消息、跟进和等待工具；并发上限4（包含总控）；本轮不修改平台配置。
- Node v24.14.0、Git 2.53.0、ripgrep 15.1.0、node:sqlite已在前轮核验；本轮用具体案例再测需要部分。
- Python运行时：C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe。
- 本轮校验依赖：PyYAML 6.0.3安装到 C:/Users/Lenovo/AppData/Local/Temp/quant-team-validation-pyyaml，仅供技能校验；未安装进交易运行时或package.json。沙箱TEMP与宿主TEMP不同，调用时显式将上述目录加入校验进程sys.path。官方quick_validate.py的8/8技能格式校验已通过。
- 前轮依赖探测：NumPy、Pandas、OpenPyXL存在；SciPy、Statsmodels、Scikit-learn、Matplotlib、pytest未发现。交易运行环境未安装新包；PyYAML仅为临时校验依赖，见上文。
- 本轮只读核验与纯函数统计不依赖缺失包；统计技能允许在NumPy中实施固定随机种子的区块bootstrap，复杂模型需要时再补依赖与数值验证。
- GitHub前轮真实只读访问成功；本轮不发布、不push，不把连接成功当发布能力验收。
- Binance/TradingView专用插件前轮搜索无结果；项目已有行情/执行接口。本轮通过本地GET观察，不安装额外交易插件。
- Excel通用技能已可发现；本轮不写Excel，不宣称已验收实时Excel会话。
- Grok外部模型接口未接入；本团队专家沿用父Agent模型，不伪装成Grok或异构模型评审。

## 本地技能目录
| 岗位 | 显式加载文件 |
|---|---|
| 策略研究 | skills/quant-research/SKILL.md |
| 数据工程 | skills/point-in-time-audit/SKILL.md |
| 回测统计 | skills/backtest-validation/SKILL.md |
| 风险管理 | skills/portfolio-risk-review/SKILL.md |
| 执行后端 | skills/demo-execution-review/SKILL.md |
| 独立审查 | skills/independent-qa/SKILL.md |
| 运行可靠性 | skills/runtime-readonly-health/SKILL.md |
| 绩效复盘 | skills/performance-attribution/SKILL.md |

这些技能通过项目AGENTS.md加载，未写入全局技能目录；新开聊天是否自动发现取决于宿主，显式读取路径始终为本项目恢复方式。
岗位文件和调用权限不同：本轮全部专家只读，不能认为每个专家拥有独立API密钥或沙箱。

## 按岗工具边界
| 岗位 | 本轮允许使用 | 未授予 |
|---|---|---|
| 总控 | 文件读取、协作调度、治理文档apply_patch、技能校验、只读复核 | 策略/配置/数据库写入、交易动作、发布 |
| 策略 | rg/源码读取、纯函数内存演练、专家消息 | 调参、上线、访问凭据 |
| 数据 | node:sqlite readOnly事务与SELECT、字段血缘读取 | Store.initialize、UPDATE/INSERT/DDL、采集回填 |
| 回测统计 | 纯函数/内存统计、验证代码阅读、专家消息 | 写研究仓库、读取封存、自动参数搜索 |
| 风险 | 风险调用链阅读、内存计算、脱敏快照 | 风险配置修改、账户操作 |
| 执行 | 执行器和合约规则源码、纯函数演练 | 签名接口、下单/撤单/平仓、解锁 |
| QA | 独立读取、无副作用反例、岗位/技能结构校验 | 修改被审实现、自己宣告端到端交易通过 |
| 运行 | GET前端/health/signals、脱敏状态比较 | POST、扫描触发、服务启停 |
| 绩效 | readOnly SQLite、纯投影/统计、脱敏分组 | 修改Excel/原始流水、混算账户/版本 |

当前工具层未提供以上岗位的独立权限强制配置；本表是明确操作合同，结合命令审计与文件哈希复核，不宣称硬隔离。
