import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// retry —— 请求层无条件静默重试（包装 provider stream）
//
// 为什么需要它：
//   pi 内置 retry 用 isRetryableAssistantError 分类，insufficient_quota / quota
//   exceeded / billing 等被判定为"不可重试"，直接快速失败。但免费额度模型的上游
//   是固定时间/固定量限流，任何报错都只是"正在被限"，重试就有意义。
//
// 本扩展做什么：
//   在 session_start / model_select 时包装当前 provider 的 stream / streamSimple，
//   把每个请求包进一个重试循环：遇到任何 error 事件（429 / 5xx / 网络 / 超时 /
//   insufficient_quota / quota exceeded / context overflow / ...）且尚未产出内容时，
//   按退避等待后在请求层重新发起，pi 和模型完全无感，不发任何消息。
//
// 唯一的硬例外：abort —— 用户按 Esc 取消是用户意志，不是错误，尊重并立即停止。
//
// 配置：~/.pi/retry.json（向后兼容：不存在时回退读取 ~/.pi/quota-retry.json）
// ============================================================================

interface QuotaRetryConfig {
	/** 总开关 */
	enabled: boolean;
	/** 单个请求的最大尝试次数（含首次）。1 = 不重试 */
	maxAttempts: number;
	/** 指数退避基础延迟（ms） */
	baseDelayMs: number;
	/** 单次等待上限（ms），含 retry-after 上限 */
	maxDelayMs: number;
	/** 单请求累计等待上限（ms），0 = 不限制 */
	maxTotalWaitMs: number;
	/** 尊重服务端 retry-after 头 */
	respectRetryAfter: boolean;
	/** 上下文溢出（prompt too long）也进入重试循环；true 则快速失败交给 compaction */
	contextOverflowFastFail: boolean;
	/** 重试期间在状态栏显示进度 */
	showStatus: boolean;
}

const DEFAULT_CONFIG: QuotaRetryConfig = {
	enabled: true,
	maxAttempts: 20,
	baseDelayMs: 3000,
	maxDelayMs: 60000,
	maxTotalWaitMs: 0,
	respectRetryAfter: true,
	contextOverflowFastFail: false, // 一切都重试（默认；如遇 prompt too long 空转可关掉此项）
	showStatus: true,
};

const CONFIG_PATH = join(homedir(), ".pi", "retry.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "quota-retry.json");

function loadConfig(): QuotaRetryConfig {
	try {
		const primary = existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH;
		if (existsSync(primary)) {
			const raw = JSON.parse(readFileSync(primary, "utf8")) as Partial<QuotaRetryConfig>;
			return { ...DEFAULT_CONFIG, ...raw };
		}
	} catch {
		// 配置损坏时用默认值
	}
	return { ...DEFAULT_CONFIG };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

const CONTEXT_OVERFLOW_PATTERN =
	/prompt.*(?:too long|exceeds|is longer)|context.*(?:length|limit|exceeded)|max.*(?:token|context)|token.*(?:limit|exceeded)|input.*too long|maximum context/i;

function isContextOverflowText(text: string): boolean {
	return CONTEXT_OVERFLOW_PATTERN.test(text);
}

function makeErrorEvent(message: string): AssistantMessageEvent {
	return {
		type: "error",
		error: {
			role: "assistant",
			stopReason: "error",
			errorMessage: message,
			content: [],
		} as unknown as AssistantMessage,
	};
}

// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const wrappedProviders = new Set<string>();
	const stats = { attempts: 0, retried: 0, recovered: 0, gaveUp: 0 };

	/**
	 * 把原 provider 的 stream 调用包进重试循环，返回一个新的
	 * AssistantMessageEventStream（官方工厂函数，用于扩展自建流）。
	 */
	function retryStream(
		produce: () => AssistantMessageEventStream,
		options: StreamOptions | undefined,
		ctx: any,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		let lastRetryAfterMs = 0;

		// 注入 onResponse：捕获 429 的 retry-after，供退避决策使用
		const origOnResponse = options?.onResponse;
		const wrappedOptions = options
			? {
					...options,
					onResponse: (resp: ProviderResponse, model: unknown) => {
						if (config.respectRetryAfter && resp?.status === 429) {
							const ra = resp.headers?.["retry-after"];
							const secs = ra ? parseInt(String(ra), 10) : NaN;
							if (Number.isFinite(secs) && secs > 0) {
								lastRetryAfterMs = Math.min(secs * 1000, config.maxDelayMs);
							}
						}
						return origOnResponse?.(resp, model);
					},
				}
			: options;

		const startedAt = Date.now();
		let attempt = 0;

		(async () => {
			while (true) {
				attempt++;
				stats.attempts++;
				let emitted = false;
				let lastErrorEvent: AssistantMessageEvent | undefined;

				try {
					const src = produce();
					for await (const ev of src) {
						if (ev.type === "done") {
							if (attempt > 1) stats.recovered++;
							out.push(ev);
							return;
						}
						if (ev.type === "error") {
							lastErrorEvent = ev;
							// 已经产出过真实内容（流中途断）：无法安全重试，直接上交错误
							if (emitted) {
								out.push(ev);
								return;
							}
							break; // 未产出内容 → 进入重试决策
						}
						if (
							ev.type === "text_delta" ||
							ev.type === "thinking_delta" ||
							ev.type === "toolcall_delta"
						) {
							emitted = true;
						}
						out.push(ev);
					}
					if (!lastErrorEvent) {
						out.end(); // 迭代自然结束（正常流都会有 done/error 终端事件）
						return;
					}
				} catch (err) {
					// 迭代异常（多为网络/传输层错误，如 connection refused、timeout）
					const msg = err instanceof Error ? err.message : String(err);
					if (emitted) {
						out.end(); // 已有部分输出，无法重试
						return;
					}
					lastErrorEvent = makeErrorEvent(msg);
				}

				// ---- 重试决策 ----
				const errText =
					lastErrorEvent.type === "error"
						? (lastErrorEvent.error.errorMessage ?? "")
						: "";

				// 可选项：上下文溢出快速失败（默认关闭 —— 一切都重试。若配置开启，
				// prompt too long 会立即上交，由 pi 的 compaction 机制恢复）
				if (config.contextOverflowFastFail && isContextOverflowText(errText)) {
					out.push(lastErrorEvent);
					return;
				}
				// 唯一硬例外：用户取消 → 尊重意志，不再重试
				if (options?.signal?.aborted) {
					out.push(lastErrorEvent);
					return;
				}
				if (attempt >= config.maxAttempts) {
					stats.gaveUp++;
					out.push(lastErrorEvent);
					return;
				}
				if (config.maxTotalWaitMs > 0 && Date.now() - startedAt >= config.maxTotalWaitMs) {
					stats.gaveUp++;
					out.push(lastErrorEvent);
					return;
				}

				// ---- 退避等待后重试 ----
				const delay =
					config.respectRetryAfter && lastRetryAfterMs > 0
						? lastRetryAfterMs
						: Math.min(config.baseDelayMs * 2 ** Math.min(attempt - 1, 6), config.maxDelayMs);
				stats.retried++;
			if (config.showStatus) {
					ctx.ui.setStatus(
						"retry",
						`上游不稳定，静默重试 #${attempt}（等 ${Math.round(delay / 1000)}s）`,
					);
				}
				await sleep(delay, options?.signal);
				if (options?.signal?.aborted) {
					out.push(lastErrorEvent);
					return;
				}
			}
		})().catch(() => {
			out.end();
		});

		return out;
	}

	/** 包装指定 provider：覆盖 stream / streamSimple，注册回 registry */
	function wrapProvider(providerId: string | undefined, ctx: any) {
		if (!config.enabled || !providerId || wrappedProviders.has(providerId)) return;
		const base = ctx.modelRegistry.getProvider(providerId);
		if (!base) return;

		const origStream = base.stream;
		const origSimple = base.streamSimple;
		if (!origStream && !origSimple) return;

		if (origStream) {
			base.stream = (model: unknown, context: unknown, options?: StreamOptions) =>
				retryStream(() => origStream.call(base, model, context, options), options, ctx);
		}
		if (origSimple) {
			base.streamSimple = (model: unknown, context: unknown, options?: StreamOptions) =>
				retryStream(() => origSimple.call(base, model, context, options), options, ctx);
		}

		pi.registerProvider(base);
		wrappedProviders.add(providerId);
	}

	// ---- 会话开始 / 模型切换时包装当前 provider ----
	pi.on("session_start", async (_event, ctx) => {
		wrapProvider(ctx.model?.provider, ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		wrapProvider(event.model?.provider, ctx);
	});

	// ---- 状态/统计命令 ----
	pi.registerCommand("retry", {
		description: "Show retry config & session stats",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`retry: ${config.enabled ? "on" : "off"}` +
					`（maxAttempts=${config.maxAttempts}, baseDelay=${config.baseDelayMs}ms, maxDelay=${config.maxDelayMs}ms, overflowFastFail=${config.contextOverflowFastFail}）` +
					` | 本会话：请求 ${stats.attempts}，重试 ${stats.retried}，救回 ${stats.recovered}，放弃 ${stats.gaveUp}`,
				"info",
			);
		},
	});
}
