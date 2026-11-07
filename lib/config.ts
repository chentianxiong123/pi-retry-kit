import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// lib/config.ts —— 配置层
// 职责：定义配置结构 + 默认值 + 从 ~/.pi/pi-resilience.json 加载（deep merge）。
// 纯配置，无任何运行时状态。其他层只读 config。
// ============================================================================

export type RetryMode = "all" | "allowlist" | "denylist";

export interface ResilienceConfig {
	enabled: boolean;
	showStatus: boolean;
	retry: {
		enabled: boolean;
		mode: RetryMode;
		matchStatus: number[];
		matchText: string[];
		maxAttempts: number;
		maxTotalWaitMs: number;
		backoff: { baseDelayMs: number; maxDelayMs: number; multiplier: number; jitter: number };
		respectRetryAfter: boolean;
		retryOnOverflow: boolean;
	};
	ttft: {
		enabled: boolean;
		firstTokenTimeoutMs: number;
		retryOnEmpty: boolean;
		models: Record<string, { firstTokenTimeoutMs?: number }>;
	};
	breaker: {
		enabled: boolean;
		failureThreshold: number;
		resetTimeoutMs: number;
		cooldownMs: number;
		models: Record<string, Partial<{ failureThreshold: number; resetTimeoutMs: number; cooldownMs: number }>>;
	};
	fallback: {
		models: { provider: string; model: string }[];
		maxAttempts: number;
	};
	/** 主模型（虚拟模型 route 的首选；可空则退化为只用 fallback） */
	primary?: { provider: string; model: string };
}

export const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	showStatus: true,
	retry: {
		enabled: true,
		mode: "all",
		matchStatus: [408, 429, 500, 502, 503, 504, 524],
		matchText: [
			"insufficient_quota",
			"quota.*(?:exceeded|limit|reached)",
			"out of budget",
			"rate.?limit",
			"too many requests",
			"overloaded",
			"server.?error",
			"service.?unavailable",
			"internal.?error",
			"connection.*(?:refused|lost|reset)",
			"fetch failed",
			"timeout",
			"socket hang up",
		],
		maxAttempts: 20,
		maxTotalWaitMs: 0,
		backoff: { baseDelayMs: 3000, maxDelayMs: 60000, multiplier: 2, jitter: 0.1 },
		respectRetryAfter: true,
		retryOnOverflow: true,
	},
	ttft: {
		enabled: true,
		firstTokenTimeoutMs: 20_000,
		retryOnEmpty: true,
		models: {},
	},
	breaker: {
		enabled: true,
		failureThreshold: 1,
		resetTimeoutMs: 120_000,
		cooldownMs: 60_000,
		models: {},
	},
	fallback: {
		models: [],
		maxAttempts: 8,
	},
};

const CONFIG_PATH = process.env.PI_RESILIENCE_CONFIG ?? join(homedir(), ".pi", "pi-resilience.json");

function deep<T>(base: T, patch: unknown): T {
	if (patch === undefined || patch === null) return base;
	if (Array.isArray(base) || typeof base !== "object" || typeof patch !== "object") {
		return (patch as T) ?? base;
	}
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v === undefined) continue;
		out[k] = deep((base as Record<string, unknown>)[k], v);
	}
	return out as T;
}

export function loadConfig(): ResilienceConfig {
	let raw: unknown;
	try {
		if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		// 损坏则用默认
	}
	return deep(structuredClone(DEFAULT_CONFIG), raw);
}
