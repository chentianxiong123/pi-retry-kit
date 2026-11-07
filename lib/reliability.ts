import {
	canAttemptCircuit,
	recordCircuitResult,
	releaseCircuitProbe,
	type CircuitBreaker,
} from "./circuit-breaker.js";
import { getFailureCooldownMs } from "./failure-classifier.js";
import { keyOf, modelPattern, debug } from "./core.js";
import type { ResilienceConfig } from "./config.js";

// ============================================================================
// lib/reliability.ts —— 熔断决策层
// 职责：持有熔断电路状态（open/closed/half-open）+ 失败冷却表。
//       暴露决策操作：canAttempt / recordResult / releaseProbe / inCooldown /
//       recordFailure / isHealthy。是「某模型还行不行」的唯一裁决者。
// ============================================================================

export function createReliability(config: ResilienceConfig) {
	const breaker: CircuitBreaker = {
		circuits: new Map(),
		failureThreshold: config.breaker.failureThreshold,
		resetTimeoutMs: config.breaker.resetTimeoutMs,
		enabled: config.breaker.enabled,
	};
	const cooldowns = new Map<string, number>();

	const canAttempt = (key: string) => canAttemptCircuit(breaker, key, debug);
	const recordResult = (key: string, success: boolean) => recordCircuitResult(breaker, key, success, debug);
	const releaseProbe = (key: string) => releaseCircuitProbe(breaker, key, debug);

	function inCooldown(key: string): boolean {
		const end = cooldowns.get(key);
		if (end === undefined) return false;
		if (Date.now() >= end) { cooldowns.delete(key); return false; }
		return true;
	}

	function recordFailure(m: { provider: string; id: string }, error: string, statusCode?: number): void {
		let cd = config.breaker.cooldownMs;
		const label = `${m.provider}/${m.id}`;
		for (const [pattern, o] of Object.entries(config.breaker.models)) {
			if (modelPattern(pattern).test(label)) { cd = o.cooldownMs ?? cd; break; }
		}
		const { cooldownMs } = getFailureCooldownMs(error, cd, statusCode);
		cooldowns.set(keyOf(m), Date.now() + cooldownMs);
	}

	// 只读健康检查（不认领探测槽，route 用）
	function isHealthy(key: string): boolean {
		if (inCooldown(key)) return false;
		const s = breaker.circuits.get(key);
		if (!s) return true;
		if (s.state === "closed") return true;
		if (s.state === "open") return Date.now() >= s.nextRetryTime;
		return !s.halfOpenInFlight;
	}

	return {
		breaker,
		canAttempt,
		recordResult,
		releaseProbe,
		inCooldown,
		recordFailure,
		isHealthy,
	};
}

export type Reliability = ReturnType<typeof createReliability>;
