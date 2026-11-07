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
import { classifyFailure } from "./failure-classifier.js";
import {
	sleep,
	makeErrorEvent,
	isContentEvent,
	isContextOverflowText,
	debug,
	keyOf,
	compileText,
	shouldRetry,
	computeDelay,
	ttftTimeoutFor,
	type ModelInfo,
} from "./core.js";
import type { ResilienceConfig } from "./config.js";
import type { Reliability } from "./reliability.js";
import type { Footer } from "./present.js";

// ============================================================================
// lib/executor.ts —— 执行层
// 职责：真正「跑请求」的地方。
//   tryCandidate      —— 对单个模型做「错误重试 + 首字看门狗」的同一循环（重试层 + 看门狗层）
//   resilienceStream  —— 候选链级联（协调层）：熔断检查 → tryCandidate → 耗尽则熔断 → 切下一候选
//   所有决策（熔断/重试/看门狗）委托给 reliability / core 纯函数；呈现委托给 footer。
// ============================================================================

export type TryResult =
	| { status: "success" }
	| { status: "committed"; error: string; httpStatus?: number } // 已产出内容，不可重放
	| { status: "aborted" }
	| { status: "nonRetryable"; error: string; httpStatus?: number } // 非可重试类（鉴权/未知/部分 4xx）
	| { status: "exhausted"; error: string; httpStatus?: number }; // 重试耗尽（模型判死刑）

export type Candidate = {
	key: string;
	label: string;
	model: ModelInfo;
	isPrimary: boolean;
	produce: () => AssistantMessageEventStream;
};

export interface SessionStats {
	attempts: number;
	retried: number;
	recovered: number;
	failedOver: number;
	switched: number;
	gaveUp: number;
}

export function createExecutor(deps: {
	config: ResilienceConfig;
	reliability: Reliability;
	footer: Footer;
	stats: SessionStats;
	origStreams: Map<string, { stream?: (m: Model<Api>, c: TranscriptContext, o?: StreamOptions) => AssistantMessageEventStream }>;
}) {
	const { config, reliability, footer, stats, origStreams } = deps;
	const compiledText = compileText(config.retry.matchText);

	// 候选列表 = [primary, ...fallbacks]（route 与 wrapper 共享同一顺序）
	function buildCandidates(ctx: any): { model: Model<Api>; key: string; label: string }[] {
		const specs: { provider: string; model: string }[] = [];
		if (config.primary) specs.push(config.primary);
		for (const fb of config.fallback.models) specs.push(fb);
		const list: { model: Model<Api>; key: string; label: string }[] = [];
		for (const s of specs) {
			const m = ctx.modelRegistry?.find(s.provider, s.model) as Model<Api> | undefined;
			if (!m) { debug(`candidate not found: ${s.provider}/${s.model}`); continue; }
			list.push({ model: m, key: keyOf({ provider: s.provider, id: s.model }), label: `${s.provider}/${s.model}` });
		}
		return list;
	}

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
		const timeoutMs = ttftTimeoutFor(config.ttft, model);
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
		let firstTokenThisTry = 0;
		// 本次尝试的上限：分类器可为特定类别（如 precondition/safety）收紧它，但不放大超过调用方预算
		let attemptMax = maxAttempts;
		for (;;) {
			attempt++;
			stats.attempts++;
			footer.noteAttempt();
			let emitted = false;
			let timeoutFired = false;
			let errorText = "";
			let haveError = false;
			let done = false;
			let emptyFired = false;
			// 本次出错时的实际上限（分类器收紧后 < maxAttempts）
			const effectiveMax = attemptMax;

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
					if (!emitted && isContentEvent(ev)) { emitted = true; firstTokenThisTry = Date.now() - t0; }
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
					footer.noteFirstToken(firstTokenThisTry);
					return { status: "success" };
				}
				emptyFired = true; // 空响应 → 按 ttft.retryOnEmpty 重试
			}

			// 已产出内容 → 不可重放（out 已放行内容，现在上交错误）
			if (emitted) {
				return { status: "committed", error: haveError ? errorText : "流中断（已产出内容）", httpStatus: lastStatus };
			}

			// 首字超时（无内容、无错误）
			if (timeoutFired && !haveError) {
				errorText = `首字超时（${Math.round(timeoutMs / 1000)}s 无响应）`;
				haveError = true;
			}

			// 真正错误（非超时）且非可重试类 → 上交（丢弃 prelude）
			if (haveError && !timeoutFired && !emptyFired) {
				const cls = classifyFailure(errorText, lastStatus);
				if (!cls.retryable) return { status: "nonRetryable", error: errorText, httpStatus: lastStatus };
				if (!useRetry) return { status: "nonRetryable", error: errorText, httpStatus: lastStatus };
				if (config.retry.retryOnOverflow === false && isContextOverflowText(errorText)) {
					return { status: "nonRetryable", error: errorText, httpStatus: lastStatus };
				}
				if (!shouldRetry(config.retry, lastStatus, errorText, compiledText)) {
					return { status: "nonRetryable", error: errorText, httpStatus: lastStatus };
				}
				// 分类器为这类错误声明了更严的上限（precondition/safety 默认 3）→ 收紧
				if (cls.maxAttempts !== undefined) attemptMax = Math.min(attemptMax, cls.maxAttempts);
			}

			// 重试耗尽 / 累计上限 → 判死刑
			if (attempt >= effectiveMax) {
				return { status: "exhausted", error: haveError ? errorText : emptyFired ? "空响应" : "流意外结束", httpStatus: lastStatus };
			}
			if (config.retry.maxTotalWaitMs > 0 && Date.now() - t0 >= config.retry.maxTotalWaitMs) {
				return { status: "exhausted", error: "达到累计等待上限" };
			}

			// 退避等待后重试
			stats.retried++;
			const delay = computeDelay(config.retry, attempt, lastRetryAfterMs);
			if (config.showStatus) {
				const why = timeoutFired
					? `首字 ${Math.round(timeoutMs / 1000)}s 无响应`
					: emptyFired ? "空响应" : `错误${lastStatus !== undefined ? `(HTTP ${lastStatus})` : ""}`;
				footer.setRetryInfo(`重试 #${attempt}/${maxAttempts}（${why}，等 ${Math.round(delay / 1000)}s）`);
				footer.updateFooter(ctx);
			}
			await sleep(delay, userSignal);
			if (userSignal?.aborted) return { status: "aborted" };
		}
	}

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

		// 常驻 footer：启动实时秒表 + 记录被派发物理模型
		footer.setCurrentPhysical(model ? `${model.provider}/${model.id}` : undefined);
		footer.clearRetryInfo();
		footer.startTurnTimer(ctx);

		// 被派发模型 = 主（produce 由调用方捕获原始 stream，防递归）
		const dispatchedKey = model ? keyOf(model) : "unknown";
		chain.push({
			key: dispatchedKey,
			label: model ? `${model.provider}/${model.id}` : "unknown",
			model,
			isPrimary: true,
			produce,
		});

		// 其余候选（primary + fallbacks，去掉被派发模型；走原始流；透传同一 context = 无缝）
		// 防御：ctx 可能因 session 替换 / reload 已 stale。访问 ctx.modelRegistry 的 getter 会
		// assertActive() 抛 "extension ctx is stale"。这里 try/catch 兜住：stale 时跳过 fallback
		// 候选（只用主 produce），绝不把 stale 错误抛给 pi（那会注入无 usage 的 assistant error
		// 消息 → getSessionStats 崩溃）。
		// 同时把「是否 stale」结果传给后续 tryCandidate/footer，避免它们在 async 循环里
		// 反复访问已 stale 的 ctx（footer 内部已 try/catch，但 tryCandidate 的 produce 可能访问）。
		let ctxStale = false;
		try {
			for (const c of buildCandidates(ctx)) {
				if (c.key === dispatchedKey) continue;
				const fbProvider = ctx.modelRegistry?.getProvider(c.model.provider);
				if (!fbProvider) continue;
				const orig = origStreams.get(c.model.provider);
				chain.push({
					key: c.key,
					label: c.label,
					model: { provider: c.model.provider, id: c.model.id },
					isPrimary: false,
					produce: () =>
						orig?.stream
							? orig.stream.call(fbProvider, c.model, context, options)
							: fbProvider.stream(c.model, context, options),
				});
			}
		} catch (e) {
			// ctx stale：放弃 fallback 候选，只用主 produce（主 produce 不访问 ctx.modelRegistry，安全）。
			ctxStale = true;
			debug(`resilienceStream: skip fallback candidates (ctx stale): ${e instanceof Error ? e.message : String(e)}`);
		}

		(async () => {
			// stale ctx 时降级为 undefined：后续所有 footer / tryCandidate 调用都走
			// 安全路径（footer 无 ctx 即跳过刷新；tryCandidate 不再访问 stale ctx 的 getter）。
			const safeCtx = ctxStale ? undefined : ctx;
			try {
				const errors: string[] = [];
				for (let i = 0; i < chain.length; i++) {
					const cand = chain[i];

					// ① 熔断 / 冷却检查
					if (reliability.inCooldown(cand.key)) { debug(`skip ${cand.label}: in cooldown`); continue; }
					if (!reliability.canAttempt(cand.key)) { debug(`skip ${cand.label}: circuit open`); continue; }

					// ② 重试 + 首字看门狗（同一循环；备用也走同逻辑）
					const budget = cand.isPrimary ? config.retry.maxAttempts : config.fallback.maxAttempts;
					const res = await tryCandidate(cand.produce, cand.model, options, out, safeCtx, budget);

					switch (res.status) {
						case "success":
							if (!cand.isPrimary) stats.switched++;
							reliability.recordResult(cand.key, true);
							footer.stopTurnTimer();
							footer.clearRetryInfo();
							footer.updateFooter(safeCtx);
							out.end();
							return;
						case "aborted":
							reliability.releaseProbe(cand.key);
							stats.gaveUp++;
							footer.stopTurnTimer();
							footer.clearRetryInfo();
							footer.updateFooter(safeCtx);
							out.push(makeErrorEvent("已由用户取消"));
							return;
						case "committed":
							reliability.recordFailure(cand.model ?? { provider: "?", id: "?" }, res.error, res.httpStatus);
							reliability.recordResult(cand.key, false);
							stats.gaveUp++;
							footer.stopTurnTimer();
							footer.clearRetryInfo();
							footer.updateFooter(safeCtx);
							out.push(makeErrorEvent(res.error));
							return;
						case "nonRetryable":
							stats.gaveUp++;
							footer.stopTurnTimer();
							footer.clearRetryInfo();
							footer.updateFooter(safeCtx);
							out.push(makeErrorEvent(res.error));
							return;
						case "exhausted":
							// ③ 重试耗尽 → 熔断（判死刑）→ 切下一个
							if (cand.model) reliability.recordFailure(cand.model, res.error, res.httpStatus);
							reliability.recordResult(cand.key, false);
							errors.push(`${cand.label}: ${res.error}`);
							if (i + 1 < chain.length) stats.failedOver++;
							footer.clearRetryInfo();
							footer.updateFooter(safeCtx);
							debug(`failover ${cand.label} -> ${chain[i + 1]?.label ?? "give up"}`);
							continue;
					}
				}
				// 全失败
				stats.gaveUp++;
				footer.stopTurnTimer();
				footer.clearRetryInfo();
				footer.updateFooter(safeCtx);
				out.push(makeErrorEvent(errors.length > 0 ? errors.join("；") : "所有模型均不可用"));
			} finally {
				footer.stopTurnTimer();
				footer.clearRetryInfo();
				footer.updateFooter(safeCtx);
			}
		})().catch((err) => {
			out.push(makeErrorEvent(err instanceof Error ? err.message : String(err)));
			out.end();
		});

		return out;
	}

	return { tryCandidate, resilienceStream, buildCandidates };
}

export type Executor = ReturnType<typeof createExecutor>;
