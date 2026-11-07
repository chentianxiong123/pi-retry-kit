/**
 * test/fake-stream.ts —— 可控 AssistantMessageEventStream（单元层用）
 *
 * 让 executor 的 tryCandidate / resilienceStream 能在**没有真实 provider**的情况下，
 * 按脚本依次产出事件：error(5xx) / 超时 / 空响应 / 成功文本。用于单测重试/看门狗/熔断逻辑。
 * 全部 type-only import（bun test 直接跑，不需要 pi-ai 运行时）。
 */

import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function startEvent(): AssistantMessageEvent {
	return { type: "start" } as AssistantMessageEvent;
}

/** 有内容的文本增量（isContentEvent 判定为内容） */
export function textDelta(text: string): AssistantMessageEvent {
	return { type: "text_delta", delta: text } as AssistantMessageEvent;
}

/** 空文本增量（isContentEvent 判定为「非内容」，会进 prelude 缓冲） */
export function emptyTextDelta(): AssistantMessageEvent {
	return { type: "text_delta", delta: "" } as AssistantMessageEvent;
}

export function doneEvent(): AssistantMessageEvent {
	return { type: "done" } as AssistantMessageEvent;
}

export function errorEvent(message: string): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			stopReason: "error",
			errorMessage: message,
			content: [],
			usage: zeroUsage,
		} as unknown as AssistantMessage,
	} as AssistantMessageEvent;
}

export function thinkingDelta(text: string): AssistantMessageEvent {
	return { type: "thinking_delta", delta: text } as AssistantMessageEvent;
}

/** 脚本流：按数组顺序依次 yield 事件 */
export function scriptStream(events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
	return (async function* () {
		for (const e of events) yield e;
	})();
}

/** 便捷脚本：先 N 次失败（error），最后成功（文本+done） */
export function failThenSuccess(failCount: number, errMsg = "HTTP 500", okText = "PONG"): AssistantMessageEvent[] {
	const evs: AssistantMessageEvent[] = [];
	for (let i = 0; i < failCount; i++) evs.push(errorEvent(errMsg));
	evs.push(textDelta(okText), doneEvent());
	return evs;
}
