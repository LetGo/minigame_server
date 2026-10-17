# 激励视频完成上报与统计

> 当前为开发版本，尚未发布到正式或常驻测试环境。正式上线需要迁移 006、最小权限授权及游戏 API / dashboard 版本切换；须单独获授权。

## 接口

`POST /h5login/api/analytics/rewarded-video/completed`

HTTPS + `Authorization: Bearer <accessToken>` + `Content-Type: application/json`，与现有登录/存档一致，无自定义加密。测试环境发布后对应 `/h5login-test/api/analytics/rewarded-video/completed`。不支持 URL 参数。

请求示例（仅结构示例，非真实玩家事件）：

```json
{
  "eventId": "c733651f-a15c-4c11-9bfa-806b23b8bf25",
  "placement": "revive",
  "clientInfo": {
    "adUnitId": "your-ad-unit-id",
    "level": 12,
    "scene": "battle_result",
    "clientCompletedAt": "2026-10-18T01:00:00.000+08:00",
    "clientVersion": "1.2.0"
  }
}
```

- `eventId`：必填 UUID，每次真实完整观看生成一个新的值；同一次观看的网络重试必须复用原值和原始内容。可以由客户端已有 UUID 实现生成，不要求依赖本 SDK。不要每次请求临时生成一个新 ID，也不要把点位固定用作事件 ID。
- `placement`：必填点位标识，例如 `revive` / `double_reward`。1–64 个 Unicode 字符且 UTF-8 最多 256 字节，不含控制字符、首尾空白，不做自动 trim 或改名。
- `clientInfo`：可选 JSON 对象，默认 `{}`。可包含点位之外的业务信息（关卡、广告单元、客户端版本、客户端完成时间等），服务端完整保存 JSON 内容，不只挑选示例字段。序列化后 UTF-8 最多 8192 字节，嵌套深度最多 8 层（clientInfo 根对象为第 0 层），不能包含 NUL 或非法 Unicode。按结构化 JSON 保存，不保证原始空白和键顺序；超出 JavaScript 安全整数范围的业务 ID / 数值请使用字符串。不要上报密码、accessToken、微信 code、session_key 或不必要的个人信息。
- 顶层仅接受以上字段。不接受 `userId`、openid、appId、服务端记录时间或调用者声明的身份。玩家 UID 从 Bearer 会话提取，并验证其游戏归属；成功响应会返回实际 UID。
- 仅在激励视频关闭回调明确 `isEnded === true` 时调用。提前关闭、加载失败、展示失败不调用；此接口没有“不完整观看”事件类型。

## 成功响应

HTTP 200，直接 JSON，`Cache-Control: no-store`。结构示例：

```json
{
  "eventId": "c733651f-a15c-4c11-9bfa-806b23b8bf25",
  "userId": "2858be70-b1b2-4c0f-a6fe-4b0d9fb58b98",
  "placement": "revive",
  "recordedAt": "2026-10-17T17:00:01.123Z",
  "alreadyRecorded": false
}
```

`recordedAt` 来自数据库接收并首次记录事件时的时钟；UTC ISO 时间可按北京时间展示。不是客户端宣称的播放完成时间。重试返回原来的 `recordedAt`，`alreadyRecorded: true`。

同游戏、同玩家、同 `eventId` 只写一条；不同玩家各自事件独立。同一 ID 改点位或 clientInfo 返回 409，不覆盖已有记录。JSON 对象的键顺序不构成内容变化，省略 clientInfo 与 `{}` 等效。返回丢失/超时后重试也不能重复累加。

## 错误及重试

| HTTP | message | 处理 |
| --- | --- | --- |
| 400 | `INVALID_REWARDED_VIDEO_REQUEST` / `INVALID_JSON` | 修正格式，勿循环重试 |
| 401 | `SESSION_INVALID` | 重新登录；若还是同一玩家，继续使用待上报原事件 ID 和原内容 |
| 409 | `REWARDED_VIDEO_EVENT_CONFLICT` | 同一事件 ID 的内容不同，检查客户端；不要为绕过冲突生成新 ID 重复记一次 |
| 413 | `REQUEST_TOO_LARGE` 或代理层非 JSON 错误 | 缩小正文；一般接口正文上限 16 KiB，clientInfo 仍限制 8 KiB |
| 415 | `UNSUPPORTED_ENCODING` / `UNSUPPORTED_CHARSET` | 普通 UTF-8 JSON、不压缩 |
| 429 | `REWARDED_VIDEO_RATE_LIMITED` | 遵循 `Retry-After` 秒数，退避后仍使用原事件 |
| 503 | `REWARDED_VIDEO_STORAGE_UNAVAILABLE` | 有限退避重试，同一事件保持原 ID 和内容 |

每个游戏的每个玩家每分钟最多 60 次请求，多个 token 共用限流；重试也计请求次数，不代表可真实看完 60 次。不共享存档/邀请限流键。网络失败时不确定服务端是否已写入，所以必须幂等重试。不要阻塞或改变现有客户端发奖流程；此接口仅分析埋点，不负责发奖。

## 小游戏接入要点

1. 开始展示前为本次观看创建/保留一个事件 ID，并将点位与本次观看上下文绑定；不能用某个不断变化的全局“当前点位”。
2. 为广告对象只注册一个关闭监听器；在完整观看分支冻结 payload。重复回调/超时重试复用同一份 payload。
3. 使用普通 `wx.request` POST 上报；返回 200 后删除待上报记录。失败时按上述分类有限退避。
4. 如需跨重启恢复，待上报记录按环境和玩家 UID 分区；玩家切号后不能用新玩家 token 重放旧玩家事件。正式和测试缓存也必须分开。
5. 客户端完成时间只作为 clientInfo 元数据；客户端时钟可不准，聚合归日应以服务端 `recorded_at` 为准。

## 数据与 dashboard

迁移 `006_rewarded_video_events.sql` 建立 `game_rewarded_video_events`：app_id、user_id、event_id、placement、client_info、recorded_at。联合外键保证游戏/玩家一致；存储索引支持按游戏/时间/点位分析。runtime 只需此表 SELECT / INSERT，dashboard 仅 SELECT，均不需要 UPDATE / DELETE / DDL。

Dashboard 概览增加 **累计激励视频次数**（`metrics.totalRewardedVideos`）：本游戏已成功落库的去重完成事件条数，覆盖所有日期/点位/玩家，不是独立观看人数，也不是“今天次数”。0 条显示 0，字段未知显示“—”。沿用网页可见时每 30 秒请求刷新，以及近 14 天日期倒序。

该值从客户端接入并开始成功上报后才积累，不补造历史观看。鉴权只能防冒报其他玩家，不能证明本人的视频确实完整播放；**不是广告平台确认的有效展示、结算量或收入**。服务端不验证广告平台签名/回调，不发奖励。当前不新增视频明细列表、按点位排行或数据导出页面；明细已存数据库供后续分析。

删除玩家会级联删除其事件，累计数相应变化；当前未做自动事件清理。任何将来的保留期限/清理策略应与累计口径一并明确。

## 授权后的上线顺序（本轮尚未执行）

1. 获准目标环境，记录正式/常驻测试各进程和产物基线，正式发布前备份并实际恢复验证。
2. 使用该环境数据库 owner 执行新增迁移 006，保留全部旧表/玩家/存档。不要用受限 runtime 角色迁移，也不在 API 启动时自动迁移。
3. 正式环境由 owner 为既有角色显式授权：

   ```sql
   GRANT SELECT, INSERT ON game_rewarded_video_events TO minigame_app;
   GRANT SELECT ON game_rewarded_video_events TO minigame_dashboard_app;
   ```

   独立测试环境只对自己的 `minigame_staging_app` 授此表 SELECT / INSERT。不授 UPDATE/DELETE，不改密码，不跨环境连接。已部署 dashboard 不能重新运行首次 `prepare` 来升级（该命令拒绝替换凭据）；本次在原角色上补授权。
4. 先完成迁移/权限，再切换已验证的游戏 API 与 dashboard 快照，各自重启。无需 Nginx 路由更改，现有一般接口 16 KiB 限制继续有效。API 单实例重启可能产生短时请求失败。
5. 按实际域名验证鉴权、一次完成上报、原事件重试、数据库记录及 dashboard 次数；检查原登录/存档/邀请/来源接口和其他环境未受影响。真机 `isEnded === true` 的回调链仍需客户端联调。
6. 如需回退，切回旧代码并重启对应服务，保留新增表与真实事件，不删除已记录数据。
