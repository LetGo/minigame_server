# 本机生产部署与运维

## 已部署组件

- 入口：`https://sub2api.wdaveh5game.com/h5login/api/auth/wechat-login`，POST JSON。
- API：`minigame-login.service`，ubuntu 用户，`127.0.0.1:18740`，512 MiB 内存上限、1 CPU 配额、异常自动重启、开机启动。
- 存储：独立 Compose 项目 `minigame-prod`，`compose.production.yaml`。PostgreSQL 18、Redis 8 镜像按当前已安装镜像 digest 固定，不跟随 latest 自动升级。
- PostgreSQL：`127.0.0.1:15440`，数据库 `minigame`。管理员 `minigame_owner` 负责迁移；运行用户 `minigame_app` 仅有用户表及存档表 SELECT/INSERT/UPDATE，无建库、建角色、超级用户、DELETE 或迁移表访问权限。
- Redis：`127.0.0.1:16390`，独立密码、AOF everysec、96 MiB maxmemory/noeviction。Redis 内存不足时登录会失败而非悄悄驱逐会话，需要监控并扩容。令牌到期/会话丢失需重新登录。
- 存储均为命名卷，非测试 tmpfs；容器资源上限为 PG 768 MiB、Redis 192 MiB。禁止 `docker compose down -v`，避免删除生产数据。
- `minigame-infrastructure.service` 管理基础设施开机启动；容器自身配置 unless-stopped。停止 API 不会停止数据库。
- 原有 sub2api 的 PostgreSQL/Redis 未复用、未重启、未改动。

## 配置与安全

`.env` 和 `.env.production.infrastructure` 均为 0600 并被 Git 忽略。不要打印整个文件、在命令行参数中展开连接密码或把内容发送到聊天/日志。

Nginx 的生效文件为 `/etc/nginx/sites-enabled/sub2api`（本机不是指向 available 的软链接）。新增路由带 `BEGIN/END MINIGAME LOGIN` 标记，保留原前缀代理、不带结尾斜杠。新路径关闭正文 mirror、access_log、proxy cache，覆盖来源 IP 头。登录及通用路径正文上限 16 KiB，独立 `/h5login/api/data/` 路径为 256 KiB，存档原文仍限 64 KiB。未改原 `/`、`/request-logs` 和 `/tqwz-query/` 路由。

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

无小游戏客户端新鲜 code，不能声称已完成真实玩家成功登录验收。客户端还需在微信后台配置 request 合法域名并确认 AppID 一致。线上现已提供存档接口，完整真实玩家链路仍需客户端验收。

## JSON 存档生产发布（2026-10-16）

已获授权并发布 HTTPS + Bearer 普通 JSON save/get，生产代码提交 `25ea2cc`。migration `002_game_saves.sql` 已应用，运行角色新增表最小权限已回读验证，Nginx 独立数据路由已启用。自定义加密已按要求移除，接入见 `save-api.md`。

本次上线记录：

- 发布前数据库备份：`/var/backups/minigame-server/minigame-20261016T145528694969Z.dump`；发布后另已补做一次成功备份。
- 旧 dist、Nginx 修改前配置及构建清单：仓库 `tmp/json-save-release-20261016T145625Z/`；当前记录 `tmp/json-save-current-release.json`。这些本机文件被 Git 忽略，不含配置凭据。
- 发布前重新运行 17 项单元测试、21 项隔离集成测试，全部通过；部署产物逐文件哈希与经过测试的候选一致。
- 公网 HTTPS 实测 15 项检查通过，包括临时鉴权账号无存档 get、save/get 原文一致、409、用户隔离、64 KiB 原文经 Nginx 往返、超限拒绝、登录畸形 JSON 脱敏和微信无效 code 401。
- 临时测试账号、存档、会话及限流键均已清理并回读；不涉及真实玩家存档。该测试通过管理员准备临时账号/会话，不是微信真实玩家成功登录证明。
- API 为 active/running，发布后 NRestarts=0；原 `/` 200、`/request-logs` 401、`/tqwz-query/` 200 保持不变。测试 Compose 已关闭，生产 PG/Redis 未重启。

现机 API 直接运行 dist；开发测试不可覆盖该目录，以免服务异常重启时误用未发布构建。使用 `npm run typecheck`、`npm test`、`npm run build:client`，再执行 `npx tsc -p tsconfig.build.json --outDir tmp/json-api-candidate-dist`。专用测试 Compose 启动后，用 `MINIGAME_TEST_DIST_DIR=tmp/json-api-candidate-dist node --import tsx --test --test-concurrency=1 test/*.integration.ts` 验证候选构建。不要在未授权发布时直接运行会写 dist 的 `check` / `test:integration`。

后续发布参考顺序：

1. 做数据库备份；以管理员连接运行迁移（运行账号无建表权限）。
2. 给 `minigame_app` 授予新表 `game_saves` 的 SELECT/INSERT/UPDATE。不要授予 DELETE 或整个 schema 的泛化写权限。
3. 构建并测试新版本，准备旧版本构建回滚副本。部署 API 后检查登录回归和存档未认证401；仅有鉴权错误不能证明成功读写，需测试账号完成完整 JSON 读写联调。
4. 更新 Nginx `ops/nginx-h5login.conf.example` 中的独立 `/h5login/api/data/` location：HTTP正文限额256KiB（存档原文64KiB），而通用 `/h5login/` 和登录仍保持16KiB；保持mirror/access_log关闭。继续只通过HTTPS公网入口访问。
5. nginx -t通过后reload，再核对生效配置及现有路由。
6. 用客户端完整验证登录→无存档get→save→get原文相等→旧version409，并检查跨用户隔离、限流、64KiB边界与错误脱敏。没有独立nonce防重放，重复同版本保存由CAS拒绝。不要用未认证请求测试代替成功链路。

备份pg_dump会自动包含新增表。新增表不影响旧版本登录功能；回滚API通常保留新增表和数据，不要为回滚删除存档。

## 测试环境（2026-10-17）

已另行获授权部署常驻测试环境 `/h5login-test/api`，见 `staging-operations.md`。其独立API18741、PG15441、Redis16391，不复用生产数据；仅Nginx增加测试include并reload。以下邀请版本生产发布清单仍未执行，不能把测试上线当作正式上线。

## 邀请拉新版本发布前清单（正式环境尚未执行）

本次仅开发，不代表以下生产动作已获授权或已执行。新增接口契约见 `invite-api.md`。线上 `user.openid` 返回字段同样仍待发布。

1. 另行取得部署/重启授权，确认备份及旧 dist 回滚副本。开发测试只写 `tmp/invite-candidate-dist`，不覆盖当前 dist。
2. 使用迁移管理员运行新增 `migrations/003_invites.sql`，禁止修改 001/002 历史迁移。该迁移将既有用户标记为已完成首登，避免旧用户在功能上线后获得拉新资格；新增用户由新版登录显式设置首登流程。
3. 为运行角色仅增加 `game_profiles`、`game_invitations` 的 SELECT/INSERT/UPDATE；保留既有 `game_users`/`game_saves` 权限，不新增 DELETE、DDL、全 schema 通配权限。上线前以受限角色实际执行资料→归因→列表→领取，不能只用管理员验证。
4. 四个新接口使用现有 `/h5login/` 通用 16 KiB 正文限制，无需为邀请功能扩大 Nginx body cap。保留原 no-mirror/no-cache/no-access-log 策略；未经授权不改 Nginx。
5. 登录增加 isNewUser 并在首次注册会话内记录资格。旧 Redis 会话没有此字段时仍是有效老用户会话，不授予新用户资格；无需为了功能清空全体用户会话。
6. 验证新注册、旧用户重登、首次会话来源上报、重复上报不重复计数、不同邀请人不能覆盖、跨应用隔离、并发领取稳定 claimId、客户端不依赖 invitationId。原 JSON 存档原文及 CAS 行为保持不变。
7. 服务端 rewardClaimed 仅代表登记领取，不代表客户端道具到账。客户端发奖、claimId 持久去重和异常恢复由客户端负责，不能把数据库领取状态当成真实奖励交付证明。
8. 新版登录依赖新增首登列，新版邀请依赖新增表；必须先迁移/授权再切换候选。回滚应用时保留新增数据，不删用户/邀请关系；检查旧版应用忽略附加会话字段时仍可登录/读写存档。
9. 使用两名真实微信用户实测分享卡片冷/热启动和授权头像昵称，其中被邀请者必须未注册过此小游戏。自动化用显式 WeChat stub，不是真实微信成功登录证明。

本清单仅为后续运维准备，实际运行结果须另行记录，不能将清单视为上线成功报告。

### 本次开发验收记录（2026-10-17，非上线记录）

- `npm run typecheck` 通过，17 项单元测试通过；39 个集成叶子用例通过（Node 报告 43 个测试，其中包含 4 个父测试），无失败、无跳过。依赖审计 0 漏洞。
- 真实隔离 PostgreSQL/Redis；编译候选以受限 PG 角色完成实际 HTTP 登录、资料、绑定、分页、并发领取及存档回归。微信换码使用显式网络测试替身，不是真实微信玩家成功登录或真实卡片点击证明。
- 验证了旧库迁移保留已有用户/存档且老用户不获新资格、并发首登仅一份资格、竞争归因只绑定一次、领取幂等、微秒分页、首登 Redis 故障回滚，以及 NX 拒绝时不误删已有会话键。
- 候选仅写 `tmp/invite-candidate-dist`；测试 JUnit、验收 JSON 和候选 SHA256 清单位于 Git 忽略的 `tmp/invite-*.xml/json`。
- 与开发前 SHA256 清单逐文件对比，生产 dist 保持不变；`minigame-login` 原 MainPID/启动时间不变，NRestarts=0。专用测试 Compose 已停止；未迁移生产库、未授予生产权限、未改 Nginx、未部署或重启生产服务。
