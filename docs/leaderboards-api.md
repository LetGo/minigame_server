# stage / boss 排行榜接口（正式服、测试服均已部署）

2026-10-19经授权已部署持久测试服，基址 `https://sub2api.wdaveh5game.com/h5login-test/api`；测试门槛仍为stage≥500、boss≥50。正式服 `https://sub2api.wdaveh5game.com/h5login/api` 已开放排行榜；2026-10-20按用户要求将关卡榜门槛调整为 **stage≥101**，Boss榜仍为 **boss≥30**，包含边界。本次与订阅提醒一起发布，仅更新正式服；测试服门槛不变。两环境用户、令牌、成绩独立。当前单游戏配置不变，预留按服务端 app_id 隔离，**不意味着已支持客户端任意切换 gameId**。

## 规则

- 累计榜两种 `type`：`stage`、`boss`；独立存储、独立排名，不每日重置。
- `value` 为 JSON number，非负 int32：0～2147483647，拒绝字符串、小数、负数及超范围值。
- 数值越大越靠前，保留历史最高值；相同/更低上报不会降分或增加重复榜项。
- 同分按规范化 UUID 字符串的字节字典序**降序**排列；不是先达到者优先。名次连续、从 1 开始，不并列。
- 入榜门槛由服务端固定，当前源码及正式服为**stage ≥ 101，boss ≥ 30**，包含边界；测试服仍为500/50。未达标成绩仍持久保存历史最高值，但不写入 Redis 排名集合；名单及名次只计算达标玩家。客户端不能覆盖门槛。
- 从未上报时，本人 rank/value 均为 null；已有成绩但未达标时，rank 为 null、value 为历史最高值（包括 0）。达标后再上报低分不降分、不退榜。
- 玩家身份、游戏归属从 Bearer 会话及服务端配置取得；不接受客户端 userId/openid/appId/gameId 覆盖。
- 昵称、头像复用 `/users/profile` 已上传的资料，不需要每次上报携带；未上传资料时 nickname 为 `游客`，avatarUrl 为空字符串。客户端自行展示本地默认头像，不请求空地址。
- 分数是客户端申报信息，不是微信认证通关结果；不作为防作弊证明或高价值奖励的权威结算依据。

## 通用约定

HTTPS；`Authorization: Bearer <accessToken>`；`Content-Type: application/json`；成功体直接为 JSON，无自定义加密；响应 `Cache-Control: no-store`。

不要在 URL/query 里放 Token、玩家身份或排行榜参数。所有接口必须登录，无公开匿名榜查询。只允许约定字段；不兼容额外字段或 URL query。

## 查询前 30 名与本人

`POST /leaderboards/list`

```json
{"type":"stage"}
```

```json
{
  "type": "stage",
  "entries": [
    {"userId":"ffffffff-ffff-ffff-ffff-ffffffffffff","rank":1,"nickname":"玩家","avatarUrl":"https://example.com/avatar.png","value":1100}
  ],
  "self": {"userId":"11111111-1111-1111-1111-111111111111","rank":56,"nickname":"游客","avatarUrl":"","value":900}
}
```

- entries 最多 30 项，可以少于 30 或空数组；无分页参数。
- self 始终返回当前登录玩家，已在 entries 中也不省略。
- self 保留 userId/nickname/avatarUrl。没有历史成绩：rank/value 均为 null；未达标：rank 为 null、value 为已保存最高值。正式客户端可按类型显示“stage 达到101 / boss 达到30即可入榜”，不把未达标上报视为错误；测试服仍按500/50提示。
- 前 30 与已入榜本人的名次/成绩在 Redis 单次短脚本内读取。未入榜本人的持久最高值通过后续同一批资料 SQL 查询按主键补取，不全榜计算名次。该数据库补取和昵称头像不属于 Redis 的原子快照：并发达标时可能短暂出现 value 已达标但 rank 仍为 null，下次 list 可刷新；故障待同步窗口同样不承诺跨存储强一致。
- 收到新响应后整体替换榜单及 self，不混合不同请求/不同类型/不同游戏环境的数据。

## 本人附近排名（正式服、测试服均已部署）

`POST /leaderboards/nearby`，请求 `{"type":"boss"}` 或 `{"type":"stage"}`。返回当前登录玩家前 5 位＋本人＋后 5 位，最多 11 项；榜首/榜尾不足不补齐，名次仍为全榜名次。未上榜返回空 `entries`，并保留 `self` 与已保存历史成绩。与 `list` 共享查询限流；不支持指定其他玩家身份。

**2026-11-10正式服、测试服均已部署此接口**：测试服北京时间20:12已验收；正式服21:28切换，21:30完成公开HTTPS验收及最终回读。正式服仍按101/30、测试服仍按500/50入榜，原 `list/report` 契约不变。此次只更新两个排行榜模块并重启正式API，无数据库迁移；临时验收数据已清理。完整请求、响应和边界约定见 [本人附近排行榜接口](leaderboards-nearby-api.md)。

## 上报历史最高成绩

`POST /leaderboards/report`

```json
{"type":"stage","value":1100}
```

成功返回服务端有效最高成绩及名次；未达标也成功保存，rank 为 null：

```json
{"type":"stage","value":1100,"rank":12,"improved":true}
```

- `improved`：本次数据库事务是否首次建立或提升了最高成绩；相同/较低值重试为 false。
- `value`：服务端有效最高成绩，不保证等于请求值；并发请求可能已把最高值提升得更高。
- `rank`：已入榜时从 1 开始；未达标为 null。不是永久名次，其他玩家上报后会变化。
- 正式服例如 stage 上报100：`{"type":"stage","value":100,"rank":null,"improved":true}`；随后上报101即入榜。boss 同理，上报29不入榜、30入榜。
- 门槛变更会按服务端已上报的历史最高成绩重建榜单，已有101～299分记录可进入关卡榜；不读取云存档补报成绩，也不修改玩家历史最高值。
- `improved` 不等于发奖凭据，尤其丢失成功响应后重试可能为 false。

客户端只在成绩变化时上报，不要逐帧请求。

遇到超时或 503 时，数据库可能已经提交；用原 type/value 重试不会降分或重复入榜。不要因为失败改传更小的值。收到成功响应才能认为该次请求已按接口约定处理；若需显示最新榜单，再调用 list。

## 错误与频率

错误体沿用 `{ "statusCode": 400, "message": "机器可读错误码" }`。

- 401 `SESSION_INVALID`：Token 缺失/无效/过期、不同游戏或玩家不存在/未完成注册，重新登录。
- 400 `INVALID_LEADERBOARD_REQUEST`：不支持的 type、非法 value、额外字段/query；解析错误为 `INVALID_JSON`。
- 429 `LEADERBOARD_RATE_LIMITED`：频率过高，遵守响应 `Retry-After` 秒数；不要立即循环重试。
- 503 `LEADERBOARD_STORAGE_UNAVAILABLE`：数据库/Redis 依赖失败；`LEADERBOARD_REBUILDING`：索引正在由另一个实例恢复或本轮恢复未能安全发布。稍后退避重试，不当成空榜或未入榜。

上报与查询各自独立每玩家每游戏每分钟 60 次；同一玩家的不同 Token、两种榜共享该操作额度，不占用云存档/邀请/视频各自的业务额度。鉴权本身仍依赖现有会话 Redis，因此整体 Redis 中断也会影响登录态验证。

## 性能和可靠性约束

- Redis Sorted Set 做排名索引：更新 O(log N)、本人排名 O(log N)、前 30 O(log N+30)。不全量拉到 Node 排序，不每次用 PostgreSQL 全榜窗口排名。
- 昵称头像一次批量查最多 31 个玩家；不逐人 SQL、不在后端下载头像。
- PostgreSQL 持久保存所有历史最高值及待同步记录，Redis 只索引达标成绩；正常上报、后台重试、故障重建遵循同一门槛。低分待办确认时不能误清并发产生的新高分。
- 不把 Redis key 丢失当成空榜；恢复使用有限分页/批次，短 Redis 脚本不得遍历全榜。重试同步不得让高分退回低分。
- 多游戏/多榜 key 独立，内存按榜参与人数增长，需预算；换 Redis DB 编号不构成内存或 CPU 隔离。
- 实际性能以 `docs/leaderboard-performance.md` 和对应隔离压测 JSON 为准，不能把本地闭环吞吐等同于生产容量承诺。

## 发布边界

测试服已完成owner迁移005–007、runtime最小授权及独立release切换；54项排行榜/编译登录统计检查和29项既有公网回归通过，合成数据已清理回读。统计登录验证使用显式微信transport stub，不代表真机新鲜code登录。随后获授权正式发布：owner应用007及runtime SELECT/INSERT/UPDATE最小授权，正式产物匹配测试服候选，仅重启正式API；23项排行榜HTTPS检查及42项既有业务检查通过，临时数据清理回读。原98用户/34存档保留，测试服、看板及全部存储进程未变。测试服证据 `tmp/leaderboard-staging-deploy/`，正式服证据 `tmp/leaderboard-production-deploy/`；正式回滚恢复该目录 `live-previous-dist/`并仅重启minigame-login，保留增量表及真实成绩。
