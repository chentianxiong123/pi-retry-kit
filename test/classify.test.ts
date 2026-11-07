/**
 * test/classify.test.ts —— 分类器单测（错误码优先）
 *
 * 核心断言：provider 的 message 散文可能是本地化/误导的，**数字 status 才是权威**。
 */
import { describe, expect, test } from "bun:test";
import { classifyFailure, getFailureCooldownMs } from "../lib/failure-classifier.js";

describe("① 数字 HTTP 状态码权威", () => {
	test("status=400 即使 message 撒谎也判 precondition（限量）", () => {
		const c = classifyFailure('400: {"message":"服务繁忙，请稍后重试"}', 400);
		expect(c.kind).toBe("precondition");
		expect(c.maxAttempts).toBe(3);
	});
	test("status=401 判 auth 不重试（即使 message 说 timeout 也不算）", () => {
		expect(classifyFailure("401 timeout", 401).kind).toBe("auth");
	});
	test("status=429 判 rate-limit", () => {
		expect(classifyFailure("429", 429).kind).toBe("rate-limit");
	});
	test("status=408 判 timeout", () => {
		expect(classifyFailure("", 408).kind).toBe("timeout");
	});
	test("status >= 500 判 provider（500/502/503/504/524）", () => {
		for (const s of [500, 502, 503, 504, 524]) {
			expect(classifyFailure("", s).kind, `status ${s}`).toBe("provider");
		}
	});
	test("status=404/413 判 unknown 不重试", () => {
		expect(classifyFailure("404 not found", 404).kind).toBe("unknown");
		expect(classifyFailure("413 too large", 413).retryable).toBe(false);
	});
	test("message 里带 500 字样但 status=400 → 仍判 precondition（别被散文骗）", () => {
		expect(classifyFailure("400: internal 500 mentioned", 400).kind).toBe("precondition");
	});
});

describe("② 结构化 body 字段（type/code）", () => {
	test("failed_precondition_error → precondition 限量", () => {
		expect(classifyFailure('400: {"type":"failed_precondition_error","code":"9"}').kind).toBe("precondition");
	});
	test("insufficient_quota → rate-limit 可重试", () => {
		expect(classifyFailure('{"error":{"type":"insufficient_quota"}}').kind).toBe("rate-limit");
	});
	test("authentication_error → auth 不重试", () => {
		expect(classifyFailure('{"error":{"type":"authentication_error"}}').kind).toBe("auth");
	});
	test("overloaded_error → provider 可重试", () => {
		expect(classifyFailure('{"error":{"type":"overloaded_error"}}').kind).toBe("provider");
	});
	test("非 JSON body → 不崩，走兜底", () => {
		expect(classifyFailure("plain text failure").kind).toBe("unknown");
	});
});

describe("③ abort 仍判死不重试", () => {
	test("AbortError 字样", () => {
		expect(classifyFailure("AbortError: signal is aborted without reason").kind).toBe("abort");
	});
});

describe("④ 文本兜底（status 缺失时）", () => {
	test("ECONNREFUSED → network", () => {
		expect(classifyFailure("connect ECONNREFUSED 127.0.0.1:443").kind).toBe("network");
	});
	test("IP/端口不被误当 HTTP 状态码（127/443 不命中白名单）", () => {
		// 回归：旧实现把 127 当 status → unknown，网络错被误判
		expect(classifyFailure("ECONNRESET 10.0.0.255:8080").kind).toBe("network");
		expect(classifyFailure("v2.1.0 fetch failed").kind).toBe("unknown"); // 无网络类关键词，确实是未知
	});
	test("ETIMEDOUT → timeout", () => {
		expect(classifyFailure("connect ETIMEDOUT").kind).toBe("timeout");
	});
	test("Invalid API key → auth", () => {
		expect(classifyFailure("Invalid API key").kind).toBe("auth");
	});
	test("未知文本 → unknown 不重试", () => {
		expect(classifyFailure("something weird").retryable).toBe(false);
	});
});

describe("冷却时长（码优先）", () => {
	test("status=503 → provider 冷却用配置值", () => {
		expect(getFailureCooldownMs("busy", 60000, 503).cooldownMs).toBe(60000);
	});
	test("status=408 → timeout 冷却 5s", () => {
		expect(getFailureCooldownMs("", 60000, 408).cooldownMs).toBe(5000);
	});
	test("status=400 → precondition 用配置值", () => {
		expect(getFailureCooldownMs("", 60000, 400).cooldownMs).toBe(60000);
	});
});
