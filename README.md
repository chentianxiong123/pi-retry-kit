# pi-retry

**Retry everything. 一切都重试。**

pi 的扩展：在 **provider 请求层**对上游**一切错误**自动静默重试，
绕过 pi 内核"配额类错误不可重试"的判定，模型和 pi 全程无感知，**不发任何消息**。

## 适用场景

- 免费额度模型（固定时间 / 固定量限流）—— 任何报错都只是"正在被限"，重试就有意义
- 429 / `insufficient_quota` / `quota exceeded` / 5xx / 网络中断 / 超时 / context overflow……
  默认全部进入重试循环，直到成功或达到配置上限

## 安装

```bash
pi install git:github.com/chentianxiong123/pi-retry@v0.3.0
```

安装后 `/reload` 生效。查看配置与统计：`/pi-retry`

## 配置

`~/.pi/pi-retry.json`（旧版 `~/.pi/retry.json`、`~/.pi/quota-retry.json` 自动兼容读取）：

```json
{
  "enabled": true,
  "mode": "all",
  "matchStatus": [408, 429, 500, 502, 503, 504, 524],
  "matchText": [
    "insufficient_quota",
    "quota.*(?:exceeded|limit|reached)",
    "rate.?limit",
    "too many requests",
    "fetch failed"
  ],
  "maxAttempts": 20,
  "maxTotalWaitMs": 0,
  "backoff": {
    "baseDelayMs": 3000,
    "maxDelayMs": 60000,
    "multiplier": 2,
    "jitter": 0.1
  },
  "respectRetryAfter": true,
  "retryOnOverflow": true,
  "showStatus": true
}
```

### 重试策略（什么情况重试 / 哪些重试）

| `mode` | 行为 | 用途 |
|---|---|---|
| `"all"`（默认） | **一切错误都重试** | 免费额度模型，无脑重试 |
| `"allowlist"` | **只有**命中 `matchStatus` / `matchText` 的错误才重试 | 只想重试指定的错误 |
| `"denylist"` | 命中 `matchStatus` / `matchText` 的错误**不**重试，其余都重试 | 排除指定的错误 |

- `matchStatus`：HTTP 状态码数组（`[429, 500, 502, 503]`）
- `matchText`：错误文本正则数组（`"insufficient_quota"`、`"rate.?limit"` 等，不区分大小写）

判定规则：**状态码命中 或 错误文本命中任一正则** → 记为"命中"，由 `mode` 决定该错误是否重试。

### 退避与上限

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxAttempts` | `20` | 单请求最大尝试次数（含首次），`1` = 不重试 |
| `maxTotalWaitMs` | `0` | 单请求累计等待上限（ms），`0` = 不限 |
| `backoff.baseDelayMs` | `3000` | 基础延迟，指数增长 `base * multiplier^(n-1)` |
| `backoff.maxDelayMs` | `60000` | 单次等待上限（含 retry-after 上限） |
| `backoff.multiplier` | `2` | 指数倍数 |
| `backoff.jitter` | `0.1` | 抖动比例 0-1（±10% 随机化，防集体重试风暴；`0` = 无抖动） |
| `respectRetryAfter` | `true` | 尊重服务端 `retry-after` 响应头（4xx/5xx 均可用） |
| `retryOnOverflow` | `true` | `false` 时：prompt too long 快速失败，交给 pi 的 compaction 恢复 |
| `showStatus` | `true` | 重试期间状态栏显示进度（`静默重试 #n (HTTP 429)（等 Xs）`） |

## 工作原理

1. `session_start` / `model_select` 时通过 `ctx.modelRegistry.getProvider()` 拿到当前 provider
2. 覆盖其 `stream` / `streamSimple`：把每个请求包进重试循环，产出新的
   `AssistantMessageEventStream`（官方 `createAssistantMessageEventStream` 工厂）
3. 错误且**尚未产出任何内容** → 按策略判定 + 退避等待后重新发起；
   已产出内容（流中途断）不重试，直接上交（无法安全重放）
4. `pi.registerProvider()` 注册回 registry，对 pi 透明

### 唯一硬例外

- **用户取消（abort）** —— 尊重用户意志，永不重试（这不是错误，不参与策略）

## 开发

```bash
# 类型/语法检查（pi 运行时通过 loader aliases 解析捆绑的 pi-ai，无需本地安装）
bun build src/index.ts --external '@earendil-works/*' --external 'node:*' --target=bun
```

## License

MIT