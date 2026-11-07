import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type ProviderResponse,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { hub, type ModelInfo } from "../lib/resilience.js";

// ============================================================================
// pi-retry —— 请求层无条件静默重试（包装 provider stream）
//
// 为什么需要它：
//   pi 内置 retry 用 isRetryableAssistantError 分类，insufficient_quota / quota
//   exceeded / billing 等被判定为"不可重试"，直接快速失败。但免费额度模型的上游
//   是固定时间/固定量限流，任何报错都只是"正在被限"，重试就有意义。
//
// 本扩展做什么：
//   在 session_start / model_select 时包装当前 provider 的 stream / streamSimple，
//   把每个请求包进重试循环：错误且尚未产出内容时，按退避等待后在请求层重新发起，
//   pi 和模型完全无感，不发任何消息。
//
// 重试策略（mode）：
//   - "all"        —— 一切错误都重试（默认，用户哲学"一切都重试"）
//   - "allowlist"  —— 只有命中 matchStatus / matchText 的错误才重试
//   - "denylist"   —— 命中 matchStatus / matchText 的错误不重试，其余都重试
//
// 唯一硬例外：abort —— 用户按 Esc 取消是用户意志，不是错误，永不重试。
//
// 配置：~/.pi/pi-retry.json（兼容旧 ~/.pi/retry.json、~/.pi/quota-retry.json）
// ============================================================================

type RetryMode = "all" | "allowlist" | "denylist";

interface RetryConfig {
	/** 总开关 */
	enabled: boolean;
	/** 重试策略："all" = 一切重试；"allowlist" = 只重试命中的；"denylist" = 命中的不重试 */
	mode: RetryMode;
	/** HTTP 状态码匹配（allowlist/denylist 模式下生效） */
	matchStatus: number[];
	/** 错误文本正则匹配，正则字符串数组（allowlist/denylist 模式下生效） */
	matchText: string[];
	/** 单个请求最大尝试次数（含首次），1 = 不重试 */
	maxAttempts: number;
	/** 单请求累计等待上限（ms），0 = 不限制 */
	maxTotalWaitMs: number;
	backoff: {
		/** 指数退避基础延迟（ms） */
		baseDelayMs: number;
		/** 单次等待上限（ms），含 retry-after 上限 */
		maxDelayMs: number;
		/** 指数倍数（默认 2：base, base*2, base*4, ...） */
		multiplier: number;
		/** 抖动比例 0-1（避免集体重试风暴；0 = 无抖动） */
		jitter: number;
	};
	/** 尊重服务端 retry-after 头 */
	respectRetryAfter: boolean;
	/** 上下文溢出（prompt too long）也重试（默认 true = 一切都重试） */
	retryOnOverflow: boolean;
	/** 重试期间状态栏显示进度 */
	showStatus: boolean;
}

const DEFAULT_CONFIG: RetryConfig = {
	enabled: true,
	mode: "all",
	matchStatus: [408, 429, 500, 502, 503, 504, 524],
	matchText: [
		"insufficient_quota",
		"quota.*(?:exceeded|limit|reached)",
		"out of budget",
		"rate.?limit",
		"too many requests",
		"overloaded",
		"server.?error",
		"service.?unavailable",
		"internal.?error",
		"connection.*(?:refused|lost|reset)",
		"fetch failed",
		"timeout",
		"socket hang up",
	],
	maxAttempts: 20,
	maxTotalWaitMs: 0,
	backoff: {
		baseDelayMs: 3000,
		maxDelayMs: 60000,
		multiplier: 2,
		jitter: 0.1,
	},
	respectRetryAfter: true,
	retryOnOverflow: true,
	showStatus: true,
};

const CONFIG_PATHS = [
	join(homedir(), ".pi", "pi-retry.json"),
	join(homedir(), ".pi", "retry.json"),
	join(homedir(), ".pi", "quota-retry.json"),
];

function loadConfig(): { config: RetryConfig; compiled: RegExp[] } {
	let raw: Partial<RetryConfig> | undefined;
	for (const p of CONFIG_PATHS) {
		try {
			if (existsSync(p)) {
				raw = JSON.parse(readFileSync(p, "utf8"));
				break;
			}
		} catch {
			// 损坏则尝试下一个
		}
	}
	const config = normalize(raw);
	const compiled = config.matchText.map((p) => {
		try {
			return new RegExp(p, "i");
		} catch {
			return /$^/; // 无效正则永不命中
		}
	});
	return { config, compiled };
}

/** 兼容 v0.1/v0.2 旧格式（顶层 baseDelayMs/maxDelayMs/contextOverflowFastFail） */
function normalize(raw?: Partial<RetryConfig>): RetryConfig {
	if (!raw) return structuredClone(DEFAULT_CONFIG);
	const backoff = raw.backoff ?? {};
	const cfg = {
		...DEFAULT_CONFIG,
		...raw,
		backoff: { ...DEFAULT_CONFIG.backoff, ...backoff },
	} as RetryConfig;

	// 旧格式顶层字段映射
	const legacy = raw as Record<string, unknown> & { backoff?: Record<string, unknown> };
	if (typeof legacy.baseDelayMs === "number" && legacy.backoff?.baseDelayMs === undefined) {
		cfg.backoff.baseDelayMs = legacy.baseDelayMs as number;
	}
	if (typeof legacy.maxDelayMs === "number" && legacy.backoff?.maxDelayMs === undefined) {
		cfg.backoff.maxDelayMs = legacy.maxDelayMs as number;
	}
	if (typeof legacy.contextOverflowFastFail === "boolean") {
		cfg.retryOnOverflow = !legacy.contextOverflowFastFail;
	}
	return cfg;
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
		reason: "error",
		error: {
			role: "assistant",
			stopReason: "error",
			errorMessage: message,
			content: [],
		} as unknown as AssistantMessage,
	};
}

/** 按配置判定"这个错误是否该重试" */
function shouldRetry(
	status: number | undefined,
	errorText: string,
	cfg: RetryConfig,
	compiled: RegExp[],
): boolean {
	if (cfg.mode === "all") return true;
	const hit =
		(status !== undefined && cfg.matchStatus.includes(status)) ||
		compiled.some((re) => re.test(errorText));
	return cfg.mode === "allowlist" ? hit : !hit;
}

// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const { config, compiled } = loadConfig();
	const wrappedProviders = new Set<string>();
	const stats = { attempts: 0, retried: 0, recovered: 0, gaveUp: 0 };

	/** 计算退避延迟（含抖动） */
	function computeDelay(attempt: number, retryAfterMs: number): number {
		let delay: number;
		if (config.respectRetryAfter && retryAfterMs > 0) {
			delay = retryAfterMs;
		} else {
			delay =
				config.backoff.baseDelayMs *
				config.backoff.multiplier ** Math.min(attempt - 1, 10);
		}
		delay = Math.min(delay, config.backoff.maxDelayMs);
		if (config.backoff.jitter > 0) {
			const j = config.backoff.jitter * (Math.random() * 2 - 1); // ±jitter
			delay = Math.max(0, Math.round(delay * (1 + j)));
		}
		return delay;
	}

	/**
	 * 把原 provider 的 stream 调用包进重试循环，返回一个新的
	 * AssistantMessageEventStream（官方工厂函数，用于扩展自建流）。
	 */
	function retryStream(
		produce: () => AssistantMessageEventStream,
		modelInfo: ModelInfo,
		options: StreamOptions | undefined,
		ctx: any,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		let lastRetryAfterMs = 0;
		let lastStatus: number | undefined;

		// 注入 onResponse：捕获 HTTP status 与 retry-after，供判定与退避使用
		const origOnResponse = options?.onResponse;
		const wrappedOptions = options
			? {
					...options,
					onResponse: (resp: ProviderResponse, model: Model<Api>) => {
						lastStatus = resp?.status;
						if (config.respectRetryAfter && resp?.status === 429) {
							const ra = resp.headers?.["retry-after"];
							const secs = ra ? parseInt(String(ra), 10) : NaN;
							if (Number.isFinite(secs) && secs > 0) {
								lastRetryAfterMs = Math.min(secs * 1000, config.backoff.maxDelayMs);
							}
						}
						return origOnResponse?.(resp, model);
					},
				}
			: options;

		const startedAt = Date.now();
		let attempt = 0;

		(async () => {
			try {
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

				// 唯一硬例外：用户取消 → 尊重意志，永不重试
				if (options?.signal?.aborted) {
					out.push(lastErrorEvent);
					return;
				}
				// 上下文溢出按配置（默认重试；设 retryOnOverflow=false 则快速失败给 compaction）
				if (!config.retryOnOverflow && isContextOverflowText(errText)) {
					out.push(lastErrorEvent);
					return;
				}
				// 策略判定：什么情况重试 / 哪些重试
				if (!shouldRetry(lastStatus, errText, config, compiled)) {
					stats.gaveUp++;
					out.push(lastErrorEvent);
					return;
				}
				if (attempt >= config.maxAttempts) {
					stats.gaveUp++;
					if (modelInfo) hub.noteExhausted(modelInfo, errText, attempt);
					out.push(lastErrorEvent);
					return;
				}
				if (config.maxTotalWaitMs > 0 && Date.now() - startedAt >= config.maxTotalWaitMs) {
					stats.gaveUp++;
					if (modelInfo) hub.noteExhausted(modelInfo, errText, attempt);
					out.push(lastErrorEvent);
					return;
				}

				// ---- 退避等待后重试 ----
				const delay = computeDelay(attempt, lastRetryAfterMs);
				stats.retried++;
				if (config.showStatus) {
					const statusHint = lastStatus !== undefined ? ` (HTTP ${lastStatus})` : "";
					ctx.ui.setStatus(
						"pi-retry",
						`静默重试 #${attempt}${statusHint}（等 ${Math.round(delay / 1000)}s）`,
					);
				}
				await sleep(delay, options?.signal);
				if (options?.signal?.aborted) {
					out.push(lastErrorEvent);
					return;
				}
				}
			} finally {
				// 流结束（无论成败）：清除状态栏残留
				if (config.showStatus) ctx.ui.setStatus("pi-retry", undefined);
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
			base.stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				retryStream(
					() => origStream.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					options,
					ctx,
				);
		}
		if (origSimple) {
			base.streamSimple = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				retryStream(
					() => origSimple.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					options,
					ctx,
				);
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
	pi.registerCommand("pi-retry", {
		description: "Show pi-retry config & session stats",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`pi-retry: ${config.enabled ? "on" : "off"} | mode=${config.mode} | ` +
					`maxAttempts=${config.maxAttempts} | base=${config.backoff.baseDelayMs}ms x${config.backoff.multiplier} ` +
					`max=${config.backoff.maxDelayMs}ms jitter=${config.backoff.jitter} | ` +
					`overflow=${config.retryOnOverflow ? "retry" : "fast-fail"}` +
					(config.mode !== "all"
						? ` | ${config.mode === "allowlist" ? "仅重试" : "不重试"}: ` +
							`status[${config.matchStatus.join(",")}] text[${config.matchText.join(" | ")}]`
						: "") +
					` | 本会话：请求 ${stats.attempts}，重试 ${stats.retried}，救回 ${stats.recovered}，放弃 ${stats.gaveUp}`,
				"info",
			);
		},
	});
}