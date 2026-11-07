import type {
	AssistantMessage,
	AssistantMessageEvent,
} from "@earendil-works/pi-ai";

// ============================================================================
// lib/core.ts —— 纯工具 + 纯决策函数
// 职责：无状态的工具函数（sleep/pattern/事件判定）与纯决策函数
//       （shouldRetry / computeDelay / ttftTimeoutFor）。全部接受参数，不持有状态，
//       便于单测。状态（熔断电路、统计、footer）在其他层。
// ============================================================================

import type { ResilienceConfig } from "./config.js";

export type ModelInfo = { provider: string; id: string } | undefined;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
	});
}

export function modelPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

export function makeErrorEvent(message: string): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			stopReason: "error",
			errorMessage: message,
			content: [],
			// 必须带 usage：pi 的 FooterComponent.getSessionStats 遍历消息时，
			// addUsageToTotals 会读 msg.usage.input，缺 usage 则 undefined 崩溃
			// （Cannot read properties of undefined (reading 'input')）。
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as unknown as AssistantMessage,
	};
}

/** 首个真实内容事件：非空 text/thinking/toolcall delta */
export function isContentEvent(ev: AssistantMessageEvent): boolean {
	return (
		(ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") &&
		((ev as { delta?: string }).delta?.length ?? 0) > 0
	);
}

const CONTEXT_OVERFLOW_PATTERN =
	/prompt.*(?:too long|exceeds|is longer)|context.*(?:length|limit|exceeded)|max.*(?:token|context)|token.*(?:limit|exceeded)|input.*too long|maximum context/i;

export function isContextOverflowText(text: string): boolean {
	return CONTEXT_OVERFLOW_PATTERN.test(text);
}

export function debug(msg: string): void {
	if (process.env.PI_RESILIENCE_DEBUG) console.warn(`[pi-resilience] ${msg}`);
}

export const keyOf = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

export function compileText(patterns: string[]): RegExp[] {
	return patterns.map((p) => {
		try { return new RegExp(p, "i"); } catch { return /$^/; }
	});
}

/** 重试模式判定（mode=all 全重试；否则按 matchStatus/matchText 命中，allowlist=命中才重试，denylist=命中不重试） */
export function shouldRetry(
	retry: ResilienceConfig["retry"],
	status: number | undefined,
	errText: string,
	compiled: RegExp[],
): boolean {
	if (retry.mode === "all") return true;
	const hit =
		(status !== undefined && retry.matchStatus.includes(status)) ||
		compiled.some((re) => re.test(errText));
	return retry.mode === "allowlist" ? hit : !hit;
}

export function computeDelay(retry: ResilienceConfig["retry"], attempt: number, retryAfterMs: number): number {
	let delay: number;
	if (retry.respectRetryAfter && retryAfterMs > 0) {
		delay = retryAfterMs;
	} else {
		delay = retry.backoff.baseDelayMs * retry.backoff.multiplier ** Math.min(attempt - 1, 10);
	}
	delay = Math.min(delay, retry.backoff.maxDelayMs);
	if (retry.backoff.jitter > 0) {
		delay = Math.max(0, Math.round(delay * (1 + retry.backoff.jitter * (Math.random() * 2 - 1))));
	}
	return delay;
}

export function ttftTimeoutFor(ttft: ResilienceConfig["ttft"], m: ModelInfo): number {
	if (m) {
		const label = `${m.provider}/${m.id}`;
		for (const [pattern, o] of Object.entries(ttft.models)) {
			if (modelPattern(pattern).test(label)) return o.firstTokenTimeoutMs ?? ttft.firstTokenTimeoutMs;
		}
	}
	return ttft.firstTokenTimeoutMs;
}
