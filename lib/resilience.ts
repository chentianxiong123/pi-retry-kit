// Shared resilience hub — the coupling point for pi-retry / pi-ttft / pi-breaker.
//
// One project = one system. All three extensions call into this singleton:
//   - pi-retry / pi-ttft  call noteExhausted(model, err, n) when they exhaust their
//     retries on a model — an explicit "this model has been proven bad" signal.
//   - pi-breaker reads that signal (takeExhausted) when it observes a failure, so it
//     knows WHY the request failed (retry-exhausted vs a single attempt).
// They share one CircuitBreaker, one config, one stats object.
//
// Config: ~/.pi/pi-breaker.json (flat, config-driven, webUI-friendly).
import {
	canAttemptCircuit,
	recordCircuitResult,
	releaseCircuitProbe,
	type CircuitBreaker,
} from "./circuit-breaker.js";
import { getFailureCooldownMs } from "./failure-classifier.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ModelRef = { provider: string; id: string };
export type ModelInfo = ModelRef | undefined;

export interface FallbackModelSpec {
	provider: string;
	model: string;
}

export interface ResilienceConfig {
	enabled: boolean;
	/** 连续失败多少次后熔断（open）。默认 1：重试耗尽仍失败 = 模型已挂，一次即熔断 */
	failureThreshold: number;
	/** 熔断后多少 ms 恢复（open → half-open 探测） */
	resetTimeoutMs: number;
	/** 单次失败后的冷却（ms）；临时错(network/timeout/鉴权)自动用 5s */
	cooldownMs: number;
	/** 熔断/失败后依次尝试的备用模型链 */
	fallbackModels: FallbackModelSpec[];
	/** 按模型 glob 覆盖阈值 */
	models: Record<string, Partial<{ failureThreshold: number; resetTimeoutMs: number; cooldownMs: number }>>;
	/** 状态栏显示进度 */
	showStatus: boolean;
}

const DEFAULT_CONFIG: ResilienceConfig = {
	enabled: true,
	failureThreshold: 1,
	resetTimeoutMs: 120_000,
	cooldownMs: 60_000,
	fallbackModels: [],
	models: {},
	showStatus: true,
};

export const RESILIENCE_CONFIG_PATH = join(homedir(), ".pi", "pi-breaker.json");

function debug(msg: string): void {
	if (process.env.PI_BREAKER_DEBUG) console.warn(`[pi-breaker] ${msg}`);
}

function modelPattern(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

export class ResilienceHub {
	config: ResilienceConfig;
	breaker: CircuitBreaker;
	stats = { attempts: 0, failedOver: 0, switched: 0, gaveUp: 0 };
	private cooldowns = new Map<string, number>();
	private exhausted = new Map<string, { error: string; retries: number; time: number }>();
	private compiled: Array<{ re: RegExp; ov: Partial<ResilienceConfig> }>;

	constructor(raw?: Partial<ResilienceConfig>) {
		const c = {
			...DEFAULT_CONFIG,
			...raw,
			fallbackModels: raw?.fallbackModels ?? [],
			models: raw?.models ?? {},
		} as ResilienceConfig;
		this.config = c;
		this.breaker = {
			circuits: new Map(),
			failureThreshold: c.failureThreshold,
			resetTimeoutMs: c.resetTimeoutMs,
			enabled: c.enabled,
		};
		this.compiled = Object.entries(c.models).map(([pattern, ov]) => ({ re: modelPattern(pattern), ov: ov ?? {} }));
	}

	key(m: ModelRef): string {
		return `${m.provider}/${m.id}`;
	}

	thresholds(m: ModelInfo): { failureThreshold: number; resetTimeoutMs: number; cooldownMs: number } {
		if (m) {
			const label = `${m.provider}/${m.id}`;
			for (const { re, ov } of this.compiled) {
				if (re.test(label)) {
					return {
						failureThreshold: ov.failureThreshold ?? this.config.failureThreshold,
						resetTimeoutMs: ov.resetTimeoutMs ?? this.config.resetTimeoutMs,
						cooldownMs: ov.cooldownMs ?? this.config.cooldownMs,
					};
				}
			}
		}
		return {
			failureThreshold: this.config.failureThreshold,
			resetTimeoutMs: this.config.resetTimeoutMs,
			cooldownMs: this.config.cooldownMs,
		};
	}

	// ---- 熔断器 API（pi-breaker 用） ----
	canAttempt(key: string): boolean {
		return canAttemptCircuit(this.breaker, key, debug);
	}
	recordResult(key: string, success: boolean): void {
		recordCircuitResult(this.breaker, key, success, debug);
	}
	releaseProbe(key: string): void {
		releaseCircuitProbe(this.breaker, key, debug);
	}

	// ---- 冷却 ----
	inCooldown(key: string): boolean {
		const end = this.cooldowns.get(key);
		if (end === undefined) return false;
		if (Date.now() >= end) {
			this.cooldowns.delete(key);
			return false;
		}
		return true;
	}
	recordFailure(m: ModelInfo, error: string): void {
		if (!m) return;
		const { cooldownMs } = getFailureCooldownMs(error, this.thresholds(m).cooldownMs);
		this.cooldowns.set(this.key(m), Date.now() + cooldownMs);
		debug(`failure ${this.key(m)}: ${error} -> cooldown ${cooldownMs}ms`);
	}

	// ---- 重试层 → 熔断层 显式上报（相互调通的桥） ----
	/** pi-retry / pi-ttft 耗尽重试时调用：显式声明「此模型已被证明不行」 */
	noteExhausted(m: ModelRef, error: string, retries: number): void {
		const key = this.key(m);
		this.exhausted.set(key, { error, retries, time: Date.now() });
		debug(`noteExhausted ${key} after ${retries} attempts: ${error}`);
	}
	/** pi-breaker 消费「已证明不行」信号；15s 内有效，过期视为陈旧 */
	takeExhausted(key: string): { error: string; retries: number } | undefined {
		const s = this.exhausted.get(key);
		if (!s) return undefined;
		this.exhausted.delete(key);
		if (Date.now() - s.time > 15_000) return undefined;
		return { error: s.error, retries: s.retries };
	}
}

function loadConfig(): Partial<ResilienceConfig> {
	try {
		if (existsSync(RESILIENCE_CONFIG_PATH)) return JSON.parse(readFileSync(RESILIENCE_CONFIG_PATH, "utf8"));
	} catch {
		// 损坏则用默认
	}
	return {};
}

/** 全局单例：三者共享（一个项目 = 一个系统） */
export const hub = new ResilienceHub(loadConfig());
