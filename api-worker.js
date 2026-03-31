/**
 * AI Screener — 통합 Worker
 * 
 * /api/screen POST → Anthropic API 프록시
 * /api/screen GET  → 상태 확인
 * /api/diag   GET  → 🆕 API 키 실시간 진단
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RETRIES = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/screen") return handleApiRequest(request, env);
    if (url.pathname === "/api/diag") return handleDiag(env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response(JSON.stringify({ error: "ASSETS 바인딩 없음" }), { status: 500, headers: { "Content-Type": "application/json" } });
  },
};

// ── 🆕 진단: API 키를 실제로 테스트 ─────────────────────────
async function handleDiag(env) {
  const h = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const key = env.ANTHROPIC_API_KEY;
  const result = {
    timestamp: new Date().toISOString(),
    key_exists: !!key,
    key_length: key ? key.length : 0,
    key_prefix: key ? key.slice(0, 12) + "..." : "없음",
    key_has_whitespace: key ? key !== key.trim() : false,
    live_test: null,
  };
  if (key) {
    try {
      const r = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key.trim(), "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
      });
      const b = await r.text();
      result.live_test = { status: r.status, ok: r.ok, body: b.slice(0, 300) };
    } catch (e) { result.live_test = { error: e.message }; }
  }
  return new Response(JSON.stringify(result, null, 2), { status: 200, headers: h });
}

// ── API 핸들러 ──────────────────────────────────────────────
async function handleApiRequest(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (request.method === "GET") {
    const hasKey = !!env.ANTHROPIC_API_KEY;
    return new Response(JSON.stringify({
      status: "ok", api_key_set: hasKey, api_key_length: hasKey ? env.ANTHROPIC_API_KEY.length : 0,
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors } });
  }

  if (request.method !== "POST")
    return new Response(JSON.stringify({ error: "POST만 허용" }), { status: 405, headers: { "Content-Type": "application/json", ...cors } });

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey)
    return new Response(JSON.stringify({ error: "API 키 미설정", errorType: "NO_API_KEY" }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });

  let rawText;
  try { rawText = await request.text(); }
  catch { return new Response(JSON.stringify({ error: "요청 읽기 실패", errorType: "BAD_REQUEST" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } }); }

  const size = new TextEncoder().encode(rawText).length;
  if (size > MAX_PAYLOAD_BYTES)
    return new Response(JSON.stringify({ error: `페이로드 초과 (${(size / 1024 / 1024).toFixed(1)}MB)`, errorType: "PAYLOAD_TOO_LARGE" }), { status: 413, headers: { "Content-Type": "application/json", ...cors } });

  let payload;
  try { payload = JSON.parse(rawText); }
  catch { return new Response(JSON.stringify({ error: "JSON 파싱 실패", errorType: "INVALID_JSON" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } }); }

  if (!payload?.messages?.length)
    return new Response(JSON.stringify({ error: "messages 필요", errorType: "MISSING_MESSAGES" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });

  const model = payload.model || "claude-sonnet-4-6";
  const body = { model, max_tokens: payload.max_tokens || 4000, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

  const cleanKey = apiKey.trim();
  const payloadSizeKB = Math.round(JSON.stringify(body).length / 1024);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiRes = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cleanKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const responseText = await apiRes.text();

      // 재시도 가능: 429, 5xx (403은 인증이므로 재시도 무의미)
      const retryable = [429, 500, 502, 503, 529];
      if (retryable.includes(apiRes.status) && attempt < MAX_RETRIES) {
        const ra = apiRes.headers.get("retry-after");
        const delay = ra ? Math.min(parseInt(ra, 10) * 1000, 30000) : 1000 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!apiRes.ok) {
        let parsed;
        try { parsed = JSON.parse(responseText); } catch { parsed = null; }

        const errorType =
          apiRes.status === 401 || apiRes.status === 403 ? "AUTH_ERROR" :
          apiRes.status === 429 ? "RATE_LIMIT" :
          apiRes.status === 413 ? "PAYLOAD_TOO_LARGE" :
          apiRes.status >= 500 ? "SERVER_ERROR" : "UNKNOWN";

        return new Response(JSON.stringify({
          error: parsed?.error?.message || responseText.slice(0, 300),
          errorType,
          status: apiRes.status,
          debug: {
            source: "anthropic_api",
            anthropic_error_type: parsed?.error?.type || "unknown",
            payload_size_kb: payloadSizeKB,
            model,
            attempt,
          }
        }), { status: apiRes.status, headers: { "Content-Type": "application/json", ...cors } });
      }

      return new Response(responseText, { status: apiRes.status, headers: { "Content-Type": "application/json", ...cors } });

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      return new Response(JSON.stringify({
        error: "서버 연결 실패: " + err.message,
        errorType: "NETWORK_ERROR",
      }), { status: 502, headers: { "Content-Type": "application/json", ...cors } });
    }
  }
}
