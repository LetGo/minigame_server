# 微信小游戏登录接口（客户端接入）

## 1. 地址与前提

`POST https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login`

微信小游戏后台的 **request 合法域名**配置为：`https://sub2api.wdaveh5game.com`（不带路径）。客户端调用 `wx.login()` 获取当前小游戏的新鲜 code，然后提交本接口。AppSecret 仅在服务端保存，客户端不需要也不得携带。

2026-10-17 正式环境及测试环境均已部署完整契约（包含 `user.openid`、`isNewUser`）。测试登录地址为 `https://sub2api.wdaveh5game.com/h5login-test/api/auth/wechat-login`，见 [`staging-integration.md`](staging-integration.md)；下方示例在测试时统一替换为测试前缀。

## 2. 请求

请求头：`Content-Type: application/json`

```json
{"code":"wx.login() 返回的一次性 code"}
```

`code` 必填，必须是长度 1–512 的非空、无空白字符串；另可选提交字符串 `clientVersion` 和整数 `scene`。不允许额外提交 openid、userId、appid。正文最多 16 KiB，不支持压缩正文。code 一次性使用，重试前必须重新调用 wx.login()。

> 可选客户端游戏版本 `clientVersion` **正式、测试环境均已部署**：测试 2026-10-23 12:38:59，正式同日 18:14（北京时间）。例如 `{"code":"...","clientVersion":"2.0.7"}`。版本格式为 1–64 个 ASCII 字符，字母或数字开头，其余仅字母、数字、`.`、`_`、`+`、`-`。**旧客户端只传 `code` 仍可正常登录；省略时保留历史版本，不要传空串或 null。** 详见 [`login-client-version.md`](login-client-version.md)。

### 可选登录来源 `scene`（正式与测试环境已部署）

可选参数与首次来源自动记录已发布：测试环境 2026-10-28 22:15:23、正式环境 2026-10-29 08:49:17（北京时间）。下方首次来源规则继续有效；逐次登录 scene 流水正式已部署，测试当前发布物未含该采集，详见本节末尾。

可选提交 JSON 整数 `scene`，范围 `1..2147483647`，例如 `{"code":"...","clientVersion":"2.0.7","scene":1007}`。省略时保持旧行为；显式 null、字符串、布尔值、小数、0、负数或越界值均返回 400，并在微信换码之前拒绝。

- 客户端在首次进入游戏时保存 `wx.getLaunchOptionsSync().scene`，登录时传入，不能用后续 `onShow` 覆盖初始值；不是分享 query 中的 UID。
- 仅本次首次成功注册且来源尚未记录时，在原登录事务中记录 `source_scene` 和数据库时间；登录失败整体回滚。后续登录即使传不同 scene 也不会覆盖首次来源或因此拒绝正常登录。
- 已完成注册的历史缺失用户保持 NULL，不用本次启动场景冒充首次来源；不批量回填。并发注册只有一个首次成功登录，来源取该次实际提交的数据。
- 省略 scene 的首次登录仍可用原首次 token 调用 `/users/source-scene`；该独立接口的同值幂等、异值 409、老会话不补录规则不变。
- 成功响应与会话字段不变；登录不会额外返回 scene。与邀请归因、客户端版本上报独立，scene 仍是客户端报告的统计数据，不是微信核验信息。
- 正式与测试登录接口均可接收该参数。完整客户端示例见 [`login-scene.md`](login-scene.md)，发布状态以本节及既有部署记录为准。

#### 逐次登录 scene 流水（正式已部署）

新增开发在每次成功登录事务内额外保存**该次请求实际携带的 scene**，包括老用户重登；省略时记录 NULL，不复用首次来源或上次值。首次来源字段仍只在首次成功注册时写入，原响应和客户端字段校验不变。看板新增「本次登录场景」列，和「首次来源场景」分开；旧日志不回填。服务端只能记录客户端传值，不能自动知道客户端未传入的后续进入场景。正式已于 2026-10-31 02:43:31（北京时间）恢复发布成功，迁移 013 和最小权限已就绪；测试状态不随正式外推。契约见 [`login-events.md`](login-events.md)，实际发布与首轮回滚见 [`login-events.md`](login-events.md)。

## 3. 成功响应

HTTP **200**，`Cache-Control: no-store`。以下仅为结构示例：

```json
{
  "accessToken": "<随机不透明令牌，不是 JWT>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "isNewUser": true,
  "user": {
    "id": "<本服务用户 UUID>",
    "openid": "<当前小游戏的微信 openid>",
    "nickname": null,
    "avatarUrl": null
  }
}
```

- `expiresIn` 单位为秒，默认 7 天，客户端以实际返回值计算有效期。
- `user.id` 是本服务用户 ID，不是微信 openid。同一小游戏同一微信用户重复登录，ID 不变。
- `user.openid` 是服务端通过微信换码获得的当前小游戏用户标识，可用于客户端展示及平台反馈问题定位；不是访问凭据，不可代替 Bearer token。不同小游戏的 openid 不应混用。
- `isNewUser` 表示是否首次成功注册登录；服务端在该次会话记录拉新资格，重登不会再次获得。仅供客户端展示，不能自行声明。新用户通过分享卡片进入后，保持首次会话调用邀请上报，见 [`invite-api.md`](invite-api.md)。
- 多次登录允许多个 token 并存，不会自动踢掉其他设备。
- 令牌为敏感凭据，不得打印日志、放进 URL 或对外分享。到期、会话失效后重新登录。
- 不返回微信 session_key 或 AppSecret。`user.openid`、`isNewUser` 及邀请/资料接口已于2026-10-17发布正式服。
线上已有登录与 JSON 存档读写，见 [`save-api.md`](save-api.md)。用户资料与邀请接口见 [`invite-api.md`](invite-api.md)，正式及测试环境均已部署。尚无刷新令牌、注销或 token 校验查询接口。

### 登录恢复头像昵称（正式与测试环境均已发布）

测试登录地址：`https://sub2api.wdaveh5game.com/h5login-test/api/auth/wechat-login`。

测试服于 2026-10-21 部署，正式服于 2026-10-22 17:56（北京时间）部署。在原有 `user.id` / `user.openid` 上增加两个字段；原请求与已有响应字段不变：

```json
{
  "user": {
    "id": "<本服务用户 UUID>",
    "openid": "<当前小游戏的微信 openid>",
    "nickname": "已上传的昵称",
    "avatarUrl": "https://example.com/avatar.png"
  }
}
```

- 两个字段均来自当前游戏、当前登录用户已存储的 `game_profiles`，不是微信换码自动返回，也不接受登录请求覆盖。
- 尚未通过 `/users/profile` 上传资料时，`nickname` 与 `avatarUrl` 均为 JSON `null`，不影响正常登录；客户端自行显示默认头像和昵称。
- 上传或更新资料后，下次成功登录返回数据库查询时的当前资料；登录本身不覆盖头像昵称。
- token、UID、openid、过期时间、`isNewUser` 和首次会话邀请资格口径不变。资料读取在原登录事务中、会话签发前完成；数据库读取失败返回原脱敏 `LOGIN_STORAGE_UNAVAILABLE`，不会返回半成功 token。
- 正式服已通过旧请求格式、跨重启 token 与存档读写回归；普通 JSON 客户端可继续读取原有字段，无需补传新参数。验证中的成功换码使用显式测试替身，不代表已经完成线上旧包真机联调；真实微信成功登录仍需客户端提供新鲜 `wx.login()` code。

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

## 登录与资料恢复历史验收摘要

测试于2026-10-21上线，158项集成/48项单元/62项看板回归通过；正式2026-10-22 17:56（北京时间）上线，164项集成/48项单元/64项看板/2项运维及22项公网与实际模块断言通过。迁移010支持空头像；旧请求、旧token跨重启、存档原文/CAS、清空和省略保留均验收，临时账号/会话清理回读。正式备份实际恢复验证，原223用户/72存档/45资料在当次验收中保留。成功换码为明确测试替身，不是正式旧包真机证明；这些数字是历史发布时点，不是当前数据量。
