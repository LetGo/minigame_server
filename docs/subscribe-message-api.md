# 签到提醒订阅消息：仅测试服、手动指定用户联调

> 本阶段先提供**手动指定单个用户的测试服联调**，暂不开自动推送；尚未提供真实测试服登录 UID。测试证据需区分接口验证和真实游戏授权/微信收件，禁止正式服、批量发送或 cron。

## 固定内容与边界

- 测试服 baseUrl：`https://sub2api.wdaveh5game.com/h5login-test`（不含 `/api`）。
- 固定模板 ID：`2QYSHFLi0JmD9vcoKqXLEzGwCRibBAqvpl7nHjA66v4`；模板库编号 **85**；类型 `once`。
- 固定 `phrase1.value`：`未签到`。
- 固定 `thing10.value`：`签到领海量奖励`。
- 固定 `thing5.value`：`您的猫咪提示您有海量钻石待领取`。
- 依用户要求，来源标签/消息状态始终使用 `未签到`；**没有真实服务端签到系统，也没有签到状态判断或钻石发放逻辑**。
- 消息跳转环境固定 `miniprogram_state: "trial"`，手动发送脚本默认 `page: "index"`；可显式指定游戏内页面。
- **测试服与正式服使用同一个微信 AppID，微信订阅权限/一次性次数并不是两套沙箱。`trial` 只控制点击卡片打开体验版；真实试发仍会消耗该测试玩家在微信端的订阅机会，因此只向明确指定、已同意的测试用户发送。**
- 登录 API 返回的 `accessToken` 是游戏服务端会话凭证，不是微信服务端 `access_token`。客户端不得接触 AppSecret 或微信服务端发送凭证。

## 公共客户端接口

所有请求使用 HTTPS、`POST`、`Content-Type: application/json` 和 `Authorization: Bearer <测试服登录 accessToken>`。身份只由服务端会话确定；不要提交 `openid`、`userId`、`uid`、`appId` 等身份覆盖字段，也不要放入 URL。正式服 token/UID 不可混用于测试服。

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

**这些是客户端可伪造的回调观察，不是微信核验过的发送额度；不得累加 accept 作为可用发送次数。一次性订阅是否可发送最终由微信执行限制。`wx.getSetting` 读取的是已有设置，不是新授权，不能据此补报 accept。** 无公共发送接口；成功上报不会自动发送消息。

## 可选、零依赖前端 helper

文件：`client/checkin-subscription-client.mjs`，唯一模块导出：

```js
import { createCheckinSubscriptionClient } from './checkin-subscription-client.mjs';

const client = createCheckinSubscriptionClient({
  wx,
  accessToken: stagingLoginResult.accessToken,
  // 默认就是测试服；自定义地址也必须为 HTTPS 且精确以 /h5login-test 结尾。
  baseUrl: 'https://sub2api.wdaveh5game.com/h5login-test',
});
```

返回 `requestSubscription(eventId)`、`reportResult({eventId, status})`，均返回 Promise；未实现可选的 `getTemplate()`。源码为 ESM，可由游戏现有打包器导入；不需要安装运行时依赖，也不提供新的打包产物。

- 工厂同步校验 32 字节登录 token 的规范 base64url 表示（43 字符），只接收原 token，不接收带 `Bearer ` 的字符串、空白、非规范尾位。
- `eventId` 必须由调用方提供规范小写 UUID（版本 1–8、RFC variant）；不接受大写、空白、nil UUID。不使用 crypto/随机 API 生成 ID；调用方使用自己可靠的 UUID 生成机制，**不要用 UID 当 eventId**。
- 仅接受精确的 HTTPS `/h5login-test` base，拒绝 `/h5login` 正式服、`/api`、尾斜杠、凭证、查询/片段和路径穿越。自定义测试域名需加入微信 request 合法域名；helper 校验不代替后端环境隔离。
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

当前仅支持手动指定单个用户测试；没有真实测试服登录 UID 前不执行发送。后端操作者先等实际游戏点击产生本模板的有效同意，再取得**该玩家在测试服本次登录返回的 `user.id`**，由服务端根据该 UID 找到 openid。不要把客户端传来的 openid 当接收人，也不要用正式服 UID。

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
3. 仍需真实游戏按钮点击、测试服登录 UID、指定用户 dry-run、显式手动 send、玩家确认微信收件与跳转，才能描述为真实链路验证。本次尚缺真实 UID 与这组人工证据，不做正式服或批量试发。

## 参考与本地验证

- [微信官方：小游戏订阅消息指南](https://developers.weixin.qq.com/minigame/dev/guide/open-ability/subscribe-message.html)：普通模板为一次性；多次提醒需再次在游戏内调用订阅接口。
- [微信官方：wx.requestSubscribeMessage](https://developers.weixin.qq.com/minigame/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)：点击限制、动态模板键与 accept/reject/ban/filter 状态。
- [微信官方：subscribeMessage.send / sendMessage](https://developers.weixin.qq.com/minigame/dev/api-backend/subscribe-message/api_sendmessage)：仅服务端调用、trial/page 参数、发送错误码。

只运行聚焦测试，不构建/改写当前生产 dist：

```sh
node --import tsx --test test/checkin-subscription-client.test.ts
```
