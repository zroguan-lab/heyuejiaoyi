# TEAM-029 下一版单变量策略与可靠性上线

用户于2026-11-06明确要求结合TEAM028报告优化下一版、检查BUG并上线运行。目标为提升长期扣费净期望，同时保持执行安全。本合同不授权真实资金、人工交易或绕过安全锁。

## 阶段A 先只读对齐与诊断

- 当前活动源码历史定位为TEAM024 release，TEAM027恢复；根目录已有TEAM019因子dirty接线、TEAM025/026离线修复，另有2026-11-06 16:54起的V2.4.4 BOUNDARY+COMPRESSION草稿，均不能直接整包启动。
- 用户收到策略选择问题：已有边界+收缩精确二元过滤、领跌单一来源过滤、仅BUG修复。第二道明确替换第一道，用户未答前不选默认项、不同时实施两个策略变量。
- 新策略只改获确认的来源准入一个变量，Score、LONG确认、SLTPBE价格比例/顺序、保证金、杠杆、成本门槛保持；旧订单继续按原计划管理。旧148报告与原始账不改，不伪称已证明盈利。
- 不覆盖根现有草稿或活动发布文件。总控负责治理、冻结指纹、建立独立干净候选、备份/受控交接；任何业务实现先指定候选路径的唯一所有者。
- 查询现有库仅DatabaseSync(readOnly:true)+query_only+BEGIN SELECT，ROLLBACK/close；只GET已有health，15秒超时，不强扫。阶段A不读.env/凭据、不签名，不启停/解锁/操作订单/更改活动库。

## 真实专家分工

- /root/attribution_research：策略研究，只读比较单变量候选、根草稿边界与新版本兼容，不能改源码。
- /root/execution_release_review：执行后端，只读核对TEAM025/026已验收差异、当前执行故障及干净包引入路径，先提交最小修复/测试文件所有权建议；暂不写文件。
- /root/attribution_qa：独立QA，只读检查当前发布/运行与候选测试验收门槛；未来独立复测，不修改被审实现。
- 总控最多并行含自身4实例，负责真实交叉讨论，不伪装侧边栏常驻响应。

## 上线前不可放宽的门槛

明确单变量政策和版本边界、代码旧反例回归及独立全量QA；干净发布manifest排除因子与其他草稿；新鲜账户与所有现仓的保护归属可确认；在线/停机一致性可恢复备份；旧实例、监听及执行锁身份明确，确认全退出后仅启动一个实例；进程7897路由保持；旧账、旧纪元保留，策略新纪元如何续接须明确，不清除旧收益。只走原安全入口，不SQL清锁或历史回填。

用户本次要求上线不是允许忽略未知，亦不是未来自动重启/解锁授权。任何账户/保护/备份/单实例/策略选择未知，停止有影响动作并说明；不通过手动下单/撤单/平仓造验收。签名账户预检与有影响上线步骤须在本次精确部署合同中落实范围，不沿用TEAM027历史许可。

## 阶段B1 已授权离线可靠性候选

总控已核验并仅复制TEAM024 manifest143到独立目录quant-team/backups/TEAM-029-20261106/release，未启动。依据用户本次检查BUG并上线请求，执行专家/root/execution_release_review现在独占该候选内以下10文件，可用apply_patch移植已验收的TEAM025/026非策略修复并补必要隔离回归：

- src/execution/testnet-canary-executor.js、test/testnet-canary-executor.test.js
- src/execution/execution-fill-facts.js、test/execution-fill-facts.test.js
- src/execution/readiness.js、test/execution-readiness.test.js
- src/http/server.js、test/server.test.js
- src/execution/binance-testnet-trading.js、test/binance-testnet-trading.test.js

只有候选路径可写；root、活动TEAM024、TEAM020、其他草稿及数据库不得改。adapter/test须匹配TEAM025最终，TEAM026原7项hash可核对；根readiness.test已被V244单行改动，恢复原V243用例后才等价，不以替换旧用例冒充兼容。HTTP仅移植四个executionRuntime/readiness/effective安全hunks，因子import/handler/dispatch三处必须排除。server.test可以移入已核无因子依赖的运行门控回归。

旧反例：未知提交强证据跨轮保存、无效成功与明确不存在分离；旧批次不得覆盖终态；FINISHED弱NEW不当活动保护；历史退出身份/数量及独立交易所时间上界；调度异常不逃逸、门控一致、晚成功不清新故障、兄弟广播继续且无循环等待。保留正常首次部分成交和原保护顺序，不增加应急/重试/退出政策，不自动清安全锁。

专家可以在候选workdir运行已确认无网络/无凭据/无活动库依赖的隔离node --test，先旧反例再回归，记录失败。新干净包必须重新实际测试，不继承558/558。新增其他文件或源层依赖先回报；策略变量仍待用户选择，B1不修改版本、准入或纪元。执行者不单独验收自己的实现，后交独立QA。

## 阶段B1完成（2026-11-06 18:50）

执行自测全量445/445、总控复跑445/445，独立QA定向152/152及全量445/445实际通过，追加历史证据否决、并发广播和共享门控夹具通过，最终OFFLINE_VERIFIED / NOT_DEPLOYED。候选143恰好10差异，活动143无漂移；manifest为release-manifest-B1.json，逐项复核0差异。原环回EACCES及旧反例失败保留。专家结束本回合待命，不启动新包。

整体仍POLICY_SELECTION_PENDING；未回答前不得默认实施A或B，不以BUG离线验收代替策略/上线验收。下一阶段待明确单变量后，先为候选规则、执行提升、旧仓管理、反事实分账及版本显示列唯一文件所有权和通过/否决条件，再实施与独立复测；本次账户/备份/单实例上线门槛仍未执行。

## GitHub归档提交（2026-11-06晚间，用户另行明确授权）

用户要求先提交GitHub；这不是策略选择或上线授权。总控唯一负责发布构造和推送，独立QA/root/attribution_qa只读验收拟发布树/敏感信息/候选一致性，不修改或自行发布。

- 从本地HEAD66f2541构造独立分支codex/team-029-reliability，现有远端TEAM011 e361cdf是其祖先；不改main/现有远端分支，不强推、不合并或创建PR。
- 仅B1候选10项源/test与HEAD的实质差异；其余133项必须在LF归一化后与候选一致。Git文本归一化不修改候选/根文件，发布前全143再次核验。
- 文档白名单：AGENTS.md、quant-team/TASKS.md、tasks/TEAM-028.md、tasks/TEAM-029.md、acceptance/2026-11-06-TEAM-028-profit-loss-summary.md、acceptance/2026-11-06-TEAM-029-report.md、acceptance/2026-11-06-TEAM-029-publish-manifest.json（均quant-team下，AGENTS除外）。只归档汇总，不上传148笔逐笔账户明细或依赖本地活动库的分析脚本。
- 使用独立临时GIT_INDEX_FILE和Git对象构造提交，当前分支HEAD与默认index保留；root所有业务dirty、活动TEAM024、候选143和运行服务不得改。发布前后校验默认index/业务文件指纹。
- 独立QA检查精确树diff、143候选等价、无策略/因子/敏感文件；实际提交后还须核对commit树和GitHub远端SHA一致。先前445/445只在代码树等价成立后适用，不继承根dirty测试结果。
- 排除.env/凭据、data/数据库、备份、日志、原始签名账户资料和未知文件。仅Git既有认证和7897进程级代理用于授权仓库读写，不修改系统代理/配置，不读取交易所凭据。
- 推送失败保留本地提交和明确错误；不得虚称已上传，亦不借此部署、重启/解锁/操作订单或默认采用V244。
