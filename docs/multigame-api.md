# 多小游戏统一 API 与客户端接入

## 入口与隔离边界

新平台公共入口：

```js
const API_BASE = 'https://sub2api.wdaveh5game.com/minigame/api';
```

- 统一使用 HTTPS；微信后台 request 合法域名填写 `https://sub2api.wdaveh5game.com`，不带路径。
- `/minigame/api` 的**所有游戏请求，包括微信登录**，均发送 `X-Minigame-AppId` 请求头。值必须为当前游戏 AppID：`wx` 后跟 16 位小写十六进制字符，不能附加 AppSecret、其他凭据或参数。
- AppID 从 `wx.getAccountInfoSync().miniProgram.appId` 获取，也可使用构建时固定的**本游戏** AppID；不能从分享 query、任意用户输入或每次请求参数决定。
- AppID 是公开路由标识，不是访问凭据。服务端只路由管理员已注册的游戏；格式正确不代表已注册，更不代表有权访问其他游戏。
- 除登录外，原有游戏接口继续携带 `Authorization: Bearer <accessToken>`。token 必须属于同一游戏及会话存储；cat 原有合法 token 在会话仍有效且复用同一 cat 会话存储时，可配合同一 AppID 在新入口继续使用。不能因改变 AppID 请求头就跨游戏复用 token，旧 `/h5login` 原游戏 token 不能混用。正文仍为 `Content-Type: application/json` 的普通 JSON。
- token、UID、存档版本、邀请绑定及幂等事件等本地缓存按入口、AppID 和玩家隔离；不把旧 `/h5login` 应用的 token/UID 当作 cat 凭据。cat 切换入口应保留本游戏原有有效会话与 UID 的对应关系，不以新建身份代替入口切换。

此次新平台只迁入 **cat**：这是入口与运行承载的调整，复用现有 cat PostgreSQL（PG）和 Redis，不搬迁或清空游戏数据，不重置 UID；同一会话存储内未失效的原 cat token 可在新入口配合同一 AppID 继续使用。旧 `/h5login` 保持独立旧应用，`/h5login-test` 保持既有测试应用；它们不自动迁入新平台、不与 cat 共享身份或数据，原客户端不必补 AppID。cat 的旧 `/cat-sudoku` URL 下线，**不保留兼容、重定向或失败回退**；cat 客户端改用 `/minigame/api`。

本文说明新平台的接入契约，不代表已经上线或完成真机验收。既有文档中的 `/h5login`、`/h5login-test` 发布记录只适用于各自旧应用，不能外推为新平台发布证据。

## 微信登录：只新增路由请求头，不改正文

`POST API_BASE + '/auth/wechat-login'` 不需要 Bearer；必须带 `X-Minigame-AppId`。

```js
const APP_ID = wx.getAccountInfoSync().miniProgram.appId;
// 或固定为管理员已注册的本游戏真实 AppID；不要在客户端配置 AppSecret。

function login(code, clientVersion, scene) {
  // code 必填；clientVersion、scene 可省略，不能用 null 代替省略。
  const data = { code };
  if (clientVersion !== undefined) data.clientVersion = clientVersion;
  if (scene !== undefined) data.scene = scene;
  return new Promise((resolve, reject) => {
    wx.request({
      url: API_BASE + '/auth/wechat-login',
      method: 'POST',
      header: {
        'content-type': 'application/json',
        'X-Minigame-AppId': APP_ID
      },
      data,
      timeout: 20000,
      success(res) {
        if (res.statusCode === 200) resolve(res.data);
        else reject(new Error('LOGIN_REQUEST_FAILED'));
      },
      fail() { reject(new Error('LOGIN_NETWORK_ERROR')); }
    });
  });
}
// code 必须由本游戏本次 wx.login() 获取；重试前取新 code。
```

登录正文仍**仅允许 `code`、可选 `clientVersion`、可选 `scene`**，不增加 `appId`、`appid`、`gameId`、`openid`、`userId` 或 AppSecret。原字段校验与成功响应沿用[登录契约](wechat-login-api.md)、[客户端版本契约](login-client-version.md)和[scene 契约](login-scene.md)，只替换入口并增加路由头；这些链接的历史地址与发布状态不适用于新平台。

## 存档 SDK：baseUrl 不含 `/api`

复制重新构建的 `client/minigame-data-client.js`，无需 Node、WebCrypto、CSPRNG、TextEncoder 或运行时第三方库。

```js
const { createDataClient } = require('./minigame-data-client.js');
const appId = wx.getAccountInfoSync().miniProgram.appId;
const store = createDataClient({
  wx,
  accessToken, // 本游戏合法 token；现有 cat 未失效会话可复用，不能用旧 /h5login 原游戏 token。
  baseUrl: 'https://sub2api.wdaveh5game.com/minigame', // 不含 /api，也不带尾斜杠。
  appId
});

async function saveGame(originalJsonText) {
  const loaded = await store.get();
  return store.save(originalJsonText, loaded.version);
}
```

- SDK 自动追加 `/api/data/get` 或 `/api/data/save`，每次都设置固定的 `X-Minigame-AppId` 与原有 Bearer。
- get 正文仍为 `{}`；save 正文仍仅 `{version, data}`，其中 data 是原始 JSON **字符串**。SDK 不把 AppID 插入正文、不改写业务存档字符串。
- 平台选项只允许 `wx`、`accessToken`、`baseUrl`、`appId`；缺失/格式错误 AppID、secret 或自定义 header 等额外选项都会在本地抛出脱敏的 `INVALID_CLIENT_OPTIONS`，不发请求。合法但未注册的 AppID 由服务端拒绝，SDK 不具有注册表。
- 仅精确的 HTTPS `/minigame` 平台路径可用；拒绝 userinfo、query、hash、编码/路径注入、未知路径、`/api` 后缀和尾斜杠。自定义 HTTPS 主机及合法端口仍可用于受控环境，但 SDK 校验不替代微信合法域名或服务端权限。
- AppID 在创建实例时固定，不提供逐请求覆盖选项；修改原 options 或传额外方法参数不能切换 AppID。切换真实游戏/入口应重新登录并显式建立独立实例，不能借此绕过服务端隔离。
- 默认 baseUrl 仍是旧 `/h5login`；显式 `/h5login`、`/h5login-test` 继续不要求 AppID，原请求头与 body 不变，不会自动切换新平台。
- 保留原始 JSON、UTF-8 大小、Unicode、CAS version 和响应校验，不自动重试。409 或不确定是否保存成功的超时，先 get 再由业务决定处理，见[存档契约](save-api.md)。

## 其他游戏 API：只换入口与路由头

下表均使用 **POST `API_BASE + 路径`**，每次附带 `X-Minigame-AppId`；除登录外同时使用原有 Bearer。`?` 表示字段可省略。正文不新增 AppID 或身份覆盖字段，字段边界、响应、幂等及权限沿用原契约：

| 接口 | 原有请求正文 | 契约 |
|---|---|---|
| `/auth/wechat-login` | `{code, clientVersion?, scene?}` | [登录](wechat-login-api.md) |
| `/users/profile` | `{nickname, avatarUrl?}` | [资料](invite-api.md) |
| `/users/source-scene` | `{scene}` | [首次来源](source-scene-api.md) |
| `/data/get` | `{}` | [存档](save-api.md) |
| `/data/save` | `{version, data}` | [存档](save-api.md) |
| `/invites/report` | `{inviterUid}` | [邀请](invite-api.md) |
| `/invites/list` | `{cursor?, limit?}` | [邀请](invite-api.md) |
| `/invites/claim` | `{inviteeUid}` | [邀请](invite-api.md) |
| `/share-assists/report` | `{shareId, inviterUid}` | [分享助力](share-assists-api.md) |
| `/share-assists/summary` | `{shareId}` | [分享助力](share-assists-api.md) |
| `/analytics/rewarded-video/completed` | `{eventId, placement, clientInfo?}` | [本人视频统计](rewarded-video-api.md) |
| `/leaderboards/report` | `{type, value}` | [排行榜](leaderboards-api.md) |
| `/leaderboards/list` | `{type}` | [排行榜](leaderboards-api.md) |

例如直接请求存档时，请求头为：

```js
const header = {
  'content-type': 'application/json',
  'X-Minigame-AppId': APP_ID,
  Authorization: 'Bearer ' + accessToken
};
// wx.request({url: API_BASE + '/data/get', method: 'POST', header, data: {}, ...callbacks});
```

本次不新增奖励或订阅功能，不恢复退役的好友视频奖励。本人视频完成上报仍是统计，不是发奖接口。

## 后续添加游戏与容量边界

统一平台采用**一个 API 进程、多独立 Nest 应用上下文**，按 AppID 分派到管理员配置的游戏上下文，无须每个 game 新起一个独立 API 进程。各游戏共享代码与 Node 依赖，不是每 App 的依赖包都隔离；隔离的是配置、Infrastructure 连接池、存储和身份。独立 Nest 上下文不能被理解为独立进程或独立 Node 运行时。

新游戏接入必须由管理员完成：

1. 在服务端注册表中显式配置 AppID 及对应上下文；AppSecret 仅存服务端，禁止写入 SDK、客户端、请求或日志。
2. 准备独立存储与独立命名空间，显式配置数据库/Redis 资源，不回落使用其他游戏的默认资源。PostgreSQL URL 必须显式指定 1–63 位字母、数字或下划线组成的数据库名（如 `cat_sudoku`）；不接受数据库名中的百分号编码、空路径/用户名回退、URL 查询参数或片段，也不接受会被 URL 解析器规范化的非标准写法。此限制用于避免配置校验与数据库驱动解析结果不一致；凭据中的合法百分号编码仍可使用。平台进程不接受非空 `PGPORT` 环境变量（即使所有游戏 URL 都显式指定端口，也会拒绝启动）；端口只能来自各游戏数据库 URL，未显式指定时按 PostgreSQL 默认端口 5432 校验，不能依赖进程环境回退。
3. 在目标游戏存储执行所需迁移，配置并验证最小数据库权限等访问权限，再通过隔离测试。
4. 完成路由、跨游戏 token/存档/邀请/统计/榜隔离与错误路径验收，之后按受控发布流程启用。

客户端不能提交任意 AppID 自注册；改请求头不会创建游戏、上下文、数据库或迁移。旧 `/h5login` 不在本次自动迁移范围，新增游戏也不自动复制其数据。

平台容量受进程内存、每游戏连接池、数据库、Redis、限流及实际负载约束，不承诺无限游戏数量或无限并发。当前注册表上限为 **32**，这是资源 guard，不是保证可承载 32 款游戏的容量承诺；新增游戏需要评估资源和压测，不沿用历史单游戏压测数字作保证。未来每个 game 的数据库和 Redis 仍须独立准备，执行所需迁移并授予最小权限；单靠客户端 AppID 不会自动开服。

同一平台进程内的所有已注册游戏**共同发布、共同重启**。任一游戏初始化失败会使整个平台启动失败（fail-closed），不存在进程级故障隔离；配置、连接池、存储和身份隔离不能消除共享进程的故障影响。旧 `/h5login` 仍是独立旧应用，不受本次平台重启影响。

SDK/source/bundle 的本地自动化测试只能证明客户端契约与无平台依赖执行，不能证明生产已部署或真实微信换码成功。新平台真实微信登录、真机分享及业务回调仍需本游戏新鲜 code 和对应环境联调验收；本次文档不宣称这些已通过。
