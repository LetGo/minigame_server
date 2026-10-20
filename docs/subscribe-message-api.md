# 签到提醒订阅消息：正式服/测试服接入与每日9点提醒

> 正式服与测试服均提供订阅上报接口及每天北京时间 **09:00** 的服务端提醒，只面向本环境已订阅且当天尚未登录的玩家。正式服点击消息进入正式版，测试服进入体验版。测试服已完成真实单用户收件和体验版跳转验证；正式服首轮定时收件另行验证。

## 固定内容与边界

- 正式服 baseUrl：`https://sub2api.wdaveh5game.com/h5login`（不含 `/api`）。
- 测试服 baseUrl：`https://sub2api.wdaveh5game.com/h5login-test`（不含 `/api`）。
- 下方协议示例使用测试服地址；正式服把 `/h5login-test` 替换成 `/h5login`，并使用**正式服登录得到的 token**。UID、登录会话、订阅上报与发送记录按环境隔离，不迁移测试服记录。
- 固定模板 ID：`2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4`；模板库编号 **85**；类型 `once`。
- 固定 `phrase1.value`：`未签到`。
- 固定 `thing10.value`：`签到领海量奖励`。
- 固定 `thing5.value`：`您的猫咪提示您有海量钻石待领取`。
- 依用户要求，来源标签/消息状态始终使用 `未签到`；**没有真实服务端签到系统，也没有签到状态判断或钻石发放逻辑**。
- 消息跳转环境由服务端固定：正式服 `miniprogram_state: "formal"`，测试服 `"trial"`；默认 `page: "index"`，客户端不能覆盖跳转环境。
- **测试服与正式服使用同一个微信 AppID，微信订阅权限/一次性次数并不是两套沙箱。`trial` 仅控制跳转体验版；任一环境的真实发送都可能消耗微信端同一用户、同一模板的订阅机会。两套本地记录不能证明微信有两份独立额度。**
- 登录 API 返回的 `accessToken` 是游戏服务端会话凭证，不是微信服务端 `access_token`。客户端不得接触 AppSecret 或微信服务端发送凭证。

## 公共客户端接口

所有请求使用 HTTPS、`POST`、`Content-Type: application/json` 和 `Authorization: Bearer <本环境登录 accessToken>`。身份只由服务端会话确定；不要提交 `openid`、`userId`、`uid`、`appId` 等身份覆盖字段，也不要放入 URL。正式服 token/UID 不可混用于测试服。

### 1. 查询模板（可选，不能插在点击与订阅 API 之间）

`POST https://sub2api.wdaveh5game.com/h5login-test/api/subscriptions/checkin/template`

请求体：`{}`。响应：

```json
{
  "templateId": "2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4",
  "templateNumber": 85,
  "type": "once",
  "miniprogramState": "trial",
  "data": {
    "phrase1": { "value": "未签到" },
    "thing10": { "value": "签到领海量奖励" },
    "thing5": { "value": "您的猫咪提示您有海量钻石待领取" }
  }
}
```

需要查询时可在页面初始化阶段独立调用；helper 使用固定模板，不会在授权前请求此接口。

### 2. 上报本次订阅回调观察结果

`POST https://sub2api.wdaveh5game.com/h5login-test/api/subscriptions/checkin/report`

```json
{
  "eventId": "9b9f8d21-1c00-4f11-8a02-123456789abc",
  "templateId": "2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4",
  "status": "accept"
}
```

`status` 只允许微信该模板回调中的 `accept`、`reject`、`ban`、`filter`，分别表示同意、拒绝、封禁、同名标题过滤。取消、失败、缺失模板键或无效状态不能捏造为 `accept`/`reject`。

```json
{
  "eventId": "9b9f8d21-1c00-4f11-8a02-123456789abc",
  "templateId": "2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4",
  "status": "accept",
  "recordedAt": "2026-10-20T01:00:00.000Z",
  "alreadyRecorded": false
}
```

相同事件重试必须保持原 `eventId`、模板和状态；`alreadyRecorded: true` 是既有观察记录的回执，不是一次新授权。HTTP/网络错误可能发生于服务端已经记录之后，不能通过换 UUID 再次上报来“恢复次数”。示例 UUID/时间只是协议示例，不是真实用户联调记录。

**这些是客户端可伪造的回调观察，不是微信核验过的发送额度；不得累加 accept 作为可用发送次数。一次性订阅是否可发送最终由微信执行限制。`wx.getSetting` 读取的是已有设置，不是新授权，不能据此补报 accept。** 无公共发送接口；成功上报不会立即触发发送，自动提醒仅在定时任务筛选通过后执行。

## 可选、零依赖前端 helper

文件：`client/checkin-subscription-client.mjs`，唯一模块导出：

```js
import { createCheckinSubscriptionClient } from './checkin-subscription-client.mjs';

const client = createCheckinSubscriptionClient({
  wx,
  accessToken: stagingLoginResult.accessToken,
  // 默认仍是测试服；正式服必须显式传 https://sub2api.wdaveh5game.com/h5login。
  baseUrl: 'https://sub2api.wdaveh5game.com/h5login-test',
});
```

返回 `requestSubscription(eventId)`、`reportResult({eventId, status})`，均返回 Promise；未实现可选的 `getTemplate()`。源码为 ESM，可由游戏现有打包器导入；不需要安装运行时依赖，也不提供新的打包产物。

- 工厂同步校验 32 字节登录 token 的规范 base64url 表示（43 字符），只接收原 token，不接收带 `Bearer ` 的字符串、空白、非规范尾位。
- `eventId` 必须由调用方提供规范小写 UUID（版本 1–8、RFC variant）；不接受大写、空白、nil UUID。不使用 crypto/随机 API 生成 ID；调用方使用自己可靠的 UUID 生成机制，**不要用 UID 当 eventId**。
- 仅接受精确的 HTTPS `/h5login-test`（测试服）或 `/h5login`（正式服）base，拒绝 `/api`、尾斜杠、凭证、查询/片段和路径穿越。默认仍为测试服，不自动切换或回退环境；正式服须显式指定 baseUrl 并使用正式服 token。自定义域名需加入微信 request 合法域名；helper 校验不代替后端环境隔离。
- `requestSubscription` 内部 Promise executor 同步调用 `wx.requestSubscribeMessage`，在它之前无网络、无 `await`。随后仅上报实际回调状态与原 UUID。`wx.request` 以回调封装 Promise，不把 RequestTask 当结果。
- 不读写凭证存储、不日志输出原始错误、不自动重试。缺少订阅 API 返回 `SUBSCRIPTION_API_UNAVAILABLE`；取消/调用失败返回 `SUBSCRIPTION_REQUEST_FAILED`；无效回调返回 `INVALID_SUBSCRIPTION_CALLBACK`，均不产生 pendingReport。
- 上报网络/SDK 抛错返回 `SUBSCRIPTION_NETWORK_ERROR`，HTTP 非 200 返回 `SUBSCRIPTION_REQUEST_FAILED`（可带 `statusCode`），无效响应返回 `INVALID_SUBSCRIPTION_RESPONSE`。这些上报错误附带安全的 `error.pendingReport = {eventId, status}`，不含 token/openid/原始响应；它仅表示待核对/重试的观察事件，不保证每种 HTTP 错误都适合立即重试。

### 点击处理与人工重试

下列 `obtainNextEventUuid()` 由调用方实现，**在点击前**准备好新事件 UUID。按钮注册方式由游戏引擎决定；`onSubscribeClick` 必须直接处于真实用户点击回调中。

```js
let nextEventId = obtainNextEventUuid();
let pendingReport = null;
let busy = false;

function onSubscribeClick() {
  if (busy || pendingReport) return; // 先处理未完成上报，避免把重试当成新授权。
  busy = true;
  const currentEventId = nextEventId;
  // 不要在此调用之前 await 登录、请求模板、定时器或其他异步操作。
  const operation = client.requestSubscription(currentEventId);
  operation.then(receipt => {
    showObservedStatus(receipt.status); // accept 也仅显示“已观察到同意”，不是送达。
  }).catch(error => {
    pendingReport = error.pendingReport || null;
    showSafeError(error.message);
  }).finally(() => {
    busy = false;
    nextEventId = obtainNextEventUuid(); // 只供下一次独立用户点击，不用于上报重试。
  });
}

async function onRetryReportClick() {
  if (busy || !pendingReport) return;
  busy = true;
  try {
    const receipt = await client.reportResult(pendingReport); // 不弹窗、不新建 UUID。
    pendingReport = null;
    showObservedStatus(receipt.status);
  } catch (error) {
    // 保留原观察事件；先处理离线、过期登录、限流等原因，再由用户手动重试。
    showSafeError(error.message);
  } finally {
    busy = false;
  }
}
```

例中的 UI/UUID 函数是游戏侧接入点，不是 helper 导出。登录过期时先取得**同一测试服用户**的新 token 并重建 client，再用原 pendingReport 重试；更换账号/环境必须隔离或丢弃旧 pendingReport，不可上报到新账号。helper 不负责持久化，也不存 token。

## 后端手动指定用户联调（不是客户端 API）

除每日定时任务外，仍保留手动指定单个用户的联调命令。后端操作者先等实际游戏点击产生本模板的有效同意，再取得**该玩家在测试服本次登录返回的 `user.id`**，由服务端根据该 UID 找到 openid。不要把客户端传来的 openid 当接收人，也不要用正式服 UID。

以下 `UUID_FROM_STAGING_LOGIN`、`NEW_UUID` 是**文档字面占位符**，必须由操作者替换成真实测试服登录 UID 和新的发送请求 UUID；不要原样执行。每次新的实际发送意图使用新的 request-id；它与客户端观察的 eventId 概念不同，不能据此增加授权。

先 dry-run（默认不调用微信发送）：

```sh
node ops/send-checkin-subscription.mjs --user-id UUID_FROM_STAGING_LOGIN
```

核对指定用户、模板、固定内容、`miniprogram_state: trial` 和默认 `page: index` 后，仅在操作者明确决定发送时：

```sh
node ops/send-checkin-subscription.mjs --user-id UUID_FROM_STAGING_LOGIN --send --request-id NEW_UUID
```

可选指定站内页面：

```sh
node ops/send-checkin-subscription.mjs --user-id UUID_FROM_STAGING_LOGIN --send --request-id NEW_UUID --page 'index?source=checkin'
```

不要自动重试发送、不要因发送结果不明确换 request-id 盲目重发；按后台发送记录核对后再决定。微信服务端返回成功仍不等于用户设备已显示/已阅读；最终需玩家确认微信“服务通知”收到卡片，并点击验证体验版游戏及 page 跳转。`43101` 说明未订阅或一次性次数已用完；不能靠伪造 accept 上报修复。

### 验收证据必须分层

1. 本地 helper 测试只证明同步调用顺序、参数校验、状态与安全重试行为；模拟 wx 回调不是真实授权。
2. 后端 fixtures/接口测试只证明服务端契约和隔离，不证明真实用户微信同意或收到了消息。
3. 已在2026-10-20完成真实玩家订阅、手动发送、玩家确认微信收件及体验版跳转；这不等于每日定时批次已实际执行，首次定时运行仍需单独核验。

## 每日北京时间09:00提醒（正式服/测试服）

前端接口和授权按钮接法不变，不新增客户端群发接口。正式服 `minigame-production-checkin.timer`、测试服 `minigame-staging-checkin.timer` 分别每天按 `Asia/Shanghai` 09:00触发，普通玩家不能指定接收人或启动任务。

### 筛选与去重

- 只处理本环境同AppID、已完成登录注册的账号；最新的本模板回调必须是 `accept`。
- “当天”是北京时间 `[00:00, 次日00:00)`；当天存在成功登录日记录，或最近成功登录时间落在当天，均跳过。不按在线状态、签到接口或广告事件判断。
- 发送前在用户行锁内再次读取登录和订阅信息；如果在等待期间已登录、撤回/拒绝或授权观察已经被发送尝试使用，则跳过。预约提交与外部微信调用无法组成跨系统原子事务：最终检查后瞬间新登录或新上报拒绝仍存在极小竞态，不声称完全消除。
- 不把多条 `accept` 累加为微信发送次数。保守地仅使用最新且晚于已有发送尝试的授权观察；手动试发也会使该观察不再用于自动任务。已消耗后需再次真实点击订阅，不能换eventId伪造次数。
- 每个玩家每天最多一次定时发送尝试，有数据库唯一约束；即使当天后来再次订阅，也不会再自动发一条。当次微信明确拒绝也不在当天盲目重试。
- 顺序、限速发送；微信明确“未订阅/次数不足”记录后跳过。发送结果不明、数据库故障或全局凭据/模板错误会停止本批次，不自动重发，不清除待核查记录。

### 运行窗口与操作

定时触发点是09:00。实际发送只允许北京时间09:00至10:00之间，超过窗口不再新增发送。定时器不补发机器停机时错过的任务，也不自动重启失败的批次；正常下一天仍会按时触发并重新筛选。

只读预览（不发送、不消耗微信权限）：

```sh
# 正式服
node runtime/production-checkin/current/ops/run-production-checkin.mjs
# 测试服
node ops/run-daily-checkin.mjs
```

定时器使用受限的 `--send` 入口。正式服必须同时满足正式服地址硬校验、`SUBSCRIBE_MESSAGES_ENABLED=true`、`SUBSCRIBE_MINIPROGRAM_STATE=formal` 和 `PRODUCTION_DAILY_CHECKIN_ENABLED=true`；测试服必须满足测试服硬校验及 `SUBSCRIBE_MESSAGES_ENABLED=true`、`STAGING_DAILY_CHECKIN_ENABLED=true`。不提供环境、日期、时间、OpenID或接收人覆盖参数。不要为补跑而调整服务器时间或直接改数据库回执。

查看状态和日志：

```sh
systemctl list-timers minigame-production-checkin.timer minigame-staging-checkin.timer
journalctl -u minigame-production-checkin.service --no-pager
journalctl -u minigame-staging-checkin.service --no-pager
```

暂停后续自动提醒（不影响API或手动试发）：

```sh
sudo systemctl disable --now minigame-production-checkin.timer
# 测试服需单独暂停：
sudo systemctl disable --now minigame-staging-checkin.timer
```

两环境分别筛选各自的订阅记录；不迁移测试服授权观察至正式服，不清空任何真实订阅或发送历史。测试/正式共用微信AppID的一次性权限风险仍适用。实际定时收件需要符合条件的真实玩家，不能用模拟授权或测试替身宣称已送达。

## 参考与本地验证

- [微信官方：小游戏订阅消息指南](https://developers.weixin.qq.com/minigame/dev/guide/open-ability/subscribe-message.html)：普通模板为一次性；多次提醒需再次在游戏内调用订阅接口。
- [微信官方：wx.requestSubscribeMessage](https://developers.weixin.qq.com/minigame/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)：点击限制、动态模板键与 accept/reject/ban/filter 状态。
- [微信官方：subscribeMessage.send / sendMessage](https://developers.weixin.qq.com/minigame/dev/api-backend/subscribe-message/api_sendmessage)：仅服务端调用、trial/page 参数、发送错误码。

只运行聚焦测试，不构建/改写当前生产 dist：

```sh
node --import tsx --test test/checkin-subscription-client.test.ts
```
