# 新用户来源场景上报

## 发布状态

2026-10-17 已部署到常驻测试服，并完成迁移004及公网验证；**正式服尚未部署**。测试服可直接用于真机联调。

用于后续按首次来源场景分析用户行为，不负责上报行为事件，也不修改邀请归因。scene 是客户端上报的统计元数据，服务端不能独立验证是否来自真实微信启动场景，不能据此直接发奖或授权。

## 请求

`POST <API_BASE>/users/source-scene`

API_BASE（正式地址仅列作未来发布参考）：
- 测试：`https://sub2api.wdaveh5game.com/h5login-test/api`
- 正式：`https://sub2api.wdaveh5game.com/h5login/api`

使用 HTTPS、普通 JSON，携带 `Authorization: Bearer <accessToken>` 和 `Content-Type: application/json`。

```json
{"scene":1007}
```

- `scene` 必填，为 JSON 数字整数，范围 `1..2147483647`；不接受字符串、0、负数、小数、null。
- 微信来源场景取**首次进入时启动参数的 `options.scene`**，不是 `query.inviterUid`，也不是邀请人的 UID。
- 只接受 `scene` 字段，不接受 UID、openid、客户端 isNewUser、时间或额外 query 参数。目标身份仅来自 Bearer 会话。

## 资格和不可变规则

1. 登录响应 `isNewUser:true` 后，使用**这次首次注册返回的 token**立即上报。服务端检查会话里自己的新用户标记，不信客户端声明。
2. 每个用户只接受首次成功写入的 scene。服务端同时记录上报时间；该时间不是微信启动时间。
3. 同一 scene 重报成功，返回原时间；换 scene 返回 409，原值不变。
4. 已记录后的同值重报允许使用该用户后续有效会话；但尚未记录的老用户/后续登录会话不允许补录。
5. 历史用户保持来源未知（NULL），不将其后续启动场景当作初始来源。
6. 多实例/并发用 PostgreSQL 用户行锁串行化；数据库约束及触发器禁止已存 scene/上报时间被修改或清空。
7. 不影响邀请关系和邀请上报的新用户资格；两项可使用同一次首次登录 token，先后顺序不限。
8. 沿用现有会话有效期，没有额外的来源上报宽限期。首次会话丢失/过期后再登录，不获得首次填写资格。

## 响应

首次成功，HTTP 200：

```json
{
  "scene":1007,
  "reportedAt":"2026-10-17T14:00:00.000Z",
  "alreadyRecorded":false
}
```

以上时间仅是格式示例。`reportedAt` 为服务端数据库记录的 UTC ISO 时间。

同值重试 HTTP 200，`scene`、`reportedAt` 不变，`alreadyRecorded:true`。

| HTTP | message | 客户端处理 |
|---|---|---|
| 400 | `INVALID_SOURCE_SCENE` | 修正 scene 类型/范围，不原样重试 |
| 400 | `INVALID_INVITE_REQUEST` | 缺字段、额外字段、错误对象结构或 query；修正请求 |
| 400 | `INVALID_JSON` | 修正 JSON |
| 401 | `SESSION_INVALID` | 登录态失效；重登不会恢复未填写的新用户资格 |
| 403 | `SOURCE_SCENE_NOT_NEW_USER` | 非首次注册会话且尚无来源，不自动重试 |
| 409 | `SOURCE_SCENE_ALREADY_RECORDED` | 来源已锁定，不尝试覆盖 |
| 429 | `INVITE_RATE_LIMITED` | 遵守 Retry-After；与资料/邀请操作共享每用户每分钟60次限流 |
| 503 | `INVITE_STORAGE_UNAVAILABLE` | 存储暂不可用，退避后用原 token 和原 scene 重试 |

统一 `Cache-Control: no-store`。反向代理仍可能返回非 JSON 错误；客户端需容错。网络超时可能发生在提交后，因此重试必须使用原 scene，不能重新采集热启动值或为重试再次登录。

## 前端接入

```js
// 游戏启动最早阶段读取一次并保存到当前启动上下文；不要用后续 onShow 覆盖。
const firstLaunch = wx.getLaunchOptionsSync();
const initialScene = firstLaunch.scene;

// 与邀请上报共用同一个登录 Promise，避免重复登录覆盖首次 token。
const auth = await loginOnce();
if (auth.isNewUser === true && Number.isInteger(initialScene) && initialScene > 0) {
  const result = await postApi('/users/source-scene', {scene: initialScene}, auth.accessToken);
  // HTTP 200 表示已记录；alreadyRecorded=true 同样视为成功。
}
```

`loginOnce`、`postApi` 为调用方封装；`postApi` 可沿用测试联调指南的 wx.request Promise 示例。失败重试应在此调用外围按上表处理，不能仅因已发过请求就在本地标记成功。测试/正式的 token、来源待上报缓存必须隔离。

## 数据与部署

新增迁移 `migrations/004_source_scene.sql`：
- `game_users.source_scene integer NULL`
- `game_users.source_scene_reported_at timestamptz NULL`
- 正整数、成对非空约束；已记录值和时间的 write-once UPDATE 触发器。

需管理员显式执行迁移后发布对应候选程序。运行角色沿用 game_users SELECT/INSERT/UPDATE，不新增 DELETE/DDL 权限；不在 API 启动时自动迁移。旧迁移不能改写。回退旧程序可保留新增列和约束，不应清空已记录来源。

后续行为分析可用 user_id 联结用户表，再按 source_scene 分组；NULL 单独归类为来源未知。当前不新增行为事件采集接口或分析面板。
