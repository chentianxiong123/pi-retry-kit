// Copied from jiangge/pi-router (MIT) — study note 2026-11-07.
// Self-contained, zero-dependency module.
//
// 判定优先级（2026-11-07 重构，从「文本关键词优先」改为「错误码优先」）：
//   ① 数字 HTTP 状态码  —— 权威。executor 从 onResponse 直接拿到 resp.status，别再从消息文本正则抠。
//                          文本抠码会漏（400/409/422 不在旧白名单）、会被本地化/包装文案骗。
//   ② 结构化 body 字段   —— provider 返回的 {"type":"failed_precondition_error","code":"9"}，
//                          type/code 是机器可读的，比 message 散文稳定。
//   ③ Error.code         —— Node 网络错误的稳定标识（ECONNREFUSED/ETIMEDOUT…）。
//   ④ 文本关键词         —— 仅兜底（status 缺失、body 解析不了时）。
// 教训：原来 classifyFailure(errorText) 只收文本，executor 手里有 lastStatus 却不用，
//       导致 400 safety check 被 regex 漏掉 → 落 unknown → 一次不重试。
export type FailureKind =
  | "transient-auth"
  | "network"
  | "timeout"
  | "rate-limit"
  | "auth"
  | "abort"
  | "provider"
  | "precondition"
  | "unknown";

export type FailureClassification = {
  kind: FailureKind;
  retryable: boolean;
  /**
   * 该类别「值得」的最大尝试次数（含首次）。分类器在这里声明策略，executor 尊重它。
   * undefined = 不额外限制（用配置的 maxAttempts）。
   * precondition（400/409/422/precondition/safety）默认 3：内容/前置条件类错误可能自愈，
   * 但重满是浪费——同样的内容大概率同样被拒。
   */
  maxAttempts?: number;
};

/** 从 provider 错误文本里抽 JSON body 的 machine-readable 字段（type/code） */
function parseErrorBody(text: string): { type?: string; code?: string; message?: string } {
  const start = text.indexOf("{");
  if (start < 0) return {};
  try {
    const obj = JSON.parse(text.slice(start));
    if (obj && typeof obj === "object") {
      const e = (obj as { error?: unknown }).error ?? obj;
      if (e && typeof e === "object") {
        const t = e as { type?: unknown; code?: unknown; message?: unknown };
        return {
          type: typeof t.type === "string" ? t.type : undefined,
          code: t.code !== undefined ? String(t.code) : undefined,
          message: typeof t.message === "string" ? t.message : undefined,
        };
      }
    }
  } catch {
    /* 不是 JSON：正常，退回文本兜底 */
  }
  return {};
}

/**
 * 真实的 HTTP 状态码白名单。从文本里抠码时**只认这些**——否则 "ECONNREFUSED 127.0.0.1:443"
 * 里的 127、"v2.1.0" 里的数字、端口号都会被误当成 status，把网络错判成 unknown。
 */
const KNOWN_HTTP_STATUS = new Set([
	400, 401, 403, 404, 405, 408, 409, 413, 422, 425, 429, 451,
	500, 502, 503, 504, 507, 508, 509, 524, 529,
]);

/** 仅当确实拿不到数字 status 时，才从文本里抠（兜底，不再作为第一信号） */
function statusFromText(text: string): number | undefined {
	const m = text.match(/(?:^|\D)([1-5]\d\d)(?:\D|$)/);
	if (!m) return undefined;
	const code = Number(m[1]);
	// 只认白名单：拒绝 127（IP）/8080 片段/版本号等误匹配
	return KNOWN_HTTP_STATUS.has(code) ? code : undefined;
}

export function classifyFailure(error: string, statusCode?: number): FailureClassification {
  const text = error || "";
  const lower = text.toLowerCase();
  const status = Number.isFinite(statusCode) ? Number(statusCode) : statusFromText(text);

  // abort 优先：决定性信号。用户 abort 在 executor 已先行拦（永不重试），这里拦 provider 侧 abort。
  // 注：这是唯一保留的文本判断——abort 没有稳定 code 通道（AbortError.name / DOMException code 20
  // 到我们手里已只剩 message）。
  if (lower.includes("aborterror") || lower.includes("operation was aborted") || lower.includes("request was aborted")) {
    return { kind: "abort", retryable: false };
  }

  // ① 数字 HTTP 状态码（权威）
  if (status !== undefined) {
    if (status === 401 || status === 403) return { kind: "auth", retryable: false };
    if (status === 429) return { kind: "rate-limit", retryable: true };
    if (status === 408) return { kind: "timeout", retryable: true };
    if (status >= 500) return { kind: "provider", retryable: true };
    // 4xx 客户端错误：细分
    if (status === 400 || status === 409 || status === 422) {
      return { kind: "precondition", retryable: true, maxAttempts: 3 };
    }
    // 其余 4xx（404/413/451…）：请求本身有问题，重试无意义
    return { kind: "unknown", retryable: false };
  }

  // ② 结构化 body 字段（type/code，机器可读）
  const body = parseErrorBody(text);
  if (body.type) {
    const t = body.type.toLowerCase();
    if (t.includes("quota") || t.includes("billing") || t.includes("budget")) return { kind: "rate-limit", retryable: true };
    if (t.includes("rate") || t.includes("too_many")) return { kind: "rate-limit", retryable: true };
    if (t.includes("auth") || t.includes("api_key") || t.includes("token") || t.includes("permission")) {
      return { kind: "auth", retryable: false };
    }
    if (t.includes("precondition") || t.includes("safety") || t.includes("moderation") || t.includes("content_filter")) {
      return { kind: "precondition", retryable: true, maxAttempts: 3 };
    }
    if (t.includes("overloaded") || t.includes("internal") || t.includes("api_error") || t.includes("unavailable")) {
      return { kind: "provider", retryable: true };
    }
    if (t.includes("timeout") || t.includes("timed_out")) return { kind: "timeout", retryable: true };
  }

  // ③ Node 网络错误码（稳定标识）
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("enetunreach") ||
    lower.includes("epipe") ||
    lower.includes("socket hang up")
  ) {
    return { kind: "network", retryable: true };
  }

  // pi 自身的临时鉴权层文案（无 code 通道，只能看文本）
  if (
    lower.includes("registry auth temporarily unavailable") ||
    lower.includes("auth resolution temporarily unavailable") ||
    lower.includes("credential store temporarily unavailable") ||
    lower.includes("authentication temporarily unavailable")
  ) {
    return { kind: "transient-auth", retryable: true };
  }

  // ④ 文本兜底（最后手段：本地化/改文案就会漏，所以放最后）
  if (lower.includes("insufficient_quota") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { kind: "rate-limit", retryable: true };
  }
  if (lower.includes("invalid api key") || lower.includes("invalid token") || lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("no api key")) {
    return { kind: "auth", retryable: false };
  }
  if (lower.includes("etimedout") || lower.includes("timed out") || lower.includes("timeout")) {
    return { kind: "timeout", retryable: true };
  }
  if (lower.includes("connection refused") || lower.includes("connection error") || lower.includes("dns lookup failed")) {
    return { kind: "network", retryable: true };
  }
  if (lower.includes("failed_precondition") || lower.includes("precondition failed") || lower.includes("safety") || lower.includes("moderation") || lower.includes("content_filter")) {
    return { kind: "precondition", retryable: true, maxAttempts: 3 };
  }
  if (lower.includes("500") || lower.includes("502") || lower.includes("503") || lower.includes("504")) {
    return { kind: "provider", retryable: true };
  }

  return { kind: "unknown", retryable: false };
}

export function getFailureCooldownMs(
  error: string,
  configuredCooldownMs: number,
  statusCode?: number,
): { cooldownMs: number; classification: FailureClassification } {
  const classification = classifyFailure(error, statusCode);

  if (
    classification.kind === "transient-auth" ||
    classification.kind === "network" ||
    classification.kind === "timeout"
  ) {
    return { cooldownMs: 5000, classification };
  }

  return { cooldownMs: configuredCooldownMs, classification };
}
