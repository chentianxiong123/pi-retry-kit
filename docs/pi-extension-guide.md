# pi 插件制作思路 —— 从 pi-resilience 实战沉淀

> 日期：2026-11-07
> 主题：给 pi 编码代理写一个「请求层静默重试 + 首字看门狗 + 熔断 + 自动切模型」插件，把整个摸索过程（结构、工具、坑、决策）变成可复现手册。
> 仓库：`https://github.com/chentianxiong123/pi-retry-kit`（单插件 `extensions/pi-resilience.ts`，v0.5.0+）

---

## ① 目标与动机

给 pi 写一个**请求层**插件：某个模型抽风（网络错 / 5xx / 429 / 配额 / 首字超时）时，**静默重试**，重试耗尽即**熔断**该模型，并**自动切到备用模型**继续（同一回合，不失败）。核心哲学是**无感 + 无缝**：

- **无感**：不注入消息、不用 `pi.sendMessage`、不依赖 pi 内置 retry —— 模型和 pi 全程无感知，对话流「看起来就是一条正常流」；
- **无缝**：切模型时透传同一个对话上下文（`TranscriptContext`），备用模型接着写，不重复 `start`、不污染输出。

最终归一成**一个插件 `pi-resilience`**（一开始是 pi-retry / pi-ttft / pi-breaker 三个独立扩展，后来合并），因为三者共享同一套熔断器/配置/统计，耦合成一个系统才自洽。

---

## ② 资源拓扑（pi 扩展机制 —— 本次最大成果）

pi（`@earendil-works/pi-coding-agent` v1.4.0）的扩展机制，摸出来是这么一张地图：

### 扩展怎么被发现 / 加载

```
pi 启动
  └─ discoverExtensionsInDir()
       ├─ <agent-dir>/extensions/           ← 用户扩展目录（~/.pi/agent/extensions/）
       │    ├─ 直接 .ts/.js 文件 → 加载
       │    └─ 子目录：
       │         ├─ 读 package.json 的 pi.extensions[] → 加载列出的文件   ← 本包用这个
       │         └─ 无则找 index.ts / index.js
       ├─ .pi/extensions/                    ← 项目扩展目录
       └─ settings.packages / --extension    ← 包管理 / 命令行
```

- `~/.pi/agent` 在我机器上是 symlink → `/mnt/shared/.pi/agent`，所以实际扩展目录是 `/mnt/shared/.pi/agent/extensions/`；
- **本地开发最简单**：把整个仓库目录放进 `extensions/`（或 symlink 过去），pi 读它的 `package.json` → `pi.extensions: ["./extensions/pi-resilience.ts"]` 自动加载。

### 扩展文件形态

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 运行时依赖 @earendil-works/pi-ai（createAssistantMessageEventStream 等）+ node:fs/path/os
export default function (pi: ExtensionAPI) {
  // 在这里注册：事件、命令、虚拟模型、包装 provider……
}
```

- 工厂可以 `async`，pi 会等它完成再继续启动；
- 工厂里**不要**起进程/定时器/监听（有些调用加载扩展但不开会话）——长驻资源放 `session_start`，结束放 `session_shutdown`。

### 依赖解析（jiti + alias/virtualModules）—— 关键

pi 用 **jiti** 加载扩展（本地 TS 不用编译）。运行时 import `@earendil-works/pi-ai` 能否解析，取决于 pi 是哪种构建：

```js
// pi 源码 loadExtensionModule()
let resolutionOptions = usesEmbeddedModules
  ? { virtualModules: await getVirtualModules(), tryNative: !1 }   // bundled 二进制 → virtualModules
  : isTypeScriptSourceRuntime
  ? { virtualModules, tsconfigPaths: !0 }
  : { alias: getAliases() };                                        // 源码跑 → alias 映射
```

- 我装的 `pi`（`dist/bundle/cli.js`）是 **bundled** → `usesEmbeddedModules = true` → 走 **virtualModules**；
- `virtual-modules-*.js` 里映射了 `"@earendil-works/pi-ai": compat_exports`、`pi-ai/models`、`pi-ai/providers/all` 等；
- 所以扩展里 `import {...} from "@earendil-works/pi-ai"` **能解析**（pi 提供），扩展目录里**不需要** node_modules。

### 官方一等公民 API（本次用到的）

| API | 用途 |
|---|---|
| `pi.registerVirtualModel({provider,id,name,thinkingLevels,route})` | **虚拟模型**：选模型与 dispatch 分离，route 每请求选物理模型 |
| `pi.on("session_start"/"model_select"/"turn_end"/"session_before_switch|shutdown|fork|compact", ...)` | 生命周期事件 |
| `pi.registerCommand("pi-resilience", {description, handler})` | `/pi-resilience` 命令（`ctx.ui.notify()` 弹状态） |
| `ctx.ui.setStatus(key, text)` | **footer 常驻状态条**（不注入消息） |
| `ctx.modelRegistry.find(provider, model)` / `.getProvider()` | 查模型 / provider |
| `ctx.ui.notify(msg, "info")` | 弹通知 |

### 虚拟模型 route() 的入参 / 返回（types: `dist/core/virtual-models.d.ts`）

```ts
route(request, ctx) => { model: Model<Api>, thinkingLevel, state? }
// request:
//   model        选中的虚拟模型
//   thinkingLevel 请求的思考级别
//   reason       "user" | "continuation" | "retry" | "direct"
//   previous     { model, thinkingLevel? }  上一个成功响应的物理模型（保持 prompt cache）
//   failed?      { model, thinkingLevel?, message }  retry 时失败的物理模型 + errorMessage
//   state        上次 route 返回的跨请求状态
//   messages     完整对话（含 system）
//   signal       AbortSignal
```

**route() 是切模型的正解**：pi 分开「选择（虚拟）」和「dispatch（物理）」，assistant message 记录**实际 dispatch 的物理模型** → **pi 统计天然记对**，用户无感。

### provider 请求层包装（重试/看门狗入口）

```ts
// wrapProvider(providerId, ctx)：
//   保存 origStream = base.stream（防递归）
//   覆盖 base.stream = (model, context, options) =>
//     resilienceStream(() => origStream.call(base, model, context, options), model, context, options, ctx)
// resilienceStream 里用 createAssistantMessageEventStream() 造一个「代理流」，
//   内部自己 for await 原始流、重试、缓冲「内容前」事件、透传同一 context。
```

---

## ③ 工具链清单

| 工具 | 版本 | 用途 | 关键命令 |
|---|---|---|---|
| pi | 1.4.0 | 宿主（加载扩展） | `pi --print "..."`、`pi --print --mode json --model pi-resilience/auto "..."` |
| bun | 当前 | 构建/跑 TS | `bun build extensions/pi-resilience.ts --external '@earendil-works/*' --external 'node:*' --target=bun` |
| tsc | 严格 | 类型检查 | `tsc -p tsconfig.check.json`（paths 指向 pi 的 .d.ts） |
| jiti | pi 内建 | 加载扩展 | 无需单独装 |
| git | — | 版本管理 | tag / push |

**tsconfig 检查要点**（严格 + paths 指向宿主的类型）：

```json
{ "compilerOptions": { "target":"ES2022","module":"ESNext","moduleResolution":"Bundler",
  "strict":true,"noEmit":true,"skipLibCheck":true,"types":[],
  "paths":{
    "@earendil-works/pi-coding-agent":["/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts"],
    "@earendil-works/pi-ai":["/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.d.ts"] } },
  "include":["extensions/*.ts","lib/*.ts"] }
```

**装到用户环境的正确姿势**：

```bash
# 单一来源（推荐）：扩展目录 symlink 到仓库，改仓库即生效
rm -rf ~/.pi/agent/extensions/pi-retry-kit
ln -s /mnt/shared/.pi/agent/git/github.com/chentianxiong123/pi-retry-kit ~/.pi/agent/extensions/pi-retry-kit
# 配置
~/.pi/pi-resilience.json   # 分节 retry/ttft/breaker/fallback，每节可独立开关
```

---

## ④ 成功路径（可复现步骤）

**做一个能加载的 pi 插件的最小闭环**：

```bash
# 1) 仓库里放 extensions/xxx.ts，export default function(pi){...}
# 2) package.json 加：
#    "pi": { "extensions": ["./extensions/xxx.ts"] },
#    "peerDependencies": { "@earendil-works/pi-ai":"*", "@earendil-works/pi-coding-agent":"*" }
# 3) symlink 或复制到 ~/.pi/agent/extensions/<pkg>/
# 4) 验证加载（print mode，走一次真实小请求）：
pi --print "Reply with exactly: OK"
# 5) 验证虚拟模型 route：
pi --print --mode json --model pi-resilience/auto "Reply with exactly: OK"
#    看输出 NDJSON 里 assistant 消息的 provider/model = 实际 dispatch 的物理模型
# 6) 严格类型 + 构建：
tsc -p tsconfig.check.json && bun build extensions/pi-resilience.ts --external '@earendil-works/*' --external 'node:*' --target=bun
# 7) 交互验证（TUI）：/model 选 pi-resilience/auto → footer 秒表 + 状态条
```

**本插件的请求级联（核心逻辑）**：

```
用户选 pi-resilience/auto（虚拟模型）
  pi → route() 每请求按电路选物理模型：
        主健康 → 主；主熔断 → 第一个健康备用
        continuation 且 previous 健康 → 保留 previous（prompt cache）
        retry → 跳过失败模型
       ↓ pi dispatch 到该物理模型（assistant message 记这个物理模型）
  provider.stream（被我们包装）→ 静默重试 + 首字看门狗（同一循环，自管）
       ↓ 重试耗尽 → 熔断该模型 → 下次 route() 自动切健康备用
```

关键实现细节：

- **候选链** `[被派发模型, ...其余候选]`（primary + fallbacks，去重）—— wrapper 与 route 共享同一顺序，防循环；
- **同一循环做两件事**：错误重试（retry）+ 首字超时看门狗（ttft）。失败未产出内容才重试；`committed`（已产出）直接上交；
- **内容前事件缓冲**：`start`/空 `text_start` 等先缓冲，失败候选丢弃、成功候选才放行 → 避免重复 `start`/污染；
- **熔断语义**：`failureThreshold=1`（重试耗尽 = 判死刑）；只有**可重试类**失败（network/5xx/429/timeout/配额）计熔断，**400/鉴权/未知不熔断**（换模型也没用）；
- **用户 abort 永不重试、不计熔断**（尊重意志）。

---

## ⑤ 踩坑记录（最有价值）

### 坑 1：秒表 setInterval 捕获 stale ctx → pi 大崩溃 ⚠️ 最严重

- **现象**：TUI 里 `/reload` / 会话切换后，pi 崩溃，报 `Cannot read properties of undefined (reading 'input')`；
- **根因**：footer 秒表 `setInterval(() => updateFooter(ctx), 500)` **闭包捕获了旧 ctx**。session 替换后定时器还在跑，去调**已失效（stale）的 `ctx.ui.setStatus`** → pi 注入一条**无 usage 的 assistant error 消息** → pi 的 `getSessionStats` 遍历到它时对 `usage` 无守卫 → 崩溃；
- **解法**（三件套，缺一不可）：
  1. **`footerCtx` 引用**替代闭包捕获：`footerCtx = ctx`，定时器只调 `updateFooter()`（用最近有效 ctx），事件回调才传显式 `ctx`；
  2. **`updateFooter` 包 try/catch**：stale 时静默放弃，绝不触碰失效 ctx；
  3. **`disposeTurnTimer()`** 绑定 `session_before_switch / shutdown / fork / compact`——会话生命周期变化时**彻底清定时器 + 引用**（根治）。

### 坑 2：改 models.json 的 baseUrl 造失败 → 得到 401 而非连接失败（污染熔断测试）

- **现象**：把 `cpa` 的 baseUrl 改成 `http://127.0.0.1:1/v1`（不通），本想造「连接失败 → 熔断」，结果请求返回 `401: {"code":16,"message":"Forbidden"}`（商汤风格），不是连接失败；
- **根因**：cpa 是「商汤 token 网关」类 provider，baseUrl 变化触发了**鉴权层**重新校验，返回 401；且 401 被 classify 判为**不可重试**（鉴权）→ 不熔断、不切换——**完全测不到想测的熔断路径**；
- **教训**：造「确定性失败」别改 baseUrl/apiKey 这类**鉴权相关**配置，会 401；用**会挂起/超时的模型**（首字看门狗触发）或**真实断网**更可靠。而且 401 不切换本身**符合设计**（鉴权错误换模型也没用）。

### 坑 3：`pi --help` 不加载扩展

- **现象**：想用 `pi --help` 验证扩展加载，看不到扩展命令/报错；
- **根因**：`--help` 快速返回，不跑扩展加载流程；
- **解法**：用 `pi --print "..."`（真实小请求）或 `--mode json` 验证；扩展加载失败会在 stderr 打 `Failed to load extension`。

### 坑 4：`--print` 默认用 defaultModel，不走 route

- **现象**：`pi --print "..."` 走的是 settings 里 `defaultModel`（物理模型），**不会**走虚拟模型 route；
- **解法**：必须 `--model pi-resilience/auto` 才触发 route；用 `--mode json` 看 NDJSON 里 assistant 消息的 `provider/model` 确认实际 dispatch 的物理模型。

### 坑 5：print mode 没有 footer（setStatus 不存在）

- **现象**：`--print` 下 `ctx.ui.setStatus` 不存在，秒表逻辑空转；
- **解法**：`updateFooter` 先判 `if (!config.showStatus || !target?.ui?.setStatus) return;` 安全跳过；**秒表的跳动只能在 TUI 里肉眼验证**，print mode 只能验证「不崩 + 回合正常」。

### 坑 6：旧包声明与新插件双加载

- **现象**：settings.json 里残留 `packages: ["git:...pi-retry@v0.3.1"]`（改名前的旧仓库），可能和新插件同时加载、冲突；
- **解法**：装新插件时从 `settings.packages` 移除旧声明（备份后改），避免双加载。

### 坑 7：扩展目录「复制」会不同步

- **现象**：改仓库里的 `.ts`，扩展目录还是旧副本 → 改了没生效；
- **解法**：**symlink 扩展目录 → 仓库**（单一来源），改仓库即生效，永不不同步。

---

## ⑥ 验证成果（证据）

- `tsc` 严格检查：`exit=0`；
- `bun build`：OK；
- `pi --print "Reply with exactly: PONG"` → `PONG`（扩展加载成功 + 包装不破坏请求）；
- `pi --print --mode json --model pi-resilience/auto "..."` → NDJSON 里 assistant 消息 `provider=sensenova, model=sensenova-6.8-flash-lite`（**route 选主模型生效 + pi 统计记物理模型**）；
- **熔断后自动切备用**：同一进程两个 turn，turn1 主模型失败，turn2 assistant 消息 `provider=sensenova`（备用）——**route 熔断后切备用**；
- 注意：熔断状态在**内存**，跨 `--print` 进程不保留（每个 --print 是新进程，测跨请求切换需同一进程多 turn 或交互会话）。

---

## ⑦ 决策记录

| 决策点 | 选了 | 为什么 / 否决了什么 |
|---|---|---|
| 切模型机制 | **官方虚拟模型 `route()`** | 否决了 `pi.setModel` hack（turn_end 显式切换：UI 可见但那单 usage 记主模型、统计不准）。route() 是官方一等公民，**选择（虚拟）与 dispatch（物理）分离**，assistant message 记物理模型 → 统计天然对、用户无感 |
| 重试归属 | **自管重试循环**（请求层包装） | 不依赖 pi 内置 retry；不注入消息（pi-quiver 的 provider-stall-watchdog 会 `sendMessage` 注入合成消息，违反无感） |
| 熔断语义 | `failureThreshold=1` + **只可重试类计熔断** | 重试耗尽 = 模型判死刑，一次即熔断；400/鉴权/未知不熔断（换模型无用） |
| 模块形态 | **一仓一包单插件**（归一 pi-resilience） | 最初 pi-retry/pi-ttft/pi-breaker 三扩展，后归一——三者共享熔断器/配置/统计，耦合成一个系统才自洽 |
| 切模型可见性 | 容忍非无缝 → **route 无缝** | 先接受 `setModel` 可见切换，后找到官方 route 无缝钩子，推翻 |
| 验证方式 | `--print`/`--mode json` 一次性 | `--help` 无效；TUI 秒表只能肉眼 |

---

## ⑧ 未解之谜 / 下一步岔路

- **熔断状态不持久**：电路状态在内存，重启 pi 丢失。可做「熔断状态持久化」（写 `~/.pi/pi-resilience-state.json`，启动恢复）——让跨进程/重启仍记得哪个模型熔断；
- **TUI 秒表跳动未亲眼验证**：print mode 无 footer，我只验证了「不崩 + 回合正常」，TUI 里的跳动效果需要用户在交互会话里确认；
- **如何可靠触发真实熔断**：改 baseUrl 会 401（鉴权不熔断），挂起模型慢——真实场景是网络故障/配额，测试环境难复现；
- **wrapper 同请求切换 vs route 下一请求切换**：route 主要负责「下一请求」切换；pi 内置 retry 触发 `route(reason="retry")` 时也能同请求切。配额类（pi 不重试）→ wrapper 静默重试耗尽 → 该请求失败 → 下一请求 route 用备用。这里「过渡请求失败」是已知取舍；
- **`session_before_*` 事件的完整清单**：只用了 switch/shutdown/fork/compact，其他会 invalidate ctx 的事件（如 reload）需继续确认。

---

## 一句话总结

> pi 插件 = `export default function(pi)` + 在 `extensions/` 目录（symlink 到仓库）里被 jiti 加载；**选模型用官方 `registerVirtualModel().route()`（无缝 + 统计记对），重试用请求层包装 provider.stream（静默）**；**凡是异步闭包捕获 ctx，一律改用「最近有效 ctx」+ 生命周期 dispose**——这是这次最大的坑。
