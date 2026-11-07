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
import {
	canAttemptCircuit,
	recordCircuitResult,
	releaseCircuitProbe,
	type CircuitBreaker,
} from "../lib/circuit-breaker.js";
import { classifyFailure, getFailureCooldownMs } from "../lib/failure-classifier.js";

// ============================================================================
// pi-resilience —— 三合一：静默重试 + 首字看门狗 + 熔断器/自动切模型
//
// 一个项目 = 一个插件（由 pi-retry / pi-ttft / pi-breaker 归一而来）。
// 核心承诺：无感、无缝。
//   无感：包装 provider stream，内部重试/切换，从不 pi.sendMessage / 不注入消息、
//         不依赖 pi 内置 retry，pi 和模型全程无感。
//   无缝：切到备用模型时，把同一个 TranscriptContext（对话消息数组）传给备用
//         provider.stream() —— 备用模型看到完整对话，接着写，用户毫无察觉。
//         同时「内容前」事件（start 等）先缓冲，失败候选丢弃、成功候选才放行，
//         避免重复 start / 失败候选污染输出流。
//
// 单请求的显式级联（代码里顺序写死，无加载顺序坑）：
//   ① 熔断检查（主模型电路 open/冷却 → 直接跳③）
//   ② 重试+首字看门狗（同一循环，同模型，含退避）
//   ③ ② 耗尽仍失败 → 熔断主模型（判死刑）→ 切备用链
//   备用链 [F1,F2,...]：每个也走②的完整重试逻辑（同 provider 或跨 provider 一致），
//     且透传同一个 context。全失败 → 上交错误。
//
// 安全边界：只重试/切换「尚未产出任何内容」的失败（内容无法安全重放）；
//   committed（已产出）直接上交。用户 abort 永不重试、不计熔断失败。
//
// 配置：~/.pi/pi-resilience.json（分节 retry / ttft / breaker / fallback，各节可独立开关）
// ============================================================================

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

type RetryMode = "all" | "allowlist" | "denylist";

interface ResilienceConfig {
	enabled: boolean;
	showStatus: boolean;
	retry: {
		enabled: boolean;
		mode: RetryMode;
		matchStatus: number[];
		matchText: string[];
		maxAttempts: number;
		maxTotalWaitMs: number;
		backoff: { baseDelayMs: number; maxDelayMs: number; multiplier: number; jitter: number };
		respectRetryAfter: boolean;
		retryOnOverflow: boolean;
	};
	ttft: {
		enabled: boolean;
		firstTokenTimeoutMs: number;
		retryOnEmpty: boolean;
		models: Record<string, { firstTokenTimeoutMs?: number }>;
	};
	breaker: {
		enabled: boolean;
		failureThreshold: number;
		resetTimeoutMs: number;
		cooldownMs: number;
		models: Record<string, Partial<{ failureThreshold: number; resetTimeoutMs: number; cooldownMs: number }>>;
	};
	fallback: {
		models: { provider: string; model: string }[];
		maxAttempts: number;
	};
}

const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	showStatus: true,
	retry: {
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
		backoff: { baseDelayMs: 3000, maxDelayMs: 60000, multiplier: 2, jitter: 0.1 },
		respectRetryAfter: true,
		retryOnOverflow: true,
	},
	ttft: {
		enabled: true,
		firstTokenTimeoutMs: 20_000,
		retryOnEmpty: true,
		models: {},
	},
	breaker: {
		enabled: true,
		failureThreshold: 1,
		resetTimeoutMs: 120_000,
		cooldownMs: 60_000,
		models: {},
	},
	fallback: {
		models: [],
		maxAttempts: 8,
	},
};

const CONFIG_PATH = join(homedir(), ".pi", "pi-resilience.json");

function deep<T>(base: T, patch: unknown): T {
	if (patch === undefined || patch === null) return base;
	if (Array.isArray(base) || typeof base !== "object" || typeof patch !== "object") {
		return (patch as T) ?? base;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v === undefined) continue;
		out[k] = deep((base as Record<string, unknown>)[k], v);
	}
	return out as T;
}

function loadConfig(): ResilienceConfig {
	let raw: unknown;
	try {
		if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		// 损坏则用默认
	}
	return deep(structuredClone(DEFAULT_CONFIG), raw);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

function modelPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
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

/** 首个真实内容事件：非空 text/thinking/toolcall delta */
function isContentEvent(ev: AssistantMessageEvent): boolean {
	return (
		(ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") &&
		((ev as { delta?: string }).delta?.length ?? 0) > 0
	);
}

const CONTEXT_OVERFLOW_PATTERN =
	/prompt.*(?:too long|exceeds|is longer)|context.*(?:length|limit|exceeded)|max.*(?:token|context)|token.*(?:limit|exceeded)|input.*too long|maximum context/i;

function isContextOverflowText(text: string): boolean {
	return CONTEXT_OVERFLOW_PATTERN.test(text);
}

type ModelInfo = { provider: string; id: string } | undefined;

function debug(msg: string): void {
	if (process.env.PI_RESILIENCE_DEBUG) console.warn(`[pi-resilience] ${msg}`);
}

// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const wrappedProviders = new Set<string>();
	/** 每个 provider 的原始 stream（包装前捕获），供 fallback 防递归 */
	const origStreams = new Map<string, { stream?: (m: Model<Api>, c: TranscriptContext, o?: StreamOptions) => AssistantMessageEventStream }>();

	const breaker: CircuitBreaker = {
		circuits: new Map(),
		failureThreshold: config.breaker.failureThreshold,
		resetTimeoutMs: config.breaker.resetTimeoutMs,
		enabled: config.breaker.enabled,
	};
	const cooldowns = new Map<string, number>();
	const stats = { attempts: 0, retried: 0, recovered: 0, failedOver: 0, switched: 0, gaveUp: 0 };

	// ---- 熔断 / 冷却 ----
	const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
	const canAttempt = (key: string) => canAttemptCircuit(breaker, key, debug);
	const recordResult = (key: string, success: boolean) => recordCircuitResult(breaker, key, success, debug);
	const releaseProbe = (key: string) => releaseCircuitProbe(breaker, key, debug);

	function inCooldown(key: string): boolean {
		const end = cooldowns.get(key);
		if (end === undefined) return false;
		if (Date.now() >= end) { cooldowns.delete(key); return false; }
		return true;
	}
	function recordFailure(m: { provider: string; id: string }, error: string): void {
		let cd = config.breaker.cooldownMs;
		const label = `${m.provider}/${m.id}`;
		for (const [pattern, o] of Object.entries(config.breaker.models)) {
			if (modelPattern(pattern).test(label)) { cd = o.cooldownMs ?? cd; break; }
		}
		const { cooldownMs } = getFailureCooldownMs(error, cd);
		cooldowns.set(keyOf(m), Date.now() + cooldownMs);
	}

	// ---- 重试模式判定 ----
	function shouldRetry(status: number | undefined, errText: string, compiled: RegExp[]): boolean {
		const r = config.retry;
		if (r.mode === "all") return true;
		const hit =
			(status !== undefined && r.matchStatus.includes(status)) ||
			compiled.some((re) => re.test(errText));
		return r.mode === "allowlist" ? hit : !hit;
	}
	const compiledText = config.retry.matchText.map((p) => {
		try { return new RegExp(p, "i"); } catch { return /$^/; }
	});

	function computeDelay(attempt: number, retryAfterMs: number): number {
		let delay: number;
		if (config.retry.respectRetryAfter && retryAfterMs > 0) {
			delay = retryAfterMs;
		} else {
			delay = config.retry.backoff.baseDelayMs * config.retry.backoff.multiplier ** Math.min(attempt - 1, 10);
		}
		delay = Math.min(delay, config.retry.backoff.maxDelayMs);
		if (config.retry.backoff.jitter > 0) {
			delay = Math.max(0, Math.round(delay * (1 + config.retry.backoff.jitter * (Math.random() * 2 - 1))));
		}
		return delay;
	}

	function ttftTimeoutFor(m: ModelInfo): number {
		if (m) {
			const label = `${m.provider}/${m.id}`;
			for (const [pattern, o] of Object.entries(config.ttft.models)) {
				if (modelPattern(pattern).test(label)) return o.firstTokenTimeoutMs ?? config.ttft.firstTokenTimeoutMs;
			}
		}
		return config.ttft.firstTokenTimeoutMs;
	}

	// ---- 尝试一个候选（重试 + 首字看门狗，同一循环） ----
	type TryResult =
		| { status: "success" }
		| { status: "committed"; error: string } // 已产出内容，不可重放
		| { status: "aborted" }
		| { status: "nonRetryable"; error: string } // 非可重试类（400/鉴权/未知）
		| { status: "exhausted"; error: string }; // 重试耗尽（模型判死刑）

	async function tryCandidate(
		produce: () => AssistantMessageEventStream,
		model: ModelInfo,
		options: StreamOptions | undefined,
		out: AssistantMessageEventStream,
		ctx: any,
		maxAttempts: number,
	): Promise<TryResult> {
		const userSignal = options?.signal;
		const t0 = Date.now();
		const useRetry = config.retry.enabled;
		const useTtft = config.ttft.enabled;
		const timeoutMs = ttftTimeoutFor(model);
		let lastRetryAfterMs = 0;
		let lastStatus: number | undefined;

		// 注入 onResponse：捕获 HTTP status + retry-after
		const origOnResponse = options?.onResponse;
		const wrappedOptions = options
			? {
					...options,
					onResponse: (resp: ProviderResponse, m: Model<Api>) => {
						lastStatus = resp?.status;
						if (config.retry.respectRetryAfter && resp?.status === 429) {
							const ra = resp.headers?.["retry-after"];
							const secs = ra ? parseInt(String(ra), 10) : NaN;
							if (Number.isFinite(secs) && secs > 0) lastRetryAfterMs = Math.min(secs * 1000, config.retry.backoff.maxDelayMs);
						}
						return origOnResponse?.(resp, m);
					},
				}
			: options;

		let attempt = 0;
		for (;;) {
			attempt++;
			stats.attempts++;
			let emitted = false;
			let timeoutFired = false;
			let errorText = "";
			let haveError = false;
			let done = false;
			let emptyFired = false;

			// 「内容前」事件缓冲：失败候选丢弃，成功候选才放行（无缝，避免重复 start）
			const prelude: AssistantMessageEvent[] = [];
			let flushed = false;

			const attemptController = new AbortController();
			const onUserAbort = () => attemptController.abort();
			if (userSignal) {
				if (userSignal.aborted) attemptController.abort();
				else userSignal.addEventListener("abort", onUserAbort, { once: true });
			}
			const attemptOptions = { ...wrappedOptions, signal: attemptController.signal };
			const timer = useTtft
				? setTimeout(() => { timeoutFired = true; attemptController.abort(); }, timeoutMs)
				: undefined;

			try {
				const src = produce();
				for await (const ev of src) {
					if (ev.type === "done") {
						if (!flushed) { for (const p of prelude) out.push(p); flushed = true; }
						out.push(ev);
						done = true;
						break;
					}
					if (ev.type === "error") {
						errorText = ev.error.errorMessage ?? "provider error";
						haveError = true;
						break; // 先不推，后面决定（重试/切换则丢弃）
					}
					if (!flushed && !isContentEvent(ev)) {
						prelude.push(ev); // start / 空 text_start 等 → 缓冲
						continue;
					}
					if (!flushed) { for (const p of prelude) out.push(p); flushed = true; }
					if (!emitted && isContentEvent(ev)) emitted = true;
					out.push(ev);
				}
			} catch (err) {
				errorText = err instanceof Error ? err.message : String(err);
				haveError = true;
			} finally {
				userSignal?.removeEventListener("abort", onUserAbort);
				if (timer) clearTimeout(timer);
			}

			// 用户取消 → 永不重试
			if (userSignal?.aborted) return { status: "aborted" };

			// 成功（有 done，未报错）
			if (done && !haveError) {
				if (emitted || !(useTtft && config.ttft.retryOnEmpty)) {
					if (attempt > 1) stats.recovered++;
					return { status: "success" };
				}
				emptyFired = true; // 空响应 → 按 ttft.retryOnEmpty 重试
			}

			// 已产出内容 → 不可重放（out 已放行内容，现在上交错误）
			if (emitted) {
				return { status: "committed", error: haveError ? errorText : "流中断（已产出内容）" };
			}

			// 首字超时（无内容、无错误）
			if (timeoutFired && !haveError) {
				errorText = `首字超时（${Math.round(timeoutMs / 1000)}s 无响应）`;
				haveError = true;
			}

			// 真正错误（非超时）且非可重试类 → 上交（丢弃 prelude）
			if (haveError && !timeoutFired && !emptyFired) {
				const cls = classifyFailure(errorText);
				if (!cls.retryable) return { status: "nonRetryable", error: errorText };
				if (!useRetry) return { status: "nonRetryable", error: errorText };
				if (config.retry.retryOnOverflow === false && isContextOverflowText(errorText)) {
					return { status: "nonRetryable", error: errorText };
				}
				if (!shouldRetry(lastStatus, errorText, compiledText)) {
					return { status: "nonRetryable", error: errorText };
				}
			}

			// 重试耗尽 / 累计上限 → 判死刑
			if (attempt >= maxAttempts) {
				return { status: "exhausted", error: haveError ? errorText : emptyFired ? "空响应" : "流意外结束" };
			}
			if (config.retry.maxTotalWaitMs > 0 && Date.now() - t0 >= config.retry.maxTotalWaitMs) {
				return { status: "exhausted", error: "达到累计等待上限" };
			}

			// 退避等待后重试
			stats.retried++;
			const delay = computeDelay(attempt, lastRetryAfterMs);
			if (config.showStatus) {
				const why = timeoutFired
					? `首字 ${Math.round(timeoutMs / 1000)}s 无响应`
					: emptyFired ? "空响应" : `错误${lastStatus !== undefined ? `(HTTP ${lastStatus})` : ""}`;
				ctx.ui?.setStatus?.("pi-resilience", `静默重试 #${attempt}（${why}，等 ${Math.round(delay / 1000)}s）`);
			}
			await sleep(delay, userSignal);
			if (userSignal?.aborted) return { status: "aborted" };
		}
	}

	// ---- 请求级联（主模型 + 备用链） ----
	type Candidate = {
		key: string;
		label: string;
		model: ModelInfo;
		isPrimary: boolean;
		produce: () => AssistantMessageEventStream;
	};

	function resilienceStream(
		produce: () => AssistantMessageEventStream,
		model: ModelInfo,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		ctx: any,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		const userSignal = options?.signal;
		const chain: Candidate[] = [];

		// 主模型
		chain.push({
			key: model ? keyOf(model) : "unknown",
			label: model ? `${model.provider}/${model.id}` : "unknown",
			model,
			isPrimary: true,
			produce,
		});

		// 备用链（一律走原始流，防递归；同一个 context 透传 = 无缝）
		for (const fb of config.fallback.models) {
			const fbModel = ctx.modelRegistry?.find(fb.provider, fb.model) as Model<Api> | undefined;
			if (!fbModel) { debug(`fallback model not found: ${fb.provider}/${fb.model}`); continue; }
			const fbProvider = ctx.modelRegistry?.getProvider(fb.provider);
			if (!fbProvider) { debug(`fallback provider not found: ${fb.provider}`); continue; }
			const orig = origStreams.get(fb.provider);
			const fbProduce = () => {
				if (orig?.stream) return orig.stream.call(fbProvider, fbModel, context, options);
				if (fbProvider.stream) return fbProvider.stream(fbModel, context, options);
				throw new Error(`no stream for fallback ${fb.provider}/${fb.model}`);
			};
			chain.push({
				key: keyOf({ provider: fb.provider, id: fb.model }),
				label: `${fb.provider}/${fb.model}`,
				model: { provider: fb.provider, id: fb.model },
				isPrimary: false,
				produce: fbProduce,
			});
		}

		(async () => {
			try {
				const errors: string[] = [];
				for (let i = 0; i < chain.length; i++) {
					const cand = chain[i];

					// ① 熔断 / 冷却检查
					if (inCooldown(cand.key)) { debug(`skip ${cand.label}: in cooldown`); continue; }
					if (!canAttempt(cand.key)) { debug(`skip ${cand.label}: circuit open`); continue; }

					// ② 重试 + 首字看门狗（同一循环；备用也走同逻辑）
					const budget = cand.isPrimary ? config.retry.maxAttempts : config.fallback.maxAttempts;
					const res = await tryCandidate(cand.produce, cand.model, options, out, ctx, budget);

					switch (res.status) {
						case "success":
							if (!cand.isPrimary) stats.switched++;
							recordResult(cand.key, true);
							out.end();
							return;
						case "aborted":
							releaseProbe(cand.key);
							stats.gaveUp++;
							out.push(makeErrorEvent("已由用户取消"));
							return;
						case "committed":
							recordFailure(cand.model ?? { provider: "?", id: "?" }, res.error);
							recordResult(cand.key, false);
							stats.gaveUp++;
							out.push(makeErrorEvent(res.error));
							return;
						case "nonRetryable":
							stats.gaveUp++;
							out.push(makeErrorEvent(res.error));
							return;
						case "exhausted":
							// ③ 重试耗尽 → 熔断（判死刑）→ 切下一个
							if (cand.model) recordFailure(cand.model, res.error);
							recordResult(cand.key, false);
							errors.push(`${cand.label}: ${res.error}`);
							if (i + 1 < chain.length) stats.failedOver++;
							debug(`failover ${cand.label} -> ${chain[i + 1]?.label ?? "give up"}`);
							continue;
					}
				}
				// 全失败
				stats.gaveUp++;
				out.push(makeErrorEvent(errors.length > 0 ? errors.join("；") : "所有模型均不可用"));
			} finally {
				if (config.showStatus) ctx.ui?.setStatus?.("pi-resilience", undefined);
			}
		})().catch((err) => {
			out.push(makeErrorEvent(err instanceof Error ? err.message : String(err)));
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

		if (origStream) origStreams.set(providerId, { stream: origStream });

		if (origStream) {
			base.stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				resilienceStream(
					() => origStream.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					context,
					options,
					ctx,
				);
		}
		if (origSimple) {
			base.streamSimple = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				resilienceStream(
					() => origSimple.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					context,
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
	pi.registerCommand("pi-resilience", {
		description: "Show pi-resilience config, circuit states & session stats",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(
				`pi-resilience: ${config.enabled ? "on" : "off"} | retry=${config.retry.enabled ? "on" : "off"}(${config.retry.mode},×${config.retry.maxAttempts}) | ` +
					`ttft=${config.ttft.enabled ? "on" : "off"}(${config.ttft.firstTokenTimeoutMs}ms) | ` +
					`breaker=${config.breaker.enabled ? "on" : "off"}(阈值${config.breaker.failureThreshold},恢复${config.breaker.resetTimeoutMs}ms)`,
			);
			lines.push(
				`备用=${config.fallback.models.map((f) => `${f.provider}/${f.model}`).join(",") || "无"}（×${config.fallback.maxAttempts}）`,
			);
			for (const [key, s] of breaker.circuits) {
				const next = s.state === "open" ? ` → 恢复于 ${new Date(s.nextRetryTime).toLocaleTimeString()}` : "";
				lines.push(`  ${key}: ${s.state} (失败${s.failureCount})${next}`);
			}
			lines.push(
				`本会话：请求 ${stats.attempts}，重试 ${stats.retried}，救回 ${stats.recovered}，切换 ${stats.failedOver}，成功切备用 ${stats.switched}，放弃 ${stats.gaveUp}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
