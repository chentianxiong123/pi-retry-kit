import type { Reliability } from "./reliability.js";
import type { ResilienceConfig } from "./config.js";

// ============================================================================
// lib/present.ts —— 呈现层
// 职责：TUI footer 常驻状态条（实时秒表 + 物理模型 + 熔断 + 重试进度）。
//       通过 ctx.ui.setStatus 输出，不注入消息、不污染对话（保持无感）。
//       持有 footer 状态 + 秒表定时器。**用 footerCtx 引用而非闭包捕获**，
//       定时器只调 updateFooter()（用最近有效 ctx），stale 时 try/catch 静默放弃——
//       这是 stale-ctx 崩溃（Cannot read properties of undefined (reading 'input')）的根治。
// ============================================================================

export function createFooter(config: ResilienceConfig, reliability: Reliability) {
	let currentPhysical: string | undefined;
	let retryInfo: string | undefined;
	// 回合实时秒表：turnStart>0 表示计时中（每 500ms 刷新），回合结束保留最终耗时
	let turnStart = 0;
	let turnElapsed = 0;
	let turnTimer: ReturnType<typeof setInterval> | undefined;
	let turnAttempts = 0;
	let lastFirstTokenMs = 0;
	// footerCtx 由事件回调在每次更新时刷新为「当前会话的有效 ctx」，避免闭包捕获到 stale ctx。
	let footerCtx: any;

	function startTurnTimer(ctx: any) {
		stopTurnTimer();
		turnStart = Date.now();
		turnElapsed = 0;
		turnAttempts = 0;
		lastFirstTokenMs = 0;
		footerCtx = ctx;
		updateFooter();
		turnTimer = setInterval(updateFooter, 500);
	}

	function stopTurnTimer() {
		if (turnTimer) clearInterval(turnTimer);
		turnTimer = undefined;
		if (turnStart > 0) { turnElapsed = Date.now() - turnStart; turnStart = 0; }
	}

	/** 彻底释放秒表定时器 + 引用（session 切换 / shutdown 时调用，防止定时器在旧 ctx 上继续跑） */
	function disposeTurnTimer() {
		if (turnTimer) clearInterval(turnTimer);
		turnTimer = undefined;
		turnStart = 0;
		turnElapsed = 0;
		turnAttempts = 0;
		lastFirstTokenMs = 0;
		footerCtx = undefined;
	}

	function updateFooter(ctx?: any) {
		// 显式 ctx 优先（事件回调传当前 ctx）；否则用最近一次的有效 ctx。
		// 两者都无效或已 stale → 直接跳过，绝不调用 stale ctx 的 ui（这是崩溃根源）。
		const target = ctx ?? footerCtx;
		if (!config.showStatus || !target?.ui?.setStatus) return;
		try {
			// 只在目标有效时刷新 footerCtx（定时器回调不带 ctx，继续用最近一次的有效引用）
			if (ctx) footerCtx = ctx;
			const parts: string[] = [];
			// 实时秒表
			if (turnStart > 0 || turnElapsed > 0) {
				const ms = turnStart > 0 ? Date.now() - turnStart : turnElapsed;
				let s = `回合 ${(ms / 1000).toFixed(1)}s`;
				if (turnStart === 0 && lastFirstTokenMs > 0) s += `(首字 ${(lastFirstTokenMs / 1000).toFixed(1)}s)`;
				if (turnStart === 0 && turnAttempts > 1) s += `(重试${turnAttempts - 1})`;
				parts.push(s);
			}
			if (currentPhysical) parts.push(`物理=${currentPhysical}`);
			if (retryInfo) parts.push(retryInfo);
			const trips: string[] = [];
			for (const [k, s] of reliability.breaker.circuits) {
				if (s.state === "closed") continue;
				if (s.state === "open") {
					const secs = Math.max(0, Math.round((s.nextRetryTime - Date.now()) / 1000));
					trips.push(`${k} 开(还${secs}s)`);
				} else {
					trips.push(`${k} ${s.state}`);
				}
			}
			if (trips.length) parts.push(`熔断: ${trips.join("；")}`);
			target.ui.setStatus("pi-resilience", parts.length ? parts.join(" | ") : undefined);
		} catch {
			// ctx stale / 已销毁：放弃本次刷新，并清掉 footerCtx 引用（定时器路径也清），
			// 防止后续每 500ms 的定时器反复访问已 stale 的 ctx（虽被 catch，但浪费）。
			footerCtx = undefined;
		}
	}

	return {
		startTurnTimer,
		stopTurnTimer,
		disposeTurnTimer,
		updateFooter,
		setCurrentPhysical(p: string | undefined) { currentPhysical = p; },
		setRetryInfo(i: string | undefined) { retryInfo = i; },
		clearRetryInfo() { retryInfo = undefined; },
		noteAttempt() { turnAttempts++; },
		noteFirstToken(ms: number) { lastFirstTokenMs = ms; },
	};
}

export type Footer = ReturnType<typeof createFooter>;
