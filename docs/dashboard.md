# 小游戏只读运营后台

入口：`https://sub2api.wdaveh5game.com/h5dashboard/`。这是独立管理员登录，不使用玩家 Bearer token，不在 URL 放密码或 token。

## 统计口径

- 北京时间自然日（Asia/Shanghai，00:00 切日）。
- **今日活跃**：今天成功完成游戏登录的用户去重。仅持旧 token 拉取/保存存档、上报 scene 或查邀请不算登录活跃；不是在线人数。
- **今日新注册**：注册时间落在今天、首次登录已成功完成的用户。
- **今日邀请新注册 / 每日其中邀请注册**：上述新注册用户中，已存在本游戏成功绑定邀请关系的去重人数；按注册日期（北京时间）归属，不按绑定/领奖日期计数，与是否领奖无关。延迟绑定会在下一次刷新补到原注册日；尚未上报绑定的用户暂不计入，剩余人数不能直接当作确定的自然新增。卡片同时显示占今日新注册比例，分母为 0 显示“—”。现有表只读查询，无需迁移或改游戏 API。
- **今日激励视频次数**：按数据库服务端 `recorded_at` 统计北京时间当日 `[00:00, 次日00:00)` 已保存的完整观看事件，跨点位及玩家；同一玩家同一事件 ID 重试不重复计数，不是观看人数或广告平台核验数据。不展示历史累计数，历史明细仍保留，跨日自动按新一天查询，无需清表或定时重置。客户端接入后才有数据，不补造历史。详见 [`rewarded-video-api.md`](rewarded-video-api.md)。删除玩家会级联移除其事件。卡片说明显示 **人均次数 = 今日激励视频次数 ÷ 今日活跃用户数**（包含未观看视频的活跃用户），保留两位小数；活跃人数为 0 或任一指标不可用时显示“—”，有活跃但视频次数为 0 时显示 `0.00`。
- **实时次留**：昨日新注册用户中，今天已经成功登录的用户数 ÷ 昨日新注册人数。当天持续变化，不是最终整日次留。分母为 0 显示“—”。
- 最近 14 天按“回访日”展示新增、活跃和前一日新用户次留。今天标记“截至现在”。页面每 30 秒刷新，隐藏页面暂停轮询。
- **更新于**：接口 `generatedAt` 是本次统计查询开始时的数据库服务端时间，与 `today` 及当日统计边界共用同一时间快照，前端按北京时间显示。缓存命中时保持原值，缓存失效并成功重新统计后更新；不是最新玩家操作时间，也不是代码发布时间。

- `005_daily_logins.sql` 建立逐日登录表。上线当日用用户现有 `last_login_at` 补录当日已登录用户，**不使用最后登录时间反推更早每日活跃**。覆盖日期前的 DAU/留存显示“—”；历史注册数仍可查询。覆盖日期由数据库记录，非前端猜测。
- 登录与当天去重记录在同一数据库事务中提交；Redis/数据库失败不得留下成功活跃或半注册记录。按获锁后数据库时钟归日，跨日不使用排队前的事务起始时间。

## 概览性能与缓存

- 概览使用服务端进程内缓存，按游戏和北京时间日期隔离，最多保留一个快照；当前单实例的所有已登录管理员页面共享。TTL 最多 30 秒，从实际查询开始时间/`generatedAt` 计，不从查询完成或每次命中续期；北京时间零点提前失效。
- 缓存未命中或过期时，同一实例的并发请求共享同一次统计查询（single-flight）。旧日查询若跨零点才返回，丢弃旧日结果并合并重查；持续日期不一致时返回脱敏 503，不循环、不展示昨日数值。数据库错误不缓存，也不使用过期快照兜底。
- 每次请求仍先校验 Redis 登录会话；缓存命中也不跳过鉴权，退出/会话过期/Redis 故障均不能读取缓存。HTTP 仍为 `Cache-Control: no-store`，Nginx `proxy_cache off`，不是公开 CDN 或浏览器缓存。玩家精确查询及原始存档不缓存。
- 页面仍每 30 秒请求、隐藏时暂停。服务端快照最多 30 秒；两者叠加，业务变化到页面可见可能接近 60 秒，另计网络/查询耗时。“更新于”展示实际快照时间，页面注明缓存时长。
- 仅看板自己创建的数据库连接用启动参数 `jit=off`，保留最多 4 连接、SQL 5 秒超时及只读角色。没有 `ALTER SYSTEM`/`ALTER ROLE`，游戏 API 和其他数据库连接不受影响。
- 当前为单实例内存缓存，服务重启即清空，不新增 Redis 指标键。未来扩多实例时每实例会各自回源；如需全实例只回源一次，须另行实现共享缓存和分布式互斥。大数据量下仍需持续评估索引、查询计划和日汇总表，本改动不是无限并发或大规模容量保证。

## 登录日志（只读）

- 左侧“登录日志”页展示配置游戏在**北京时间当天**已成功登录的现有记录，列为登录时间（北京时间）、openid、昵称、首次来源场景；按登录时间倒序，同时间按用户 ID 排序。
- 首次来源场景读取 `game_users.source_scene`，与玩家查询页共用官方映射，显示 `原始 value · 场景描述`（如 `1030 · 自动化测试下打开小程序`）；未上报显示“未上报”，未收录的值仍保留原始值。它是用户首次上报的来源，不代表本次登录的进入场景，不新增逐次场景采集。
- 数据来自 `game_daily_logins.first_login_at`：该表本身仅保留每个用户每天首次成功登录的一条记录。页面和接口不再额外去重，但**不是每次登录的流水**，不能还原重复登录次数、逐次时间或 IP。昵称展示当前资料；未设置显示“—”。
- 每页 50 条，支持上一页、下一页和手动刷新（回到首页）；不使用概览缓存。总数和当前页在同一 SQL 查询快照中生成，按应用 ID 隔离；翻页期间新登录可能推动页边界，跨北京时间零点按新当天重新查询。
- `POST /h5dashboard/api/login-logs` 接受 `{ "offset": 0 }`（缺省为 0；只允许整数 0–10,000,000），固定页大小 50。返回 `today`、`timezone`、`generatedAt`、`total`、`offset`、`limit`、`hasMore`、`items[{loginAt,openid,nickname,sourceScene}]`。
- 沿用后台会话、Origin 和 JSON 校验；未登录不可查，所有昵称/openid 仅以纯文本显示，不存浏览器持久存储。无数据库迁移、无玩家数据写入、无游戏登录接口修改。

## 玩家查询（只读）

按配置游戏的完整 openid 精确匹配，以 POST JSON 发送，不放查询 URL。

返回 UID、openid、昵称、头像 URL、注册/最后登录时间、首次 scene 及上报时间、完整原始云存档及版本/更新时间、邀请人、邀请汇总、最近 100 条邀请记录（超出明确提示）及最近 30 个已记录登录日。

首次来源 scene 以 **`原始 value · 场景描述`** 显示（例如 `1030 · 自动化测试下打开小程序`），使用[微信小游戏官方场景值列表](https://developers.weixin.qq.com/minigame/dev/reference/scene-list.html)的本地映射快照；本次收录 209 条，保留官方版本/废弃说明。没有上报仍显示“未上报”；映射未收录的值保留原值并显示“官方当前文档未收录”，不猜测、不改写数据库中的来源值。这是首次来源，不代表每次登录的进入方式。

存档不做 JSON 数字转换或内容截断，支持复制/下载原文。所有用户数据用 DOM `textContent` 渲染，不能执行昵称/存档中的 HTML。

不提供修改存档、删除玩家、领取或发放奖励操作。

## 安全及运行

- 后台 `minigame-dashboard.service` 独立运行，仅监听 `127.0.0.1:18742`，由 Nginx HTTPS `/h5dashboard/` 代理。
- `.env.dashboard` 仅 0600，存独立 `minigame_dashboard_app` 只读 DB 连接、管理员 scrypt 哈希和 Redis DB1 连接；不得提交或回显。独立管理员访问资料 `.env.dashboard.access` 也仅 0600，不做 Web 静态文件。
- 数据库角色仅获 7 张指定业务表 SELECT，默认只读事务；2026-10-18 激励视频版本额外仅授予 `game_rewarded_video_events` SELECT。游戏 runtime 对新事件表只授 SELECT/INSERT，无 UPDATE/DELETE。游戏 runtime 对 `game_daily_logins` 也仅有 SELECT/INSERT（Postgres `ON CONFLICT` 需要 SELECT），无该表 UPDATE/DELETE；不对旧表扩权。
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

## 邀请注册统计发布（2026-10-18，北京时间）

- 功能提交 `a9e3f5d`；后台快照 `runtime/dashboard/releases/20261017T164017Z-a9e3f5d`，只替换 `dashboard/queries.mjs` 和 `dashboard/public/app.js`。卡片新增“今日邀请新注册”及其占比，14 日趋势增加“其中邀请注册”。后续趋势展示改为日期降序（最新日期在最上方），仅前端排序，不改变接口顺序或统计口径。
- 无迁移、无 DB 写入、无鉴权/密码变更；仅重启 dashboard。游戏 API、常驻测试进程、游戏产物、全部环境文件、迁移和 Nginx 哈希逐项验证未变。
- 18 单测、8 后台、77 集成、2 运维通过，audit 0，独立审查通过。公网 HTML/JS/API/DOM 与数据库独立聚合交叉核对 72 项通过，原后台 26 项回归通过。非真实浏览器验收。
- 证据 `tmp/dashboard-invited-registrations/`；临时自动化 Compose 已停止，未创建正式玩家验证数据。

## 发布/恢复注意事项

发布须获用户明确授权。先全量测试、独立审查、正式备份及临时库实际恢复验证；再用生产 owner 执行 `node ops/dashboard-admin.mjs prepare`（迁移、最小权限及首次凭据生成），切换正式游戏 API 和后台服务；健康后安装 Nginx 路由并 `nginx -t`/reload，最后实际 HTTPS 登录/查询/退出及数据库回读。

`prepare` 拒绝测试 DB、非本机地址和重复配置，不会覆盖既有管理员。发布留档 `tmp/dashboard-rollout/`。回退 API 时保留新增统计表，不删除真实记录；Nginx 站点旧文件备份 `/var/backups/minigame-dashboard/site-before-dashboard.conf`。不要使用反向迁移删除数据。测试环境不迁移、不重启，不复用正式会话/数据库。

验证：`npm run typecheck`、`npm test`、`npm run test:dashboard`；隔离 Compose 下运行全部 `test/*.integration.ts`（候选 dist 使用 `MINIGAME_TEST_DIST_DIR`）；另跑 `node --test test/staging-ops.test.mjs`。
