# 小游戏只读运营后台

入口：`https://sub2api.wdaveh5game.com/h5dashboard/`。这是独立管理员登录，不使用玩家 Bearer token，不在 URL 放密码或 token。

## 统计口径

- 北京时间自然日（Asia/Shanghai，00:00 切日）。
- **今日活跃**：今天成功完成游戏登录的用户去重。仅持旧 token 拉取/保存存档、上报 scene 或查邀请不算登录活跃；不是在线人数。
- **今日新注册**：注册时间落在今天、首次登录已成功完成的用户。
- **实时次留**：昨日新注册用户中，今天已经成功登录的用户数 ÷ 昨日新注册人数。当天持续变化，不是最终整日次留。分母为 0 显示“—”。
- 最近 14 天按“回访日”展示新增、活跃和前一日新用户次留。今天标记“截至现在”。页面每 30 秒刷新，隐藏页面暂停轮询。
- `005_daily_logins.sql` 建立逐日登录表。上线当日用用户现有 `last_login_at` 补录当日已登录用户，**不使用最后登录时间反推更早每日活跃**。覆盖日期前的 DAU/留存显示“—”；历史注册数仍可查询。覆盖日期由数据库记录，非前端猜测。
- 登录与当天去重记录在同一数据库事务中提交；Redis/数据库失败不得留下成功活跃或半注册记录。按获锁后数据库时钟归日，跨日不使用排队前的事务起始时间。

## 玩家查询（只读）

按配置游戏的完整 openid 精确匹配，以 POST JSON 发送，不放查询 URL。

返回 UID、openid、昵称、头像 URL、注册/最后登录时间、首次 scene 及上报时间、完整原始云存档及版本/更新时间、邀请人、邀请汇总、最近 100 条邀请记录（超出明确提示）及最近 30 个已记录登录日。无存档和未上报 scene 单独显示。存档不做 JSON 数字转换或内容截断，支持复制/下载原文。所有用户数据用 DOM `textContent` 渲染，不能执行昵称/存档中的 HTML。

不提供修改存档、删除玩家、领取或发放奖励操作。

## 安全及运行

- 后台 `minigame-dashboard.service` 独立运行，仅监听 `127.0.0.1:18742`，由 Nginx HTTPS `/h5dashboard/` 代理。
- `.env.dashboard` 仅 0600，存独立 `minigame_dashboard_app` 只读 DB 连接、管理员 scrypt 哈希和 Redis DB1 连接；不得提交或回显。独立管理员访问资料 `.env.dashboard.access` 也仅 0600，不做 Web 静态文件。
- 数据库角色仅获 6 张指定业务表 SELECT，默认只读事务。游戏 runtime 仅新增 `game_daily_logins` 的 SELECT/INSERT（Postgres `ON CONFLICT` 需要 SELECT），无该表 UPDATE/DELETE；不对旧表扩权。
- 随机 256 位会话 token，Redis 只保存其 SHA-256 摘要，8 小时过期。Cookie `Secure; HttpOnly; SameSite=Strict; Path=/h5dashboard/`。退出删除服务端会话。
- 写方法仅精确接受本站 Origin、普通 JSON；登录限流使用 Redis 原子 INCR/EXPIRE，仅信任本机代理提供的真实 IP，密码校验最多并发两份。限流/存储失败闭锁。
- HTML/API 禁缓存，API 不启用跨域；固定 CSP、不允许内联脚本。Nginx 此路由关闭 access log/mirror；应用不记录请求正文、密码、token、openid 或存档。
- 发布 snapshot：`runtime/dashboard/releases/<time>-<gitsha>`，`current` 指向实际运行版本；源码目录编辑不直接改变线上后台。原游戏 `dist` 切换另留旧产物。

## 已授权正式发布（2026-10-17，北京时间）

- 用户确认成功登录去重的活跃口径并授权正式上线。功能提交 `6600d3f`；后台运行快照 `runtime/dashboard/releases/20261017T155816Z-6600d3f`。
- owner 已执行迁移 005，游戏 runtime 仅增逐日表 SELECT/INSERT，后台使用 `minigame_dashboard_app` 只读角色和独立 Redis DB1。
- `minigame-login` 重启一次；`minigame-dashboard` 已启用开机启动；共享 Nginx 仅新增已标记后台 include。常驻测试进程/产物、原有配置及旧迁移逐项验证未变。
- 发布前备份已实际恢复至 scratch DB 并删除 scratch；原有 4 用户、1 存档及来源信息保留。备份 `/var/backups/minigame-server/minigame-20261017T155841993354Z.dump`，仅本机备份。
- 18 单测、6 后台、76 集成、2 运维测试通过，依赖 audit 0。正式 HTTPS 26 项鉴权/指标/精确玩家原始存档/退出检查通过；公开前端 DOM 10 项登录、14 日表、查询、复制、下载及退出验收通过（非真实浏览器，不代替真机验收）。测试 HTTPS 29 项回归及关联旧站点检查通过。
- 证据 `tmp/dashboard-rollout/{verification,backup,db-after,public-smoke,public-dom,staging-public}.json`。临时预览进程及一次性测试 Compose 已停止；正式、常驻测试服务保留。
- 管理员凭据仅位于已忽略的 0600 `.env.dashboard.access`；不写进本文、提交或公开 URL。未来更改/部署仍需逐次授权。

## 发布/恢复注意事项

发布须获用户明确授权。先全量测试、独立审查、正式备份及临时库实际恢复验证；再用生产 owner 执行 `node ops/dashboard-admin.mjs prepare`（迁移、最小权限及首次凭据生成），切换正式游戏 API 和后台服务；健康后安装 Nginx 路由并 `nginx -t`/reload，最后实际 HTTPS 登录/查询/退出及数据库回读。

`prepare` 拒绝测试 DB、非本机地址和重复配置，不会覆盖既有管理员。发布留档 `tmp/dashboard-rollout/`。回退 API 时保留新增统计表，不删除真实记录；Nginx 站点旧文件备份 `/var/backups/minigame-dashboard/site-before-dashboard.conf`。不要使用反向迁移删除数据。测试环境不迁移、不重启，不复用正式会话/数据库。

验证：`npm run typecheck`、`npm test`、`npm run test:dashboard`；隔离 Compose 下运行全部 `test/*.integration.ts`（候选 dist 使用 `MINIGAME_TEST_DIST_DIR`）；另跑 `node --test test/staging-ops.test.mjs`。
