import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessageEventStream,
	Model,
	StreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { loadConfig } from "../lib/config.js";
import { createReliability } from "../lib/reliability.js";
import { createFooter } from "../lib/present.js";
import { createExecutor } from "../lib/executor.js";
import { keyOf, debug } from "../lib/core.js";

// ============================================================================
// extensions/pi-resilience.ts —— 接入层（入口）
// 职责：组装各层，并把插件接到 pi 上：
//   wrapProvider  —— 包装 provider.stream / streamSimple（请求入口，接入层）
//   route()        —— 虚拟模型选物理模型（路由层）
//   事件           —— session_start / model_select / session_before_*（生命周期）
//   /pi-resilience —— 状态命令（呈现）
//
// 分层：config(配置) / core(纯决策) / reliability(熔断决策) / executor(执行) /
//       present(footer 呈现)。本文件只做组装和接入，不写业务逻辑。
//
// 核心承诺：无感、无缝。
//   无感：包装 provider stream，内部重试/切换，从不 pi.sendMessage / 不注入消息、
//         不依赖 pi 内置 retry，pi 和模型全程无感。
//   无缝：切到备用模型时，把同一个 TranscriptContext（对话消息数组）传给备用
//         provider.stream() —— 备用模型看到完整对话，接着写，用户毫无察觉。
//         同时「内容前」事件（start 等）先缓冲，失败候选丢弃、成功候选才放行，
//         避免重复 start / 失败候选污染输出流。
// ============================================================================

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const wrappedProviders = new Set<string>();
	/** 每个 provider 的原始 stream（包装前捕获），供 fallback 防递归 */
	const origStreams = new Map<string, { stream?: (m: Model<Api>, c: TranscriptContext, o?: StreamOptions) => AssistantMessageEventStream }>();
	const stats = { attempts: 0, retried: 0, recovered: 0, failedOver: 0, switched: 0, gaveUp: 0 };

	const reliability = createReliability(config);
	const footer = createFooter(config, reliability);
	const executor = createExecutor({ config, reliability, footer, stats, origStreams });

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
				executor.resilienceStream(
					() => origStream.call(base, model, context, options),
					model ? { provider: model.provider, id: model.id } : undefined,
					context,
					options,
					ctx,
				);
		}
		if (origSimple) {
			base.streamSimple = (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
				executor.resilienceStream(
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

	// ---- 会话开始 / 模型切换时包装当前 provider（含全部备用 provider，防切过去后失去保护）----
	pi.on("session_start", async (_event, ctx) => {
		wrapProvider(ctx.model?.provider, ctx);
		for (const fb of config.fallback.models) wrapProvider(fb.provider, ctx);
		if (config.primary) wrapProvider(config.primary.provider, ctx);
		footer.setCurrentPhysical(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		footer.updateFooter(ctx);
	});
	pi.on("model_select", async (event, ctx) => {
		wrapProvider(event.model?.provider, ctx);
		for (const fb of config.fallback.models) wrapProvider(fb.provider, ctx);
		if (config.primary) wrapProvider(config.primary.provider, ctx);
		footer.setCurrentPhysical(event.model ? `${event.model.provider}/${event.model.id}` : undefined);
		footer.updateFooter(ctx);
	});

	// ---- 秒表生命周期：session 切换 / 关闭时彻底释放定时器，防止旧 ctx 在 session 结束后仍被定时器触碰 ----
	// 这是 stale-ctx 崩溃（Cannot read properties of undefined (reading 'input')）的根治：
	// 之前 setInterval 闭包捕获旧 ctx，session 替换后仍调用 setStatus → pi 注入无 usage 的 assistant error 消息
	// → pi 的 getSessionStats 遍历到该消息时对 usage 无守卫 → 崩溃。
	pi.on("session_before_switch", () => { footer.disposeTurnTimer(); });
	pi.on("session_shutdown", () => { footer.disposeTurnTimer(); });
	pi.on("session_before_fork", () => { footer.disposeTurnTimer(); });
	pi.on("session_before_compact", () => { footer.disposeTurnTimer(); });

	// ---- 虚拟模型 route：无缝换模型（pi 统计记实际 dispatch 的物理模型）----
	// 用户选 pi-resilience/auto，pi 每次请求前调 route() 按电路选物理模型：
	//   主健康 → 主；主熔断 → 第一个健康备用。retry 时跳过失败模型。
	//   continuation 且 previous 健康 → 保留 previous（prompt cache）。
	pi.registerVirtualModel({
		provider: "pi-resilience",
		id: "auto",
		name: "Auto (resilience)",
		thinkingLevels: ["off", "low", "medium", "high"],
		route(request, ctx) {
			const candidates = executor.buildCandidates(ctx);
			if (candidates.length === 0) {
				// 无候选：退到 previous（保缓存）；若无 previous 则报错
				if (request.previous?.model) {
					return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
				}
				throw new Error("pi-resilience: 无有效候选模型（检查 primary / fallback.models）");
			}
			const failedKey =
				request.reason === "retry" && request.failed
					? keyOf({ provider: request.failed.model.provider, id: request.failed.model.id })
					: undefined;
			// continuation：若 previous 健康，保留它（prompt cache 有效，无缝）
			if (
				request.reason !== "user" &&
				request.previous &&
				keyOf({ provider: request.previous.model.provider, id: request.previous.model.id }) !== failedKey &&
				reliability.isHealthy(keyOf({ provider: request.previous.model.provider, id: request.previous.model.id }))
			) {
				return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
			}
			// 选第一个健康候选（跳过失败模型）
			for (const c of candidates) {
				if (c.key === failedKey) continue;
				if (reliability.isHealthy(c.key)) return { model: c.model, thinkingLevel: request.thinkingLevel };
			}
			// 全部不健康：取第一个（非失败）候选去试（half-open 探测）
			const first = candidates.find((c) => c.key !== failedKey) ?? candidates[0];
			return { model: first.model, thinkingLevel: request.thinkingLevel };
		},
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
			if (config.primary) lines.push(`主=${config.primary.provider}/${config.primary.model}`);
			for (const [key, s] of reliability.breaker.circuits) {
				const next = s.state === "open" ? ` → 恢复于 ${new Date(s.nextRetryTime).toLocaleTimeString()}` : "";
				lines.push(`  ${key}: ${s.state} (失败${s.failureCount})${next}`);
			}
			lines.push(
				`本会话：请求 ${stats.attempts}，重试 ${stats.retried}，救回 ${stats.recovered}，切换 ${stats.failedOver}，成功切备用 ${stats.switched}，放弃 ${stats.gaveUp}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	debug("pi-resilience loaded");
}
