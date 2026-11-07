/**
 * test/smoke.test.ts —— 注册表面 smoke test（借鉴 jmcombs/pi-extensions）
 *
 * 用最小 ExtensionAPI stub（真实类型）调 pi-resilience 的 default factory，
 * 验证它注册了预期资源：虚拟模型 pi-resilience/auto、/pi-resilience 命令、
 * session_start/model_select/session_before_* 事件。不 mock 外部 API，不真跑 pi。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import factory from "../extensions/pi-resilience.js";

interface RegistrationLog {
	events: string[];
	commands: string[];
	virtualModels: { provider: string; id: string }[];
	providers: string[];
}

function createApiStub(): { api: ExtensionAPI; log: RegistrationLog } {
	const log: RegistrationLog = { events: [], commands: [], virtualModels: [], providers: [] };
	const notImplemented = (m: string) => () => {
		throw new Error(`ExtensionAPI.${m} not implemented in test stub`);
	};
	const api = {
		on: ((event: string) => {
			log.events.push(event);
			return () => {};
		}) as unknown as ExtensionAPI["on"],
		registerCommand: ((name: string) => {
			log.commands.push(name);
		}) as unknown as ExtensionAPI["registerCommand"],
		registerVirtualModel: ((vm: { provider: string; id: string }) => {
			log.virtualModels.push(vm);
		}) as unknown as ExtensionAPI["registerVirtualModel"],
		registerProvider: ((p: { name: string }) => {
			log.providers.push(p.name);
		}) as unknown as ExtensionAPI["registerProvider"],
		registerTool: notImplemented("registerTool"),
		registerShortcut: notImplemented("registerShortcut"),
		registerFlag: notImplemented("registerFlag"),
		getFlag: notImplemented("getFlag"),
		registerMessageRenderer: notImplemented("registerMessageRenderer"),
		sendMessage: notImplemented("sendMessage"),
		sendUserMessage: notImplemented("sendUserMessage"),
		appendEntry: notImplemented("appendEntry"),
		setSessionName: notImplemented("setSessionName"),
		getSessionName: notImplemented("getSessionName"),
		setLabel: notImplemented("setLabel"),
		exec: notImplemented("exec"),
		getActiveTools: notImplemented("getActiveTools"),
		getAllTools: notImplemented("getAllTools"),
		setActiveTools: notImplemented("setActiveTools"),
		getCommands: notImplemented("getCommands"),
		setModel: notImplemented("setModel"),
	} as unknown as ExtensionAPI;
	return { api, log };
}

let cfgFile: string;

beforeAll(() => {
	// 隔离 config：不读用户 ~/.pi/pi-resilience.json（loadConfig 支持 PI_RESILIENCE_CONFIG）
	cfgFile = join(tmpdir(), `pi-resilience-smoke-${process.pid}.json`);
	writeFileSync(cfgFile, JSON.stringify({ enabled: true }));
	process.env.PI_RESILIENCE_CONFIG = cfgFile;
});

afterAll(() => {
	delete process.env.PI_RESILIENCE_CONFIG;
	rmSync(cfgFile, { force: true });
});

describe("pi-resilience 注册表面", () => {
	test("注册虚拟模型 pi-resilience/auto + /pi-resilience 命令 + 生命周期事件", () => {
		const { api, log } = createApiStub();
		factory(api);
		// 虚拟模型
		expect(log.virtualModels.some((v) => v.provider === "pi-resilience" && v.id === "auto")).toBe(true);
		// 命令
		expect(log.commands).toContain("pi-resilience");
		// 生命周期事件（stale-ctx 关键点）
		for (const ev of ["session_start", "model_select", "session_before_switch", "session_shutdown", "session_before_fork", "session_before_compact"]) {
			expect(log.events, `应监听 ${ev}`).toContain(ev);
		}
	});
});
