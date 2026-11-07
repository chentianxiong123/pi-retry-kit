/**
 * test/mock-server.ts —— E2E 假供应商（本地 HTTP server）
 *
 * 实现 OpenAI-completions 协议（/v1/chat/completions，SSE 流式），
 * 按脚本依次返回：>=400 报错（可重试类）或 200 + 流式内容（PONG）。
 * 让 E2E 用**真实 pi + 假供应商**跑完整链路，不真用 LLM。
 */

import { createServer, type Server } from "node:http";

export interface MockServer {
	/** 已收到的请求次数（= 重试次数 + 1，若最后一次成功） */
	getCalls(): number;
	/** 返回 baseUrl（如 http://127.0.0.1:PORT/v1） */
	listen(): Promise<string>;
	close(): Promise<void>;
}

/** script: 第 i 次请求返回的状态码（超出取最后一个） */
export function createMockServer(script: number[]): MockServer {
	let calls = 0;
	const server: Server = createServer((req, res) => {
		calls++;
		const code = script[Math.min(calls - 1, script.length - 1)];

		if (code >= 400) {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `mock ${code}`, type: "mock_error" } }));
			return;
		}

		// 200：SSE 流式（assistant 角色 + 内容 PONG + finish stop + [DONE]）
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const chunk = (delta: unknown, finish: string | null) =>
			`data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		res.write(chunk({ role: "assistant", content: "" }, null));
		res.write(chunk({ content: "PONG" }, null));
		res.write(chunk({}, "stop"));
		res.end("data: [DONE]\n\n");
	});

	return {
		getCalls: () => calls,
		listen: () =>
			new Promise<string>((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const addr = server.address() as { port: number };
					resolve(`http://127.0.0.1:${addr.port}/v1`);
				});
			}),
		close: () => new Promise<void>((r) => server.close(() => r())),
	};
}
