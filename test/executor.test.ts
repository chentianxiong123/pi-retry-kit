/**
 * test/executor.test.ts —— 执行层单测（用 fake-stream，无 pi、无网络）
 * 覆盖 tryCandidate 的重试/看门狗/空响应/非可重试/耗尽 + resilienceStream 级联。
 */
import { describe, expect, test } from "bun:test";
import { createExecutor } from "../lib/executor.js";
import { createReliability } from "../lib/reliability.js";
import { createFooter } from "../lib/present.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import { scriptStream, failThenSuccess, errorEvent, doneEvent, textDelta } from "./fake-stream.js";

/** 测试用零退避 config（重试等待立即返回，避免单测超时） */
function fastConfig() {
	return {
		...DEFAULT_CONFIG,
		retry: {
			...DEFAULT_CONFIG.retry,
			backoff: { baseDelayMs: 0, maxDelayMs: 0, multiplier: 1, jitter: 0 },
		},
	};
}

function setup() {
	const config = fastConfig();
	const stats = { attempts: 0, retried: 0, recovered: 0, failedOver: 0, switched: 0, gaveUp: 0 };
	const reliability = createReliability(config);
	const footer = createFooter(config, reliability);
	const origStreams = new Map();
	const ex = createExecutor({ config, reliability, footer, stats, origStreams });
	return { config, stats, reliability, footer, ex };
}

/** 收集 out（push/end 的假 AssistantMessageEventStream） */
function makeOut() {
	const evs: any[] = [];
	return {
		evs,
		push: (e: any) => evs.push(e),
		end: () => {},
		[Symbol.asyncIterator]() {
			return (async function* () {
				for (const e of evs) yield e;
			})();
		},
	} as any;
}

const model = { provider: "cpa", id: "m1" };

describe("tryCandidate：重试 + 看门狗", () => {
	test("失败2次后成功 → retried=2 recovered=1，成功文本放行", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		// 跨尝试计数：第 1、2 次 produce 返回 error，第 3 次返回成功
		let call = 0;
		const res = await ex.tryCandidate(
			() => {
				call++;
				return call <= 2 ? scriptStream([errorEvent("HTTP 500")]) : scriptStream(failThenSuccess(0, "HTTP 500", "PONG"));
			},
			model,
			undefined,
			out,
			{},
			5,
		);
		expect(res.status).toBe("success");
		expect(stats.retried).toBe(2);
		expect(stats.recovered).toBe(1);
		expect(out.evs.some((e: any) => e.type === "text_delta" && e.delta === "PONG")).toBe(true);
	});

	test("重试耗尽 → exhausted（判死刑）", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		const res = await ex.tryCandidate(() => scriptStream([errorEvent("HTTP 500")]), model, undefined, out, {}, 3);
		expect(res.status).toBe("exhausted");
		expect(stats.retried).toBe(2); // 3 次尝试，重试 2 次
	});

	test("非可重试（鉴权类）→ nonRetryable，不重试", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		const res = await ex.tryCandidate(() => scriptStream([errorEvent("Invalid API key")]), model, undefined, out, {}, 5);
		expect(res.status).toBe("nonRetryable");
		expect(stats.retried).toBe(0);
	});

	test("空响应（done 无内容）+ retryOnEmpty → 重试", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		// 每次 produce 都只给 done（无内容）→ emptyFired → 重试，直到 maxAttempts
		const res = await ex.tryCandidate(() => scriptStream([doneEvent()]), model, undefined, out, {}, 3);
		expect(res.status).toBe("exhausted");
		expect(stats.retried).toBeGreaterThan(0);
	});

	test("首字看门狗：超时后重试（短 ttft）", async () => {
		const cfg = { ...fastConfig(), ttft: { ...DEFAULT_CONFIG.ttft, enabled: true, firstTokenTimeoutMs: 10, retryOnEmpty: false } };
		const stats = { attempts: 0, retried: 0, recovered: 0, failedOver: 0, switched: 0, gaveUp: 0 };
		const reliability = createReliability(cfg);
		const footer = createFooter(cfg, reliability);
		const ex = createExecutor({ config: cfg, reliability, footer, stats, origStreams: new Map() });
		const out = makeOut();
		// produce：先挂起（不产出，触发超时），再成功
		let call = 0;
		const res = await ex.tryCandidate(
			() => {
				call++;
				if (call === 1) return scriptStream([]); // 空流 → 超时
				return scriptStream(failThenSuccess(0, "HTTP 500", "PONG"));
			},
			model,
			undefined,
			out,
			{},
			3,
		);
		expect(res.status).toBe("success");
		expect(stats.retried).toBeGreaterThanOrEqual(1);
	});
});

describe("resilienceStream：候选级联 + 熔断", () => {
	test("主模型耗尽后切 fallback（buildCandidates 用 fake registry）", async () => {
		const { ex, stats, reliability } = setup();
		const out = makeOut();
		// fake ctx.modelRegistry：find 返回模型，getProvider 返回带 stream 的 provider（fallback 用）
		const produceByModel: Record<string, () => AsyncIterable<any>> = {
			"primary-m": () => scriptStream([errorEvent("HTTP 500")]),
			"fb-m": () => scriptStream(failThenSuccess(0, "HTTP 500", "FB_OK")),
		};
		const registry = {
			find: (_p: string, m: string) => ({ provider: "cpa", id: m, name: m }),
			getProvider: (p: string) => ({
				provider: p,
				name: p,
				stream: (m: any) => produceByModel[m.id](),
				streamSimple: (m: any) => produceByModel[m.id](),
			}),
		};
		const ctx: any = { modelRegistry: registry };
		// 候选：primary(失败) + fallback(成功)
		// buildCandidates 从 config.primary/fallback.models 构造——用 DEFAULT_CONFIG 的 primary/fallback
		// 但 DEFAULT_CONFIG.primary/fallback 可能未设，用 override
		const cfg = {
			...fastConfig(),
			primary: { provider: "cpa", model: "primary-m" },
			fallback: { ...DEFAULT_CONFIG.fallback, models: [{ provider: "cpa", model: "fb-m" }], maxAttempts: 3 },
		};
		const stats2 = { attempts: 0, retried: 0, recovered: 0, failedOver: 0, switched: 0, gaveUp: 0 };
		const reliability2 = createReliability(cfg);
		const footer = createFooter(cfg, reliability2);
		const ex2 = createExecutor({ config: cfg, reliability: reliability2, footer, stats: stats2, origStreams: new Map() });
		const stream = ex2.resilienceStream(
			() => produceByModel["primary-m"](),
			{ provider: "cpa", id: "primary-m" },
			undefined as any,
			undefined,
			ctx,
		);
		const evs: any[] = [];
		for await (const e of stream) evs.push(e);
		expect(stats2.failedOver).toBe(1);
		expect(evs.some((e) => e.type === "text_delta" && e.delta === "FB_OK")).toBe(true);
	});
});
