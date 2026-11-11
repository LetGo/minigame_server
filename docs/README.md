# 接口与环境总索引

本页统一客户端入口和环境状态；字段边界、响应、错误与幂等以链接的详细契约为准。状态依据仓库发布记录与本机发布物核对整理（2026-11-05）；其中分享助力已于当日 14:09（北京时间）完成测试服发布，并于 17:15 完成正式服发布后回读、57 项公网合成会话验收及数据/权限核验。其他功能状态不代表本次重新验收；源码或文档编辑本身不等于部署。

## 1. 环境与认证

| 项目 | 正式 | 常驻测试（开发版/体验版） |
|---|---|---|
| API_BASE（已含 `/api`） | `https://sub2api.wdaveh5game.com/h5login/api` | `https://sub2api.wdaveh5game.com/h5login-test/api` |
| 存档 SDK baseUrl（不含 `/api`） | `https://sub2api.wdaveh5game.com/h5login` | `https://sub2api.wdaveh5game.com/h5login-test` |
| 排行榜入榜门槛 | stage ≥ 101；boss ≥ 30 | stage ≥ 500；boss ≥ 50 |
| 登录 clientVersion / scene | 均已部署，可选 | 均已部署，可选 |
| 逐次成功登录 scene 事件 | 已部署，见[正式发布记录](login-events.md) | 当前本地发布物未含该采集；不将正式状态外推测试 |
| 玩家自身视频完成统计 | 已部署 | 已部署（随 2026-10-19 排行榜发布） |
| 好友昨日视频奖励 | 已退役，领取 404，列表无奖励字段 | 已退役，领取 404，列表无奖励字段 |
| `diapig_invite` 分享助力 | 已部署，2026-11-05 17:15 北京时间公网验收及回读通过 | 已部署，2026-11-05 14:09 北京时间公网验收通过 |

- 微信后台 request 合法域名：`https://sub2api.wdaveh5game.com`，不带路径；微信 AppSecret 只在服务端。
- 除微信登录外，下表游戏接口均需本环境 `Authorization: Bearer <accessToken>`，不是微信服务端 access_token，也不是 JWT。身份/应用来自会话与服务端配置，不接受 appId/gameId/openid/userId 覆盖。
- HTTPS、`Content-Type: application/json`、未压缩普通 JSON；无自定义应用层加密。成功通常为 200 直接 JSON、`Cache-Control: no-store`；字段省略、null、空串并不等价。
- 一般游戏正文上限 16 KiB；存档路径上限 256 KiB，但原始存档字符串仍最多 64 KiB UTF-8。业务参数放 JSON，不在 query 放身份/令牌；额外字段按各契约拒绝。
- token、UID、存档版本、待绑定邀请来源、待上报视频事件、领奖去重回执均按环境和玩家隔离。同一微信 openid 不代表两环境 UID 相同。
- 默认会话 7 天，按返回 expiresIn 处理。401 重新登录；429 按 Retry-After 退避；代理层错误可能不是 JSON。登录重试必须取新 code；其他写操作不能盲目换幂等 ID 重试。
- 当前单游戏配置不变，没有客户端多游戏切换、支付、刷新 token、游戏会话注销或 token 查询接口。

## 2. 游戏 API 全表

以下均为 **POST `API_BASE + 路径`**。`?` 表示字段可省略，不表示接受 null；表中 `{}` 是必须发送的空 JSON 对象，不是无正文。

| 路径 | Bearer | 请求字段（必填无 `?`） | 关键结果 / 契约 |
|---|---|---|---|
| `/auth/wechat-login` | 否 | `{code, clientVersion?, scene?}` | token、isNewUser、user.id/openid/nickname/avatarUrl；[登录](wechat-login-api.md)、[版本](login-client-version.md)、[scene](login-scene.md) |
| `/users/profile` | 是 | `{nickname, avatarUrl?}` | 更新本人资料；省略头像保留，null/空串清空；[资料与空头像示例](invite-api.md) |
| `/users/source-scene` | 是 | `{scene}` | 首次注册来源 write-once，同值幂等；[首次来源](source-scene-api.md) |
| `/invites/report` | 是 | `{inviterUid}` | 首次会话绑定邀请人，不要求关卡/留存；[普通邀请](invite-api.md) |
| `/invites/list` | 是 | `{cursor?, limit?}` | 未领优先、游标分页、累计 summary；无 serverDate/videoRewardDate/yesterdayVideoReward；[列表](invite-api.md) |
| `/invites/claim` | 是 | `{inviteeUid}` | 普通拉新领取标记、稳定 claimId；每邀请人北京时间每日最多新领 50，重领不占额度；[领取](invite-api.md) |
| `/share-assists/report` | 是 | `{shareId, inviterUid}` | **正式服与测试服均已部署**；固定 diapig_invite，新老用户每日去重助力；[分享助力](share-assists-api.md) |
| `/share-assists/summary` | 是 | `{shareId}` | **正式服与测试服均已部署**；本人今日助力人数与北京午夜 resetAt；[分享助力](share-assists-api.md) |
| `/data/get` | 是 | `{}` | 原始 JSON 字符串与 CAS version；[存档](save-api.md) |
| `/data/save` | 是 | `{version, data}` | data 为原始 JSON **字符串**，CAS 冲突 409，不自动重试；[存档](save-api.md) |
| `/analytics/rewarded-video/completed` | 是 | `{eventId, placement, clientInfo?}` | 本人完整观看完成事件幂等统计，不发奖；[视频统计](rewarded-video-api.md) |
| `/leaderboards/report` | 是 | `{type, value}` | stage/boss 历史最高值、rank、improved；未达门槛仍保存；[排行榜](leaderboards-api.md) |
| `/leaderboards/list` | 是 | `{type}` | 前 30 + 始终返回 self；[排行榜](leaderboards-api.md) |
| `/leaderboards/nearby` | 是 | `{type}` | **正式服、测试服均已部署**：本人前后各 5 位，最多 11 项＋self；[附近排名](leaderboards-nearby-api.md) |
| `/subscriptions/checkin/template` | 是 | `{}` | 固定一次性订阅模板配置；[订阅提醒](subscribe-message-api.md) |
| `/subscriptions/checkin/report` | 是 | `{eventId, templateId, status}` | 记录微信回调观察值，非新增发送授权；[订阅提醒](subscribe-message-api.md) |

**退役，不得调用或恢复：** `POST /invites/video-rewards/claim`，两环境均 404。简短[退役记录及防恢复约束](feature-retirements.md)覆盖两环境；过时奖励契约与测试发布文档已清理。不删除历史奖励表/数据、不影响普通邀请与本人视频统计。玩家自身视频钻石奖励是独立未开发、未上线需求，不得把现有统计上报当成领奖接口。

字段要点：登录 code 必填，clientVersion 可选 1–64 ASCII 格式串，scene 可选 JSON 整数 1..2147483647（均不接受 null）；资料 nickname 必填且不得全空白；邀请 cursor 可省略或 null，limit 可省略、为整数 1–100；视频 clientInfo 可省略默认为对象 `{}`；榜 value 为非负 int32。详细约束仍须阅读各契约。

## 3. 运营后台 API 全表

入口 `https://sub2api.wdaveh5game.com/h5dashboard/`；API_BASE 为该地址追加 `api`。**独立管理员 Cookie 会话，不使用游戏 Bearer。** 登录与全部 POST 均校验本站 Origin；Cookie 为 Secure/HttpOnly/SameSite=Strict，8 小时有效。除登录外下列接口均须管理员登录，无 URL query，成功响应禁缓存。

| 方法 / 相对 API 路径 | 请求 | 用途 / 契约 |
|---|---|---|
| POST `/login` | `{username,password}` | 管理员登录；[看板](dashboard.md) |
| POST `/logout` | `{}` | 销毁管理员会话；[看板](dashboard.md) |
| GET `/me` | 无正文 | 管理员及环境；[看板](dashboard.md) |
| GET `/overview` | 无正文 | 今日指标、同期、14 日趋势，30 秒快照缓存；[看板](dashboard.md) |
| GET `/production-status` | 无正文 | 只读正式服务/定时提醒状态；[看板](dashboard.md) |
| POST `/player` | `{openid}` 或 `{uid}`，二选一 | 完整玩家/原文存档/本人视频聚合；[看板](dashboard.md) |
| POST `/login-logs` | `{offset?,date?}` | 逐次成功登录 + 兼容历史逐日记录，本次/首次 scene 分开；[登录事件](login-events.md) |
| POST `/video-ranking` | `{date?}` | 指定北京日期视频次数前 20；[看板](dashboard.md) |
| POST `/yesterday-analysis` | `{}` | 昨日注册队列的来源/视频/今日回访；[看板](dashboard.md) |
| GET `/retention-report` | 无正文 | 仅读取已持久化留存日报；[留存](retention-dashboard.md) |
| POST `/save-repair/lookup` | `{openid}` | 查找原存档，不写玩家；[恢复/补偿](dashboard-save-repair.md) |
| POST `/save-repair/preview` | `{openid,version,fingerprint,changes}` | 预览，不写玩家；[恢复/补偿](dashboard-save-repair.md) |
| POST `/save-repair/apply` | 上述字段 + `{requestId,reason}` | **受控写接口**，独立最小权限连接、CAS/幂等/审计，必须逐次确认；[恢复/补偿](dashboard-save-repair.md) |

看板一般 JSON 上限 8 KiB，登录 2 KiB。统计/查询保持只读；存档恢复 apply 是明确例外，不能笼统称整个后台只读。留存 D1/3/5/7/14/20/30 已上线，北京时间每天 00:10 生成 `runtime/analytics/retention/latest.json`；读取接口不会触发数据库重算。pending/uncovered/empty 不得当成真实 0。

## 4. 文档分类与发布证据

- 当前契约：本页、[登录](wechat-login-api.md)、[版本](login-client-version.md)、[scene](login-scene.md)、[首次来源](source-scene-api.md)、[普通邀请](invite-api.md)、[存档](save-api.md)、[排行榜](leaderboards-api.md)、[视频](rewarded-video-api.md)、[订阅](subscribe-message-api.md)。
- 后台：[看板](dashboard.md)、[逐次登录契约与正式发布记录](login-events.md)、[留存日报](retention-dashboard.md)、[存档恢复](dashboard-save-repair.md)。
- 环境与运维：[测试接入](staging-integration.md)、[正式运维与历史发布](production-operations.md)、[测试运维](staging-operations.md)、[排行榜运维](leaderboards-operations.md)、[历史压测与容量边界](leaderboard-performance.md)、[Redis 扩容记录](redis-online-expansion.md)。
- [退役功能约束](feature-retirements.md)仅保留好友视频奖励关闭结果和禁止恢复要求，不保留其旧接入契约。各运维文档内历史数字/当时环境状态不可当作实时数据，不构成新部署授权。
- 文档工作树可同步更新；历史审查绑定的 ignored tmp/frozen 工件保持原字节，不改写过去的审查结论。私有 tmp/runtime 证据不可当客户端交付附件。

隔离自动化测试不能替代客户端真机验收：新鲜微信 code 登录、卡片分享和广告完整回调仍须对应环境的真实客户端联调。
