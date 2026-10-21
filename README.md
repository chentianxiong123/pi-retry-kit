# retry

**Retry everything. 一切都重试。**

一对 pi 的扩展：在 **provider 请求层**对上游**一切错误**自动静默重试，
绕过 pi 内核"配额类错误不可重试"的判定，模型和 pi 全程无感知，**不发任何消息**。

## 适用场景

- 免费额度模型（固定时间 / 固定量限流）—— 任何报错都只是"正在被限"，重试就有意义
- 429 / `insufficient_quota` / `quota exceeded` / 5xx / 网络中断 / 超时 / context overflow……
  一律进入重试循环，直到成功或达到配置上限

## 安装

```bash
# git（推荐，tag 钉版本）
pi install git:github.com/chentianxiong123/retry@v0.2.0
```

安装后 `/reload` 生效。检查状态：`/retry`

## 配置

`~/.pi/retry.json`（旧版 `~/.pi/quota-retry.json` 会自动兼容读取）：

```json
{
  "enabled": true,
  "maxAttempts": 20,
  "baseDelayMs": 3000,
  "maxDelayMs": 60000,
  "maxTotalWaitMs": 0,
  "respectRetryAfter": true,
  "contextOverflowFastFail": false,
  "showStatus": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `maxAttempts` | `20` | 单个请求最大尝试次数（含首次），`1` = 不重试 |
| `baseDelayMs` | `3000` | 指数退避基础延迟 |
| `maxDelayMs` | `60000` | 单次等待上限（含 retry-after 上限） |
| `maxTotalWaitMs` | `0` | 单请求累计等待上限，`0` = 不限 |
| `respectRetryAfter` | `true` | 尊重服务端 `retry-after` 响应头 |
| `contextOverflowFastFail` | `false` | `false` = prompt 太长也重试（默认）；`true` = 快速失败交给 pi 的 compaction |
| `showStatus` | `true` | 重试期间状态栏显示进度 |

## 工作原理

1. `session_start` / `model_select` 时通过 `ctx.modelRegistry.getProvider()` 拿到当前 provider
2. 覆盖其 `stream` / `streamSimple`：把每个请求包进重试循环，产出新的
   `AssistantMessageEventStream`（官方 `createAssistantMessageEventStream` 工厂）
3. 任何 error 事件（429 / quota / 5xx / 网络 / overflow）且**尚未产出任何内容** →
   退避等待后在请求层重新发起；已产出内容（流中途断）不重试，直接上交
4. `pi.registerProvider()` 注册回 registry，对 pi 透明

### 唯一硬例外

- **用户取消（abort）** —— 尊重用户意志，立即停止（这不是错误，不参与"一切都重试"）

## 开发

```bash
# 类型/语法检查（pi 运行时通过 loader aliases 解析捆绑的 pi-ai，无需本地安装）
bun build src/index.ts --external '@earendil-works/*' --external 'node:*' --target=bun
```

## License

MIT