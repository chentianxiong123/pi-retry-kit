/**
 * test/e2e.test.ts —— 端到端（真 pi + 假供应商，不真用 LLM）
 *
 * 起本地 mock-server（假供应商），用临时 PI_CODING_AGENT_DIR（不动 ~/.pi/agent），
 * 跑 `pi --print --model pi-resilience/auto`，断言：
 *   - 主模型返回 500×2 → 静默重试 → 第 3 次成功（PONG）；
 *   - mock-server 收到的请求数 = 重试次数 + 1（证明重试真的发生）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createMockServer, type MockServer } from "./mock-server.js";

const REPO = "/mnt/shared/.pi/agent/git/github.com/chentianxiong123/pi-retry-kit";

let mock: MockServer;
let agentDir: string;
let configFile: string;

beforeAll(async () => {
	mock = createMockServer([500, 500, 200]);
	const baseUrl = await mock.listen();

	// 临时 config 目录（PI_CODING_AGENT_DIR）
	agentDir = mkdtempSync(join(tmpdir(), "pi-e2e-agent-"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });

	// 假供应商：fake provider 指向本地 mock-server
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					name: "fake",
					baseUrl,
					api: "openai-completions",
					apiKey: "test",
					models: [{ id: "mock-model", name: "mock-model", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 4096 }],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "mock-model" }));

	// 临时 pi-resilience 配置（PI_RESILIENCE_CONFIG 覆盖）
	configFile = join(tmpdir(), `pi-resilience-e2e-${process.pid}.json`);
	writeFileSync(
		configFile,
		JSON.stringify({
			enabled: true,
			primary: { provider: "fake", model: "mock-model" },
			retry: { enabled: true, mode: "all", maxAttempts: 3, backoff: { baseDelayMs: 50, maxDelayMs: 50, multiplier: 1, jitter: 0 } },
			ttft: { enabled: false },
			breaker: { enabled: true, failureThreshold: 1, resetTimeoutMs: 5000, cooldownMs: 5000 },
			fallback: { models: [], maxAttempts: 3 },
		}),
	);

	// 扩展 symlink → 仓库（pi 发现 package.json pi.extensions 加载 pi-resilience）
	symlinkSync(REPO, join(agentDir, "extensions", "pi-retry-kit"));
});

afterAll(async () => {
	await mock.close();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(configFile, { force: true });
});

describe("E2E：真 pi + 假供应商", () => {
	test("主模型 500×2 → 静默重试 → 第 3 次成功（PONG）", async () => {
		// 清理继承的 PI_*（本进程是 pi 会话，会污染子 pi：PI_SESSION_FILE 等）
		const env: Record<string, string | undefined> = { ...process.env };
		for (const k of Object.keys(env)) {
			if (k.startsWith("PI_")) delete env[k];
		}
		env.PI_CODING_AGENT_DIR = agentDir;
		env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
		env.PI_RESILIENCE_CONFIG = configFile;
		// 关键：用 async spawn（不是 spawnSync）——spawnSync 会阻塞 bun 事件循环，
		// 使本进程内的 mock-server 无法响应 pi 的请求，pi 等待响应而卡死。
		const child = spawn(
			"pi",
			[
				"--print",
				"--no-extensions",
				"-e", `${REPO}/extensions/pi-resilience.ts`,
				"-e", `${REPO}/extensions/pi-notify.ts`,
				"--model", "pi-resilience/auto",
				"Reply with exactly: PONG",
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const status = await new Promise<number | null>((resolve) => {
			const t = setTimeout(() => child.kill("SIGTERM"), 90000);
			child.on("close", (c) => {
				clearTimeout(t);
				resolve(c);
			});
		});
		expect(status, `pi 退出码非 0，stderr=${err.slice(-300)}`).toBe(0);
		expect(out, "输出应含 PONG（重试后成功）").toContain("PONG");
		expect(mock.getCalls(), "mock-server 应收到 ≥3 次请求（2 次 500 + 1 次 200）").toBeGreaterThanOrEqual(3);
	}, 100000);
});
