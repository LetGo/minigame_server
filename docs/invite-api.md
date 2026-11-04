# 小游戏邀请拉新接口

**发布状态：2026-10-17 已部署正式环境及测试环境。** 正式使用 `https://sub2api.wdaveh5game.com/h5login/api`；测试使用 `https://sub2api.wdaveh5game.com/h5login-test/api`，见 [`staging-integration.md`](staging-integration.md)。两环境UID、token和缓存不得混用。

## 1. 已确认规则

- 每个用户直接使用登录返回的 `user.id`（UUID）作为分享来源；不创建独立邀请码，也没有获取邀请码/分享参数接口。
- 分享 query：`inviterUid=<分享玩家的user.id>`。UID 标识来源，不是秘密或访问凭据。不得把 accessToken、openid、昵称或头像放进 query。
- 被邀请者是当前小游戏的新注册用户，完成登录即可算有效拉新。不要求通关、等级或留存。
- 当前小游戏中，一个新用户只允许绑定一个邀请人，不允许自邀；第一条合法且成功提交的上报胜出，之后不能覆盖。
- 邀请列表不下发邀请记录 ID。领取时以 `inviteeUid`（被邀请玩家的 UID）定位邀请关系，邀请人身份来自 Bearer。
- 服务端只登记奖励已领取；真实奖励由客户端发放。服务端不维护奖励数额、金币/道具钱包，也不证明实际到账。
- 头像昵称需客户端获得玩家授权后上传。未授权时可为空，不阻塞归因；后续上传后列表展示当前资料。

## 已退役：好友昨日视频奖励

2026-11-05 两环境均已关闭：`POST /invites/video-rewards/claim` 返回 404；`/invites/list` 不再含顶层 `serverDate`、`videoRewardDate` 或条目 `yesterdayVideoReward`。不得恢复该功能，旧接入契约已清理；两环境关闭结果与证据见[退役记录](feature-retirements.md)。下文普通拉新 report/list/claim、每日最多新领 50 份、未领取优先均保留。存档和玩家自身视频完成统计不受影响，统计接口不等于视频钻石领奖。

## 2. 通用约定

接口前缀：`https://sub2api.wdaveh5game.com/h5login/api`。

以下四个接口均为 `POST`，请求头：

```text
Content-Type: application/json
Authorization: Bearer <登录返回的accessToken>
```

使用普通 JSON，无自定义加密。所有响应 `Cache-Control: no-store`。请求正文最多 16 KiB，不支持压缩正文；只允许文档点名字段，禁止额外 query 参数。服务端按当前应用+用户限流，资料/邀请功能共享每分钟 60 次额度，与存档额度分开。429 带 `Retry-After`，客户端遵循退避，不无限重试。

UID 为 UUID 字符串；所有当前操作者身份由 Bearer 解析，不允许靠请求体冒充其他用户。openid 仍在服务端用户表保存，可按 `app_id + open_id` 关联查询邀请关系以排查平台反馈；普通邀请列表不暴露其他人的完整 openid。

## 3. 登录扩展与新用户资格

`POST /auth/wechat-login` 必填 `code`，可选 `clientVersion`、`scene`；旧 `{"code":"新鲜wx.login code"}` 继续兼容。完整字段见 [wechat-login-api.md](wechat-login-api.md)，不接收 inviterUid 或客户端声明的新老用户状态。

登录返回顶层 `isNewUser`；以下仅摘录邀请相关字段，完整 user 还含可空 nickname/avatarUrl，见登录契约：

```json
{
  "accessToken": "<不透明登录令牌>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "isNewUser": true,
  "user": {"id":"<UUID>","openid":"<当前小游戏微信openid>"}
}
```

服务端将首次成功注册登录的资格写入该次会话，不相信客户端传来的 `isNewUser`，也不以上报时用户表是否存在来判断（登录后记录本来就已经存在）。历史账号、重装、清缓存、换设备、再次登录不会产生新用户资格。部署迁移前已存在的用户一律按老用户处理。

首次注册会话可在其原有有效期内报告邀请；没有额外十分钟窗口，也不另签发 inviteBindToken。再次登录的新 token 不延长或重新授予资格，因此应保存首次登录 token 并及时上报。若已经绑定同一邀请人，用该用户后续会话重试上报仍返回原绑定结果。

登录使用数据库事务串行化同一用户的首次登录并完成 Redis 会话确认；Redis 写失败不消耗首次注册资格。数据库或 Redis 失败返回脱敏 503，不向客户端返回未确认 token。

**边界：首次成功登录响应在网络上丢失，客户端再次登录时可能已经是老用户会话；本版不承诺丢失首登 token 后仍可补绑。** 点击来源由客户端报告，不能将其描述为微信提供的可信点击证明。

## 4. 更新本人资料

`POST /users/profile`

```json
{"nickname":"玩家昵称","avatarUrl":"https://example.com/avatar.png"}
```

- **正式与测试环境均支持（正式服于 2026-10-22 发布）**：`nickname` 仍必填；`avatarUrl` 可传 `""` 或 `null` 清空头像，统一保存和返回 `null`；省略 `avatarUrl` 则保留已有头像，首次无旧头像时为 `null`。非空头像地址继续按下面规则校验。
- 旧客户端继续提交完整的 `nickname` 与 HTTPS `avatarUrl` 时，请求与响应结构不变。昵称 1–64 个 Unicode 码点，不接受全空白、控制字符或畸形 UTF-16。
- avatarUrl 为长度不超过 2048 的 HTTPS URL，不允许 URL 内嵌用户名密码；服务端只保存地址，不抓取、代理或下载图片，避免 SSRF。
- 资料是展示信息，不作为身份、邀请归属或奖励资格证明。

响应结构：

```json
{"user":{"id":"<当前玩家UID>","nickname":"玩家昵称","avatarUrl":"https://example.com/avatar.png"}}
```

获取真实微信头像昵称需符合小游戏隐私声明与授权要求；玩家拒绝授权时可跳过此接口，列表返回 null，客户端自行展示默认值。昵称头像的展示和内容安全由产品结合平台规范处理，不能声称客户端上传的资料已由微信认证。

### 资料展示安全与空头像示例

- 服务端只保存头像地址，不代上传图片、不抓取或代理图片；请先取得可访问的 HTTPS 图片地址，不能直接传本地临时文件路径。
- 这是展示资料，不代表微信认证资料；获取和展示须符合小游戏隐私、授权及内容安全规则。
- **昵称是原始、未做 HTML 转义的不可信文本。** 请使用普通文本组件（如 `textContent` / 非富文本 Label）展示；若必须进入 HTML/富文本上下文，先按该上下文安全转义，禁止直接拼入 `innerHTML`。
- **头像地址也是玩家提供的不可信外链。** HTTPS 不代表可信；客户端宜限制允许的图片域名和资源类型，加载失败时使用默认头像。直接加载第三方图片可能向该站点暴露玩家 IP 等网络信息，请结合隐私策略处理。

### 空头像请求示例

下面三种请求都允许，区别是“显式清空”与“保留旧值”：

```json
{"nickname":"只有昵称","avatarUrl":""}
```

```json
{"nickname":"只有昵称","avatarUrl":null}
```

```json
{"nickname":"只更新昵称"}
```

前两种保存后 `user.avatarUrl` 均为 `null`，不会返回空字符串；第三种保留旧头像，原本没有头像则为 `null`。

### 成功响应：HTTP 200

```json
{
  "user": {
    "id": "<当前玩家UUID>",
    "nickname": "玩家昵称",
    "avatarUrl": "https://example.com/avatar.png"
  }
}
```

此接口响应不包含 `openid`；客户端可直接更新当前显示和本地资料缓存。已有登录响应不会自动改变，下一次成功登录会返回新资料。

资料恢复联调：未上传登录返回双 null → 用同一 token 上传资料 → 取得新 code 重登核对同 UID/已保存资料 → 更新后再次重登核对。须先完成首次会话邀请归因，再进行重登验证；不能让资料验收耗掉首次资格。

## 5. 登录后报告邀请来源

`POST /invites/report`

```json
{"inviterUid":"<启动参数中的分享玩家UID>"}
```

当前 Bearer 是被邀请玩家 B 的 token。服务端验证 A 的 UID 存在且属于同一个小游戏、非自邀、B 为首次注册会话，并且未绑定其他邀请人。邀请人必须已在被邀请人注册时存在，不能用后来创建的用户制造反向/循环归因。

首次绑定成功：

```json
{"accepted":true,"alreadyBound":false,"rewardClaimed":false}
```

同一邀请人重复上报：

```json
{"accepted":true,"alreadyBound":true,"rewardClaimed":false}
```

已领取后重复上报时 rewardClaimed 为 true。成功响应均不包含邀请记录 ID。

业务上不计入拉新时返回 HTTP 200 与原因：

```json
{"accepted":false,"reason":"NOT_NEW_USER"}
```

可能原因包括 `NOT_NEW_USER`（非首次注册会话）、`SELF_INVITE`（自邀）、`ALREADY_ATTRIBUTED`（已归属其他邀请人）。校验顺序为：自邀 → 已有绑定的幂等/冲突结果 → 新用户资格 → 来源存在性。仅对尚未绑定且具备资格的新注册会话，继续校验邀请人是否存在、同应用且不晚于被邀请人注册；不符合时返回 404 `INVITER_NOT_FOUND`，不返回目标用户信息。客户端可提交合法来源参数，由服务器给出业务结果。

## 6. 查询本人邀请列表

`POST /invites/list`

```json
{"cursor":null,"limit":20}
```

cursor 默认 null，limit 默认 20，允许 1–100。**默认全列表未领取优先**：先返回 `rewardClaimed:false`，再返回 `rewardClaimed:true`；各组内按邀请时间倒序，时间相同按 inviteeUid 倒序。超过 100 条继续按此顺序分页，不是只对当前页重排。summary 仍统计全部记录。

传入后续响应的 nextCursor 获取下一页，不解析或修改游标。此排序更新采用包含领取分组的新版游标；旧版游标返回 400 `INVALID_INVITE_CURSOR`，客户端应清空已有列表及游标，从 `cursor:null` 重新请求。

本版不是跨请求数据库快照：新增邀请或领取会改变实时列表。**领取成功后清空旧分页并从首页刷新**，记录会进入已领取组；继续使用旧游标时，已领取的移动记录可能再次出现，客户端应按 inviteeUid 合并去重，不能据列表重复项重复发奖。翻页期间新出现的记录仍需刷新首页查看。

发布状态：2026-10-17 “未领取优先”先部署到常驻测试环境 `/h5login-test/api`（源代码提交 `749695f`），公网135条混合记录分页及领取后重排验证通过；随后随完整版本发布正式服，公网分组排序回归通过。

结构示例（非真实账号数据）：

```json
{
  "items": [
    {
      "inviteeUid": "<被邀请玩家UID>",
      "nickname": null,
      "avatarUrl": null,
      "invitedAt": "2026-10-17T04:00:00.000Z",
      "rewardClaimed": false,
      "rewardClaimedAt": null,
      "claimId": null
    }
  ],
  "summary": {"total":1,"claimed":0,"unclaimed":1},
  "nextCursor": null
}
```

- items 只包含当前 Bearer 所属邀请人的记录，不允许指定任意 inviterUid 查询别人的列表。
- summary 是服务端统计的全部邀请记录，不是当前页计数。
- 未上传资料返回 null；后续更新头像昵称会反映在列表中。
- 不下发 `id` 或 `invitationId`。`claimId` 是领取凭据，不是邀请记录 ID；已领取记录返回固定 claimId，可用于恢复和去重。

## 7. 登记领取奖励

`POST /invites/claim`

```json
{"inviteeUid":"<该条记录的被邀请玩家UID>"}
```

操作者必须是此玩家的邀请人。服务端原子写入领取凭据和时间：

```json
{
  "claimId":"<固定UUID领取凭据>",
  "rewardClaimed":true,
  "rewardClaimedAt":"2026-10-17T04:05:00.000Z"
}
```

相同邀请关系的并发/重复请求返回同一 claimId 和同一时间，不产生第二次领取。没有邀请关系或不属于当前用户，统一返回 404 `INVITATION_NOT_FOUND`，不泄露其他用户是否存在。

### 每日领取上限

- 每名邀请人按**北京时间（Asia/Shanghai）自然日，每天最多新领取 50 份邀请奖励**，每日 00:00 重新计算额度，不是滚动 24 小时。
- 按服务端实际 `rewardClaimedAt` 计入领取当天，不按邀请发生时间。只限制领取，不限制邀请人数；未领取记录不失效，可在次日继续领取。
- 重试已领取记录始终返回原 claimId 和时间，不重复占额度；即使当天已达上限仍允许查询原领取凭据。
- 达到上限后，尝试领取另一条未领取记录返回 HTTP **409**：

```json
{"message":"INVITE_DAILY_CLAIM_LIMIT","error":"Conflict","statusCode":409}
```

- 被拒绝的记录仍为未领取，不能发奖。前端提示“今日领取已达50次，请明日再来”，不要自动连续重试；已有每分钟请求限流的 429 是另一种错误。
- 配额在数据库事务中按邀请人串行校验，多个设备、token、API进程并发共享同一额度。切换客户端日期或重新登录不会重置额度；升级前当天已登记的领取也计入上限。
- `/invites/list` 的 summary 仍是**累计**计数，不代表今日领取次数；接口字段保持不变，没有新增今日剩余额度字段。
- 发布状态：2026-10-17 每日上限先部署到常驻测试环境 `/h5login-test/api`（源代码 `f821c5b`），通过公网配额/并发/北京时间边界验证；随后发布正式环境，正式公网验证49→50并发只成功1次、另1次409且保持未领取，已领取重试凭据不变。

### 客户端发奖边界

- 收到成功响应后，由客户端根据自身奖励配置实际增加道具；服务器不返回或决定奖励数量。
- 客户端按 claimId 持久去重；不能每收到一次 `rewardClaimed:true` 就再加一次。
- 客户端重复请求拿到相同凭据，只用于恢复原操作；邀请列表也能查看已领取凭据。
- 如奖励与已消费 claimId 都存游戏 JSON 存档，应一次保存二者并遵守存档 CAS，冲突时先读取最新存档合并；禁止盲目覆盖。
- 本方案只保证服务端登记幂等，不保证客户端道具不可作弊，也不保证服务端登记与客户端发奖跨进程 exactly-once。登记成功后客户端崩溃可能漏发，多设备未正确合并可能重复发奖；产品接受此边界，不应把已领取写成已到账。

## 8. 微信客户端接入顺序

1. 分享者已有登录结果 `auth`，调用微信分享：

```js
wx.shareAppMessage({
  title: '一起来玩',
  query: 'inviterUid=' + encodeURIComponent(auth.user.id)
});
```

2. 冷启动读取 `wx.getLaunchOptionsSync().query`，热启动监听 `wx.onShow(options)` 的 query，缓存待上报 inviterUid。没有参数的普通 onShow 不要误覆盖尚未提交的来源。对于同一注册过程中的多个来源建议保留首个有效来源，实际绑定仍以服务器成功提交为准。
3. 使用新鲜 wx.login code 登录，保存 token。同一启动流程应复用一个登录 Promise，避免并发登录；只有一个响应会携带首次注册资格。拿到该会话后立即使用它上报归因，在结果明确前不要主动重新登录或让其他登录响应覆盖此 token。
4. 如果存在 inviterUid，以当前 token 调用 /invites/report；网络超时可在同一首次注册会话内退避重试，不要为每次重试重新登录。成功或明确业务拒绝后清理待上报来源。
5. 头像昵称授权与 /users/profile 独立执行，不阻塞第 4 步。
6. 邀请人调用 /invites/list 展示好友，点击领取调用 /invites/claim，再按 claimId 去重发奖。

wx.request 是回调接口，不应直接假设 `await wx.request()` 得到响应；需封装 Promise。此功能无需新增 SDK，客户端可自行接入现有 HTTPS JSON。

## 9. 错误与运维

- 400：无效 JSON、字段/UID/游标/URL 不合法或存在额外字段。
- 401 `SESSION_INVALID`：会话缺失、失效、跨应用；重新登录，但新 token 不会重获首次注册资格。
- 404：邀请来源不存在/不属于同应用、领取目标不属于自己等；不泄露目标资料。
- 409 `INVITE_DAILY_CLAIM_LIMIT`：今日新领取已达 50 份，保留未领取状态，次日北京时间 00:00 后可继续；不执行客户端发奖。
- 429：功能限流，遵循 Retry-After。
- 503：存储不可用，返回脱敏错误，不包含 SQL、连接字符串、token 或上游 secret。
- 413/415 等通用正文错误可能来自 Nginx，客户端兼容非 JSON 错误响应。

开发使用隔离 PG15439、Redis16389/15，明确微信换码测试替身。真实客户端验收需两名真实微信用户，其中被邀请者必须从未注册此小游戏；覆盖冷启动/热启动、授权拒绝、网络重试、重复领取和旧用户不计数。

分享及奖励玩法应核对微信最新运营与隐私规范，不强制分享解锁，不将接口实现当作平台合规审批。

参考：[微信分享参数](https://developers.weixin.qq.com/minigame/dev/api/share/wx.shareAppMessage.html)、[小游戏用户信息授权](https://developers.weixin.qq.com/minigame/dev/guide/open-ability/user-info.html)。
