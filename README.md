# pi-extension-quota-retry

无条件静默重试的 pi 扩展 —— 在 **provider 请求层**对上游一切错误自动重试，
绕过 pi 内核"配额类错误不可重试"的判定，模型和 pi 全程无感知，**不发任何消息**。

> 适用场景：免费额度模型（固定时间/固定量限流）。任何报错都只是"正在被限"，
> 重试就有意义。瞬时错误、429、`insufficient_quota`、`quota exceeded`、5xx、
> 网络中断……一律静默重试，直到成功或达到配置上限。

## 安装

```bash
# git（推荐，tag 钉版本）
pi install git:github.com/chentianxiong123/pi-extension-quota-retry@v0.1.0

# 或本地路径
pi install /path/to/pi-extension-quota-retry
```

安装后 `/reload` 生效。检查状态：`/quota-retry`

## 配置

`~/.pi/quota-retry.json`（不存在则用默认值）：

```json
{
  "enabled": true,
  "maxAttempts": 20,
  "baseDelayMs": 3000,
  "maxDelayMs": 60000,
  "maxTotalWaitMs": 0,
  "respectRetryAfter": true,
  "contextOverflowFastFail": true,
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
| `contextOverflowFastFail` | `true` | prompt 太长类错误快速失败（不重试，交给 pi 的 compaction 恢复） |
| `showStatus` | `true` | 重试期间状态栏显示进度 |

## 工作原理

1. `session_start` / `model_select` 时通过 `ctx.modelRegistry.getProvider()` 拿到当前 provider
2. 覆盖其 `stream` / `streamSimple`：把每个请求包进重试循环，产出新的
   `AssistantMessageEventStream`（官方 `createAssistantMessageEventStream` 工厂）
3. 错误事件（429 / quota / 5xx / 网络）且**尚未产出任何内容** → 退避等待后在
   请求层重新发起；已产出内容（流中途断）不重试，直接上交
4. `pi.registerProvider()` 注册回 registry，对 pi 透明

### 硬例外（不做无脑重试）

- **用户取消（abort）** —— 尊重用户意志，立即停止
- **上下文溢出（prompt too long）** —— 重试无效，快速失败交给 pi 的 compaction

## 开发

```bash
# 类型/语法检查（pi 运行时通过 loader aliases 解析捆绑的 pi-ai，无需本地安装）
bun build src/index.ts --external '@earendil-works/*' --external 'node:*' --target=bun
```

## License

MIT