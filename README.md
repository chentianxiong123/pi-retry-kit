# pi-retry-kit

**提效工具包：上游请求「错误」与「首字」双维度的静默重试，一个包搞定。**

pi 的扩展工具包，内置多个**提效扩展**，主打**无感重试**——pi 和模型全程不感知、不发任何消息。

## 内置扩展

| 扩展 | 触发维度 | 干什么 |
|---|---|---|
| **pi-retry** | **错误** | 429 / `insufficient_quota` / 5xx / 网络 / 超时 / context overflow —— 一切报错都静默重试，绕过 pi 内核「配额类错误不可重试」判定 |
| **pi-ttft** | **时间** | **首字太久**：首个真实 token 超过 `firstTokenTimeoutMs` 未出现 → abort 并静默重试；空响应也重试 |
| **pi-breaker** | **熔断** | 某模型连续失败 → **熔断**（暂停使用 `resetTimeoutMs`），并**自动切到 `fallbackModels` 备用链**；临时错(network/timeout)用 5s 短冷却 |

两者互补、可叠加：**pi-retry 管「报错就重试」，pi-ttft 管「不报错但半天不吐字就重试」**，合成「错误 + 首字」全覆盖。

## 安装

```bash
pi install git:github.com/chentianxiong123/pi-retry-kit@v0.4.0
```

安装后 `/reload` 生效。查看配置与统计：`/pi-retry`、`/pi-ttft`

## 为什么是「工具包」而不是每扩展一个仓库

- **好维护**：一个 git 仓库、一个 package.json、一份 README，共享骨架；历史一路保留。
- **内置多扩展**：`pi` 清单里列多个 extension 文件，一次安装全部生效；以后加扩展只需丢一个文件 + 加一行。
- **配置仍独立**：每个扩展读各自配置文件，互不干扰——
  - pi-retry：`~/.pi/pi-retry.json`（旧版 `~/.pi/retry.json`、`~/.pi/quota-retry.json` 兼容）
  - pi-ttft：`~/.pi/pi-ttft.json`

## pi-retry 配置（错误维度）

`~/.pi/pi-retry.json`：

```json
{
  "enabled": true,
  "mode": "all",
  "matchStatus": [408, 429, 500, 502, 503, 504, 524],
  "matchText": ["insufficient_quota", "quota.*(?:exceeded|limit|reached)", "rate.?limit", "too many requests", "fetch failed"],
  "maxAttempts": 20,
  "maxTotalWaitMs": 0,
  "backoff": { "baseDelayMs": 3000, "maxDelayMs": 60000, "multiplier": 2, "jitter": 0.1 },
  "respectRetryAfter": true,
  "retryOnOverflow": true,
  "showStatus": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `"all"` | `all` 一切重试 / `allowlist` 只重试命中 / `denylist` 命中不重试 |
| `matchStatus` / `matchText` | — | allowlist/denylist 模式下判定命中的状态码 / 错误文本正则 |
| `maxAttempts` | `20` | 单请求最大尝试次数（含首次），`1` = 不重试 |
| `maxTotalWaitMs` | `0` | 单请求累计等待上限（ms），`0` = 不限 |
| `backoff` | 3000/60000/2/0.1 | 基础延迟 / 单次上限 / 指数倍数 / 抖动 |
| `respectRetryAfter` | `true` | 尊重服务端 `retry-after` 头 |
| `retryOnOverflow` | `true` | `false` 时 prompt too long 快速失败交给 compaction |
| `showStatus` | `true` | 状态栏显示 `静默重试 #n (HTTP 429)（等 Xs）` |

## pi-ttft 配置（首字/时间维度）

`~/.pi/pi-ttft.json`：

```json
{
  "enabled": true,
  "firstTokenTimeoutMs": 20000,
  "retryOnEmpty": true,
  "maxAttempts": 20,
  "maxTotalWaitMs": 0,
  "backoff": { "baseDelayMs": 2000, "maxDelayMs": 60000, "multiplier": 2, "jitter": 0.1 },
  "models": { "anthropic/claude*": { "firstTokenTimeoutMs": 45000 } },
  "showStatus": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `firstTokenTimeoutMs` | `20000` | 首字阈值（ms）：超过仍无首个真实 token → abort 并静默重试 |
| `retryOnEmpty` | `true` | 流正常结束但零内容（空响应）也静默重试 |
| `maxAttempts` | `20` | 单请求最大尝试次数（含首次） |
| `maxTotalWaitMs` | `0` | 单请求累计等待上限（ms），`0` = 不限 |
| `backoff` | 2000/60000/2/0.1 | 基础延迟 / 单次上限 / 指数倍数 / 抖动 |
| `models` | `{}` | 按模型 glob 覆盖首字阈值，`*` 通配、大小写不敏感 |
| `showStatus` | `true` | 状态栏显示 `静默重试 #n（首字 20s 无响应，等 Xs）` |

## pi-breaker 配置（熔断 / 自动切模型）

`~/.pi/pi-breaker.json`：

```json
{
  "enabled": true,
  "failureThreshold": 5,
  "resetTimeoutMs": 120000,
  "cooldownMs": 60000,
  "fallbackModels": [
    { "provider": "anthropic", "model": "claude-haiku-4-5" }
  ],
  "models": {},
  "showStatus": true
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `failureThreshold` | `1` | 连续失败多少次后熔断（`open`，暂停使用该模型）。默认 **1**：重试耗尽仍失败 = 模型已挂，一次即熔断 |
| —（护栏） | 仅可重试类 | **只有可重试类失败**（network/5xx/429/timeout/配额）才计入熔断；400/鉴权/未知（我们自己的 bug/配置）**不熔断好模型** |
| `resetTimeoutMs` | `120000` | **熔断多少秒恢复**：`open` 后等这么久才进 `half-open` 放一个探测请求；探测成功→`closed`（恢复），失败→再 `open` |
| `cooldownMs` | `60000` | 单次失败后的冷却（ms）；临时错(network/timeout/临时鉴权)自动用 **5s** |
| `fallbackModels` | `[]` | 熔断/失败后依次尝试的备用模型链，`{ provider, model }`；切模型用 `ctx.modelRegistry` |
| `models` | `{}` | 按模型 glob 覆盖阈值（如 `{ "anthropic/claude*": { "resetTimeoutMs": 180000 } }`） |
| `showStatus` | `true` | 状态栏显示进度 |

> **熔断状态机**：`closed` →(连续失败≥阈值)→ `open`(拒绝) →(`resetTimeoutMs` 后)→ `half-open`(放 1 个探测) →(成功)→ `closed`，→(失败)→ 再 `open`。`half-open` 只放一个探测（防恢复风暴）。

## 工作原理（三者一致）

1. `session_start` / `model_select` 时拿到当前 provider，包装其 `stream` / `streamSimple`
2. 每个请求包进重试循环，产出新的 `AssistantMessageEventStream`（官方工厂）
3. 重试/切换只发生在**尚未产出任何内容**时（内容无法安全重放）：
   - pi-retry：错误事件且未产出内容 → 按策略重试
   - pi-ttft：首字超时 / 空响应 → 按退避重试
   - pi-breaker：失败 → 计一次熔断失败 + 冷却 → 切下一个（`fallbackModels` 链）；熔断则跳过
4. `pi.registerProvider()` 注册回 registry，对 pi 透明

### 唯一硬例外

- **用户取消（abort）** —— 尊重用户意志，永不重试、不计熔断失败。

### 三者的分工（互补不重叠）

| 扩展 | 范围 | 触发 | 干什么 |
|---|---|---|---|
| pi-retry | 单请求内 | 错误 | 同一模型静默重试（配额/429/5xx/网络/overflow） |
| pi-ttft | 单请求内 | 首字太久/空响应 | 同一模型静默重试 |
| pi-breaker | **跨请求** | 连续失败 | **熔断该模型 + 自动切备用模型** |

### 三者可独立使用（互不耦合）

- **零跨扩展 import**：`pi-retry.ts` / `pi-ttft.ts` / `pi-breaker.ts` 互不引用；`pi-breaker` 只依赖 `lib/`（熔断器/分类器，**无状态纯函数**，作为共享库而非扩展耦合）。
- **各自独立配置**：`~/.pi/pi-retry.json`、`~/.pi/pi-ttft.json`、`~/.pi/pi-breaker.json`。
- **可单独加载**：`pi.extensions` 里只留一个也能跑——它们各自包装 provider stream，不检测对方是否存在。
- **级联只需「加载顺序」**：要完整级联（重试→耗尽→熔断→降级），三个都要加载，且 `pi-breaker` 在列表**最后**（最外层）。

> **独立使用的唯一注意**：`failureThreshold=1` 是为级联校准的（重试耗尽=判死刑）。若**只装 pi-breaker**（无 pi-retry/pi-ttft），单次瞬时 5xx 也会立即熔断；此时建议把 `failureThreshold` 调高（如 `3`），或接受「熔得狠、恢复快」的激进策略。

## 与 pi-quiver 的 provider-stall-watchdog 对比

| 维度 | provider-stall-watchdog | **pi-retry-kit（本包）** |
|---|---|---|
| 静默 | 会 `pi.sendMessage` 注入合成消息，借 pi 内置 retry | **完全静默**，无消息、无注入、不依赖 pi 内置 retry |
| 重试归属 | 借 pi 内置 retry（预算默认 3） | **自己管重试循环**（`maxAttempts` 默认 20） |
| 退避 | 固定 `base*2^(n-1)` | 可配 `base/max/multiplier/jitter` |
| 按模型覆盖 | 有（`models` glob） | 有（pi-ttft 的 `models` glob） |
| 错误维度 | 不处理 | pi-retry 处理（mode/match/retry-after/overflow） |
| 空响应 | 不专门处理 | pi-ttft `retryOnEmpty` |
| 熔断+切模型 | 无 | **pi-breaker**（`closed/open/half-open` + `fallbackModels`） |

## 发布（Release）

本包走 **git tag 发行**（与 `pi install git:...` 配套），也可走 npm。发布步骤：

```bash
# 1) 推代码到 GitHub 仓库 chentianxiong123/pi-retry-kit
pi-retry-kit> git push -u origin main

# 2) 打版本 tag（版本号与 package.json 一致）
pi-retry-kit> git tag v0.4.0
pi-retry-kit> git push origin v0.4.0

# 3) 用户安装
pi install git:github.com/chentianxiong123/pi-retry-kit@v0.4.0
```

npm 备选（包名 `pi-retry-kit` 当前未被占用）：

```bash
pi-retry-kit> npm publish   # 需要 npm login，且 peerDeps 只列 @earendil-works/*（host 提供）
pi install npm:pi-retry-kit
```

> git tag 是**不可变**引用：`pi install git:...@v0.4.0` 会固定在该 tag。改代码后必须打**新 tag**（如 `v0.4.1`），不要原地改 tag。

## 开发

```bash
# 类型/语法检查（pi 运行时通过 loader aliases 解析捆绑的 pi-ai，无需本地安装）
bun build extensions/pi-retry.ts --external '@earendil-works/*' --external 'node:*' --target=bun
bun build extensions/pi-ttft.ts  --external '@earendil-works/*' --external 'node:*' --target=bun
```

## License

MIT
