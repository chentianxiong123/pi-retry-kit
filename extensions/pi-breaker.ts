import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
	type Api,
	type TranscriptContext,
	type StreamOptions,
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
// pi-breaker —— 熔断器 + 熔断后自动切模型（请求层静默版）
//
// 学自 pi-router（jiangge/pi-router, MIT）的熔断 + failover，用我们自己的
// 「请求层静默包装」架构（同 pi-retry / pi-ttft）：
//
//   1. 熔断器本体：lib/circuit-breaker.ts（原样抄来，closed/open/half-open + 探测互斥）
//   2. 失败分类：   lib/failure-classifier.ts（错误文本 → kind + retryable + 冷却）
//   3. 包装 provider stream：尝试链 = [主模型, ...fallbackModels]。
//      熔断/冷却的跳过；失败且未产出内容 → 计一次熔断失败 + 冷却 → 切下一个；
//      全部失败 → 上交错误。全程不发任何消息，pi 与模型无感。
//
// 与 pi-retry / pi-ttft 的分工：
//   - pi-retry   ：同一模型、单请求内「错误」静默重试
//   - pi-ttft    ：同一模型、单请求内「首字太久」静默重试
//   - pi-breaker ：跨请求「熔断」——某模型连续失败就暂时不用它，切到备用模型
//
// 安全边界（同 pi-retry/pi-ttft）：只重试/切换「尚未产出任何内容」的失败；
//   committed（已产出）不能重放，直接上交。用户 abort 永不重试、不计熔断失败。
//
// 配置：~/.pi/pi-breaker.json（扁平、配置驱动，便于将来 webUI 改）
// ============================================================================

type ModelInfo = { provider: string; id: string } | undefined;

interface FallbackModelSpec {
	provider: string;
	model: string;
}

interface BreakerConfig {
	enabled: boolean;
	/** 连续失败多少次后熔断（open） */
	failureThreshold: number;
	/** 熔断后多少 ms 恢复（open → half-open 探测） */
	resetTimeoutMs: number;
	/** 单次失败后的冷却（ms）；临时错(network/timeout/鉴权)自动用 5s */
	cooldownMs: number;
	/** 熔断/失败后依次尝试的备用模型链 */
	fallbackModels: FallbackModelSpec[];
	/** 按模型 glob 覆盖阈值 */
	models: Record<string, Partial<{ failureThreshold: number; resetTimeoutMs: number; cooldownMs: number }>>;
	/** 状态栏显示进度 */
	showStatus: boolean;
}

const DEFAULT_CONFIG: BreakerConfig = {
	enabled: true,
	/** 连续失败多少次后熔断（open）。默认 1：重试耗尽仍失败 = 模型已挂，一次即熔断 */
	failureThreshold: 1,
	/** 熔断后多少 ms 恢复（open → half-open 探测） */
	resetTimeoutMs: 120_000,
	/** 单次失败后的冷却（ms）；临时错(network/timeout/鉴权)自动用 5s */
	cooldownMs: 60_000,
	fallbackModels: [],
	models: {},
	showStatus: true,
};

const CONFIG_PATH = join(homedir(), ".pi", "pi-breaker.json");

function loadConfig(): { config: BreakerConfig; compiledModels: Array<{ re: RegExp; ov: Partial<BreakerConfig> }> } {
	let raw: Partial<BreakerConfig> | undefined;
	try {
		if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		// 损坏则用默认
	}
	const config = normalize(raw);
	const compiledModels = Object.entries(config.models).map(([pattern, ov]) => ({ re: modelPattern(pattern), ov: ov ?? {} }));
	return { config, compiledModels };
}

function normalize(raw?: Partial<BreakerConfig>): BreakerConfig {
	if (!raw) return structuredClone(DEFAULT_CONFIG);
	return {
		...DEFAULT_CONFIG,
		...raw,
		fallbackModels: raw.fallbackModels ?? DEFAULT_CONFIG.fallbackModels,
		models: raw.models ?? {},
	} as BreakerConfig;
}

function modelPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

function thresholdsFor(
	config: BreakerConfig,
	compiled: Array<{ re: RegExp; ov: Partial<BreakerConfig> }>,
	model: ModelInfo,
): { failureThreshold: number; resetTimeoutMs: number; cooldownMs: number } {
	if (model) {
		const label = `${model.provider}/${model.id}`;
		for (const { re, ov } of compiled) {
			if (re.test(label)) {
				return {
					failureThreshold: ov.failureThreshold ?? config.failureThreshold,
					resetTimeoutMs: ov.resetTimeoutMs ?? config.resetTimeoutMs,
					cooldownMs: ov.cooldownMs ?? config.cooldownMs,
				};
			}
		}
	}
	return { failureThreshold: config.failureThreshold, resetTimeoutMs: config.resetTimeoutMs, cooldownMs: config.cooldownMs };
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

// ---------------------------------------------------------------------------
// 主扩展
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const { config, compiledModels } = loadConfig();
	const wrappedProviders = new Set<string>();
	/** 每个 provider 的原始 stream（包装前捕获），供 fallback 防递归 */
	const origStreams = new Map<string, { stream?: (m: Model<Api>, c: TranscriptContext, o?: StreamOptions) => AssistantMessageEventStream }>();
	const breaker: CircuitBreaker = {
		circuits: new Map(),
		failureThreshold: config.failureThreshold,
		resetTimeoutMs: config.resetTimeoutMs,
		enabled: config.enabled,
	};
	const stats = { attempts: 0, failedOver: 0, switched: 0, gaveUp: 0 };
	const cooldowns = new Map<string, number>();

	const debug = (msg: string) => {
		if (process.env.PI_BREAKER_DEBUG) console.warn(`[pi-breaker] ${msg}`);
	};

	function circuitKey(model: { provider: string; id: string }): string {
		return `${model.provider}/${model.id}`;
	}

	function inCooldown(key: string): boolean {
		const end = cooldowns.get(key);
		if (end === undefined) return false;
		if (Date.now() >= end) {
			cooldowns.delete(key);
			return false;
		}
		return true;
	}

	function recordFailure(key: string, error: string): void {
		const { cooldownMs } = getFailureCooldownMs(error, config.cooldownMs);
		cooldowns.set(key, Date.now() + cooldownMs);
		debug(`failure ${key}: ${error} -> cooldown ${cooldownMs}ms`);
	}

	type Candidate = {
		key: string;
		label: string;
		isPrimary: boolean;
		produce: () => AssistantMessageEventStream;
	};

	/**
	 * 包装 provider stream：尝试链 = [主, ...fallback]，熔断/冷却跳过，
	 * 失败（未产出内容）切下一个，committed/abort 上交。
	 */
	function breakerStream(
		produce: () => AssistantMessageEventStream,
		model: ModelInfo,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		ctx: any,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();
		const userSignal = options?.signal;
		const thresholds = thresholdsFor(config, compiledModels, model);
		const chain: Candidate[] = [];

		// 主模型（produce 由调用方捕获原始 stream）
		chain.push({
			key: model ? circuitKey(model) : "unknown",
			label: model ? `${model.provider}/${model.id}` : "unknown",
			isPrimary: true,
			produce,
		});

		// 备用模型链（一律走原始流，防递归进 breaker 包装器）
		for (const fb of config.fallbackModels) {
			const fbModel = ctx.modelRegistry?.find(fb.provider, fb.model) as Model<Api> | undefined;
			if (!fbModel) {
				debug(`fallback model not found: ${fb.provider}/${fb.model}`);
				continue;
			}
			const fbProvider = ctx.modelRegistry?.getProvider(fb.provider);
			if (!fbProvider) {
				debug(`fallback provider not found: ${fb.provider}`);
				continue;
			}
			const orig = origStreams.get(fb.provider);
			const fbProduce = () => {
				if (orig?.stream) return orig.stream.call(fbProvider, fbModel, context, options);
				if (fbProvider.stream) return fbProvider.stream(fbModel, context, options);
				throw new Error(`no stream for fallback ${fb.provider}/${fb.model}`);
			};
			chain.push({
				key: circuitKey({ provider: fb.provider, id: fb.model }),
				label: `${fb.provider}/${fb.model}`,
				isPrimary: false,
				produce: fbProduce,
			});
		}

		(async () => {
			try {
				let index = 0;
				const errors: string[] = [];

				while (index < chain.length) {
					const cand = chain[index];
					index++;
					stats.attempts++;

					// 冷却 / 熔断检查（熔断 open 且到 resetTimeoutMs 时 canAttempt 会放一个探测）
					if (inCooldown(cand.key)) {
						debug(`skip ${cand.label}: in cooldown`);
						continue;
					}
					if (!canAttemptCircuit(breaker, cand.key, debug)) {
						debug(`skip ${cand.label}: circuit open`);
						continue;
					}

					// 尝试当前候选
					let emitted = false;
					let attemptError: string | undefined;
					let done = false;
					try {
						const src = cand.produce();
						for await (const ev of src) {
							if (ev.type === "done") {
								done = true;
								break;
							}
							if (ev.type === "error") {
								attemptError = ev.error.errorMessage ?? "provider error";
								break;
							}
							if (!emitted && isContentEvent(ev)) emitted = true;
							out.push(ev);
						}
					} catch (err) {
						attemptError = err instanceof Error ? err.message : String(err);
					}

					// 成功（或空响应，视为成功透传）
					if (done && !attemptError) {
						if (!cand.isPrimary) stats.switched++;
						recordCircuitResult(breaker, cand.key, true, debug);
						out.end();
						return;
					}

					if (!attemptError) attemptError = "stream ended unexpectedly";

					// 用户取消 → 永不重试、不计熔断
					if (userSignal?.aborted) {
						releaseCircuitProbe(breaker, cand.key, debug);
						stats.gaveUp++;
						out.push(makeErrorEvent("已由用户取消"));
						return;
					}

					// 已产出内容：无法安全重放/切换 → 上交；可重试类失败才计入熔断
					if (emitted) {
						if (classifyFailure(attemptError).retryable) {
							recordFailure(cand.key, attemptError);
							recordCircuitResult(breaker, cand.key, false, debug);
						}
						stats.gaveUp++;
						out.push(makeErrorEvent(attemptError));
						return;
					}

					// 非可重试类失败（400/鉴权/未知 = 我们自己的 bug/配置，不是模型挂）
					// → 不上交、不切换、不熔断
					if (!classifyFailure(attemptError).retryable) {
						stats.gaveUp++;
						out.push(makeErrorEvent(attemptError));
						return;
					}

					// 可重试类失败（network/5xx/429/timeout/配额 = 模型/上游问题）
					// → 冷却 + 熔断计数（1 次即熔断）+ 尝试下一个
					recordFailure(cand.key, attemptError);
					recordCircuitResult(breaker, cand.key, false, debug);
					errors.push(`${cand.label}: ${attemptError}`);
					if (index < chain.length) stats.failedOver++;
					debug(`failover ${cand.label} -> ${chain[index]?.label ?? "give up"}`);
				}

				// 全部失败
				stats.gaveUp++;
				out.push(makeErrorEvent(errors.length > 0 ? errors.join("；") : "所有模型均不可用"));
			} finally {
				if (config.showStatus) ctx.ui?.setStatus?.("pi-breaker", undefined);
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

		// 记录原始流（供 fallback 防递归）
		if (origStream) origStreams.set(providerId, { stream: origStream });

		if (origStream) {
			base.stream = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				breakerStream(
					() => origStream.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					context,
					options,
					ctx,
				);
		}
		if (origSimple) {
			base.streamSimple = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				breakerStream(
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
	pi.registerCommand("pi-breaker", {
		description: "Show pi-breaker config, circuit states & session stats",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			lines.push(
				`pi-breaker: ${config.enabled ? "on" : "off"} | 阈值=${config.failureThreshold} | 恢复=${config.resetTimeoutMs}ms | 冷却=${config.cooldownMs}ms | 备用=${config.fallbackModels.map((f) => `${f.provider}/${f.model}`).join(",") || "无"}`,
			);
			for (const [key, s] of breaker.circuits) {
				const next = s.state === "open" ? ` → 恢复于 ${new Date(s.nextRetryTime).toLocaleTimeString()}` : "";
				lines.push(`  ${key}: ${s.state} (失败${s.failureCount})${next}`);
			}
			lines.push(`本会话：尝试 ${stats.attempts}，切换 ${stats.failedOver}，成功切备用 ${stats.switched}，放弃 ${stats.gaveUp}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
