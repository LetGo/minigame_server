# 本机生产部署与运维

## 已部署组件

- 入口：`https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login`，POST JSON。
- API：`minigame-login.service`，ubuntu 用户，`127.0.0.1:18740`，512 MiB 内存上限、1 CPU 配额、异常自动重启、开机启动。
- 存储：独立 Compose 项目 `minigame-prod`，`compose.production.yaml`。PostgreSQL 18、Redis 8 镜像按当前已安装镜像 digest 固定，不跟随 latest 自动升级。
- PostgreSQL：`127.0.0.1:15440`，数据库 `minigame`。管理员 `minigame_owner` 负责迁移；运行用户 `minigame_app` 仅有用户表 SELECT/INSERT/UPDATE，无建库、建角色、超级用户、DELETE 或迁移表访问权限。
- Redis：`127.0.0.1:16390`，独立密码、AOF everysec、96 MiB maxmemory/noeviction。Redis 内存不足时登录会失败而非悄悄驱逐会话，需要监控并扩容。令牌到期/会话丢失需重新登录。
- 存储均为命名卷，非测试 tmpfs；容器资源上限为 PG 768 MiB、Redis 192 MiB。禁止 `docker compose down -v`，避免删除生产数据。
- `minigame-infrastructure.service` 管理基础设施开机启动；容器自身配置 unless-stopped。停止 API 不会停止数据库。
- 原有 sub2api 的 PostgreSQL/Redis 未复用、未重启、未改动。

## 配置与安全

`.env` 和 `.env.production.infrastructure` 均为 0600 并被 Git 忽略。不要打印整个文件、在命令行参数中展开连接密码或把内容发送到聊天/日志。

Nginx 的生效文件为 `/etc/nginx/sites-enabled/sub2api`（本机不是指向 available 的软链接）。新增路由带 `BEGIN/END MINIGAME LOGIN` 标记，保留原前缀代理、不带结尾斜杠。新路径关闭正文 mirror、access_log、proxy cache，覆盖来源 IP 头，正文上限 16 KiB。未改原 `/`、`/request-logs` 和 `/tqwz-query/` 路由。

修改前的 Nginx 备份位于 `/var/backups/minigame-server/nginx-sub2api-20261016T133941Z.conf`。回滚仅移除该标记块或恢复此备份；若原站点此后发生修改，不要直接覆盖整份配置。任何变更后先 `sudo nginx -t`，通过后 reload。

## 常用命令

从仓库目录执行：

```bash
systemctl status minigame-login --no-pager
sudo journalctl -u minigame-login -n 50 --no-pager
sudo docker compose --env-file .env.production.infrastructure -p minigame-prod -f compose.production.yaml ps
sudo systemctl restart minigame-login
```

Redis 客户端只有限次重连；若 Redis 持续中断导致客户端停止重连，恢复 Redis 后需重启 API。恢复后从公网检查请求参数校验/微信错误路径。

更新应用先构建/测试，确认无误后重启 API；迁移需要独立管理员连接，不能以运行用户执行。禁止用生产数据库运行集成测试。集成测试只使用 `compose.test.yaml` 的固定独立端口 15439/16389。

本次部署安装的 systemd 文件来自 `ops/`，API 直接运行编译后的 `dist/main.js`，不运行开发服务器。后续迁移通过新增 SQL 文件，禁止修改已执行迁移。

## 备份

- `minigame-backup.timer` 每日 UTC 03:35（北京时间 11:35）加 0–15 分钟随机延迟，错过会补跑。
- 通过 pg_dump custom 格式生成本地备份，并检查归档目录，保留最近 14 天。备份权限仅 root 可读。
- 位置：`/var/backups/minigame-server/minigame-*.dump`。
- 实际执行脚本为 root 管理的 `/usr/local/lib/minigame-server/backup-production.py`。
- 手动执行：`sudo systemctl start minigame-backup.service`。
- 查看结果：`sudo journalctl -u minigame-backup.service -n 20 --no-pager`。
- 本次已将首份备份实际恢复到临时数据库，核实迁移表后删除临时库；备份文件权限为 0600。
- 这是同机备份，不防整机/磁盘损坏。尚未配置异地备份或主动监控告警；后续应补齐。
- 不备份 Redis 会话令牌；Redis 本身 AOF 持久化。数据库恢复不能保证 Redis 会话同步恢复，必要时让玩家重新登录。

## 部署验证边界

本次验证包括真实生产数据库迁移/最小权限、真实 Redis 连接、开机启动配置、服务常驻、公网 TLS、参数校验、畸形 JSON 脱敏、Nginx 413 限制、真实微信无效 code 401，以及原三个路由响应状态不变。隔离环境的 11 项单元测试、10 项集成测试通过，集成测试成功登录使用明确的微信测试替身。

无小游戏客户端新鲜 code，不能声称已完成真实玩家成功登录验收。客户端还需在微信后台配置 request 合法域名并确认 AppID 一致。线上当前不提供存档接口。

## 新增 JSON 存档待发布（本次开发不改生产）

代码新增 HTTPS + Bearer 普通 JSON save/get 与 migration `002_game_saves.sql`，尚未应用生产迁移或更新 Nginx。自定义加密已按要求移除，接入见 `save-api.md`。

现机 API 直接运行 dist；开发测试不可覆盖该目录，以免服务异常重启时误用未发布构建。使用 `npm run typecheck`、`npm test`、`npm run build:client`，再执行 `npx tsc -p tsconfig.build.json --outDir tmp/json-api-candidate-dist`。专用测试 Compose 启动后，用 `MINIGAME_TEST_DIST_DIR=tmp/json-api-candidate-dist node --import tsx --test --test-concurrency=1 test/*.integration.ts` 验证候选构建。不要在未授权发布时直接运行会写 dist 的 `check` / `test:integration`。

发布前按顺序：

1. 做数据库备份；以管理员连接运行迁移（运行账号无建表权限）。
2. 给 `minigame_app` 授予新表 `game_saves` 的 SELECT/INSERT/UPDATE。不要授予 DELETE 或整个 schema 的泛化写权限。
3. 构建并测试新版本，准备旧版本构建回滚副本。部署 API 后检查登录回归和存档未认证401；仅有鉴权错误不能证明成功读写，需测试账号完成完整 JSON 读写联调。
4. 更新 Nginx `ops/nginx-h5login.conf.example` 中的独立 `/h5login/api/data/` location：HTTP正文限额256KiB（存档原文64KiB），而通用 `/h5login/` 和登录仍保持16KiB；保持mirror/access_log关闭。继续只通过HTTPS公网入口访问。
5. nginx -t通过后reload，再核对生效配置及现有路由。
6. 用客户端完整验证登录→无存档get→save→get原文相等→旧version409，并检查跨用户隔离、限流、64KiB边界与错误脱敏。没有独立nonce防重放，重复同版本保存由CAS拒绝。不要用未认证请求测试代替成功链路。

备份pg_dump会自动包含新增表。新增表不影响旧版本登录功能；回滚API通常保留新增表和数据，不要为回滚删除存档。
