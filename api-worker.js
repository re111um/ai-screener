/**
 * AI Screener — 통합 Worker 엔트리포인트
 * 
 * 1. /api/screen POST → Anthropic API 프록시
 * 2. /api/screen GET  → 상태 확인
 * 3. 그 외 → 정적 파일(프론트엔드) 서빙 via env.ASSETS
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /api/screen 경로만 API로 처리
    if (url.pathname === "/api/screen") {
      return handleApiRequest(request, env);
    }

    // 정적 파일 서빙 (ASSETS 바인딩 사용)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // ASSETS 바인딩이 없는 경우 안내 메시지
    return new Response(
      JSON.stringify({ error: "ASSETS 바인딩이 설정되지 않았습니다. wrangler.jsonc의 assets.binding 설정을 확인하세요." }),
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
    return new Response(JSON.stringify({ error: "POST만 허용" }), { status: 405, headers: { "Content-Type": "application/json", ...cors } });
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY가 설정되지 않았습니다.", stage: "환경변수" }), { status: 500, headers: { "Content-Type": "application/json", ...cors } });
  }

  let rawText;
  try { rawText = await request.text(); }
  catch (e) { return new Response(JSON.stringify({ error: "요청 읽기 실패", stage: "요청" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } }); }

  const size = new TextEncoder().encode(rawText).length;
  if (size > MAX_PAYLOAD_BYTES) {
    return new Response(JSON.stringify({ error: `페이로드 초과 (${(size / 1024 / 1024).toFixed(1)}MB)`, stage: "크기" }), { status: 413, headers: { "Content-Type": "application/json", ...cors } });
  }

  let payload;
  try { payload = JSON.parse(rawText); }
  catch { return new Response(JSON.stringify({ error: "잘못된 JSON", stage: "파싱" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } }); }
  if (!payload?.messages?.length) {
    return new Response(JSON.stringify({ error: "messages 필요", stage: "검증" }), { status: 400, headers: { "Content-Type": "application/json", ...cors } });
  }

  const model = payload.model || "claude-sonnet-4-6";
  const body = { model, max_tokens: payload.max_tokens || 4000, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

 for (let attempt = 1; attempt <= 3; attempt++) {
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

      // 콜드 스타트로 인한 403/429 → 1.5초 후 재시도
      if ((apiRes.status === 403 || apiRes.status === 429) && attempt < 3) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      return new Response(responseText, { status: apiRes.status, headers: { "Content-Type": "application/json", ...cors } });
    } catch (err) {
      if (attempt < 3) {  // ← 수정
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      return new Response(JSON.stringify({ error: "Anthropic API 호출 실패: " + err.message, stage: "API 통신" }), { status: 502, headers: { "Content-Type": "application/json", ...cors } });
    }
  }
}
