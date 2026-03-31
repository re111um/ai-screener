/**
 * AI Screener — 통합 Worker 엔트리포인트
 * 
 * 1. /api/screen POST → Anthropic API 프록시 (지수 백오프 재시도)
 * 2. /api/screen GET  → 상태 확인
 * 3. 그 외 → 정적 파일(프론트엔드) 서빙 via env.ASSETS
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RETRIES = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/screen") {
      return handleApiRequest(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      JSON.stringify({ error: "ASSETS 바인딩이 설정되지 않았습니다." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  },
};

async function handleApiRequest(request, env) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method === "GET") {
    const hasKey = !!env.ANTHROPIC_API_KEY;
    return new Response(JSON.stringify({
      status: "ok",
      api_key_set: hasKey,
      assets_bound: !!env.ASSETS,
      message: hasKey ? "API 정상. POST로 호출하세요." : "ANTHROPIC_API_KEY를 설정해주세요.",
    }), { status: 200, headers: { "Content-Type": "application/json", ...cors } });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST만 허용" }), {
      status: 405, headers: { "Content-Type": "application/json", ...cors }
    });
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: "API 키가 설정되지 않았습니다. 관리자에게 문의하세요.",
      errorType: "NO_API_KEY",
      stage: "환경변수"
    }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
  }

  let rawText;
  try { rawText = await request.text(); }
  catch (e) {
    return new Response(JSON.stringify({
      error: "요청 읽기 실패", errorType: "BAD_REQUEST", stage: "요청"
    }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
  }

  const size = new TextEncoder().encode(rawText).length;
  if (size > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({
      error: `파일이 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)}MB). 10MB 이하로 줄여주세요.`,
      errorType: "PAYLOAD_TOO_LARGE",
      stage: "크기"
    }), { status: 413, headers: { "Content-Type": "application/json", ...cors } });
  }

  let payload;
  try { payload = JSON.parse(rawText); }
  catch {
    return new Response(JSON.stringify({
      error: "잘못된 요청 형식", errorType: "INVALID_JSON", stage: "파싱"
    }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
  }

  if (!payload?.messages?.length) {
    return new Response(JSON.stringify({
      error: "messages 필요", errorType: "MISSING_MESSAGES", stage: "검증"
    }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
  }

  const model = payload.model || "claude-sonnet-4-6";
  const body = { model, max_tokens: payload.max_tokens || 4000, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

  // ── 지수 백오프 재시도 ──
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiRes = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const responseText = await apiRes.text();

      // 재시도 가능한 에러: 403, 429, 500, 502, 503, 529
      const retryable = [403, 429, 500, 502, 503, 529];
      if (retryable.includes(apiRes.status) && attempt < MAX_RETRIES) {
        // 429는 Retry-After 헤더 존재 시 해당 시간만큼 대기
        const retryAfter = apiRes.headers.get("retry-after");
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
          : Math.min(1000 * Math.pow(2, attempt - 1), 10000); // 1s, 2s, 4s...
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // 최종 응답에 errorType 추가 (프론트엔드가 분류할 수 있도록)
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
          stage: "Anthropic API",
        }), { status: apiRes.status, headers: { "Content-Type": "application/json", ...cors } });
      }

      return new Response(responseText, {
        status: apiRes.status,
        headers: { "Content-Type": "application/json", ...cors }
      });

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return new Response(JSON.stringify({
        error: "서버 연결에 실패했습니다: " + err.message,
        errorType: "NETWORK_ERROR",
        stage: "API 통신"
      }), { status: 502, headers: { "Content-Type": "application/json", ...cors } });
    }
  }
}
