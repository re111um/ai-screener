const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export default async function handler(req, res) {
  // CORS 헤더 — Cloudflare 프론트엔드에서 호출할 수 있도록
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // GET: 상태 확인
  if (req.method === "GET") {
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    return res.status(200).json({
      status: "ok",
      api_key_set: hasKey,
      platform: "vercel",
      message: hasKey ? "API 정상. POST로 호출하세요." : "ANTHROPIC_API_KEY를 설정해주세요.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST만 허용" });
  }

  // API 키 확인
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "API 키가 설정되지 않았습니다.",
      errorType: "NO_API_KEY",
    });
  }

  // 요청 본문 검증
  const payload = req.body;
  if (!payload?.messages?.length) {
    return res.status(400).json({
      error: "messages 배열 필요",
      errorType: "MISSING_MESSAGES",
    });
  }

  // Anthropic API 호출 준비
  const model = payload.model || "claude-sonnet-4-6";
  const body = {
    model,
    max_tokens: payload.max_tokens || 4000,
    messages: payload.messages,
  };
  if (payload.system) body.system = payload.system;
  if (payload.tools?.length) body.tools = payload.tools;

  // 지수 백오프 재시도 (최대 3회)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const apiRes = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey.trim(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      const responseText = await apiRes.text();

      // 429, 5xx만 재시도 (Vercel→Anthropic은 403 발생 안 함)
      if ([429, 500, 502, 503, 529].includes(apiRes.status) && attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 에러 응답에 errorType 추가
      if (!apiRes.ok) {
        let parsed;
        try { parsed = JSON.parse(responseText); } catch { parsed = null; }

        const errorType =
          apiRes.status === 401 || apiRes.status === 403 ? "AUTH_ERROR" :
          apiRes.status === 429 ? "RATE_LIMIT" :
          apiRes.status >= 500 ? "SERVER_ERROR" : "UNKNOWN";

        return res.status(apiRes.status).json({
          error: parsed?.error?.message || responseText.slice(0, 300),
          errorType,
          status: apiRes.status,
        });
      }

      // 성공 — 응답 그대로 전달
      return res.status(200).send(responseText);

    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        continue;
      }
      return res.status(502).json({
        error: "Anthropic API 연결 실패: " + err.message,
        errorType: "NETWORK_ERROR",
      });
    }
  }
}
