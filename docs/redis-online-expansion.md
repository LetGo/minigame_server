# 正式 Redis 扩容与持久化应用（2026-10-19）

## 当前状态：已完成，重启回退隐患已解除

用户先授权在线增容，随后明确授权“按更新后的配置重建容器”。2026-10-19 10:30（北京时间）已仅重建正式 `minigame-prod-redis-1`，保留原镜像、原数据卷 `minigame-prod_redis_data` 和密码。

| 参数 | 当前值 |
|---|---:|
| Redis启动命令maxmemory | 512mb |
| Redis运行时maxmemory | 536870912字节（512MiB） |
| 容器内存上限 | 1536MiB |
| 容器内存+swap合计上限 | 1728MiB（额外swap192MiB） |
| CPU上限 | 1核 |
| 淘汰策略 | noeviction |
| 持久化 | AOF，appendfsync everysec |

新容器已使用512mb启动命令，无需再次CONFIG SET；以后正常重启仍按512MiB启动。没有为了验证而额外重启第二次。

## 备份、重建与核验

- 重建前WAITAOF确认本地AOF同步，SAVE生成快照，redis-check-rdb校验checksum和结构通过。
- 备份 `tmp/redis-online-expansion/recreate/redis-before.rdb`，目录0700/文件0600；含会话数据，不得提交或对外发送。备份大小51092字节，SHA256和原始校验结果仅保存在私有证据中。此为快照校验，不是独立恢复演练。
- 使用生产Compose，仅 `up -d --no-deps --force-recreate --pull never --wait --wait-timeout 30 redis`，未执行down或删除卷。
- 原镜像和原Redis命名卷保持一致；仅Redis容器ID/进程/Redis run_id变化。
- 重建前后DB0/DB1共225个键均仍存在，逐键DUMP哈希一致（日志中仅存键名哈希和内容摘要，不输出会话值）。
- 其他原有容器的ID/PID/启动时间/重启数未变；正式API、看板、常驻测试API进程均未重启，保护的环境文件、运行产物与Nginx哈希未变。
- Redis容器healthy，重启计数0；运行参数与启动命令均回读通过。
- 正式/测试登录空JSON均保持400，看板入口200。
- 有效格式随机无效Bearer调用正式data/get返回401 SESSION_INVALID，证明正式API Redis GET链路已恢复；有效格式随机无效看板cookie调用api/me返回401 DASHBOARD_LOGIN_REQUIRED，证明看板Redis鉴权链路已恢复。不是实际微信登录或真实会话的端到端登录验证。
- 重建命令耗时6200ms（含健康等待）；100ms间隔HTTP探测59次，其中4次503。首次失败采样至首次恢复采样间隔421ms，此为采样观察窗口，不是精确停机时长。

没有部署排行榜、执行数据库迁移、改动玩家数据库或重启PostgreSQL。未改变Nginx、凭据和常驻测试环境。

## 历史边界

最初在线CONFIG SET已生效，但旧容器创建时启动命令仍为96mb，存在直接重启回退风险。该边界在本次明确授权重建后已解除。

当前Compose校验和git diff --check通过。在线阶段旧Compose备份在 `tmp/redis-online-expansion/compose.production.before.yaml`，其参数为96MiB；不要无意恢复旧配置。

证据：`tmp/redis-online-expansion/recreate/{before,after,backup,verification,timing,probes,final-health}.json`。本次资源变更不构成百万玩家生产容量保证。
