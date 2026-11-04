# 已退役功能与防恢复约束

## 好友昨日视频奖励（两环境已下线）

用户确认该功能违规，2026-11-05 已按各环境授权退役；不是关闭普通邀请，也不涉及玩家自身视频完成统计。

- 正式和测试 `POST /invites/video-rewards/claim` 均返回404，包括匿名与有效Bearer。
- `/invites/list` 不含顶层 `serverDate`、`videoRewardDate` 及条目 `yesterdayVideoReward`。
- 普通 report/list/claim、未领优先、每日最多新领取50份、稳定claimId重领、资料/首次来源、存档、登录、排行榜、订阅及本人视频完成统计均保留。
- 禁止后续源码构建、旧整包回滚或历史测试将该奖励恢复。本次源码同步清理与文档整理不代表新部署；不删执行过的迁移、历史奖励表或记录，不改ACL/凭据/基础设施。
- 玩家自身视频钻石奖励是独立未开发、未上线需求；现有完成事件上报仅统计，不是领奖或发钻石。

## 已完成的退役回验

| 环境 | 北京时间 | 结果与边界 |
|---|---|---|
| 常驻测试 | 2026-11-05 00:11:16 | 公开27项、安全33项通过；只替换两个邀请JS并重启测试API，历史奖励记录保留1条，结构/ACL未变 |
| 正式 | 2026-11-05 00:52:12最终回读 | 公开27项、受限编译11项、控制器离线19项、清理7项通过；只替换两个邀请JS并重启正式API，历史奖励记录在验收前为0，未迁移或删除历史数据 |

两次均清理自身合成fixtures并回读；不将在线真实玩家自然变更视为破坏，也不宣称真实微信登录或客户端到账证明。依赖与可信旧制品继续保留，不能清理仍被运行快照引用的旧node_modules。

私有证据仅在ignored目录：`tmp/invite-video-disable-staging/{published,public,review,final-readback}.json`、`tmp/invite-video-disable-production/{state,review,published,public,final-readback}.json`。原证据不提交、不改写。当前普通接口见 [invite-api.md](invite-api.md)，本人视频统计见 [rewarded-video-api.md](rewarded-video-api.md)，总表见 [README.md](README.md)。
