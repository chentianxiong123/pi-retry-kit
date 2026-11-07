/**
 * test/core.test.ts —— 纯函数单测（无 pi、无网络、毫秒级）
 * 覆盖 shouldRetry / computeDelay / ttftTimeoutFor / compileText / keyOf。
 */
import { describe, expect, test } from "bun:test";
import { shouldRetry, computeDelay, ttftTimeoutFor, compileText, keyOf } from "../lib/core.js";
import { DEFAULT_CONFIG } from "../lib/config.js";

describe("shouldRetry", () => {
	const retry = DEFAULT_CONFIG.retry;

	test("mode=all 一律重试", () => {
		expect(shouldRetry({ ...retry, mode: "all" }, 500, "boom", [])).toBe(true);
		expect(shouldRetry({ ...retry, mode: "all" }, 400, "bad", [])).toBe(true);
	});

	test("mode=allowlist：status 命中才重试", () => {
		const allow = { ...retry, mode: "allowlist" as const, matchStatus: [429, 500] };
		expect(shouldRetry(allow, 500, "", [])).toBe(true);
		expect(shouldRetry(allow, 429, "", [])).toBe(true);
		expect(shouldRetry(allow, 400, "", [])).toBe(false);
	});

	test("mode=allowlist：matchText 命中才重试", () => {
		const allow = { ...retry, mode: "allowlist" as const };
		const compiled = compileText(["quota", "rate.?limit"]);
		expect(shouldRetry(allow, undefined, "quota exceeded", compiled)).toBe(true);
		expect(shouldRetry(allow, undefined, "rate limit hit", compiled)).toBe(true);
		expect(shouldRetry(allow, undefined, "bad request", compiled)).toBe(false);
	});

	test("mode=denylist：命中不重试，其余重试", () => {
		const deny = { ...retry, mode: "denylist" as const };
		const compiled = compileText(["bad request"]);
		expect(shouldRetry(deny, undefined, "bad request", compiled)).toBe(false);
		expect(shouldRetry(deny, undefined, "network down", compiled)).toBe(true);
	});

	test("无 status 且无文本命中 → allowlist 不重试", () => {
		const allow = { ...retry, mode: "allowlist" as const };
		expect(shouldRetry(allow, undefined, "", [])).toBe(false);
	});
});

describe("computeDelay", () => {
	const retry = DEFAULT_CONFIG.retry;
	const base = { ...retry, backoff: { ...retry.backoff, jitter: 0 } };

	test("指数退避：attempt1=base, attempt2=base*multiplier", () => {
		expect(computeDelay(base, 1, 0)).toBe(base.backoff.baseDelayMs);
		expect(computeDelay(base, 2, 0)).toBe(base.backoff.baseDelayMs * base.backoff.multiplier);
	});

	test("respectRetryAfter：retry-after 生效", () => {
		expect(computeDelay({ ...base, respectRetryAfter: true }, 1, 5000)).toBe(5000);
	});

	test("不 respectRetryAfter：忽略 retry-after，走退避", () => {
		expect(computeDelay({ ...base, respectRetryAfter: false }, 1, 5000)).toBe(base.backoff.baseDelayMs);
	});

	test("cap：不超过 maxDelayMs", () => {
		const small = { ...base, backoff: { ...base.backoff, maxDelayMs: 10000 } };
		expect(computeDelay(small, 10, 0)).toBe(10000);
	});
});

describe("ttftTimeoutFor", () => {
	const ttft = DEFAULT_CONFIG.ttft;

	test("默认超时（无模型匹配）", () => {
		expect(ttftTimeoutFor(ttft, undefined)).toBe(ttft.firstTokenTimeoutMs);
		expect(ttftTimeoutFor(ttft, { provider: "x", id: "y" })).toBe(ttft.firstTokenTimeoutMs);
	});

	test("model pattern 命中返回定制超时", () => {
		const custom = {
			...ttft,
			models: { "cpa/glm-*": { firstTokenTimeoutMs: 9999 } },
		} as typeof ttft;
		expect(ttftTimeoutFor(custom, { provider: "cpa", id: "glm-5.3-flash" })).toBe(9999);
	});
});

describe("keyOf", () => {
	test("拼接 provider/model", () => {
		expect(keyOf({ provider: "cpa", id: "m1" })).toBe("cpa/m1");
	});
});
