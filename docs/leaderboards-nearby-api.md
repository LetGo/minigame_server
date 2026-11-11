# 猫咪枪手：本人附近排行榜接口

> 部署状态：2026-11-10 **正式服、测试服均已上线**。正式服北京时间 21:28 切换，21:30 完成公开 HTTPS 验收及最终回读；测试服此前 20:12 已完成验收。本功能属于旧猫咪枪手 `/h5login`、`/h5login-test`，不是数独或多游戏平台。正式门槛 stage101 / boss30，测试门槛 stage500 / boss50，均包含边界。验收使用合成测试会话，不等于真实微信或客户端联调完成。

## 请求

`POST /h5login/api/leaderboards/nearby`

正式服完整地址（已上线，可联调）：
`https://sub2api.wdaveh5game.com/h5login/api/leaderboards/nearby`

测试服完整地址（已上线，可联调）：
`https://sub2api.wdaveh5game.com/h5login-test/api/leaderboards/nearby`

请求头：

```http
Authorization: Bearer <当前环境的玩家 accessToken>
Content-Type: application/json
```

Boss 榜：

```json
{"type":"boss"}
```

关卡榜：

```json
{"type":"stage"}
```

- 只接受 `type` 字段，值为 `boss` 或 `stage`。
- 中心玩家从 Bearer 登录会话取得，**不接受指定其他玩家的 userId、openid，也不接受 appId/gameId**。
- 不支持 `radius`、`limit`、分页或 URL query 参数；窗口固定为前 5 位与后 5 位。
- 测试服与正式服的用户和 Token 不通用。

## 返回与边界规则

HTTP 200，普通 JSON，无自定义加密；响应头 `Cache-Control: no-store`。

- `entries`：按全榜名次升序，返回本人前 5 位＋本人＋后 5 位，**最多 11 项**。
- `rank` 是全榜真实名次，不是当前窗口内从 1 重排的序号。
- 靠近榜首、榜尾或人数较少时按实际存在的名次返回，**不从另一侧补齐**。
- 本人已上榜时，本人同时出现在 `entries` 与 `self` 中；二者字段和值一致。
- 本人未上榜时，`entries: []`、`self.rank: null`。已上报但未达门槛时，`self.value` 为已保存历史最高值（包括 0）；从未上报时为 `null`。不会回退到前 30 名。
- `self` 始终返回当前玩家信息。每项字段为 `userId`、`rank`、`value`、`nickname`、`avatarUrl`。
- 复用已上传昵称和头像；未设置时为 `nickname: "游客"`、`avatarUrl: ""`。
- 历史最高值、门槛和同分排序与原榜相同；同分按规范化 UUID 字节字典序降序排列，不并列。
- 正式服保持 `stage >= 101`、`boss >= 30`；测试服保持 `stage >= 500`、`boss >= 50`。本次正式发布未调整任何环境的既有门槛，也未修改原成绩或存档。

以下为只有三名玩家的**示例数据，不是真实用户**：

```json
{
  "type": "boss",
  "entries": [
    {"userId":"33333333-3333-4333-8333-333333333333","rank":1,"value":90,"nickname":"玩家甲","avatarUrl":""},
    {"userId":"22222222-2222-4222-8222-222222222222","rank":2,"value":60,"nickname":"游客","avatarUrl":""},
    {"userId":"11111111-1111-4111-8111-111111111111","rank":3,"value":50,"nickname":"玩家丙","avatarUrl":""}
  ],
  "self": {"userId":"22222222-2222-4222-8222-222222222222","rank":2,"value":60,"nickname":"游客","avatarUrl":""}
}
```

## 一致性与性能

- Redis 单个短 Lua 脚本读取本人名次、成绩与附近窗口，防止并发上报造成同次响应的名次/窗口错位。
- 昵称、头像及未入榜本人的数据库成绩随后批量查询，不承诺 Redis 与 PostgreSQL 跨存储强一致。资料可能刚更新；并发刚达标时仍可能暂时返回 `rank: null` 与达标的历史值，下次查询可刷新。
- 正常查询为 `O(log N + 11)`，只读取窗口并批量查询对应资料，不全榜拉取排序；索引丢失或过期时沿用已有重建机制。
- 客户端收到响应后整体替换窗口与 `self`，不要拼接不同请求、榜种或环境的数据。

## 限流与错误

`nearby` 与原 `list` **共享每玩家每游戏每分钟 60 次查询额度**，跨 Token、跨榜种共用；`report` 的额度仍独立。

- 400 `INVALID_LEADERBOARD_REQUEST`：非法 type、额外字段、query 等。
- 400 `INVALID_JSON`：无法接受的 JSON 请求体（例如根值 `null`）或格式错误。
- 401 `SESSION_INVALID`：未登录、Token 无效/过期、不同环境或游戏、玩家不存在/未完成注册。
- 429 `LEADERBOARD_RATE_LIMITED`：遵守 `Retry-After` 退避。
- 503 `LEADERBOARD_REBUILDING`：索引暂时无法完成重建，稍后重试。
- 503 `LEADERBOARD_STORAGE_UNAVAILABLE`：存储不可用；不应把失败当作无人上榜。

本次新增不涉及数据表迁移、存档修改、成绩补报或奖励发放；原 `/leaderboards/list` 仍是前 30 名＋本人，不改变返回契约。
