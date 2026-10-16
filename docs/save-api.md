# 存档保存 / 获取接口（HTTPS + JSON）

> 本版已取消自定义加密协议。存档接口目前仅开发完成，尚未生产发布；线上登录服务不变。请勿在收到上线通知前用生产地址联调存档。旧加密 SDK 不兼容本版，请替换为随本文提供的新 SDK。

## 接口与鉴权

基础地址：`https://sub2api.wdaveh5game.com/h5login`

| 操作 | 方法 | 路径 |
|---|---|---|
| 获取当前用户存档 | POST | `/api/data/get` |
| 保存当前用户存档 | POST | `/api/data/save` |

两个接口都使用：

```text
Authorization: Bearer <accessToken>
Content-Type: application/json
```

`accessToken` 来自微信登录接口。身份由服务器会话决定，不接受客户端指定 `userId`、`openid` 或 `appid`。每用户一份最新存档，无历史版本或任意文件路径；两个接口均不接受查询参数。

请求和成功响应直接使用 JSON，无需额外包装或解包。HTTPS 的 TLS 已提供传输加密与完整性保护；客户端只使用 HTTPS。

## 获取存档

请求正文：

```json
{}
```

首次无存档，HTTP 200：

```json
{"exists":false,"version":0,"data":null,"updatedAt":null}
```

已有存档，HTTP 200（结构示例，并非真实玩家数据）：

```json
{"exists":true,"version":1,"data":"{ \"level\": 12 }","updatedAt":"2026-10-16T14:00:00.000Z"}
```

## 保存存档

请求正文：

```json
{"version":0,"data":"{ \"level\": 12 }"}
```

HTTP 200（结构示例）：

```json
{"version":1,"updatedAt":"2026-10-16T14:00:00.000Z"}
```

- `data` 必须是 **JSON 原文字符串**，不是对象。服务器校验 JSON 有效，但不重新序列化，保留空白、字段顺序和大整数数字文本。
- 单份存档最多 **65,536 UTF-8 字节（64 KiB）**。不合法的 Unicode 文本会被拒绝。客户端先 parse/stringify 造成的数值精度损失无法由后端恢复。
- `version` 使用上次 get/save 返回值；无存档时为 `0`。保存成功后记住新版本。
- 数据库原子比较版本并更新；同一旧版本并发保存只有一次成功，其余返回 `409 SAVE_VERSION_CONFLICT`。
- 请求版本范围 `0`–`2147483646`；返回版本最高 `2147483647`，达到后需服务器处理版本空间，不会回绕或溢出。
- `updatedAt` 为 UTC ISO 时间。

## 小游戏 SDK

复制 `client/minigame-data-client.js` 到小游戏项目即可。这是无运行时第三方依赖的 CommonJS 包，不需要随机数 API、Node、WebCrypto 或 TextEncoder。

```js
const { createDataClient } = require('./minigame-data-client.js');

async function initCloudSave() {
  const store = createDataClient({
    wx,
    accessToken: wx.getStorageSync('game_access_token')
  });
  const loaded = await store.get();
  let version = loaded.version;

  return {
    loaded,
    async saveCurrentGame(originalJsonText) {
      const saved = await store.save(originalJsonText, version);
      version = saved.version;
      return saved;
    }
  };
}
// 在已有 async 游戏流程中：
// const cloud = await initCloudSave();
// await cloud.saveCurrentGame(JSON原文字符串);
```

同一客户端保存期间应防止并发调用。SDK 不自动重试；超时可能发生在服务器已保存后，先 get 确认内容和版本，再决定下一步。遇到 409 也应 get 后由业务决定合并或提示，不自动强行覆盖。

登录失效后重新 `wx.login()` 并调用登录接口，再用新 token 创建 SDK 实例。不要输出 token 或存档内容到日志。微信后台 request 合法域名填写 `https://sub2api.wdaveh5game.com`（不带路径）。

也可直接使用 `wx.request`；注意它返回 RequestTask，应通过回调或 Promise 包装取响应：

```js
function getSave(accessToken) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: 'https://sub2api.wdaveh5game.com/h5login/api/data/get',
      method: 'POST',
      header: {
        'content-type': 'application/json',
        Authorization: 'Bearer ' + accessToken
      },
      data: {},
      timeout: 20000,
      success(res) {
        if (res.statusCode === 200) resolve(res.data);
        else reject(new Error('DATA_REQUEST_FAILED: ' + res.statusCode));
      },
      fail() { reject(new Error('DATA_NETWORK_ERROR')); }
    });
  });
}
```

## 错误与限流

应用响应设置 `Cache-Control: no-store`。错误为脱敏 JSON，不包含正文、SQL 或堆栈。代理层错误可能不是 JSON，客户端应容错。

| HTTP | message / 含义 | 处理 |
|---|---|---|
| 400 | `INVALID_DATA_REQUEST` | 获取请求必须是空对象；两个接口都不能带查询参数 |
| 400 | `INVALID_SAVE_DATA` | 检查 data、version、额外字段、JSON/Unicode 和 64 KiB 限额 |
| 400 | `INVALID_JSON` | HTTP 正文不是有效 JSON |
| 401 | `SESSION_INVALID` | 重新微信登录并更换 token |
| 409 | `SAVE_VERSION_CONFLICT` | 先 get，再由业务决定如何处理 |
| 413 | 正文超过上限 | 存档 HTTP 正文限 256 KiB，登录仍为 16 KiB |
| 415 | 不支持的编码或字符集 | 使用未压缩 UTF-8 JSON |
| 429 | `DATA_RATE_LIMITED` | 遵循 `Retry-After` 秒数 |
| 503 | `DATA_STORAGE_UNAVAILABLE` | 退避，保存结果不确定时先 get |

每用户每 60 秒最多 60 次调用（save/get 合计），同用户不同 token 共用额度。HTTP 正文含嵌套 JSON 转义，因此正文限额与原文 64 KiB 限额不同；生产代理可能另有限速。

## 安全边界

已保留会话鉴权、用户隔离、限流和乐观版本保护。已移除自定义加密、时间戳窗口和 nonce 去重；可重复读取，重复提交同版本的保存由版本检查拒绝，**不等于通用防重放机制**。旧加密信封不再接受。

普通云存档不防持有自己有效会话的玩家提交假金币、假道具；关键经济数据需要服务器权威计算或业务校验。TLS 不代表数据库落盘加密，PostgreSQL 仍保存 JSON 原始文本。保护客户端 token，泄漏即可能失守；当前无注销/会话撤销接口。
