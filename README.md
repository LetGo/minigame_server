# minigame_server

微信小游戏服务端：NestJS + PostgreSQL + Redis，Node.js 24+、原生 ESM。当前是单游戏服务，不提供客户端任意切换 gameId。

## 文档入口

**先看 [接口与环境总索引](docs/README.md)**：完整端点表、正式/测试差异、认证、字段契约和发布记录。

- 客户端：[微信登录](docs/wechat-login-api.md) · [测试联调](docs/staging-integration.md) · [存档](docs/save-api.md) · [普通邀请与资料](docs/invite-api.md) · [排行榜](docs/leaderboards-api.md) · [玩家视频完成统计](docs/rewarded-video-api.md) · [订阅提醒](docs/subscribe-message-api.md)
- 后台：[看板](docs/dashboard.md) · [留存日报](docs/retention-dashboard.md) · [存档恢复/补偿](docs/dashboard-save-repair.md)
- 运维：[正式环境](docs/production-operations.md) · [常驻测试环境](docs/staging-operations.md)

好友昨日视频奖励已在两环境退役（领取 404、邀请列表无该奖励字段）；普通邀请、存档、玩家自身视频完成统计保留。玩家自身视频钻石奖励未开发、未上线，不属于现有统计接口。

## 安全开发命令

本机正式服务直接运行 `dist/main.js`。**未经发布授权，不运行 `npm run build`、`npm run check` 或 `npm run test:integration`（其 pretest 会重建在线 dist）**，不覆盖已部署 node_modules、配置或运行快照。

已有开发依赖时，可在仓库执行下列源码检查；构建输出仅放隔离候选目录：

```bash
npm run typecheck
npm test
npm run test:dashboard
npx tsc -p tsconfig.build.json --outDir tmp/docs-example-candidate-dist
```

需要集成测试时，须先确认目标仅为专用临时测试环境；它会写入并清理测试业务数据，**不属于只读文档校验**：

```bash
sudo docker compose -p minigame-login-test -f compose.test.yaml up -d --wait
MINIGAME_TEST_DIST_DIR=tmp/docs-example-candidate-dist node --import tsx --test --test-concurrency=1 test/*.integration.ts test/*.integration.mjs
sudo docker compose -p minigame-login-test -f compose.test.yaml down
```

仅允许固定测试 PostgreSQL `127.0.0.1:15439/minigame_test`、Redis `127.0.0.1:16389/15`；不能改指向常驻测试或正式库。新开发副本安装依赖用 `npm ci`，不要在运行快照/在线依赖目录原地安装。

真实 `.env*`、AppSecret、数据库连接、token、原始存档和私有审查证据不可回显或提交。迁移、备份恢复、发布、服务重启及 Nginx 变更需单独授权；不以文档命令视为授权。自动化换码替身/合成会话不是真实微信登录或广告回调验收。
