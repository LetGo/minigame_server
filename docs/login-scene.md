# 登录请求携带首次来源 scene

## 状态

**正式与常驻测试均已部署**：测试 2026-10-28 22:15:23，正式 2026-10-29 08:49:17（北京时间）。原 `/users/source-scene` 独立接口保留。逐次登录事件正式已另行发布，见 [login-events.md](login-events.md)；首次来源与逐次场景不可混淆。环境总览见 [README.md](README.md)。

## 请求与兼容

`POST <API_BASE>/auth/wechat-login`，HTTPS、普通 JSON，无需 Bearer。

- 测试 API_BASE：`https://sub2api.wdaveh5game.com/h5login-test/api`
- 正式 API_BASE：`https://sub2api.wdaveh5game.com/h5login/api`

```json
{"code":"wx.login 返回的新鲜 code","clientVersion":"2.0.7","scene":1007}
```

- code 仍为必填的一次性新鲜 code；失败重试前重新 wx.login。
- scene 可选，仅接受 JSON 数字整数 `1..2147483647`；不接受 null、字符串、布尔值、小数、0、负数、溢出，不自动转换类型。非法值返回 400，校验通过前不联系微信换码。
- clientVersion 仍可选，规则不变；旧客户端只传 code 仍正常登录。
- 不允许客户端传 appId、openid、userId、isNewUser、首次上报时间等身份/资格/时间覆盖字段。
- 成功响应与原登录相同，不新增 scene 响应字段，也不把 scene 放入 Redis 会话。登录响应仍含 accessToken、tokenType、expiresIn、isNewUser 和原 user 四个字段。

## 保存规则

1. 只在首次成功注册登录、来源尚为空时记录 scene，数据库同时记录上报时间（不是微信实际启动时间）。场景与注册、首次完成标记、每日登录统计在原事务内提交；资料读取/会话写入/事务失败则一起回滚。
2. 已有首次来源及原时间不可覆盖；后续带不同有效 scene 仍可正常登录，但忽略新值。重新进入/重装不算首次注册。
3. 已完成注册的历史玩家如果来源为空，仍保留未知，不拿本次场景补成首次来源，不批量改历史数据。
4. 并发首次登录只有一个 isNewUser:true，来源取该次成功提交的 scene；客户端应合并登录 Promise，避免不同入口互相竞争或覆盖首个 token。若首次登录省略 scene，后续普通登录不能补填。
5. 旧 `/users/source-scene` 保留：首次登录未传 scene 时，用本次首次会话立即补报；已由登录写入后，同值独立补报返回原记录，不同值仍返回 409。不要将独立接口的冲突行为和登录忽略后续来源的行为混淆。
6. scene 来自客户端启动参数，不是微信服务端核验，不用于奖励授权，也不替代邀请人 UID 归因。

## 客户端接入示例（两环境已支持）

```js
// 在游戏启动最早阶段采集一次；后续 onShow 不覆盖该值。
const launch = wx.getLaunchOptionsSync();
const initialScene = launch.scene;
const API_BASE = 'https://sub2api.wdaveh5game.com/h5login-test/api';

function loginOnce() {
  return new Promise((resolve, reject) => {
    wx.login({
      success({ code }) {
        if (!code) return reject(new Error('WX_LOGIN_NO_CODE'));
        const body = { code };
        if (Number.isInteger(initialScene) && initialScene >= 1 && initialScene <= 2147483647) {
          body.scene = initialScene;
        }
        wx.request({
          url: API_BASE + '/auth/wechat-login',
          method: 'POST',
          header: { 'content-type': 'application/json' },
          data: body,
          timeout: 20000,
          success(res) {
            if (res.statusCode === 200 && res.data && res.data.accessToken) {
              return resolve(res.data);
            }
            const error = new Error('GAME_LOGIN_FAILED');
            error.statusCode = res.statusCode;
            error.apiBody = res.data;
            reject(error);
          },
          fail: reject
        });
      },
      fail: reject
    });
  });
}

// 同一个注册流程复用此 Promise；不要每次业务请求都重新登录。
const authPromise = loginOnce();
// await authPromise 后按原规则保存 token/UID，并立即处理待上报 inviterUid。
// 若显式失败后需要重试，退避并重新调用 loginOnce() 获取新 code，仍使用 initialScene。
```

示例只展示参数接入，不包含游戏业务、自动重试或持久登录管理。测试/正式的 token、UID、存档版本及待上报来源缓存必须按环境隔离。仓库当前只有服务端及可选存档 SDK，无游戏客户端登录工程；需调用方将 scene 接入实际 wx.login 后的登录请求。

## 数据与验收边界

复用迁移004已有 source_scene/source_scene_reported_at、成对约束及不可变触发器；无需新增迁移或扩大运行权限。历史玩家、存档和既有来源不修改。开发验收使用隔离真实 PG/Redis、编译后 HTTP 与明确微信换码替身，不代表真机微信成功登录证明；当前上线状态见本文开头；历史候选审查工件保留原样。
