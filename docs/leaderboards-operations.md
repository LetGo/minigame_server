# 排行榜运维与发布边界

2026-10-19用户明确授权后已部署常驻测试服 `/h5login-test`：owner迁移005–007及最小授权先行，切换独立release，仅重启minigame-staging。随后2026-10-19 14:44北京时间获单独正式发布授权，已应用007、最小授权、切换测试同源产物并仅重启minigame-login；正式23项排行榜HTTPS＋42项既有业务检查通过，原98账号/34存档保留，临时fixtures清理回读，测试服/看板/存储进程与配置未变。正式证据及旧dist位于 `tmp/leaderboard-production-deploy/`。测试库备份已实际恢复到scratch库核对并删除scratch，原有账号/存档完整保留。54项排行榜/编译登录统计检查及29项既有HTTPS回归通过，自建fixtures已清理；登录统计成功路径使用显式微信transport stub，不等同真实微信登录。证据 `tmp/leaderboard-staging-deploy/`，旧release保留供回滚。接口见 `leaderboards-api.md`，实测与资源边界见 `leaderboard-performance.md`。

## 数据与一致性

`007_leaderboards.sql` 增加 `game_leaderboard_scores`：主键 `(app_id,board_type,user_id)`，同游戏用户复合外键；合法类型stage/boss、非负int32。最高值和 `dirty=true` 待同步标志在同一事务提交。dirty是按玩家/榜合并的事务性待办，不是内存队列，没有每次上报无限增长的事件表。

当前源码及正式服入榜门槛固定为 stage≥101、boss≥30（2026-10-20 后续正式发布）；测试服仍为500/50。2026-10-19 的300/30只是历史中间版本。PG仍保留所有非负最高值。提交成功后Redis短Lua仅对达标成绩用GT投影，只有数值更高才替换；未达标不ZADD、不ZREM，避免迟到低分删掉已并发入榜的高分。未达标待办同样按持久值条件确认；随后 `WHERE value=$processedValue AND dirty` 条件确认，不能把并发产生的新待办误清掉。Redis成功而确认失败允许再次投影；COMMIT响应丢失可能已经写库，客户端重复原请求仍幂等。

门槛历史由500/50调整至300/30，再至正式101/30；当前正式 `indexEpoch(type)` 使用`:min=101/30`，测试仍500/50。门槛变化后首次访问会按对应新门槛从PG重建，包括此前dirty=false但现已达标的历史成绩。不需要迁移表或手动清榜，不从云存档补算成绩。发布时不要长期混跑不同门槛的API实例。

成功上报的达标成绩在Redis投影并取得名次，未达标成绩保存至PG并返回rank=null；返回成功后其他玩家或本人更高成绩仍可能改变名次。失败的上报可能已持久化，因此503不等于“什么都没写”。列表可能在故障恢复的同步窗口暂时落后于数据库，但不把缺失索引当成真实空榜。

## 有界后台同步

- 每个API实例在首次通过鉴权及参数校验的排行榜请求后启动1秒周期任务；既有登录/存档等请求不会启动新表查询。
- 每轮按游戏、每种榜最多100条待办，使用dirty部分索引，循环内不重叠执行任务。
- 同步异常输出固定、无凭据/数据的告警，后续周期继续；停机清定时器、等在途任务结束。
- 重启后首次排行榜请求重新激活同步；没有访问时待办仍可靠保存在PG，不宣称空闲时已自动处理。
- 复用的Redis客户端沿用原服务有限重连策略。长期Redis中断耗尽重连次数后，需要在Redis恢复后经授权重启API；本功能并未改成无限重连或承诺任意时长断网自动恢复。

## 索引恢复

Redis键：`minigame:leaderboard:<appId>:<stage|boss>`。同一ZSET里 `__ready__` 成员、分值-1表示已完整发布；正常玩家分数非负，不影响真实名次，不出现在列表中。索引没有自动过期时间；不宜人工单独删成员以修改成绩。

索引缺失、Redis运行代次或门槛策略改变时在同榜PG排他事务advisory锁下，按user_id主键每页1000条、仅value≥门槛的记录重建到随机临时键，60秒总预算。过滤减少Redis成员及临时索引，但PG可能仍需扫描未达标持久行，不能按达标人数直接断言数据库重建成本。上报事务使用相同锁的shared模式，避免恢复覆盖并发提交的新值。临时键/重建owner120秒过期；发布短Lua校验随机owner代次、完整成员数=扫描成绩数+1及ready哨兵，再原子RENAME/PERSIST和发布当前Redis run_id与门槛策略，旧代次不能覆盖后来者，也不能在cleanup删除别人的owner；临时页丢失也不能发布半榜。每个实例同榜恢复single-flight，跨实例竞争失败显式503，不返回假空榜。

每个连接缓存一次 `INFO server` 的run_id，Redis重新ready后清除缓存。查询、投影和ready检查都要求榜对应`:epoch`与当前`run_id:min=<门槛>`一致。旧无门槛索引即使ready也会强制重建；未来修改门槛需升级全部API实例，不能长期混跑不同策略版本。Redis重启后即使从快照恢复旧的非空ready榜，也不能永久掩盖PG中已确认但dirty=false的更新。已在隔离Redis实际完成：手动SAVE旧快照→更高成绩写库确认→重启Redis容器→缓存恢复旧1分→真实HTTP重建返回80分。证据 `tmp/leaderboards/real-restore-evidence.json`；这是合成故障验证，不是生产操作。

所有SQL、Redis调用保留现有有限连接/语句超时；大榜恢复期间同榜写入可能等待/503，要让客户端按退避重试。Redis键空间不支持通过换DB编号获得资源隔离；大榜需要实例/内存规划。

当前无玩家注销或管理删分接口。后台手动删除/降低PG成绩不能指望GT投影自动纠正Redis，需在明确维护授权下，对该榜完整重建；不要将“只保留最高值”的实现误当成支持降分/封榜/赛季重置。资料改名/换头像不需要重建，查询直接读取最新资料。未入榜本人最高值在同一批资料SQL中按主键补取；没有逐人查询或PG全榜名次计算。Redis快照与PG补取不具备跨存储原子性。

## 授权发布前清单

1. 备份并验证恢复；保护原生产/测试dist、配置、Nginx、用户/存档基线。候选目录编译，不运行会覆盖在线dist的普通build/check/pretest。
2. 使用对应环境owner运行007迁移，保留旧迁移校验，不让API启动自动迁移。
3. 给该环境既有runtime角色显式最小授权；例如正式角色：

```sql
GRANT SELECT,INSERT,UPDATE ON game_leaderboard_scores TO minigame_app;
```

常驻测试服若获授权发布，同样对 `minigame_staging_app` 授权；保持已有 `game_users`/`game_profiles` SELECT。不授予DELETE/DDL，不更换密码、不重建基础设施或覆盖.env。迁移和授权必须先于新API切换。dashboard未新增功能，不需要新表权限或看板重启。

4. 单独授权环境切换与API重启，保留另一个环境进程/配置/产物不变；本次路由使用原前缀与16KiB通用正文上限，不需要额外Nginx配置。
5. 运行正式参数的完整HTTPS/真实客户端登录上报/查询验收，错误路径、资料默认值、最高值、两种榜、本人榜外、旧接口回归。只有真实客户端验收才能证明端到端接入，不以测试生成会话假装微信登录。
6. 记录产物hash、迁移与权限、进程身份、接口结果与回滚位置；回滚API不删除新成绩/新表，保留增量schema与持久数据。

## 只读观测

用有权限的对应环境连接参数化查询，不把连接字符串打印到终端/日志：

```sql
SELECT board_type,count(*) AS pending
FROM game_leaderboard_scores
WHERE app_id=$1 AND dirty
GROUP BY board_type;
```

关注待办是否持续积压、503/429比例、完整请求P95/P99、Redis used_memory/maxmemory与eviction策略、PG连接池等待和重建告警。正常业务不需要定时全榜COUNT排名或全榜重排。

正式Redis已在另外明确授权的运维操作中于2026-10-19增容并重建：maxmemory512MiB、容器1536MiB/1CPU，参见`redis-online-expansion.md`；本轮入榜门槛开发不再修改资源。此前百万达标玩家单榜键本地估算约112MiB，不能等同整个实例需求或生产容量保证。门槛只减少实际达标人数，不构成榜单人数硬上限；还需给两张榜、会话、限流和临时重建留余量。
