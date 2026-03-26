/**
 * Cloudflare Pages Function — /api/screen
 * 
 * 프론트엔드와 같은 도메인에서 동작하므로:
 * - CORS 불필요 (같은 origin)
 * - Bot Fight Mode 영향 없음
 * - 브라우저 → /api/screen → Anthropic API
 * 
 * 설정 방법:
 * 1. 이 파일을 프로젝트 루트의 functions/api/screen.js 에 배치
 * 2. Cloudflare Pages Dashboard → Settings → Environment variables에 ANTHROPIC_API_KEY 추가
 * 3. 재배포하면 자동으로 /api/screen 경로가 활성화됨
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

// Pages Functions는 onRequest 또는 onRequestPost 등을 export
export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. API 키 확인
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY가 설정되지 않았습니다.", stage: "환경변수" },
      { status: 500 }
    );
  }

  // 2. 요청 본문 읽기
  let rawText;
  try {
    rawText = await request.text();
  } catch (e) {
    return Response.json(
      { error: "요청 본문 읽기 실패", stage: "요청 읽기" },
      { status: 400 }
    );
  }

  // 3. 페이로드 크기 체크
  const size = new TextEncoder().encode(rawText).length;
  if (size > MAX_PAYLOAD_BYTES) {
    return Response.json(
      { error: `페이로드 초과 (${(size / 1024 / 1024).toFixed(1)}MB > 10MB)`, stage: "크기 검증" },
      { status: 413 }
    );
  }

  // 4. JSON 파싱
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (e) {
    return Response.json(
      { error: "잘못된 JSON", stage: "JSON 파싱" },
      { status: 400 }
    );
  }

  if (!payload?.messages?.length) {
    return Response.json(
      { error: "messages 배열 필요", stage: "입력 검증" },
      { status: 400 }
    );
  }

  // 5. Anthropic API 호출 준비
  const model = payload.model || "claude-sonnet-4-6";
  const body = {
    model,
    max_tokens: payload.max_tokens || 4000,
    messages: payload.messages,
  };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

  // 6. Anthropic API 호출
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
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return Response.json(
      { error: "Anthropic API 호출 실패: " + err.message, stage: "API 통신" },
      { status: 502 }
    );
  }
}

// GET 요청: 상태 확인용
export async function onRequestGet(context) {
  const hasKey = !!context.env.ANTHROPIC_API_KEY;
  return Response.json({
    status: "ok",
    endpoint: "/api/screen",
    api_key_set: hasKey,
    message: hasKey
      ? "Pages Function 정상 작동 중. POST로 API를 호출하세요."
      : "⚠️ ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.",
  });
}
