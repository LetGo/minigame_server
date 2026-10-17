# 常驻测试环境运维

## 当前布局

- HTTPS：`https://sub2api.wdaveh5game.com/h5login-test/api`；前端见 `staging-integration.md`。
- API：`minigame-staging.service`，ubuntu 用户，127.0.0.1:18741，内存384MiB、CPU50%，自动重启且开机启动。
- 基础设施：`minigame-staging-infrastructure.service` 管理 Compose `minigame-staging`，独立 `compose.staging.yaml`。
- PostgreSQL：127.0.0.1:15441，数据库 `minigame_staging`，owner仅运维使用，runtime `minigame_staging_app` 仅四张业务表 SELECT/INSERT/UPDATE，无DELETE、DDL。
- Redis：127.0.0.1:16391/0，独立随机密码、AOF、64MiB/noeviction；存储容器合计内存上限512MiB。
- 命名卷：`minigame-staging_postgres_data`、`minigame-staging_redis_data`，不与正式或自动化测试共享。不执行 `down -v`。
- 发布目录：Git忽略的 `runtime/staging/releases/<timestamp>-<sourceCommit>/`；`runtime/staging/current`指向当前发布。发布目录中 dist、migrations、package.json/lock、node_modules 均独立，不引用正式 dist 或共享 node_modules。
- 凭据：`.env.staging`、`.env.staging.infrastructure`，0600、Git忽略。仅微信AppID/AppSecret按授权复用；没有复制正式DB、Redis连接配置。
- Nginx：`/etc/nginx/snippets/minigame-staging.conf`，仅主站HTTPS server新增一条带 BEGIN/END MINIGAME STAGING 标记的 include。测试前缀重写到后端固定/h5login，正文mirror、access_log、proxy cache关闭，来源IP头覆盖；data路径256KiB，其他16KiB。
- 修改前Nginx备份：`/var/backups/minigame-staging/nginx-before-staging-20261017.conf`；回滚时优先只删除新增测试include，不能盲目覆盖其他后来变更。

同机/同微信AppID意味着服务器和上游配额仍共享，不能宣称独立机器隔离。无公网重置或假登录入口。测试数据默认持续保留，人工清理具体账号前需确认目标，不能误用正式连接。未配置自动测试环境数据库备份，不适合作为生产数据存储。

## 查看状态

从仓库根目录执行，勿打印凭据文件：

```bash
systemctl show minigame-staging -p ActiveState -p MainPID -p NRestarts
systemctl is-enabled minigame-staging minigame-staging-infrastructure
sudo docker compose --env-file .env.staging.infrastructure -p minigame-staging -f compose.staging.yaml ps
```

停止API不会停止数据库。基础设施unit不配置ExecStop，避免意外停止API连带中断存储；确需停止存储应另行确认后使用对应staging Compose，绝不操作minigame-prod。

## 后续测试发布

1. 记录正式dist及正式.env SHA256、正式API PID/启动时间。开发/验证不运行会覆盖正式dist的build/check/test:integration。
2. `npm run typecheck`、`npm test`、`node --test test/staging-ops.test.mjs`，编译到新的 `tmp/<candidate>/`。
3. 使用临时 `minigame-login-test` Compose（PG15439、Redis16389/15）跑所有集成测试，`MINIGAME_TEST_DIST_DIR`指向候选。严禁对常驻测试库或正式库运行会清库的自动化测试。
4. 创建新的独立release目录，复制候选dist、migrations、package.json和package-lock.json。**进入解析后的真实release目录再执行 `npm ci --omit=dev --ignore-scripts`**。本机npm对指向符号链接current的相对`--prefix`出现错误的锁文件解析，不能据此修改项目lock或改用npm install解锁升级。
5. 保留旧current目标，准备原子切换的新链接；确认测试发布授权后切换current。运行 `node ops/staging-admin.mjs migrate`，仅访问写死的staging owner端口/库并使用current发布目录的迁移；该命令幂等验证现有迁移checksum并回读runtime权限。迁移失败不重启API，应恢复旧current链接。
6. `sudo systemctl restart minigame-staging`；单独检查真正HTTP就绪及NRestarts。普通代码更新不需改Nginx或正式服务。若新增迁移不向后兼容，另行设计切换，不假设旧API与新schema始终兼容。
7. 运行 `node ops/verify-staging.mjs` 做HTTPS测试，明确创建的是临时合成账号/会话，不是真实微信登录；脚本仅操作staging owner15441/Redis16391，结束删除自身临时数据并回读。结果在 `tmp/staging-setup/public-smoke.json`。此脚本也以测试token只读请求正式data/get，确认401隔离，不修改正式数据。
8. 回读正式dist、.env和服务PID/启动时间未变，核对原站点路由及Nginx正文日志关闭。测试Compose用后down，保持常驻staging Compose在线。

若Redis长时间断连导致重连耗尽，恢复存储后仅重启staging API；不因测试环境问题重启正式服务。Redis noeviction有意在内存不足时报错，不以驱逐会话掩盖容量问题。

## 每日最多领取50份更新（2026-10-17）

- 源代码 `f821c5b` 部署到 `runtime/staging/releases/20261017T093822Z-f821c5b`，只原子切换测试 current 并重启 minigame-staging；无 schema、权限、Nginx 或正式服务变更。
- 每邀请人按北京时间自然日最多新领取50份；数据库锁串行化和服务端时间校验，跨token/进程一致；已领取重试不占额度，超额409 INVITE_DAILY_CLAIM_LIMIT，记录保留待领取，可次日继续。
- 类型检查、18单测、46集成、2部署配置测试、依赖审计0漏洞；独立代码复核通过。
- 公网合成fixtures验证：49已领取时两个token并发请求只允许1条成功；其余409且保持未领取；重试凭据一致；昨日50不占今日额度；北京时间零点包含、次日零点排除；升级前已领取超50时拒绝新增领取。
- 既有29项公网检查、135条未领取优先跨页回归均通过；自身合成数据/会话清理回读。运行进程cwd指向新release、active/NRestarts0，正式产物/.env哈希及PID/启动时间未变。
- 完整证据：`tmp/daily-claim-limit-deploy/verification.json`。公网验证使用临时合成账号/会话，不等同真实微信登录与客户端发奖验收。

## 未领取优先更新（2026-10-17）

- 按明确授权仅部署测试服务，源代码 `749695f`；发布快照 `runtime/staging/releases/20261017T084529Z-749695f`。旧快照保留用于回滚。
- 独立候选构建与 `npm ci --omit=dev --ignore-scripts` 后原子切换 current，仅重启 `minigame-staging`；迁移文件与旧发布逐字节一致，无 schema 迁移，无 Nginx 改动。
- 公网验证 135 条临时邀请（110未领取/25已领取）按100+35分页，包含相同时间UID排序、领取分组游标、领取后刷新排序、重复领取凭据与旧游标400；自身合成账号、会话和数据均清理回读。
- 既有29项公网检查全部通过；当前进程cwd回读指向新快照，active且NRestarts=0，开机启动保持启用。正式dist/.env哈希、正式API PID/启动时间与发布前一致。
- 新排序游标不兼容旧版；前端收到 INVALID_INVITE_CURSOR 或成功领取后，清空旧分页并从首页刷新。实时领取可能导致旧遍历中已领取记录重复，按 inviteeUid 合并、按 claimId 发奖去重。
- 完整发布证据：`tmp/unclaimed-first-deploy/verification.json`。合成会话验证不代表真实微信成功登录/分享卡片验收。

## 首次部署验收（2026-10-17）

- 常驻测试库迁移001/002/003，受限runtime权限回读通过；独立数据库、Redis和API正常，两个staging unit已设开机启动。
- 候选类型检查、18单测、2部署配置检查、39集成叶子用例通过（Node43含4父测试）。候选仅写独立目录，正式dist未替换。
- 29项公网HTTPS检查通过：参数/畸形JSON、全部新接口鉴权、资料、归因及重复上报、老会话拒绝、列表、固定claimId重复领取、领取归属、JSON原文保存及409、用户隔离、64KiB原文、16KiB登录正文上限、测试token不能访问正式环境、真实微信无效code401，以及实际生成的可选SDK通过测试前缀get/save/get。
- 临时合成测试账号、关联存档/邀请/资料、会话及账号级限流键已删除并回读。不等同真实微信新鲜code成功登录、分享卡片或客户端到账验证，仍需前端真机联调。
- Nginx执行独立配置检查及生效配置检查后reload；不是restart。正式API不重启、不迁移、不改正式配置。原/、/request-logs、/tqwz-query/状态200/401/200保持不变。
