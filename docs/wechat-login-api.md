# 微信小游戏登录接口（客户端接入）

## 1. 地址与前提

`POST https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login`

微信小游戏后台的 **request 合法域名**配置为：`https://sub2api.wdaveh5game.com`（不带路径）。客户端调用 `wx.login()` 获取当前小游戏的新鲜 code，然后提交本接口。AppSecret 仅在服务端保存，客户端不需要也不得携带。

本文为已实现的接口契约；接口是否已上线以本次部署完成通知为准。

## 2. 请求

请求头：`Content-Type: application/json`

```json
{"code":"wx.login() 返回的一次性 code"}
```

仅允许 `code` 字段，必须是长度 1–512 的非空、无空白字符串。不允许额外提交 openid、userId、appid。正文最多 16 KiB，不支持压缩正文。code 一次性使用，重试前必须重新调用 wx.login()。

## 3. 成功响应

HTTP **200**，`Cache-Control: no-store`。以下仅为结构示例：

```json
{
  "accessToken": "<随机不透明令牌，不是 JWT>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "isNewUser": true,
  "user": {"id": "<本服务用户 UUID>", "openid": "<当前小游戏的微信 openid>"}
}
```

- `expiresIn` 单位为秒，默认 7 天，客户端以实际返回值计算有效期。
- `user.id` 是本服务用户 ID，不是微信 openid。同一小游戏同一微信用户重复登录，ID 不变。
- `user.openid` 是服务端通过微信换码获得的当前小游戏用户标识，可用于客户端展示及平台反馈问题定位；不是访问凭据，不可代替 Bearer token。不同小游戏的 openid 不应混用。
- `isNewUser` 表示是否首次成功注册登录；服务端在该次会话记录拉新资格，重登不会再次获得。仅供客户端展示，不能自行声明。新用户通过分享卡片进入后，保持首次会话调用邀请上报，见 [`invite-api.md`](invite-api.md)。
- 多次登录允许多个 token 并存，不会自动踢掉其他设备。
- 令牌为敏感凭据，不得打印日志、放进 URL 或对外分享。到期、会话失效后重新登录。
- 不返回微信 session_key 或 AppSecret。新增 `user.openid`、`isNewUser` 及邀请/资料接口的线上生效时间以部署通知为准，本次开发不代表已部署。
线上已有登录与 JSON 存档读写，见 [`save-api.md`](save-api.md)。本次新增用户资料与邀请接口见 [`invite-api.md`](invite-api.md)，尚未部署。尚无刷新令牌、注销或 token 校验查询接口。

## 4. 错误处理

错误 JSON 含 `statusCode`、`message`；可能有 `error` 字段。`message` 通常为字符串，参数校验时可能为字符串数组。

```json
{"statusCode":401,"message":"WECHAT_CODE_INVALID","error":"Unauthorized"}
```

| HTTP | message / 含义 | 客户端建议 |
|---|---|---|
| 400 | 参数校验错误 / `INVALID_JSON` | 修正请求，不循环重试 |
| 401 | `WECHAT_CODE_INVALID` | code 失效、过期或已使用；重新 wx.login() |
| 403 | `WECHAT_LOGIN_BLOCKED` | 微信拦截；停止立即重试 |
| 413 | `REQUEST_TOO_LARGE` | 缩小请求；Nginx 拦截时响应可能不是 JSON |
| 415 | `UNSUPPORTED_ENCODING` / `UNSUPPORTED_CHARSET` | 使用 UTF-8、未压缩 JSON |
| 429 | `LOGIN_RATE_LIMITED` | 遵循 Retry-After 秒数再重试；Nginx 拦截时响应可能不是 JSON |
| 502 | `WECHAT_UNAVAILABLE` / `WECHAT_INVALID_RESPONSE` / `WECHAT_LOGIN_FAILED` | 延迟后重新获取 code，限制重试次数 |
| 503 | `WECHAT_BUSY` / `LOGIN_STORAGE_UNAVAILABLE` | 退避后重新获取 code，限制重试次数 |

代理层或网络故障也可能返回其他 HTTP 状态、非 JSON 正文，客户端需容错。服务端不会自动重试微信换码请求；失败重试请始终获取新 code。

应用默认限流：同一来源 IP 每 60 秒 120 次；同一 NAT 出口共享额度。线上还受域名原有 Nginx 速率/连接限制影响。建议防止重复点击并合并并发登录，不要每次业务请求都重新登录。

## 5. 客户端示例

```js
function loginGame() {
  return new Promise((resolve, reject) => {
    wx.login({
      success({ code }) {
        if (!code) return reject(new Error('WX_LOGIN_NO_CODE'));
        wx.request({
          url: 'https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login',
          method: 'POST',
          header: { 'content-type': 'application/json' },
          data: { code },
          timeout: 20000,
          success(res) {
            const data = res.data;
            if (res.statusCode !== 200 || !data || !data.accessToken ||
                !data.user || !data.user.id) {
              const err = new Error('GAME_LOGIN_FAILED');
              err.statusCode = res.statusCode;
              err.apiMessage = data && data.message;
              err.retryAfter = res.header &&
                (res.header['Retry-After'] || res.header['retry-after']);
              return reject(err);
            }
            try {
              wx.setStorageSync('game_access_token', data.accessToken);
              wx.setStorageSync('game_user_id', data.user.id);
              wx.setStorageSync('game_openid', data.user.openid);
              wx.setStorageSync('game_token_expires_at',
                Date.now() + data.expiresIn * 1000);
              resolve(data);
            } catch (err) {
              reject(err);
            }
          },
          fail: reject
        });
      },
      fail: reject
    });
  });
}

// 在需要登录时调用，避免多个并发调用。
// loginGame().then(({ user }) => { /* 进入游戏；不要输出 token */ });
```

无需先授权昵称头像。微信后台合法域名、AppID 对应关系等需客户端侧配置。真实成功登录需要当前小游戏真实 wx.login() code 联调，模拟测试不能替代。
