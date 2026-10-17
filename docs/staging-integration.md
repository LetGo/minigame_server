# 小游戏测试环境联调指南

## 1. 地址与状态

2026-10-17 已部署常驻测试环境，包含最新登录、普通 JSON 存档、头像昵称、邀请拉新与领取登记。

| 环境 | API 前缀 |
|---|---|
| 测试（开发版/体验版） | `https://sub2api.wdaveh5game.com/h5login-test/api` |
| 正式 | `https://sub2api.wdaveh5game.com/h5login/api` |

**本次只发布测试环境。正式环境尚未发布邀请功能和登录新增的 `user.openid`、`isNewUser` 字段。**

复用现有 HTTPS 域名和微信小游戏 AppID，不需要新增 request 合法域名；已有域名仍需在微信后台配置：`https://sub2api.wdaveh5game.com`（不带路径）。测试环境真实调用微信换码，不存在公开的假登录接口。

## 2. 前端切换

在构建配置中明确指定环境，建议开发版/体验版使用测试地址，正式版使用正式地址；不要让任意分享 query 决定后端环境。

```js
// 测试构建：正式构建改为 /h5login/api，且使用另一组 storage key。
const API_BASE = 'https://sub2api.wdaveh5game.com/h5login-test/api';
const STORAGE_PREFIX = 'minigame_test_';

function postApi(path, body, accessToken) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + path,
      method: 'POST',
      header: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {})
      },
      data: body,
      timeout: 20000,
      success(res) {
        if (res.statusCode === 200) return resolve(res.data);
        const error = new Error('API_REQUEST_FAILED');
        error.statusCode = res.statusCode;
        error.apiBody = res.data;
        error.retryAfter = res.header &&
          (res.header['Retry-After'] || res.header['retry-after']);
        reject(error);
      },
      fail: reject
    });
  });
}

// wx.login() 拿到 code 后：
// const auth = await postApi('/auth/wechat-login', { code });
// wx.setStorageSync(STORAGE_PREFIX + 'access_token', auth.accessToken);
// 使用当前首次注册会话立即完成邀请上报，不要并发重复登录覆盖 token。
```

测试与正式的 token、UID、存档版本、待上报邀请来源、claimId 去重记录都必须分开保存，切环境时不能复用。**同一微信用户的 openid 相同，不代表两个环境中的 UID 相同。** 测试分享必须携带测试登录返回的 UID，双方应进入相同的测试构建；不要拿正式 UID 在测试环境绑定。

HTTPS 测试响应带 `X-Minigame-Environment: staging`，可用于联调确认，但此头不是鉴权凭据。

## 3. 接口速查

所有请求均为 POST、普通 JSON。除登录外，必须携带 `Authorization: Bearer <accessToken>`。

| 完整测试地址 | 请求正文 |
|---|---|
| `https://sub2api.wdaveh5game.com/h5login-test/api/auth/wechat-login` | `{"code":"wx.login返回的新鲜code"}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/users/profile` | `{"nickname":"玩家昵称","avatarUrl":"https://example.com/avatar.png"}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/invites/report` | `{"inviterUid":"分享者的测试UID"}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/invites/list` | `{"cursor":null,"limit":20}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/invites/claim` | `{"inviteeUid":"列表中的被邀请者UID"}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/data/get` | `{}` |
| `https://sub2api.wdaveh5game.com/h5login-test/api/data/save` | `{"version":0,"data":"{\"coins\":0}"}` |

完整字段、响应、业务拒绝原因及客户端发奖边界见 `invite-api.md`；登录见 `wechat-login-api.md`；存档 CAS 见 `save-api.md`。使用这些文档时统一替换为本指南的测试 API 前缀，其余契约不变。

### 可选存档 SDK

如果前端已使用存档 SDK，请替换本次提供的最新版 `minigame-data-client.js`，并明确配置测试基础地址（注意不带 `/api`）：

```js
const { createDataClient } = require('./minigame-data-client.js');
const store = createDataClient({
  wx,
  accessToken: auth.accessToken,
  baseUrl: 'https://sub2api.wdaveh5game.com/h5login-test'
});
```

SDK 默认仍指向正式环境；旧版固定路径校验不接受测试前缀。SDK 仅为可选封装，按上方 postApi 直接接入同样可用。

## 4. 推荐真机验收

1. A 先进入测试构建并登录，分享 query 为 `inviterUid=<A的测试user.id>`。
2. B 尚未在**测试环境**注册，通过卡片进入相同测试构建。读取冷启动及 onShow query；复用同一次登录 Promise，收到首次 token 后立即上报来源。
3. 检查 A 的邀请列表；B 不授权头像昵称时仍应建立关系，授权并上传后展示当前资料。
4. A 领取两次，确认返回同一个 claimId；客户端根据 claimId 持久去重发奖，服务端只登记领取。新增每日上限按北京时间自然日每名邀请人最多新领取50份（发布状态见 invite-api.md）：第51份返回409 INVITE_DAILY_CLAIM_LIMIT，前端提示次日再来、不发奖；重复领取已成功记录仍返回原凭据，不重复占额度。
5. B 重登应为 `isNewUser:false`；老用户不增加拉新人数；已绑定者重报同一来源返回幂等结果。
6. 验证存档 get → save → get、旧 version 409、64 KiB 限制，以及网络重试。
7. 用两台真机确认分享实际打开的是正确测试构建，避免测试卡片打开正式版而混用环境。

测试数据库初始为空，不复制正式用户/存档；正式账号首次进入测试环境可以被视为测试新用户。后续重复测新注册时需人工重置指定测试账号，当前没有开放公网重置、管理员或假登录接口。不要通过修改客户端 isNewUser 伪造资格。

## 新增来源场景接口（待发布）

`POST /users/source-scene` 的源代码和隔离验证已完成，但**尚未部署到本指南的常驻测试环境或正式环境**，不能按已上线接口请求。首次注册后用同一次 token 上报启动时 `options.scene`；首次写入后不可改，和邀请归因独立。完整请求、响应、幂等与错误码见 [source-scene-api.md](source-scene-api.md)。发布后再进行真机联调。

## 5. 隔离与验证边界

- 独立常驻后端、数据库、Redis、登录会话、限流和存档；测试数据不写入正式数据库。
- 同机运行，服务器资源与微信 AppID 上游配额仍有共享边界，不是独立机器或独立小游戏。
- 公网检查以明确的临时测试账号/会话验证邀请与存档成功链路，测试数据及会话已清理；真实微信无效 code 路径也通过。
- **尚未获得真实客户端新鲜 code，不能把自动化/临时会话检查当作真实微信用户成功登录或卡片分享验收。** 第4节仍需前端真机联调。
- 测试环境为持续联调用途，非自动化测试使用的15439/16389临时 Compose。不要把正式个人资料或敏感数据导入测试环境。
