# 看板：修改数据 / 云存档恢复

状态：**三倍统计修复已于 2026-11-02 18:22:49（北京时间）部署，并通过公网及最终回读验收；未执行真实玩家补偿。** 本轮仅发布三份看板运行文件并重启看板；无数据库结构、配置或权限变更，小游戏接口、测试服及noderun保持原状态。发布证据：`tmp/diamond-three-times-release-retry/{ops-review,published,public-acceptance,final-readback}.json`。看板131项、数据库集成96项、通用单测48项、发布恢复10项及审计只读权限1项均通过，类型检查及独立审查通过。以下保留首次上线的历史记录。历史版本于2026-10-31 20:35（北京时间）按用户“发布”授权上线并开启写入。仅重启看板服务，未重启小游戏接口、测试服或 noderun，未修改真实玩家存档。公网查询/预览、权限、旧会话及资源回读均已验收；生产审计记录为0。发布证据：`tmp/save-repair-release-retry/published.json`（含首轮回滚后的复核发布）；开发阶段203项测试通过，另通过实际最小权限SQL的隔离PG18集成验证。

## 操作

1. 登录现有 HTTPS 看板，进入「修改数据」。输入完整 openid 查找同游戏、已完成注册的玩家。
2. 核对 UID/openid/昵称、存档版本和更新时间，以及当前四个字段。
3. 可切换 `Is_Remove_AD_All`（全部免广告）或输入**补偿钻石数量**，仅接受正整数（signed int32），不得为0、负数、小数、字符串或超范围数字；不支持扣减。纯免广告修改不传addDia。
4. 先填写必填原因，再「预览修改」，核对UID、当前存档版本、三个字段的原始值/修改值/增量，最后「确认保存」并确认弹窗。本次可填写“玩家钻石补偿”；只有确为恢复丢失数据时才写明具体恢复原因。
5. 修改前必须让玩家退出游戏；修改成功后重新登录并读取云存档。存档版本校验防止旧版本直接覆盖，但无法替客户端自动合并本地旧进度。

补偿N钻石的规则：`Dia += N`、`_getDia += 3*N`、`_useDia` 原值不变。`Dia`为实际余额，`_getDia`与`_useDia`为累计获取/消耗的三倍原始统计。补偿前要求三个字段为合法非负int32、两项统计为3的倍数，且`Dia === _getDia / 3 - _useDia / 3`；异常旧账返回422并要求人工复核，绝不顺手修账、重算余额、把_getDia改为余额三倍或清零统计。乘法和加法分别检查安全整数，最终Dia和_getDia必须在int32范围内；溢出拒绝、不回绕、不钳制。预览和事务内实际保存均复用同一个计算/校验函数。

示例预览（仅用户给定的验收数据，非真实玩家最新存档）：

|原始字段|修改前|补偿10000后|增量|
|---|---:|---:|---:|
|Dia|20|10020|+10000|
|_getDia（原始3倍统计）|960|30960|+30000|
|_useDia（原始3倍统计）|900|900|0|

`30960 / 3 - 900 / 3 = 10020`。保存真实补偿前仍须人工确认玩家UID和最新存档并重新预览；本轮不运行真实apply。

仅替换顶层目标值的原文片段，不将整个存档 JSON.parse/stringify 后覆盖；其他字段、嵌套同名字段、超大整数原文、空白和键顺序全部保留。根字段重复、缺字段、非布尔免广告、非规范非负整数计数、溢出或未知结构将拒绝修改，不猜测、不补建无存档玩家。

## 接口

沿用看板 Cookie 登录、SameSite=Strict、Origin 校验和 no-store：

- `POST /h5dashboard/api/save-repair/lookup`：`{openid}`
- `POST /h5dashboard/api/save-repair/preview`：`{openid,version,fingerprint,changes}`
- `POST /h5dashboard/api/save-repair/apply`：上述字段再加 `{requestId,reason}`

`changes` 仅支持 `{removeAds?:boolean,addDia?:number}`；不接受任意 data/userId/appId/force。查询和预览均不写玩家数据。预览另返回`delta:{Dia:N,_getDia:3*N,_useDia:0}`及当前`save.version`。前端不能传修改后的余额或统计；服务端在事务锁下读取当前存档并计算。HTTP另校验原始addDia数字token，避免极小小数被JSON解析舍入成整数；拒绝小数/指数表示、字符串及重复JSON字段。

每次申请更新检查已查到的 version 和 SHA256 指纹。保存事务锁定玩家当前存档，再原子递增 version。冲突返回409，必须重新查询，不提供强制覆盖。更新和原始存档备份/审计同一事务，审计失败即回滚，不出现无审计的补发。

`requestId` 为 UUID，同 app 同 requestId 的相同操作重试只返回原结果；换内容/操作者会冲突。若客户端在更新后又保存了新版本，重复请求返回的是原操作回执，不代表当前最新存档。页面保存成功后或结果不明时均要求重新查询后才可再次操作，不自动重复补发。

## 审计与数据保护

新增 `014_dashboard_save_repairs.sql`，仅新建表和索引，不重写旧存档。

`game_dashboard_save_repairs` 保存 app/user/request ID、操作者、原因、原/新完整存档原文、原/新版本、结果和服务端时间。补偿结果的`diamondCompensation`显式保留`amount`、三个字段的`before/after/delta`，与存档更新、幂等回执和原始全文备份同一事务；不需要修改已有迁移或新增权限。保存流程沿用game_saves原文、version递增、updated_at和指纹校验，未绕过任何现有机制；当前存档接口没有额外存档签名列或重签步骤。备份在数据库内，不作为浏览器接口返回。表不做玩家级联删除，避免恢复证据静默消失；保留周期需要单独制定。没有一键回退按钮；如需恢复某一原存档，应另行授权并针对当前版本审查，不能盲目覆盖后续玩家进度。

本功能需要逐条原存档备份，不需要每次代码发布强制全库备份。数据库常规备份/恢复演练保持独立。

## 上线配置与发布边界

- 已发布审查过的 dashboard 候选快照，保留独立旧快照可回滚；只重启 `minigame-dashboard.service`，不重启正式游戏 API、测试服或 noderun。
- 本次已获上线及写入开关授权，生产仅执行新增审计表、独立最小权限角色及开关配置；对真实玩家的修改仍必须在看板逐次查询、预览和确认。写入功能已在固定测试库 `127.0.0.1:15439/minigame_test` 实际验证。
- 通过已有迁移器事务性执行014；检查迁移台账和原表数据未变。不要改旧迁移文件或绕过台账。
- 保留现有 `minigame_dashboard_app` 只读连接；新增独立 `minigame_save_repair_app`，禁止 owner/superuser/DDL 权限。授予必需的用户/资料/存档查询；`game_saves` 仅 UPDATE(data,version,updated_at)，无 INSERT/DELETE；审计表仅 SELECT/INSERT，无 UPDATE/DELETE。
- 在 `.env.dashboard` 中显式配置 `DASHBOARD_SAVE_REPAIR_ENABLED=true` 和独立 `DASHBOARD_SAVE_REPAIR_DATABASE_URL`。URL只能是生产本机15440/minigame与指定独立角色，无额外查询参数。不复用数据库 owner 或扩大只读角色权限。
- 开关缺省/false 时，查找与预览可用、apply返回403；即使误传客户端字段也不能开启写入。
- 验收公网 HTTPS：新 tab/资源、未登录401、来源校验、已登录真实只读查询与预览。修改真实玩家须明确目标和修改内容；不得为上线验收擅自补发真实玩家。上线前还应验收旧路由/静态资源并检查无关进程/产物未变。

## 本地验证命令

```sh
npm run test:dashboard
npm test
npm run typecheck
node --import tsx --test test/dashboard-save-repair.integration.ts
```

最后一项仅连接 compose.test.yaml 固定测试库，创建隔离测试用户/最小权限角色，验证真实 PostgreSQL18 + HTTP登录/查询/预览/保存/回读、字节保留、跨应用隔离、并发冲突、幂等重试、审计失败回滚和权限拒绝，并清理本轮测试记录/角色。UI回归使用 VM DOM harness，不冒充真实微信客户端或公网发布验证。
