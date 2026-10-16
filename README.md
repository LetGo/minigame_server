# minigame_server

微信小游戏登录服务。NestJS + PostgreSQL + Redis；Node.js 24+，原生 ESM。

当前代码提供微信登录与 JSON 存档保存/获取，不含支付、昵称头像获取、刷新令牌、注销。**微信登录和 JSON 存档接口均已上线，可进行客户端联调。** 存档协议与可选小游戏 SDK 见 [`docs/save-api.md`](docs/save-api.md)；客户端也可自行调用接口。
登录服务已部署至下述 HTTPS 地址。客户端接入文档见 [`docs/wechat-login-api.md`](docs/wechat-login-api.md)，部署与运维见 [`docs/production-operations.md`](docs/production-operations.md)。真实玩家成功登录仍需小游戏新鲜 code 联调。

## 接口契约

部署后的地址：

```text
POST https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login
Content-Type: application/json

{"code":"小游戏端 wx.login() 刚获取的一次性 code"}
```

不接受客户端指定 `openid`、`userId`、`appid` 或其他额外字段。`code` 为 1–512 字符的无空白字符串。
登录请求正文不超过 16 KiB，不接受压缩请求正文。

成功：HTTP 200，`Cache-Control: no-store`。以下为**结构示例，不是真实登录结果**：

```json
{
  "accessToken": "<服务端生成的随机令牌>",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "user": {"id": "<用户 UUID>"}
}
```

- 默认有效期 7 天，可配置；到期或 Redis 会话丢失时，客户端重新 `wx.login()`。
- 多次登录允许多个令牌共存，用户 ID 不变；不是单设备登录/踢下线方案。
- 存档接口读取 `Authorization: Bearer <accessToken>`，通过令牌摘要查询 Redis 并校验用户/应用归属；HTTPS 下直接收发 JSON，无自定义加密。见存档接入文档，现已发布到生产。
- 不返回、记录或持久化微信 `session_key`；不返回 `openid` 或 AppSecret。
- 微信校验成功后，PG 以 `(app_id, open_id)` 唯一键原子 upsert 用户，Redis 仅保存随机令牌的 SHA-256 摘要键及会话元信息。
- PG/Redis 任一失败均不返回令牌。Redis 写入失败时 PG 用户记录可能已创建；重试成功后仍复用同一用户。
- 不自动重试微信换码请求，避免重复消费一次性 code。

错误返回有 `statusCode`、`message`，其中参数校验的 `message` 是字符串数组：

| HTTP | message / 含义 |
| --- | --- |
| 400 | 参数校验错误，或 `INVALID_JSON` |
| 401 | `WECHAT_CODE_INVALID`：code 无效、过期或已使用，重新获取 code |
| 403 | `WECHAT_LOGIN_BLOCKED`：微信拦截，不要立即循环重试 |
| 413 | `REQUEST_TOO_LARGE` |
| 415 | `UNSUPPORTED_ENCODING` / `UNSUPPORTED_CHARSET` |
| 429 | `LOGIN_RATE_LIMITED`，遵循 `Retry-After` 秒数 |
| 502 | `WECHAT_UNAVAILABLE` / `WECHAT_INVALID_RESPONSE` / `WECHAT_LOGIN_FAILED` |
| 503 | `WECHAT_BUSY` 或 `LOGIN_STORAGE_UNAVAILABLE`，退避后用新的 code 重试 |

微信请求超时 5 秒；PG 连接 3 秒、语句 5 秒；Redis 请求 3 秒。
登录默认按真实来源 IP 限制每 60 秒 120 次（同一 NAT 出口共用额度），Redis Lua 原子计数。
默认不信任客户端转发头。只有 loopback 监听时才允许启用 `TRUST_LOCAL_PROXY=true`。
登录接口不需要前端传 AppSecret，不需要授权昵称头像。

## 小游戏端示例

```js
wx.login({
  success({ code }) {
    if (!code) return;
    wx.request({
      url: 'https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login',
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: { code },
      timeout: 20000,
      success(res) {
        if (res.statusCode === 200) {
          wx.setStorageSync('game_access_token', res.data.accessToken);
          wx.setStorageSync('game_user_id', res.data.user.id);
          // 令牌是敏感凭据，禁止打印日志或加入 URL。
        } else {
          // 按上表处理；重新登录前获取新的 code，避免无限重试。
        }
      },
      fail() {
        // 网络错误：退避后重新获取 code 再试。
      }
    });
  }
});
```

需在微信小游戏后台配置 request 合法域名 `https://sub2api.wdaveh5game.com`（不带路径），并满足微信对证书、备案等的要求；仓库开发不代表已核实后台配置。

## 本机开发与配置

```bash
npm ci
cp .env.example .env  # 仅首次配置；已有 .env 时不要覆盖
chmod 600 .env
# 安全编辑 .env，填写微信配置及独立 PG/Redis 连接地址
npm run migrate
npm run dev
```

`.env` 已被 Git 忽略；绝不提交真实 AppSecret、令牌、数据库连接凭据。
本机实际微信凭据及运行账号连接保存在权限 0600 的 `.env`；独立生产数据库/Redis 已部署。管理员/基础设施凭据在 Git 忽略、权限 0600 的 `.env.production.infrastructure`，禁止回显或提交。
AppSecret 已在聊天中提供过，生产使用前建议在微信后台重置，再安全更新 `.env`。

生产数据库应使用独立用户/数据库；不要接入或复用 sub2api 的业务数据。
迁移显式执行，不在 API 启动时自动建表。迁移在事务和 advisory lock 内执行，并校验已执行文件的 SHA-256，后续通过新增 SQL 文件演进，勿修改已执行迁移。
建议迁移账号与运行账号分离，运行账号仅授予 `game_users`、`game_saves` 的 SELECT/INSERT/UPDATE 权限。

## 自动测试

```bash
npm run check
# 隔离 PG/Redis：仅绑定本机高位端口，PG 为 tmpfs，绝不能用于生产
sudo docker compose -p minigame-login-test -f compose.test.yaml up -d --wait
npm run test:integration
sudo docker compose -p minigame-login-test -f compose.test.yaml down
npm audit
```

集成测试固定使用 `127.0.0.1:15439/minigame_test` 和 `127.0.0.1:16389/15`，**不会读取真实 `.env`**。
已部署主机的 systemd 直接运行 `dist/main.js`。上述 `check` / `test:integration` 会重建 dist，不能在未授权发布时直接运行。请改用隔离构建：

```bash
npm run typecheck && npm test && npm run build:client
npx tsc -p tsconfig.build.json --outDir tmp/json-api-candidate-dist
# 先按上方命令启动专用测试 Compose
MINIGAME_TEST_DIST_DIR=tmp/json-api-candidate-dist node --import tsx --test --test-concurrency=1 test/*.integration.ts
```

会清空测试用户表和测试 Redis DB 15，不能将它们改指向生产。
成功登录场景使用真实 PG/Redis、明确的微信网络测试替身；不等同于微信真实玩家成功登录。
覆盖用户并发去重、令牌摘要及 TTL、参数和正文限制、限流与伪造 IP、依赖故障、编译入口端口冲突后的退出清理。
微信客户端单元测试覆盖官方地址/参数、一次调用不重试、错误码映射与异常脱敏。

## 部署步骤参考（本机已完成）

1. 配置独立的持久化 PostgreSQL 和 Redis，设置凭据、私网/loopback 访问以及备份策略。测试 compose 没有持久化，不可转为生产。
2. 更新 `.env`，保持 `HOST=127.0.0.1`、`PORT=18740`，按需启用 `TRUST_LOCAL_PROXY=true`。
3. 执行 `npm ci`、`npm run check`，以数据库管理员连接显式运行迁移，再用 systemd 启动应用。生产 `.env` 使用最小权限运行账号，不可直接以该账号运行 `npm run migrate`。
4. 经授权后，备份现有 Nginx 配置，将 `ops/nginx-h5login.conf.example` 加入现有 HTTPS server 块，`nginx -t` 成功后 reload。
5. `proxy_pass` **不带结尾斜杠**，保留 `/h5login` 前缀；不要覆盖 `/request-logs`、`/tqwz-query/` 和 sub2api 根路由。
6. 新路径必须禁用正文 mirror、缓存及任何请求正文/令牌日志。Nginx 覆盖 `X-Forwarded-For`，不要透传客户端伪造的来源。
7. 使用新鲜无效 code 核实公网错误路径，再用真实小游戏 `wx.login()` code 完成成功登录验收；核实 PG 用户和 Redis 会话，不把令牌写入审计日志。

官方协议参考：https://developers.weixin.qq.com/minigame/dev/api-backend/login/api_code2session.html
