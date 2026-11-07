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
import {
	hub,
	type ModelInfo,
	type ModelRef,
	type ResilienceConfig,
} from "../lib/resilience.js";
import { classifyFailure } from "../lib/failure-classifier.js";

// ============================================================================
// pi-breaker —— 熔断器 + 熔断后自动切模型（请求层静默版，耦合于共享 hub）
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
// 耦合（与 pi-retry / pi-ttft 通过 lib/resilience.ts 的 hub 相互调通）：
//   - pi-retry/pi-ttft 耗尽重试时调用 hub.noteExhausted(model, err, n)，
//     显式声明「此模型已被证明不行」；
//   - 本扩展失败时 hub.takeExhausted(key) 消费该信号，明确区分
//     「重试耗尽（判死刑）」vs「单次失败」。
//   - 三者共享同一个熔断器 / 配置 / 统计（hub）。
//
// 与 pi-retry / pi-ttft 的分工：
//   - pi-retry   ：同一模型、单请求内「错误」静默重试
//   - pi-ttft    ：同一模型、单请求内「首字太久」静默重试
//   - pi-breaker ：跨请求「熔断」——某模型连续失败就暂时不用它，切到备用模型
//
// 安全边界（同 pi-retry/pi-ttft）：只重试/切换「尚未产出任何内容」的失败；
//   committed（已产出）不能重放，直接上交。用户 abort 永不重试、不计熔断失败。
// ============================================================================

function debug(msg: string): void {
	if (process.env.PI_BREAKER_DEBUG) console.warn(`[pi-breaker] ${msg}`);
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
	const config: ResilienceConfig = hub.config;
	const wrappedProviders = new Set<string>();
	/** 每个 provider 的原始 stream（包装前捕获），供 fallback 防递归 */
	const origStreams = new Map<string, { stream?: (m: Model<Api>, c: TranscriptContext, o?: StreamOptions) => AssistantMessageEventStream }>();

	type Candidate = {
		key: string;
		label: string;
		model: ModelInfo;
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
		const chain: Candidate[] = [];

		// 主模型（produce 由调用方捕获原始 stream）
		chain.push({
			key: model ? hub.key(model) : "unknown",
			label: model ? `${model.provider}/${model.id}` : "unknown",
			model,
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
			const fbRef: ModelRef = { provider: fb.provider, id: fb.model };
			const orig = origStreams.get(fb.provider);
			const fbProduce = () => {
				if (orig?.stream) return orig.stream.call(fbProvider, fbModel, context, options);
				if (fbProvider.stream) return fbProvider.stream(fbModel, context, options);
				throw new Error(`no stream for fallback ${fb.provider}/${fb.model}`);
			};
			chain.push({
				key: hub.key(fbRef),
				label: `${fb.provider}/${fb.model}`,
				model: fbRef,
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
					hub.stats.attempts++;

					// 冷却 / 熔断检查（熔断 open 且到 resetTimeoutMs 时 canAttempt 会放一个探测）
					if (hub.inCooldown(cand.key)) {
						debug(`skip ${cand.label}: in cooldown`);
						continue;
					}
					if (!hub.canAttempt(cand.key)) {
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
						if (!cand.isPrimary) hub.stats.switched++;
						hub.recordResult(cand.key, true);
						out.end();
						return;
					}

					if (!attemptError) attemptError = "stream ended unexpectedly";

					// 用户取消 → 永不重试、不计熔断
					if (userSignal?.aborted) {
						hub.releaseProbe(cand.key);
						hub.stats.gaveUp++;
						out.push(makeErrorEvent("已由用户取消"));
						return;
					}

					// 已产出内容：无法安全重放/切换 → 上交；可重试类失败才计入熔断
					if (emitted) {
						hub.recordFailure(cand.model, attemptError);
						hub.recordResult(cand.key, false);
						hub.stats.gaveUp++;
						out.push(makeErrorEvent(attemptError));
						return;
					}

					// 消费「重试已耗尽」信号（pi-retry/pi-ttft 显式上报）——耦合桥
					const exhausted = hub.takeExhausted(cand.key);
					if (exhausted) {
						debug(`retry-exhausted signal for ${cand.label} after ${exhausted.retries} attempts: ${exhausted.error}`);
					}

					// 非可重试类失败（400/鉴权/未知 = 我们自己的 bug/配置，不是模型挂）
					// → 不上交、不切换、不熔断
					if (!classifyFailure(attemptError).retryable) {
						hub.stats.gaveUp++;
						out.push(makeErrorEvent(attemptError));
						return;
					}

					// 可重试类失败（network/5xx/429/timeout/配额 = 模型/上游问题）
					// → 冷却 + 熔断计数（1 次即熔断）+ 尝试下一个
					hub.recordFailure(cand.model, attemptError);
					hub.recordResult(cand.key, false);
					errors.push(`${cand.label}: ${attemptError}`);
					if (index < chain.length) hub.stats.failedOver++;
					debug(`failover ${cand.label} -> ${chain[index]?.label ?? "give up"}`);
				}

				// 全部失败
				hub.stats.gaveUp++;
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
			for (const [key, s] of hub.breaker.circuits) {
				const next = s.state === "open" ? ` → 恢复于 ${new Date(s.nextRetryTime).toLocaleTimeString()}` : "";
				lines.push(`  ${key}: ${s.state} (失败${s.failureCount})${next}`);
			}
			lines.push(`本会话：尝试 ${hub.stats.attempts}，切换 ${hub.stats.failedOver}，成功切备用 ${hub.stats.switched}，放弃 ${hub.stats.gaveUp}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

