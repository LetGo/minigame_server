# 加密存档保存 / 获取接口（客户端接入）

> 本文描述本次新增接口。开发测试不等于上线：现有线上登录继续运行；新增存档接口须完成生产迁移、权限和代理调整后另行发布。不要在收到上线通知前接生产地址。

## 1. 接口与容量

基础路径：`https://sub2api.wdaveh5game.com/h5login`

| 操作 | 方法 | 路径 |
|---|---|---|
| 保存当前用户存档 | POST | `/api/data/save` |
| 获取当前用户存档 | POST | `/api/data/get` |

两者都带：

```text
Authorization: Bearer <登录接口返回的 accessToken>
Content-Type: application/json
```

每个用户保留一份最新存档，不提供历史版本或任意文件路径。用户身份仅从服务端登录会话取得，客户端不能指定 userId/openid。存档为 **JSON 文件原始字符串**，最大 **65,536 UTF-8 字节（64 KiB）**，当前约 11 KB 存档适用。保存时校验 JSON 合法性，但不重新序列化存档正文，保留空白、字段顺序和大整数的原始数字文本。传对象时如先经过 JS JSON.parse，可能已丢失大整数精度，不能靠后端恢复。

## 2. 推荐使用客户端 SDK

将 `client/minigame-data-client.js` 复制到小游戏项目，并保留 `client/THIRD-PARTY-LICENSES.txt`。这是已打包的 CommonJS 文件，无需客户端另装 npm 包，不依赖 Node Buffer、WebCrypto、TextEncoder/TextDecoder。加密使用成熟纯 JS 库 AES-GCM/HKDF，不自行实现密码算法。

```js
const { createDataClient } = require('./minigame-data-client.js');

// 在游戏自己的 async 初始化函数中调用；先用登录接口获得 accessToken。
async function initCloudSave() {
  const store = createDataClient({
    wx,
    accessToken: wx.getStorageSync('game_access_token')
  });

  const loaded = await store.get();
  let version = loaded.version; // 首次无存档为 0
  if (loaded.exists) {
    const originalJsonText = loaded.data;
    // 按游戏自身逻辑加载。需要原文/大整数精度时不要随意 parse 再 stringify。
  }

  // 由游戏在需要保存时调用，并在调用期间防止同客户端并发保存。
  return {
    loaded,
    async saveCurrentGame(originalJsonText) {
      const saved = await store.save(originalJsonText, version);
      version = saved.version;
      return saved;
    }
  };
}
// const cloud = await initCloudSave(); // 放在已有的 async 游戏流程中。
// await cloud.saveCurrentGame(游戏当前存档的JSON原始字符串);
```

SDK 使用 `wx.getUserCryptoManager().getRandomValues()` 生成每次请求的随机 nonce；可用时也兼容 `wx.getRandomValues()`。小游戏 UserCryptoManager 随机接口要求基础库 2.17.3+；不支持安全随机数时直接失败，**不会降级为 Math.random 或明文**。已验证无 Node 全局/WebCrypto 的模拟运行环境；仍需小游戏真机联调。

SDK 不自动重试。网络超时可能发生在保存已成功之后，因此超时后用新请求先 get 核实版本/内容，不能盲目重复覆盖。收到 `409 SAVE_VERSION_CONFLICT` 时重新 get，再由游戏决定如何处理冲突；不要自动用新版本强行覆盖。

登录过期后重新 wx.login() 并调用登录接口取得新 token，再创建新的 store 实例。令牌和存档正文都不要输出到日志。

## 3. 业务请求与响应（加密前结构）

### 获取

请求内部 JSON：

```json
{}
```

首次无存档，成功 HTTP 200 的解密结果：

```json
{"exists":false,"version":0,"data":null,"updatedAt":null}
```

已有存档的解密结果（示例）：

```json
{"exists":true,"version":1,"data":"{ \"level\": 12 }","updatedAt":"2026-10-16T14:00:00.000Z"}
```

### 保存

请求内部 JSON：

```json
{"version":0,"data":"{ \"level\": 12 }"}
```

`version` 是上次 get/save 返回的版本；首次为 0。成功响应解密结果（示例）：

```json
{"version":1,"updatedAt":"2026-10-16T14:00:00.000Z"}
```

版本在数据库原子更新。同一旧版本并发保存只有一次成功，其余返回 409。version 请求范围为 0–2,147,483,646；返回值可能达到 2,147,483,647，达到后不能继续覆盖，需服务端处理版本空间。时间为 UTC ISO 格式。

以上业务结构**不能直接作为 HTTP 明文正文发送**，必须先包装成下一节的加密信封。SDK 已封装这些步骤。

## 4. 加密协议（供其他语言实现）

HTTPS 仍为强制要求，Authorization 头依靠 TLS 保护。信封只允许以下五个字段：

```json
{
  "v":1,
  "ts":1792159200000,
  "nonce":"<12字节随机数的无填充base64url>",
  "ciphertext":"<密文的无填充base64url>",
  "tag":"<16字节GCM认证标签的无填充base64url>"
}
```

示例中的时间和字段是格式示意，不是可直接发送的有效请求。

- 算法：AES-256-GCM，IV/nonce 12 字节，认证标签 16 字节。
- `ts`：整数 Unix 毫秒，客户端时钟与服务器误差不超过 ±120 秒。
- base64url：URL-safe 字母表、无 `=` 填充，必须为规范编码。
- 密钥派生：HKDF-SHA256，IKM = 将 accessToken 规范 base64url 解码所得 32 字节；salt = UTF8(`minigame-data-v1`)；info 请求为 UTF8(`c2s`)、响应为 UTF8(`s2c`)；输出 32 字节。客户端没有固定共享密钥。
- 密文正文：内部业务 JSON 先 JSON.stringify，再 UTF-8 编码后加密。存档 data 本身始终保持字符串。

请求 AAD 为以下数组用换行 `\n` 拼接后的 UTF-8，无末尾换行：

```js
['minigame-data-v1', 'request', 'POST',
 '/h5login/api/data/save', String(ts), nonce]
```

获取接口将路径换成 `/h5login/api/data/get`。不加域名、不带查询串、不带尾斜杠。接口不接收查询参数。

HTTP 200 响应也使用相同信封，服务端生成独立随机 nonce 和当前 ts，以 s2c 密钥加密。响应 AAD：

```js
['minigame-data-v1', 'response', 'POST',
 '/h5login/api/data/save', '200', originalRequestNonce,
 String(responseTs), responseNonce]
```

响应与原请求 nonce 绑定，不能把另一次请求的响应调包。请求/响应使用不同派生密钥，禁止自行复用 nonce。SDK 会验证响应格式、时间和 GCM 标签，不接受明文成功响应。

服务端认证并验证 GCM 后，以 Redis 原子 `SET NX EX 300` 记录 token+nonce；同一 token 的两个存档接口共享防重放空间。重放返回 409。请求进入处理后即消费 nonce，后续业务失败也不能复用；再次尝试必须生成新 nonce。nonce 去重状态依赖 Redis 的持久化/可用性，时间窗仍会限制旧请求；不把它宣传为跨任意灾难恢复的严格恰好一次。

## 5. 错误与重试

错误不返回存档内容，不返回解密异常或 SQL；非 200 错误为脱敏 JSON，不再加密。代理层故障可能返回非 JSON，客户端必须容错。应用响应设置 `Cache-Control: no-store`。

| HTTP | message | 处理 |
|---|---|---|
| 400 | `INVALID_ENCRYPTED_PAYLOAD` | 信封/认证标签/请求路径绑定错误，检查实现 |
| 400 | `REQUEST_EXPIRED` | 校准设备时间，再以新 nonce 重发 |
| 400 | `INVALID_SAVE_DATA` | 检查 version、JSON 原文、额外字段、64 KiB 上限 |
| 400 | 其他参数/格式错误 | 修正请求，不循环重试 |
| 401 | `SESSION_INVALID` | 重新微信登录并更换 token |
| 409 | `REQUEST_REPLAYED` | 不复用 nonce；保存结果不确定时先 get |
| 409 | `SAVE_VERSION_CONFLICT` | 重新 get，业务决定合并/提示，不自动覆盖 |
| 413 | 请求正文超过上限 | 信封最多 256 KiB；登录接口仍为 16 KiB |
| 415 | 不支持的编码/字符集 | 使用未压缩 UTF-8 JSON |
| 429 | `DATA_RATE_LIMITED` | 遵循 Retry-After 秒数；同用户不同 token 共用额度 |
| 503 | `DATA_STORAGE_UNAVAILABLE` | 存储不可用，退避后先 get 确认保存结果 |

存档接口按用户累计每 60 秒最多 60 次调用（save/get 合计，跨登录 token 共享）；生产代理还可能有额外 IP 速率/并发限制。

## 6. 安全边界

本方案防网络明文读取、无会话读写、存档跨用户访问、密文篡改、短窗口重放和旧版本并发覆盖。**不能阻止持有自己有效 token 的玩家修改客户端、重新计算合法密文并提交假金币/道具。** 加密不是反作弊，服务端没有业务规则时也无法辨别这些数据真假。后续关键经济数据应由服务端权威计算或严格校验。

本次是传输加密；PostgreSQL 中保存 JSON 原始文本，不等于数据库落盘加密。客户端 token 泄漏将导致该会话失守，应保护设备存储并避免日志泄漏。现阶段没有注销/会话撤销接口。

随机数官方参考：
https://developers.weixin.qq.com/minigame/dev/api/base/crypto/UserCryptoManager.getRandomValues.html
