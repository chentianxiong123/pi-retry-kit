/**
 * test/reliability.test.ts —— 熔断决策单测（无 pi、无网络）
 * 覆盖 canAttempt / recordResult / releaseProbe / inCooldown / isHealthy。
 */
import { describe, expect, test } from "bun:test";
import { createReliability } from "../lib/reliability.js";
import { DEFAULT_CONFIG } from "../lib/config.js";

function makeRel(overrides: Partial<typeof DEFAULT_CONFIG.breaker> = {}) {
	return createReliability({ ...DEFAULT_CONFIG, breaker: { ...DEFAULT_CONFIG.breaker, ...overrides } });
}

describe("熔断决策", () => {
	test("closed 初始：canAttempt 允许", () => {
		const r = makeRel();
		expect(r.canAttempt("cpa/m1")).toBe(true);
		expect(r.isHealthy("cpa/m1")).toBe(true);
	});

	test("阈值1：一次失败即熔断 → canAttempt false / isHealthy false", () => {
		const r = makeRel({ failureThreshold: 1 });
		r.recordResult("cpa/m1", false);
		expect(r.canAttempt("cpa/m1")).toBe(false);
		expect(r.isHealthy("cpa/m1")).toBe(false);
	});

	test("成功不熔断", () => {
		const r = makeRel({ failureThreshold: 1 });
		r.recordResult("cpa/m1", true);
		expect(r.canAttempt("cpa/m1")).toBe(true);
	});

	test("冷却：recordFailure 后 inCooldown=true（未过期）", () => {
		const r = makeRel({ cooldownMs: 60000 });
		r.recordFailure({ provider: "cpa", id: "m1" }, "HTTP 500");
		expect(r.inCooldown("cpa/m1")).toBe(true);
	});

	test("resetTimeout 过后 canAttempt 恢复（half-open 探测）", async () => {
		const r = makeRel({ failureThreshold: 1, resetTimeoutMs: 5 });
		r.recordResult("cpa/m1", false);
		expect(r.canAttempt("cpa/m1")).toBe(false);
		await new Promise((ok) => setTimeout(ok, 15));
		expect(r.canAttempt("cpa/m1")).toBe(true); // nextRetryTime 已过 → half-open 探测
	});

	test("releaseProbe 释放 half-open 探测槽（halfOpenInFlight 清空）", () => {
		const r = makeRel({ failureThreshold: 1, resetTimeoutMs: 100000 });
		r.recordResult("cpa/m1", false);
		const s = r.breaker.circuits.get("cpa/m1")!;
		s.nextRetryTime = Date.now() - 1;
		expect(r.canAttempt("cpa/m1")).toBe(true); // 认领探测槽（half-open，halfOpenInFlight=true）
		expect(s.halfOpenInFlight).toBe(true);
		r.releaseProbe("cpa/m1"); // 释放探测槽
		expect(s.halfOpenInFlight).toBe(false);
		expect(s.state).toBe("open");
	});

	test("enable=false：永不熔断", () => {
		const r = makeRel({ enabled: false, failureThreshold: 1 });
		r.recordResult("cpa/m1", false);
		expect(r.canAttempt("cpa/m1")).toBe(true);
	});
});
