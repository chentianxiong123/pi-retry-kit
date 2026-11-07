import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// pi-ttft —— 首字（time-to-first-token）看门狗：请求层静默重试
//
// 为什么需要它：
//   pi 内置 retry 只按"错误"分类重试，处理不了"请求没报错、但半天不吐第一个字"的
//   情况（上游排队/冷启动/链路慢）。这类问题不产生任何错误事件，pi 只能干等。
//   pi-quiver 的 provider-stall-watchdog 用时间检测，但借 pi 内置 retry 实现：会
//   pi.sendMessage 注入一条合成消息、预算默认仅 3 次。本扩展把同一思想搬到
//   provider 请求层，做到无感：
//
// 本扩展做什么：
//   在 session_start / model_select 时包装当前 provider 的 stream / streamSimple：
//   若首个真实内容事件（text/thinking/toolcall delta，非空）在 firstTokenTimeoutMs 内
//   未出现，则 abort 当前请求流，按退避等待后在请求层重新发起。pi 和模型全程无感，
//   不发任何消息，不依赖 pi 内置 retry。
//
// 比 provider-stall-watchdog 更强（无感重试）：
//   - 完全静默：不 pi.sendMessage、不注入合成消息、不依赖 pi 内置 retry
//   - 自己管重试循环：预算更高（maxAttempts 默认 20，watchdog 默认 3）
//   - 可配退避（base/max/multiplier/jitter）+ 按模型 glob 覆盖首字阈值
//   - 额外处理"空响应"（流结束仍无内容）—— 同样可安全静默重试
//
// 安全边界：只有"尚未产出任何内容"才能静默重试（内容无法安全重放）。
//   首字超时 / 空响应都满足；流中途断（已产出）不重试，直接上交。
//
// 唯一硬例外：用户 abort —— 尊重用户意志，永不重试。
//
// 配置：~/.pi/pi-ttft.json
// ============================================================================

type ModelInfo = { provider: string; id: string } | undefined;

interface TtftConfig {
	/** 总开关 */
	enabled: boolean;
	/** 首字超时阈值（ms）：超过则 abort 当前请求并静默重试 */
	firstTokenTimeoutMs: number;
	/** 流正常结束但从未产出内容（空响应）也静默重试 */
	retryOnEmpty: boolean;
	/** 单个请求最大尝试次数（含首次），1 = 不重试 */
	maxAttempts: number;
	/** 单请求累计等待上限（ms），0 = 不限制 */
	maxTotalWaitMs: number;
	backoff: {
		/** 指数退避基础延迟（ms） */
		baseDelayMs: number;
		/** 单次等待上限（ms） */
		maxDelayMs: number;
		/** 指数倍数 */
		multiplier: number;
		/** 抖动比例 0-1（0 = 无抖动） */
		jitter: number;
	};
	/** 按模型 glob 覆盖首字阈值，如 { "anthropic/claude*": { firstTokenTimeoutMs: 45000 } } */
	models: Record<string, { firstTokenTimeoutMs?: number }>;
	/** 重试期间状态栏显示进度 */
	showStatus: boolean;
}

const DEFAULT_CONFIG: TtftConfig = {
	enabled: true,
	firstTokenTimeoutMs: 20_000,
	retryOnEmpty: true,
	maxAttempts: 20,
	maxTotalWaitMs: 0,
	backoff: {
		baseDelayMs: 2_000,
		maxDelayMs: 60_000,
		multiplier: 2,
		jitter: 0.1,
	},
	models: {},
	showStatus: true,
};

const CONFIG_PATH = join(homedir(), ".pi", "pi-ttft.json");

function loadConfig(): { config: TtftConfig; compiledModels: Array<{ re: RegExp; firstTokenTimeoutMs?: number }> } {
	let raw: Partial<TtftConfig> | undefined;
	try {
		if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		// 损坏则用默认
	}
	const config = normalize(raw);
	const compiledModels = Object.entries(config.models).map(([pattern, ov]) => ({
		re: modelPattern(pattern),
		firstTokenTimeoutMs: ov?.firstTokenTimeoutMs,
	}));
	return { config, compiledModels };
}

function normalize(raw?: Partial<TtftConfig>): TtftConfig {
	if (!raw) return structuredClone(DEFAULT_CONFIG);
	const backoff = raw.backoff ?? {};
	const models = raw.models ?? {};
	return {
		...DEFAULT_CONFIG,
		...raw,
		backoff: { ...DEFAULT_CONFIG.backoff, ...backoff },
		models: { ...models },
	} as TtftConfig;
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

/** glob -> 正则：`*` 匹配任意串，大小写不敏感（同 provider-stall-watchdog） */
function modelPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

/** 按模型（provider/id）取首字阈值：先匹配 models glob，未命中用全局 */
function firstTokenTimeoutFor(
	config: TtftConfig,
	compiled: Array<{ re: RegExp; firstTokenTimeoutMs?: number }>,
	model: ModelInfo,
): number {
	if (model) {
		const label = `${model.provider}/${model.id}`;
		for (const { re, firstTokenTimeoutMs } of compiled) {
			if (re.test(label)) return firstTokenTimeoutMs ?? config.firstTokenTimeoutMs;
		}
	}
	return config.firstTokenTimeoutMs;
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

/** "第一个真实 token"：非空 text/thinking/toolcall delta（空 delta 只是流脚手架） */
function isFirstTokenEvent(ev: AssistantMessageEvent): boolean {
	return (
		(ev.type === "text_delta" ||
			ev.type === "thinking_delta" ||
			ev.type === "toolcall_delta") &&
		((ev as { delta?: string }).delta?.length ?? 0) > 0
	);
}

// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const { config, compiledModels } = loadConfig();
	const wrappedProviders = new Set<string>();
	const stats = { attempts: 0, timedOut: 0, emptyRetried: 0, recovered: 0, gaveUp: 0 };

	/** 计算退避延迟（含抖动） */
	function computeDelay(attempt: number): number {
		let delay = config.backoff.baseDelayMs * config.backoff.multiplier ** Math.min(attempt - 1, 10);
		delay = Math.min(delay, config.backoff.maxDelayMs);
		if (config.backoff.jitter > 0) {
			const j = config.backoff.jitter * (Math.random() * 2 - 1);
			delay = Math.max(0, Math.round(delay * (1 + j)));
		}
		return delay;
	}

	/**
	 * 把原 provider 的 stream 调用包进"首字看门狗 + 静默重试"循环。
	 * 每个尝试独立 AbortController：超时/用户取消都通过它中止底层请求。
	 */
	function ttftStream(
		produce: () => AssistantMessageEventStream,
		options: StreamOptions | undefined,
		ctx: any,
		modelInfo: ModelInfo,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		const userSignal = options?.signal;
		const timeoutMs = firstTokenTimeoutFor(config, compiledModels, modelInfo);
		const startedAt = Date.now();
		let attempt = 0;

		(async () => {
			try {
				while (true) {
					attempt++;
					stats.attempts++;
					let emitted = false;
					let timeoutFired = false;
					let emptyFired = false;
					let abortErrMsg = "";

					// 本次尝试的独立中止信号：用户取消 或 首字超时 都会 abort 它
					const attemptController = new AbortController();
					const onUserAbort = () => attemptController.abort();
					if (userSignal) {
						if (userSignal.aborted) attemptController.abort();
						else userSignal.addEventListener("abort", onUserAbort, { once: true });
					}
					const wrappedOptions = { ...options, signal: attemptController.signal };
					const timer = setTimeout(() => {
						timeoutFired = true;
						attemptController.abort();
					}, timeoutMs);

					try {
						const src = produce();
						for await (const ev of src) {
							if (ev.type === "done") {
								clearTimeout(timer);
								if (!emitted) {
									if (timeoutFired) break; // 超时后流才收尾 → 按首字超时重试
									if (config.retryOnEmpty) {
										emptyFired = true;
										break; // 空响应 → 重试
									}
								}
								if (attempt > 1) stats.recovered++;
								out.push(ev);
								return;
							}
							if (ev.type === "error") {
								clearTimeout(timer);
								// 已产出内容：无法安全重放，直接上交错误
								if (emitted) {
									out.push(ev);
									return;
								}
								// 我们因首字超时 abort 导致的错误 → 按首字超时重试
								if (timeoutFired) break;
								// 真正的上游错误（未产出内容）：交给 pi-retry / pi 内置重试，本插件不重复处理
								out.push(ev);
								return;
							}
							if (!emitted && isFirstTokenEvent(ev)) {
								emitted = true;
								clearTimeout(timer); // 首字已到，撤掉看门狗
							}
							out.push(ev);
						}
					} catch (err) {
						clearTimeout(timer);
						// 已有输出：无法安全重放，直接结束
						if (emitted) {
							out.end();
							return;
						}
						// 其余（网络/abort/传输）交给下方重试决策
						abortErrMsg = err instanceof Error ? err.message : String(err);
					} finally {
						userSignal?.removeEventListener("abort", onUserAbort);
					}

					// ---- 重试决策 ----
					// 唯一硬例外：用户取消 → 永不重试
					if (userSignal?.aborted) {
						stats.gaveUp++;
						out.push(makeErrorEvent("已由用户取消"));
						return;
					}
					// 既非首字超时也非空响应：真实的上游错误（网络/传输抛错）
					// → 以 error 事件上交，交给 pi-retry / pi 内置重试处理
					if (!timeoutFired && !emptyFired) {
						stats.gaveUp++;
						out.push(makeErrorEvent(abortErrMsg || "上游请求异常"));
						return;
					}
					if (attempt >= config.maxAttempts) {
						stats.gaveUp++;
						out.push(
							makeErrorEvent(
								timeoutFired
									? `首字超时（${Math.round(timeoutMs / 1000)}s 无响应），重试 ${config.maxAttempts} 次仍失败`
									: `空响应，重试 ${config.maxAttempts} 次仍失败`,
							),
						);
						return;
					}
					if (config.maxTotalWaitMs > 0 && Date.now() - startedAt >= config.maxTotalWaitMs) {
						stats.gaveUp++;
						out.push(makeErrorEvent("达到累计等待上限，放弃重试"));
						return;
					}

					// ---- 退避等待后重试 ----
					if (timeoutFired) stats.timedOut++;
					else stats.emptyRetried++;
					const delay = computeDelay(attempt);
					if (config.showStatus) {
						const why = timeoutFired
							? `首字 ${Math.round(timeoutMs / 1000)}s 无响应`
							: "空响应";
						ctx.ui.setStatus(
							"pi-ttft",
							`静默重试 #${attempt}（${why}，等 ${Math.round(delay / 1000)}s）`,
						);
					}
					await sleep(delay, userSignal);
					if (userSignal?.aborted) {
						stats.gaveUp++;
						out.push(makeErrorEvent("已由用户取消"));
						return;
					}
				}
			} finally {
				// 流结束（无论成败）：清除状态栏残留
				if (config.showStatus) ctx.ui.setStatus("pi-ttft", undefined);
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

		const modelInfo: ModelInfo = ctx.model
			? { provider: ctx.model.provider, id: ctx.model.id }
			: undefined;
		const origStream = base.stream;
		const origSimple = base.streamSimple;
		if (!origStream && !origSimple) return;

		if (origStream) {
			base.stream = (model: unknown, context: unknown, options?: StreamOptions) =>
				ttftStream(() => origStream.call(base, model, context, options), options, ctx, modelInfo);
		}
		if (origSimple) {
			base.streamSimple = (model: unknown, context: unknown, options?: StreamOptions) =>
				ttftStream(() => origSimple.call(base, model, context, options), options, ctx, modelInfo);
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
	pi.registerCommand("pi-ttft", {
		description: "Show pi-ttft config & session stats",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`pi-ttft: ${config.enabled ? "on" : "off"} | 首字阈值=${config.firstTokenTimeoutMs}ms ` +
					`| 空响应=${config.retryOnEmpty ? "重试" : "上交"} | maxAttempts=${config.maxAttempts} ` +
					`| base=${config.backoff.baseDelayMs}ms x${config.backoff.multiplier} max=${config.backoff.maxDelayMs}ms ` +
					`jitter=${config.backoff.jitter} | 模型覆盖=${Object.keys(config.models).length} ` +
					`| 本会话：请求 ${stats.attempts}，首字超时重试 ${stats.timedOut}，空响应重试 ${stats.emptyRetried}，救回 ${stats.recovered}，放弃 ${stats.gaveUp}`,
				"info",
			);
		},
	});
}
