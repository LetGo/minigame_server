# 分享助力接口（diapig_invite）

**状态：正式服和测试服均已部署。** 测试服已于 2026-11-05 14:09（北京时间）部署并通过 57 项公网合成会话验收；经客户端验收后，正式服于当日 17:15 完成发布后回读及 57 项公网合成会话验收。正式入口为 `https://sub2api.wdaveh5game.com/h5login/api`；测试入口为 `https://sub2api.wdaveh5game.com/h5login-test/api`。UID/token/待上报来源必须隔离，切换正式环境后须重新登录。合成会话验收不等于真实微信冷/热启动点击验收。

## 1. 规则

- 独立分享点 ID 固定为 `diapig_invite`，区分原来的普通邀请拉新；分享者用现有登录 `user.id`（UUID），不生成新邀请码。
- 新注册和老用户都能助力，不要求首次登录、等级、视频观看或领取操作；点击分享后完成正常登录，由接收者客户端上报。
- 按 **应用＋分享点＋分享者＋北京时间日期＋助力用户 UID** 去重。同一人当天重复点击、换设备、换 token 或并发上报只计一名助力用户。
- 自己点击自己的分享不计；同一人当天可以分别帮助不同分享者。新的一天可再次帮助同一分享者。
- **每天北京时间 00:00 今日助力人数归零**，不是滚动 24 小时。采用数据库按北京自然日隔离，不依赖定时清零任务；历史记录保留供排查，不混入今日计数，不做每日破坏性删表/删数据。
- 不改普通 `/invites/report/list/claim` 的新用户归因、累计列表和每日 50 次新领取规则；助力不创建普通邀请绑定，不占其额度。
- 本功能仅记录和计数，不新增奖励领取、钻石/道具结算或好友视频奖励。

## 2. 分享参数与前端流程

```js
wx.shareAppMessage({
  title: '一起来玩',
  query: 'shareId=diapig_invite&inviterUid=' + encodeURIComponent(auth.user.id)
});
```

`shareId` 为分享点，不是用户身份。不得在分享参数中放 token、openid 等。分享双方必须使用同一环境。

1. 冷启动读取 `wx.getLaunchOptionsSync().query`，热启动监听 `wx.onShow(options)`。
2. 仅当 `query.shareId === 'diapig_invite'` 且 inviterUid 格式正确时，缓存本次真实启动事件的来源；无参数 onShow 不制造助力。
3. 等接收者正常登录成功，使用**接收者自己的 Bearer** 调用 `/share-assists/report`；新老用户都调用，不以 isNewUser 为条件。
4. 确认成功/自助力拒绝/永久无效来源后清理待上报事件；网络异常可对同一来源有界退避重试。不得在次日普通启动时自动重报昨天已处理的旧来源，否则会制造并非新点击的助力。
5. 分享者打开助力面板调用 `/share-assists/summary`，按返回 `date` 展示今日人数。跨过 `resetAt` 后清除本地昨日人数并刷新接口；服务器归零并不主动推送 UI。

此助力来源**不要误发给 `/invites/report`**；它不是普通拉新。只有产品确实同时执行另一种普通邀请流程时才独立处理，不能把两个结果或奖励混为一谈。wx.request 是回调接口，需封装 Promise，不能假设 await wx.request() 直接得到响应。

## 3. 通用约定

两个接口均为 `POST API_BASE + 路径`，HTTPS＋普通 JSON：

```text
Content-Type: application/json
Authorization: Bearer <当前操作者登录token>
```

只接受文档字段，拒绝额外 HTTP query、客户端日期、helperUid、appId 等身份覆盖。正文上限 16 KiB；所有响应 `Cache-Control: no-store`。助力上报与查询共享独立的**每应用每用户每分钟 60 次**额度（跨 token/实例共享），与普通邀请、存档等额度分开。没有每日助力总人数上限。

### 3.1 上报本次助力

`POST /share-assists/report`

```json
{"shareId":"diapig_invite","inviterUid":"<分享者UID>"}
```

助力者身份来自 Bearer。分享者须为本应用已完成注册登录的用户；不要求分享者早于助力者注册（老用户也可帮助新分享者）。首次记录成功：

```json
{
  "shareId":"diapig_invite",
  "accepted":true,
  "date":"2026-11-05",
  "recordedAt":"2026-11-05T04:00:00.000Z",
  "alreadyRecorded":false
}
```

示例时间为结构示意。当天重复上报返回 `alreadyRecorded:true`，`date/recordedAt` 保持原回执，不增加人数。时间由数据库产生，不接受客户端补报指定日期；以本次请求在数据库捕获的日期归属，跨午夜的请求/重试可能落入不同日。无跨日幂等承诺，客户端只重试仍有效的本次点击事件。

自助力返回 HTTP 200，不写记录：

```json
{"shareId":"diapig_invite","accepted":false,"reason":"SELF_ASSIST"}
```

### 3.2 查询本人今日助力用户数

`POST /share-assists/summary`

```json
{"shareId":"diapig_invite"}
```

只查询 Bearer 对应用户收到的助力，不允许指定他人 UID：

```json
{
  "shareId":"diapig_invite",
  "date":"2026-11-05",
  "assistUserCount":3,
  "resetAt":"2026-11-05T16:00:00.000Z"
}
```

`date` 是北京日期，`resetAt` 是下一次北京 00:00 对应的 UTC ISO 时间；无助力为 0。仅返回总人数，不暴露助力者的 UID/openid/资料；计数是该请求数据库快照，不保证与同时发生的写请求实时同步。

## 4. 错误与重试

- 400 `INVALID_SHARE_ASSIST_REQUEST`：字段/UUID/固定 shareId 不合法或额外字段/query；JSON 解析失败为通用 `INVALID_JSON`。
- 401 `SESSION_INVALID`：未登录、过期、跨应用、用户不存在或注册未完成；正常重新登录后再上报，老用户仍符合资格。
- 404 `SHARE_ASSIST_INVITER_NOT_FOUND`：分享者不存在、不同应用或未完成注册，统一错误，不泄露用户资料。
- 429 `SHARE_ASSIST_RATE_LIMITED`：遵循 `Retry-After`，不要无限重试。
- 503 `SHARE_ASSIST_STORAGE_UNAVAILABLE`：PG/Redis 不可用或提交结果不明。当天重试同一来源仍幂等；不应自行增加前端人数。
- 413/415 等代理层错误可能不是 JSON，按全局契约处理。

客户端上报只能证明持有有效账号会话的用户申报了来源，**不能独立证明真实微信点击、真实自然人或平台合规**。本实现不抓取分享链接、不添加后台模拟点击或邀请奖励。玩法与文案仍应遵循微信运营规范。

## 5. 发布前置条件（本轮经授权已在测试服及正式服完成）

1. 隔离编译和验证通过，不能在在线项目根直接运行会覆盖 dist 的 build/check/pretest。
2. 在目标环境以 owner 应用新增迁移 `015_share_assists.sql`；不改已执行历史迁移，不删除数据。
3. 对目标环境现有运行角色显式授予 `game_share_assists` 的 **SELECT、INSERT**，现有 `game_users SELECT` 保留；不授予 UPDATE/DELETE/DDL。不需要看板新权限或新定时任务。
4. 只按目标环境发布经审查的 API 产物；不把本次开发当作部署授权。
5. 公网验证需覆盖新老用户、并发去重、跨应用隔离、北京时间日界；真实微信冷/热启动点击须用客户端真机验收。隔离测试中的合成会话不是实际微信点击证明。

正式发布仅新增 `015_share_assists.sql` 助力表并授予现有运行角色 SELECT/INSERT，迁移未改写原有业务数据；仅重启 `minigame-login`，测试服与看板未变，好友视频奖励仍退役。按用户决定暂不修复依赖告警，本次没有升级依赖。正式发布与回读证据位于 `tmp/share-assists-production/{published,public,final-readback}.json`。
