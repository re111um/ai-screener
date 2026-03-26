/**
 * AI Screener — 통합 Worker 엔트리포인트
 * 
 * 역할:
 * 1. /api/screen POST → Anthropic API 프록시
 * 2. /api/screen GET  → 상태 확인
 * 3. 그 외 모든 요청   → 정적 파일(프론트엔드) 서빙
 * 
 * 이 파일을 프로젝트 루트에 api-worker.js 로 저장하세요.
 * wrangler.jsonc에서 "main": "api-worker.js" 를 추가하면 작동합니다.
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /api/screen 경로만 API로 처리 ──
    if (url.pathname === "/api/screen") {
      return handleApiRequest(request, env);
    }

    // ── 그 외: 정적 파일(프론트엔드) 서빙 ──
    return env.ASSETS.fetch(request);
  },
};

async function handleApiRequest(request, env) {
  // CORS 헤더 (같은 도메인이면 불필요하지만, 안전을 위해 추가)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // OPTIONS (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // GET: 상태 확인
  if (request.method === "GET") {
    const hasKey = !!env.ANTHROPIC_API_KEY;
    return new Response(JSON.stringify({
      status: "ok",
      api_key_set: hasKey,
      message: hasKey
        ? "API 정상. POST로 호출하세요."
        : "⚠️ ANTHROPIC_API_KEY 환경변수를 설정해주세요.",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // POST: Anthropic API 프록시
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST만 허용" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: "ANTHROPIC_API_KEY가 설정되지 않았습니다. Dashboard → Settings → Variables에서 추가하세요.",
      stage: "환경변수",
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // 요청 본문 읽기
  let rawText;
  try {
    rawText = await request.text();
  } catch (e) {
    return new Response(JSON.stringify({ error: "요청 읽기 실패", stage: "요청" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // 크기 체크
  const size = new TextEncoder().encode(rawText).length;
  if (size > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({
      error: `페이로드 초과 (${(size / 1024 / 1024).toFixed(1)}MB)`,
      stage: "크기",
    }), {
      status: 413,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // JSON 파싱
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return new Response(JSON.stringify({ error: "잘못된 JSON", stage: "파싱" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
  if (!payload?.messages?.length) {
    return new Response(JSON.stringify({ error: "messages 필요", stage: "검증" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Anthropic API 호출
  const model = payload.model || "claude-sonnet-4-6";
  const body = { model, max_tokens: payload.max_tokens || 4000, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

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
    return new Response(responseText, {
      status: apiRes.status,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "Anthropic API 호출 실패: " + err.message,
      stage: "API 통신",
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
}
