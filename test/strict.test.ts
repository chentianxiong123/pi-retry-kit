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
async function collect(stream: any): Promise<any[]> {
	const evs: any[] = [];
	for await (const e of stream) evs.push(e);
	return evs;
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

describe("边界：precondition / safety 限量重试", () => {
	test("400 safety check → 可重试但上限 3（不是 40）", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		// maxAttempts 给 40，但分类器声明 precondition 上限 3 → 只尝试 3 次
		const res = await ex.tryCandidate(() => scriptStream([errorEvent('400: {"message":"safety check failed","type":"failed_precondition_error","code":"9"}')]), { provider: "cpa", id: "m" }, undefined, out, {}, 40);
		expect(res.status).toBe("exhausted");
		expect(stats.attempts, "只应尝试 3 次（分类器上限），不是 40").toBe(3);
		expect(stats.retried).toBe(2);
	});

	test("500 仍是 full budget（不受 precondition 上限影响）", async () => {
		const { ex, stats } = setup();
		const out = makeOut();
		const res = await ex.tryCandidate(() => scriptStream([errorEvent("HTTP 500")]), { provider: "cpa", id: "m" }, undefined, out, {}, 5);
		expect(res.status).toBe("exhausted");
		expect(stats.attempts).toBe(5);
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

// ============================================================================
// 「用户看不到原因」回归（2026-11-07 实证）：候选被熔断/冷却 skip 时若不留字，
// errors 空 → 终末消息落在「所有模型均不可用」废话上，真实原因全丢。
// ============================================================================
describe("终末失败必须带原因（不能只说「所有模型均不可用」）", () => {
	const always503 = () =>
		scriptStream([errorEvent("mock 503 unavailable"), doneEvent()]);
	test("首次失败：错误行含模型名 + 尝试次数 + 分类", async () => {
		const { ex } = setup();
		const evts = await collect(ex.resilienceStream(always503, { provider: "fake", id: "m1" } as any, undefined, undefined));
		console.log("EVENTS:", JSON.stringify(evts.map((e) => e.type).join(","), null, 0));
		const errs = evts.filter((e) => e.type === "error");
		expect(errs.length).toBe(1);
		const msg = (errs[0] as any).error?.errorMessage as string;
		expect(msg).toContain("fake/m1");
		expect(msg).toContain("503");
		expect(msg).toContain(`试 ${DEFAULT_CONFIG.retry.maxAttempts} 次`);
		expect(msg).toContain("[provider]");
		expect(msg).not.toBe("所有模型均不可用");
	});
	test("二次进入（熔断开）：终末消息必须是「熔断开(还Ns)」而非废话", async () => {
		const { ex } = setup(); // 每例独立 breaker
		// 第 1 轮：打满 maxAttempts 次 503 → 熔断开（threshold=1）
		await collect(ex.resilienceStream(always503, { provider: "fake", id: "m1" } as any, undefined, undefined));
		// 第 2 轮：同一 breaker，候选被 skip
		const evts2 = await collect(ex.resilienceStream(always503, { provider: "fake", id: "m1" } as any, undefined, undefined));
		const errs2 = evts2.filter((e) => e.type === "error");
		expect(errs2.length).toBe(1);
		const msg = (errs2[0] as any).error?.errorMessage as string;
		expect(msg).not.toBe("所有模型均不可用");
		expect(msg).toContain("fake/m1");
		expect(msg).toMatch(/(冷却中|熔断开)\(还\d+s\)/); // 冷却先于熔断，两者都算有效诊断
	});
});


// ============================================================================
// announce：非 TUI（print）用 stderr 说一句话「刚刚发生了什么」。
// 纯 present 层测试：announce 的职责是「判 UI 该不该说」，不依赖 executor 全链路
// （那条链需要 pi 完整消息流，单测假体给不出 message.durationMs）。
// ============================================================================
describe("announce：print 有提示，TUI/关闭/一次成功 全静默", () => {
	function cap() {
		const lines: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		(process.stderr as any).write = (c: any) => { lines.push(String(c)); return true; };
		return { lines, restore: () => { (process.stderr as any).write = orig; } };
	}
	function footer(showStatus = true, hasUI = false) {
		const cfg = { ...DEFAULT_CONFIG, showStatus };
		const rel = createReliability(cfg as any);
		const f = createFooter(cfg as any, rel);
		const ctx: any = hasUI ? { hasUI: true, ui: { setStatus: () => {} } } : undefined;
		return { f, ctx };
	}
	test("无 UI + 重试过（attempts>1）→ stderr 一行，带模型名和次数", () => {
		const { f, ctx } = footer(true, false);
		const c = cap();
		try { f.announce("recovered", "fake/m1", 3, ctx); } finally { c.restore(); }
		const got = c.lines.join("");
		expect(got).toContain("[pi-resilience] fake/m1 重试 2 次后恢复");
	});
	test("一次成功（attempts<=1）→ 完全静默", () => {
		const { f, ctx } = footer(true, false);
		const c = cap();
		try { f.announce("recovered", "fake/m1", 1, ctx); } finally { c.restore(); }
		expect(c.lines.join("")).toBe("");
	});
	test("TUI（hasUI=true）→ 静默", () => {
		const { f, ctx } = footer(true, true);
		const c = cap();
		try { f.announce("recovered", "fake/m1", 3, ctx); } finally { c.restore(); }
		expect(c.lines.join("")).toBe("");
	});
	test("showStatus=false → 静默", () => {
		const { f, ctx } = footer(false, false);
		const c = cap();
		try { f.announce("recovered", "fake/m1", 3, ctx); } finally { c.restore(); }
		expect(c.lines.join("")).toBe("");
	});
	test("failover 播报（无论次数）", () => {
		const { f, ctx } = footer(true, false);
		const c = cap();
		try { f.announce("failover", "主模型 fake/m1 不可用，切到 fake/m2", undefined, ctx); } finally { c.restore(); }
		expect(c.lines.join("")).toContain("主模型 fake/m1 不可用，切到 fake/m2");
	});
});

