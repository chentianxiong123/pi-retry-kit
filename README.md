# pi-retry-kit

> **pi-resilience** —— 一个插件，三重静默防护：**静默重试 + 首字看门狗 + 熔断器/自动切模型**。
>
> 包装 provider 的 `stream`/`streamSimple`，在**请求层**内部重试/切换。全程**无感**（不发消息、不注入、不依赖 pi 内置 retry）、**无缝**（切备用模型时透传同一个对话上下文）。pi 和模型全程无感知。

## 为什么需要它

pi 内置 retry 只按「错误」分类重试，且把 `insufficient_quota` / `quota exceeded` / `billing` 等判为**不可重试**直接快速失败；也处理不了「没报错但半天不吐第一个字」的排队/冷启动问题。本插件把整个重试/切换搬到 provider 请求层，**静默**地：

- **重试**：一切报错（配额/429/5xx/网络/超时/overflow）都重试；
- **首字看门狗**：`firstTokenTimeoutMs` 内无首个真实 token → abort 并重试；空响应也重试；
- **熔断 + 自动切模型**：某模型连续失败（重试耗尽仍失败 = 判死刑）→ **熔断**该模型 `resetTimeoutMs`，并**自动切到 `fallbackModels` 备用链**（备用模型同样走完整重试 + 透传上下文）。

## 安装

```bash
pi install git:github.com/chentianxiong123/pi-retry-kit@v0.5.0
```

> 或本地：`pi -e ./pi-retry-kit`。

## 配置 `~/.pi/pi-resilience.json`

一个扁平 JSON，分节 `retry` / `ttft` / `breaker` / `fallback`，**每节可独立开关**（`enabled: false`）。

```json
{
  "enabled": true,
  "showStatus": true,
  "retry": {
    "enabled": true,
    "mode": "all",
    "maxAttempts": 20,
    "maxTotalWaitMs": 0,
    "backoff": { "baseDelayMs": 3000, "maxDelayMs": 60000, "multiplier": 2, "jitter": 0.1 },
    "respectRetryAfter": true,
    "retryOnOverflow": true
  },
  "ttft": {
    "enabled": true,
    "firstTokenTimeoutMs": 20000,
    "retryOnEmpty": true
  },
  "breaker": {
    "enabled": true,
    "failureThreshold": 1,
    "resetTimeoutMs": 120000,
    "cooldownMs": 60000
  },
  "fallback": {
    "models": [
      { "provider": "anthropic", "model": "claude-haiku-4-5" }
    ],
    "maxAttempts": 8
  }
}
```

### retry（错误静默重试）

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `all` | `all` 一切重试；`allowlist` 只重试命中的；`denylist` 命中的不重试 |
| `matchStatus` / `matchText` | 见下 | `allowlist`/`denylist` 模式下的匹配（HTTP 状态 / 错误文本正则） |
| `maxAttempts` | `20` | 主模型单请求最大尝试次数（含首次） |
| `maxTotalWaitMs` | `0` | 单请求累计等待上限（ms），`0` = 不限 |
| `backoff` | 3000/60000/2/0.1 | 基础延迟 / 单次上限 / 指数倍数 / 抖动 |
| `respectRetryAfter` | `true` | 尊重服务端 `retry-after` 头 |
| `retryOnOverflow` | `true` | 上下文溢出也重试（`false` = 快速失败给 compaction） |

### ttft（首字看门狗）

| 字段 | 默认 | 说明 |
|---|---|---|
| `firstTokenTimeoutMs` | `20000` | 首字阈值（ms）：超过仍无首个真实 token → abort 并重试 |
| `retryOnEmpty` | `true` | 流正常结束但零内容（空响应）也重试 |
| `models` | `{}` | 按模型 glob 覆盖首字阈值，如 `{ "anthropic/claude*": { "firstTokenTimeoutMs": 45000 } }` |

### breaker（熔断 + 自动切模型）

| 字段 | 默认 | 说明 |
|---|---|---|
| `failureThreshold` | `1` | 连续失败多少次后熔断（`open`）。默认 **1**：重试耗尽仍失败 = 模型已挂，一次即熔断 |
| `resetTimeoutMs` | `120000` | **熔断多少秒恢复**：`open` 后等这么久才进 `half-open` 放一个探测请求；探测成功→`closed`，失败→再 `open` |
| `cooldownMs` | `60000` | 单次失败后的冷却（ms）；临时错(network/timeout/鉴权)自动用 **5s** |
| `models` | `{}` | 按模型 glob 覆盖**冷却**（如 `{ "anthropic/claude*": { "cooldownMs": 180000 } }`） |

> **熔断状态机**：`closed` →(连续失败≥阈值)→ `open`(拒绝) →(`resetTimeoutMs` 后)→ `half-open`(放 1 个探测) →(成功)→ `closed`，→(失败)→ 再 `open`。`half-open` 只放一个探测（防恢复风暴）。

### fallback（备用模型链）

| 字段 | 默认 | 说明 |
|---|---|---|
| `models` | `[]` | 熔断/失败后依次尝试的备用模型，`{ provider, model }` |
| `maxAttempts` | `8` | 每个备用模型的单请求最大尝试次数（备用同样走完整重试） |

## 工作原理（无感 + 无缝）

```
pi → pi-resilience（单层包装 provider stream）
       ├─ ① 熔断检查（主模型电路 open/冷却 → 跳③）
       ├─ ② 重试+首字看门狗（同一循环，同模型，含退避）
       ├─ ③ ② 耗尽仍失败 → 熔断主模型 → 切备用链
       └─ 备用链 [F1,F2,...]：每个也走②的完整重试 + 透传同一 context
```

1. `session_start` / `model_select` 时拿到当前 provider，包装其 `stream` / `streamSimple`；
2. 每个请求包进**显式级联**（顺序写死在代码里，无加载顺序坑）；
3. 只重试/切换「**尚未产出任何内容**」的失败（内容无法安全重放）；`committed`（已产出）直接上交；
4. **唯一硬例外**：用户 `abort` —— 尊重意志，永不重试、不计熔断失败。

### 无感
包装在请求层，内部重试/切换，从不 `pi.sendMessage`、不注入消息、不依赖 pi 内置 retry。pi 看到的是**一条正常流**。

### 无缝
切到备用模型时，把**同一个 `TranscriptContext`（对话消息数组）**传给备用 `provider.stream()` —— 备用模型拿到完整对话接着写。「内容前」事件（`start` 等）先缓冲，失败候选丢弃、成功候选才放行，避免重复 `start` / 失败候选污染输出流。

## 与 pi-quiver 的 provider-stall-watchdog 对比

| 维度 | provider-stall-watchdog | **pi-resilience（本包）** |
|---|---|---|
| 静默 | 会 `pi.sendMessage` 注入合成消息，借 pi 内置 retry | **完全静默**，无消息、无注入、不依赖 pi 内置 retry |
| 重试归属 | 借 pi 内置 retry（预算默认 3） | **自己管重试循环**（默认 20） |
| 退避 | 固定 `base*2^(n-1)` | 可配 `base/max/multiplier/jitter` |
| 按模型覆盖 | 有（`models` glob） | 有（ttft / breaker 的 `models` glob） |
| 错误维度 | 不处理 | retry 处理（mode/match/retry-after/overflow） |
| 空响应 | 不专门处理 | ttft `retryOnEmpty` |
| 熔断+切模型 | 无 | **有**（`closed/open/half-open` + `fallbackModels`，且备用带重试+上下文透传） |

## 命令

- `/pi-resilience` —— 显示配置、各电路状态（closed/open/half-open + 恢复时间）、本会话统计。

## 开发（本仓库）

```bash
bun build extensions/pi-resilience.ts --external '@earendil-works/*' --external 'node:*' --target=bun
# tsc 严格检查（模块解析 Bundler，映射到全局安装的 pi 类型）
```

## 发布（Release）

- 主路径：`git tag v0.5.0 && git push --tags`（仓库 `chentianxiong123/pi-retry-kit`）；
- 备选：`npm publish`（包名 `pi-retry-kit` 未被占用，需 `npm login`）。
