# pi-retry-kit

> **pi 工具包**，当前含两个扩展：
>
> - **pi-resilience** —— 一个插件，三重静默防护：**静默重试 + 首字看门狗 + 熔断器/自动切模型**。包装 provider 的 `stream`/`streamSimple`，在**请求层**内部重试/切换。全程**无感**（不发消息、不注入、不依赖 pi 内置 retry）、**无缝**（切备用模型时透传同一个对话上下文）。pi 和模型全程无感知。
> - **pi-notify** —— 回合结束后**桌面通知**（OSC 777 / Kitty OSC 99 / Windows toast），零依赖，只写 stdout escape 序列。

## 为什么需要它

pi 内置 retry 只按「错误」分类重试，且把 `insufficient_quota` / `quota exceeded` / `billing` 等判为**不可重试**直接快速失败；也处理不了「没报错但半天不吐第一个字」的排队/冷启动问题。本插件把整个重试/切换搬到 provider 请求层，**静默**地：

- **重试**：一切报错（配额/429/5xx/网络/超时/overflow）都重试；
- **首字看门狗**：`firstTokenTimeoutMs` 内无首个真实 token → abort 并重试；空响应也重试；
- **熔断 + 自动切模型**：某模型连续失败（重试耗尽仍失败 = 判死刑）→ **熔断**该模型 `resetTimeoutMs`，并**自动切到 `fallbackModels` 备用链**（备用模型同样走完整重试 + 透传上下文）。

## 安装

```bash
pi install git:github.com/chentianxiong123/pi-retry-kit@v0.7.2
```

> 或本地：`pi -e ./pi-retry-kit`。

## pi-notify（回合后自动通知）

监听 **`agent_settled`**（整轮完整跑完、等待输入时）→ 发终端桌面通知「Pi: Ready for input」。支持：

- **OSC 777**：Ghostty / iTerm2 / WezTerm / rxvt-unicode；
- **OSC 99**：Kitty；
- **Windows toast**：Windows Terminal (WSL)。

零依赖，只写 stdout escape 序列，不注入消息、不改变任何请求行为。与 pi-resilience 无关（这是「执行完提醒我」，不是容错）。

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
  "primary": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "fallback": {
    "models": [
      { "provider": "anthropic", "model": "claude-haiku-4-5" }
    ],
    "maxAttempts": 8
  }
}
```

> **虚拟模型**：插件注册一个可选择的模型 `pi-resilience/auto`（出现在 `/model`）。选中它后，`route()` 每次请求前按电路状态选物理模型（`primary` 健康→用它；熔断→第一个健康 `fallback`）。**pi 的统计记录实际 dispatch 的物理模型**，切模型**无缝**。

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

### 失败分类（错误码优先，限量重试）

> **分类器只信数字 HTTP 状态码，不信错误文本**。文本匹配易碎（本地化/包装/改文案就漏），所以判定优先级：
>
> 1. **数字 HTTP 状态码**（executor 从 `onResponse` 拿 `resp.status`）——权威；
> 2. **结构化 body 字段**（`{"type":"failed_precondition_error","code":"9"}`，机器可读）；
> 3. **Node 网络码**（`ECONNREFUSED`/`ETIMEDOUT`/`socket hang up`）；
> 4. **文本关键词**——仅兜底（状态码/body 都拿不到时）。

| 类别 | 状态码 | 重试 | 上限 | 说明 |
|---|---|---|---|---|
| `auth` | 401 / 403 | ❌ | — | 坏凭证，重试无意义 |
| `rate-limit` | 429 | ✅ | 配置 | 配额/限流，等退避可能自愈 |
| `timeout` | 408 | ✅ | 配置 | 超时 |
| `network` | —（连接错误） | ✅ | 配置 | `ECONNREFUSED`/`ECONNRESET` 等 |
| `provider` | ≥500（500/502/503/504/524） | ✅ | 配置 | 服务端过载/内部错 |
| **`precondition`** | **400 / 409 / 422** | ✅ | **3** | **内容/前置条件/安全校验类**：`failed_precondition_error`/`safety`/`content_filter`/`moderation`。**可能自愈但重满是浪费**——同样内容大概率同样被拒，所以限量 3 次（不是傻重 40 次） |
| `abort` | — | ❌ | — | 用户取消，永不重试、不计熔断 |
| `unknown` | 其余 4xx（404/413/451…） | ❌ | — | 请求本身有问题 |

> **限量不放大**：分类器声明的 `maxAttempts`（如 precondition=3）executor **只收紧**（`min(maxAttempts, 分类器上限)`），绝不放大超配置预算。
> **分类器一票否决**：`mode:"all"` 也管不了 `auth`(401/403) 和 `unknown`——坏凭证/未知重试无意义，设计如此。

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
>
> **哪些失败计入熔断**：只有**可重试类失败**（429/5xx/网络/超时/precondition）在重试耗尽后计入熔断；`auth`(401/403)、`unknown`、用户 `abort` **不计入**（这些重试无意义，是别的层的事，熔断它们会让模型被误判死刑）。

### fallback（备用模型链）

| 字段 | 默认 | 说明 |
|---|---|---|
| `primary` | — | **主模型** `{ provider, model }`：虚拟模型 route 的首选；电路闭合时用它 |
| `fallback.models` | `[]` | 熔断后依次尝试的备用模型链 `{ provider, model }` |
| `fallback.maxAttempts` | `8` | 每个备用模型的单请求最大尝试次数 |

## 工作原理（无感 + 无缝）

```
用户选 pi-resilience/auto（虚拟模型）
  pi → route() 每请求按电路选物理模型：主健康→主；主熔断→第一个健康备用
       （continuation 且 previous 健康 → 保留 previous，prompt cache 有效）
       ↓ pi dispatch 到该物理模型（统计记这个物理模型）
  provider.stream（被我们包装）→ 静默重试 + 首字看门狗（自管）
       ↓ 重试耗尽 → 熔断该模型 → 下次 route() 自动切健康备用（无缝）
```

1. **虚拟模型 `pi-resilience/auto`**：选中后，`route()` 每次请求前按电路状态选物理模型，**pi 的统计记录实际 dispatch 的物理模型**（`provider`/`api`/`model`）——切模型**无缝 + pi 统计记对**；
2. `session_start` / `model_select` 时包装当前 provider（含全部候选），做**静默重试 + 首字看门狗**；
3. 只重试/切换「**尚未产出任何内容**」的失败（内容无法安全重放）；`committed`（已产出）直接上交；
4. **唯一硬例外**：用户 `abort` —— 尊重意志，永不重试、不计熔断失败。

### 无感
包装在请求层，内部重试，从不 `pi.sendMessage`、不注入消息、不依赖 pi 内置 retry。pi 看到的是**一条正常流**。

### 无缝（切模型）
`route()` 由 pi 在 dispatch 前调用，pi 把请求发到 route 选的物理模型——**选择（虚拟）与 dispatch（物理）分离**：用户无感，且 pi 的 assistant message / 统计记录物理模型。切到备用时透传同一个 `TranscriptContext`（完整对话）＋「内容前」事件缓冲（失败候选丢弃），无重复 `start`、无污染。

## 可见性（什么时候有字）

> 核心哲学是**无感**：重试/切换过程不注入消息、不打断对话。但「最终失败」和「非 TUI 环境」必须说人话，否则用户看到的是废纸。

| 场景 | TUI（footer 常驻状态条） | print / `--mode json`（无 footer） |
|---|---|---|
| 重试中 | ✅ footer「重试 #2/20（错误HTTP 503，等3s）」 | ❌ 静默 |
| 熔断/冷却 | ✅ footer「熔断开(还58s)」 | ❌ 静默 |
| **救回成功** | ✅ footer「(重试1)」 | ✅ **stderr** `[pi-resilience] fake/m 重试 2 次后恢复` |
| **切模型** | ✅ footer | ✅ **stderr** `[pi-resilience] 主模型 a 不可用，切到 b` |
| **最终失败** | ✅ footer | ✅ **stderr** `fake/m: 503（试 20 次 [provider]）`——带模型名/次数/分类，不再只有「所有模型均不可用」 |
| 用户取消 | ✅ `已由用户取消` | ✅ 同 |

> **stderr 不写 stdout**：`--mode json` 下 stdout 被逐行解析，塞一行会破坏 JSON。
> **TUI 判据是 `ctx.hasUI`**：print/rpc 下 `ctx.ui` 是 no-op（`setStatus` 存在但是空函数），靠「setStatus 在不在」分不清 TUI 和非交互。
> **`showStatus:false`**：footer 和 stderr 播报**都闭嘴**（用户主动关，尊重）。

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

## 测试（`bun test test/` = 73 项全绿）

```bash
bun test test/          # 一键回归：单元 + 熔断 + 执行 + 分类器 + smoke + strict
bun test test/e2e.test.ts   # 端到端：真 pi + mock-server 假供应商
```

| 文件 | 测什么 |
|---|---|
| `test/core.test.ts` | 纯函数（退避/编译文本/首字阈值） |
| `test/reliability.test.ts` | 熔断决策（closed/open/half-open，阈值/恢复） |
| `test/executor.test.ts` | 执行层（fake-stream 可控事件流：重试/看门狗/熔断/切模型） |
| `test/classify.test.ts` | 分类器码优先（status 覆盖误导文本 / IP 不误判 / body type 映射） |
| `test/strict.test.ts` | 严格/边界（极端退避/空分类/abort/并发/熔断临界/失败可见性/announce） |
| `test/smoke.test.ts` | 注册表面（API stub：虚拟模型/命令/事件注册） |
| `test/e2e.test.ts` | 端到端（真 pi + mock-server，临时 `PI_CODING_AGENT_DIR`） |

**测试哲学**（借鉴 jmcombs/pi-extensions，不 mock 外部 API）：

- **只写有意义的测试**，不为覆盖率。纯函数/熔断/执行/分类器都测**决策**，不是测实现；
- **mock-server 是失败注入**（合法）：脚本化 500/200 SSE 假供应商，测**容错**——这是插件的主业，不是 mock 外部 API；
- **strict 测试必须能「测坏」**：极端参数、边界、并发、abort，专揪真实 bug（已揪出 `computeDelay` 负指数、`multiplier=0` 退避恒 0、`ECONNREFUSED 127` 被误判成 status、全失败只说废话 4 个）；
- **端到端用 async `spawn`**（不是 `spawnSync`）：spawnSync 同步阻塞 bun 事件循环 → 同进程 mock-server 无法响应 pi 请求 → 卡死；
- **E2E 真 LLM 不写进测试**：端到端真供应商手动 `pi -e` 验，CI 里只跑 mock-server。

## 已修复的真实 bug（回归测试钉住的）

- `computeDelay` 在 `attempt=0` 时负指数减半 → 修 `max(1, attempt)`；
- `multiplier=0` 退避恒 0 → 修 `max(1, multiplier)`；
- 分类器文本抠码把 `ECONNREFUSED 127.0.0.1:443` 的 **`127` 当 HTTP 状态码** → 网络错判 `unknown`；改白名单 + 码优先；
- 全失败只说「所有模型均不可用」（候选被熔断/冷却 skip 时不留字，真实原因只在 debug 日志）→ 跳过也记原因，终末消息带模型名/次数/分类；
- stale-ctx 崩溃：wrapProvider 闭包捕获 `ctx`（reload 后 stale）→ `assertActive()` 抛 → pi 注入无 usage 错误 → footer `getSessionStats` 读 `usage.input` 崩。已根治（闭包只读 module 级 `activeCtx`，不捕获 wrap 时的 ctx）；
- pi 取消回合生成「已由用户取消」无 usage 消息 → 同崩法。已补零 usage。

## 发布（Release）

- 主路径：`git tag v0.7.2 && git push --tags`（仓库 `chentianxiong123/pi-retry-kit`）；
- 备选：`npm publish`（包名 `pi-retry-kit` 未被占用，需 `npm login`）。
