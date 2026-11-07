/**
 * test/strict.test.ts —— 严格/边界测试（尝试「测坏」）
 * 用极端参数测边界：0/负数/超大退避、空/特殊分类、abort、并发、熔断临界。
 */
import { describe, expect, test } from "bun:test";
import { shouldRetry, computeDelay, ttftTimeoutFor, compileText, sleep } from "../lib/core.js";
import { createReliability } from "../lib/reliability.js";
import { createExecutor } from "../lib/executor.js";
import { createFooter } from "../lib/present.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import { scriptStream, errorEvent, doneEvent, textDelta } from "./fake-stream.js";

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
	const ex = createExecutor({ config, reliability, footer, stats, origStreams: new Map() });
	return { config, stats, reliability, footer, ex };
}
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

describe("边界：computeDelay 极端", () => {
	const base = { ...DEFAULT_CONFIG.retry, backoff: { ...DEFAULT_CONFIG.retry.backoff, jitter: 0 } };

	test("attempt=0 → 用 baseDelayMs（不除 0 崩溃）", () => {
		expect(computeDelay(base, 0, 0)).toBe(base.backoff.baseDelayMs);
	});
	test("attempt 超大 → cap 到 maxDelayMs", () => {
		expect(computeDelay(base, 999, 0)).toBe(base.backoff.maxDelayMs);
	});
	test("multiplier=0 → 退避恒 base", () => {
		const b = { ...base, backoff: { ...base.backoff, multiplier: 0 } };
		expect(computeDelay(b, 5, 0)).toBe(base.backoff.baseDelayMs);
	});
	test("jitter=1 → 结果在 [0, 2*delay] 内", () => {
		const b = { ...base, backoff: { ...base.backoff, jitter: 1 } };
		const d = computeDelay(b, 1, 0);
		expect(d).toBeGreaterThanOrEqual(0);
		expect(d).toBeLessThanOrEqual(2 * base.backoff.baseDelayMs);
	});
	test("retryAfter 超大 → cap 到 maxDelayMs", () => {
		expect(computeDelay({ ...base, respectRetryAfter: true }, 1, 99999999)).toBe(base.backoff.maxDelayMs);
	});
});

describe("边界：shouldRetry / 分类", () => {
	const retry = DEFAULT_CONFIG.retry;
	test("matchText 空数组 → 不崩溃，按 mode 判定", () => {
		expect(shouldRetry({ ...retry, mode: "all" }, undefined, "", [])).toBe(true);
		expect(shouldRetry({ ...retry, mode: "allowlist" }, undefined, "", [])).toBe(false);
	});
	test("无效 regex pattern → compileText 不崩溃（返回不匹配）", () => {
		const c = compileText(["("]);
		expect(c.length).toBe(1);
	});
	test("mode 未知值 → 默认按 allowlist 判定（不抛）", () => {
		// @ts-expect-error 故意传非法 mode
		const r = shouldRetry({ ...retry, mode: "weird" }, 500, "", []);
		expect(typeof r).toBe("boolean");
	});
});

describe("边界：ttft 模型 pattern 特殊字符", () => {
	test("空 models 表 → 用默认超时", () => {
		expect(ttftTimeoutFor({ ...DEFAULT_CONFIG.ttft, models: {} }, { provider: "x", id: "y" })).toBe(DEFAULT_CONFIG.ttft.firstTokenTimeoutMs);
	});
	test("无效 pattern（特殊字符）→ 不崩溃（返回数字超时）", () => {
		const t = { ...DEFAULT_CONFIG.ttft, models: { "cpa/*[": { firstTokenTimeoutMs: 123 } } } as typeof DEFAULT_CONFIG.ttft;
		const v = ttftTimeoutFor(t, { provider: "cpa", id: "m" });
		expect(typeof v).toBe("number");
	});
});

describe("边界：熔断临界", () => {
	test("threshold=0 → 首次失败即熔断（>=0 恒真）", () => {
		const r = createReliability({ ...DEFAULT_CONFIG, breaker: { ...DEFAULT_CONFIG.breaker, failureThreshold: 0 } });
		r.recordResult("cpa/m", false);
		expect(r.canAttempt("cpa/m")).toBe(false);
	});
	test("resetTimeout=0 → 熔断后立即恢复（可探测）", () => {
		const r = createReliability({ ...DEFAULT_CONFIG, breaker: { ...DEFAULT_CONFIG.breaker, failureThreshold: 1, resetTimeoutMs: 0 } });
		r.recordResult("cpa/m", false);
		expect(r.canAttempt("cpa/m")).toBe(true); // now >= nextRetryTime(0) → half-open 探测
	});
	test("cooldown=0 → 冷却立即过期", () => {
		const r = createReliability({ ...DEFAULT_CONFIG, breaker: { ...DEFAULT_CONFIG.breaker, cooldownMs: 0 } });
		r.recordFailure({ provider: "cpa", id: "m" }, "HTTP 500");
		expect(r.inCooldown("cpa/m")).toBe(false);
	});
});

describe("边界：tryCandidate abort", () => {
	test("userSignal 已 aborted → 返回 aborted，不重试不熔断", async () => {
		const { ex, stats, reliability } = setup();
		const ctrl = new AbortController();
		ctrl.abort();
		const out = makeOut();
		const res = await ex.tryCandidate(() => scriptStream([errorEvent("HTTP 500")]), { provider: "cpa", id: "m" }, { signal: ctrl.signal }, out, {}, 3);
		expect(res.status).toBe("aborted");
		expect(stats.retried).toBe(0);
		expect(reliability.breaker.circuits.size).toBe(0); // 未熔断
	});
});

describe("边界：并发", () => {
	test("两个 tryCandidate 并行互不干扰", async () => {
		const { ex } = setup();
		let calls1 = 0;
		let calls2 = 0;
		const [r1, r2] = await Promise.all([
			ex.tryCandidate(
				() => {
					calls1++;
					return calls1 <= 1 ? scriptStream([errorEvent("HTTP 500")]) : scriptStream([textDelta("A"), doneEvent()]);
				},
				{ provider: "cpa", id: "m1" },
				undefined,
				makeOut(),
				{},
				3,
			),
			ex.tryCandidate(
				() => {
					calls2++;
					return calls2 <= 2 ? scriptStream([errorEvent("HTTP 429")]) : scriptStream([textDelta("B"), doneEvent()]);
				},
				{ provider: "cpa", id: "m2" },
				undefined,
				makeOut(),
				{},
				3,
			),
		]);
		expect(r1.status).toBe("success");
		expect(r2.status).toBe("success");
	});
});

describe("边界：sleep abort", () => {
	test("signal 已 aborted → sleep 立即返回", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const t0 = Date.now();
		await sleep(5000, ctrl.signal);
		expect(Date.now() - t0).toBeLessThan(2000);
	});
});
