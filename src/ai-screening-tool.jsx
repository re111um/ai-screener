import { useState, useRef, useCallback, useEffect } from "react";

const API_URL = "https://ai-screener-api.qkrcksgud91.workers.dev";
const MODEL_SMART = "claude-sonnet-4-6";
const MODEL_FAST = "claude-haiku-4-5-20251001";

const SYS_CRITERIA = `당신은 세계 최고의 HR 전문가이자 직무 분석가입니다. 
채용 공고(JD)를 분석하여 서류 스크리닝에 사용할 핵심 평가 기준 3~5가지를 생성하십시오.
반드시 아래 JSON 형식으로만 응답하십시오. (가중치 개념은 완전히 삭제)
{
  "job_title": "직무명",
  "criteria": [
    {
      "id": 1,
      "name": "평가 기준명 (예: Python 백엔드 개발 역량)",
      "description": "이력서에서 확인해야 할 구체적인 지표나 키워드"
    }
  ]
}`;

const SYS_SCREENING = `당신은 냉철하고 객관적인 AI 면접관입니다. 
제공된 [평가 기준]에 따라 지원자의 이력서를 검증하십시오.
반드시 아래 JSON 형식으로만 응답하십시오.
{
  "candidate_name": "지원자 이름 (알 수 없는 경우 '이름 미기재')",
  "summary": "지원자 핵심 경력 요약 (2문장 이내, '~임', '~함' 체 사용)",
  "evaluations": [
    {
      "criteria_id": 1,
      "status": "충족", 
      "reason": "1. 이력서의 [특정 프로젝트]에서 해당 역량을 확인함.\\n2. ~한 성과를 달성한 내용이 기재되어 있음."
    }
  ],
  "recommendation": "PASS",
  "strength": "직무와 가장 잘 맞는 핵심 강점 1가지 ('~임', '~함' 체)",
  "weakness": "가장 아쉽거나 JD 대비 부족한 부분 1가지 ('~임', '~함' 체)"
}

[엄격한 평가 가이드라인]
1. status: "충족", "미충족", "판단 불가" 중 하나만 작성하십시오.
2. reason: 반드시 "1. ~임. 2. ~함." 과 같이 번호를 매기고 개조식으로 작성하십시오.
3. recommendation: 평가를 종합하여 "PASS", "MAYBE", "FAIL" 중 하나를 기재하십시오.`;

const SYS_URL_FETCH = `당신은 채용 공고 추출 전문가입니다. 웹 검색 결과에서 채용 공고의 핵심 내용을 추출하여 정리합니다.
반드시 채용 공고 원문의 내용을 최대한 충실하게 한국어로 정리하세요.
포지션명, 주요 업무, 자격 요건, 우대 사항, 근무 조건 등을 포함해 정리하세요.
마크다운이나 JSON이 아닌 일반 텍스트로 작성하세요.`;

// ─── 유틸리티 함수 ─────────────────────────────────────────

function extractJSON(text) {
  const stripped = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  return null;
}

function timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`타임아웃 (${Math.round(ms / 1000)}초 초과). 네트워크 상태를 확인하거나 다시 시도해 주세요.`)), ms)
  );
}

// 🔧 수정: 에러 분류를 더 상세하게
function classifyError(e) {
  const msg = e?.message || String(e);
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("네트워크")) {
    return `[네트워크 에러] Worker 연결 실패.\n원본: ${msg}\n\n💡 해결: Cloudflare Worker URL이 올바른지, Worker가 정상 배포되었는지 확인하세요.`;
  }
  if (msg.includes("CORS") || msg.includes("cors") || msg.includes("access-control")) {
    return `[CORS 에러] 브라우저가 Worker로의 요청을 차단했습니다.\n원본: ${msg}\n\n💡 해결: Worker의 ALLOWED_ORIGINS 환경변수를 확인하세요.`;
  }
  if (msg.includes("타임아웃") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `[타임아웃] API 응답이 제한 시간 내에 돌아오지 않았습니다.\n원본: ${msg}\n\n💡 해결: PDF 파일 크기를 줄이거나, 네트워크 상태를 확인하세요.`;
  }
  if (msg.includes("페이로드") || msg.includes("413") || msg.includes("크기 초과")) {
    return `[페이로드 초과] 전송 데이터가 너무 큽니다.\n원본: ${msg}\n\n💡 해결: 더 작은 PDF 파일을 사용하세요.`;
  }
  if (msg.includes("텍스트 추출 실패") || msg.includes("pdf.js") || msg.includes("PDF")) {
    return `[PDF 처리 에러] PDF에서 텍스트를 추출하지 못했습니다.\n원본: ${msg}\n\n💡 해결: 텍스트 기반 PDF인지 확인하세요.`;
  }
  if (msg.includes("파싱 실패") || msg.includes("candidate_name")) {
    return `[응답 파싱 에러] AI가 올바른 JSON을 반환하지 않았습니다.\n원본: ${msg}\n\n💡 해결: 다시 시도해 주세요.`;
  }
  if (msg.includes("API 4")) return `[API 클라이언트 에러] 요청 형식 또는 인증 문제.\n원본: ${msg}`;
  if (msg.includes("API 5")) return `[API 서버 에러] Anthropic 서버 측 문제.\n원본: ${msg}`;
  return `[알 수 없는 에러] ${msg}`;
}

// 🔧 수정: callAPI에 상세 로깅 추가
async function callAPI(payload) {
  console.log(`[callAPI] 요청 시작 — 모델: ${payload.model}, 메시지 수: ${payload.messages?.length}`);
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    console.error("[callAPI] 네트워크 에러 (fetch 자체 실패):", networkErr);
    throw new Error(`[네트워크] Worker 연결 실패: ${networkErr.message}`);
  }
  console.log(`[callAPI] Worker 응답 상태: ${res.status}`);
  if (!res.ok) {
    const errBody = await res.text().catch(() => "(응답 본문 읽기 실패)");
    console.error(`[callAPI] Worker 에러 응답 ${res.status}:`, errBody.slice(0, 600));
    try {
      const parsed = JSON.parse(errBody);
      throw new Error(`API ${res.status} [${parsed.stage || "알 수 없음"}]: ${parsed.error || errBody.slice(0, 400)}`);
    } catch (parseErr) {
      if (parseErr.message.startsWith("API ")) throw parseErr;
      throw new Error(`API ${res.status}: ${errBody.slice(0, 400)}`);
    }
  }
  let data;
  try {
    data = await res.json();
  } catch (jsonErr) {
    console.error("[callAPI] 응답 JSON 파싱 실패:", jsonErr);
    throw new Error("Worker 응답을 JSON으로 파싱할 수 없습니다.");
  }
  const text = (data.content || []).map((b) => b.text || "").join("");
  if (!text.trim()) {
    console.error("[callAPI] 빈 응답:", JSON.stringify(data).slice(0, 300));
    throw new Error(`빈 응답 (stop_reason: ${data.stop_reason || "unknown"})`);
  }
  console.log(`[callAPI] 응답 수신 완료 — 텍스트 길이: ${text.length}자`);
  return text;
}

async function callClaude(messages, system = "", model = MODEL_SMART) {
  const payload = { model, max_tokens: 4000, messages };
  if (system) payload.system = system;
  return Promise.race([callAPI(payload), timeoutPromise(180000)]);
}

async function callClaudeWithTools(messages, tools, system = "", model = MODEL_SMART) {
  const payload = { model, max_tokens: 4000, messages, tools };
  if (system) payload.system = system;
  return Promise.race([callAPI(payload), timeoutPromise(180000)]);
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("파일 읽기 실패"));
    r.readAsDataURL(file);
  });
}

// 🔧 수정: pdf.js 로딩을 Vite에서도 안정적으로 동작하도록 변경
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
let pdfjsLib = null;

async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  console.log("[PDF] pdf.js 라이브러리 로딩 시작...");
  const startTime = Date.now();
  try {
    // @vite-ignore 는 Vite에서 인식하는 동적 import 무시 주석
    pdfjsLib = await import(/* @vite-ignore */ PDFJS_CDN);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
    console.log(`[PDF] pdf.js 동적 import 성공 (${Date.now() - startTime}ms)`);
    return pdfjsLib;
  } catch (importErr) {
    console.warn("[PDF] 동적 import 실패, script 태그 폴백:", importErr.message);
    return new Promise((resolve, reject) => {
      if (window.pdfjsLib) {
        pdfjsLib = window.pdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
        return resolve(pdfjsLib);
      }
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js";
      script.onload = () => {
        if (window.pdfjsLib) {
          pdfjsLib = window.pdfjsLib;
          pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
          console.log(`[PDF] script 태그 로딩 성공 (${Date.now() - startTime}ms)`);
          resolve(pdfjsLib);
        } else {
          reject(new Error("pdf.js script 로딩 후 window.pdfjsLib 없음"));
        }
      };
      script.onerror = () => reject(new Error("pdf.js CDN 로딩 실패"));
      document.head.appendChild(script);
    });
  }
}

// 🔧 수정: 텍스트 추출에 상세 로깅 추가
async function extractTextFromPDF(file) {
  console.log(`[PDF] 텍스트 추출 시작: ${file.name} (${(file.size / 1024).toFixed(0)}KB)`);
  const startTime = Date.now();
  const lib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  console.log(`[PDF] 문서 열기 완료: ${pdf.numPages}페이지`);
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    if (text.trim()) pages.push(text.trim());
  }
  const fullText = pages.join("\n\n");
  console.log(`[PDF] 추출 완료: ${fullText.length}자, ${pages.length}/${pdf.numPages}페이지, ${Date.now() - startTime}ms`);
  if (fullText.length < 50) {
    console.warn(`[PDF] 텍스트 50자 미만 — 이미지 기반 PDF 가능성`);
    return null;
  }
  return fullText;
}

async function parallelMap(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ─── UI 컴포넌트 ─────────────────────────────────────────

const FONT = "'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif";
const STEPS = ["공고 입력", "평가 기준", "이력서 업로드", "스크리닝 결과"];

const StatusBadge = ({ status }) => {
  const map = {
    "충족":      { bg: "rgba(34,197,94,0.12)",  color: "#22c55e", border: "rgba(34,197,94,0.25)",  icon: "✓" },
    "미충족":    { bg: "rgba(239,68,68,0.10)",  color: "#ef4444", border: "rgba(239,68,68,0.2)",   icon: "✗" },
    "판단 불가": { bg: "rgba(245,158,11,0.10)", color: "#f59e0b", border: "rgba(245,158,11,0.2)",  icon: "?" },
  };
  const c = map[status] || map["판단 불가"];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 15px", borderRadius: 25, fontSize: 15, fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}`, letterSpacing: "0.02em", fontFamily: FONT }}>
      <span style={{ fontSize: 16 }}>{c.icon}</span>
      {status}
    </span>
  );
};

const RecBadge = ({ rec }) => {
  const colors = {
    PASS:  { bg: "rgba(34,197,94,0.12)",  color: "#22c55e", border: "rgba(34,197,94,0.25)"  },
    FAIL:  { bg: "rgba(239,68,68,0.10)",  color: "#ef4444", border: "rgba(239,68,68,0.2)"   },
    MAYBE: { bg: "rgba(245,158,11,0.10)", color: "#f59e0b", border: "rgba(245,158,11,0.2)"  },
  };
  const label = { PASS: "통과 추천", FAIL: "탈락", MAYBE: "검토 필요" };
  const c = colors[rec] || colors.MAYBE;
  return (
    <span style={{ display: "inline-block", padding: "4px 13px", borderRadius: 25, fontSize: 15, fontWeight: 600, background: c.bg, color: c.color, border: `1px solid ${c.border}`, letterSpacing: "0.02em", fontFamily: FONT }}>
      {label[rec] || rec}
    </span>
  );
};

const inputBase = {
  width: "100%", padding: "13px 15px", borderRadius: 10,
  border: "1px solid var(--border)", background: "var(--surface)",
  color: "var(--text)", fontSize: 16, outline: "none",
  fontFamily: FONT, boxSizing: "border-box", transition: "border-color 0.2s",
};

function CriteriaEditor({ initial, onConfirm, onBack }) {
  const [jobTitle, setJobTitle] = useState(initial.job_title || "");
  const [items, setItems] = useState(() =>
    (initial.criteria || []).map((c, i) => ({ id: c.id || i + 1, name: c.name || "", description: c.description || "" }))
  );
  const [formError, setFormError] = useState("");

  const update = (idx, field, value) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  const addItem = () => {
    const maxId = items.reduce((m, it) => Math.max(m, it.id), 0);
    setItems((prev) => [...prev, { id: maxId + 1, name: "", description: "" }]);
  };
  const removeItem = (idx) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };
  const handleConfirm = () => {
    if (!jobTitle.trim()) { setFormError("직무명을 입력하세요."); return; }
    if (items.some((it) => !it.name.trim())) { setFormError("모든 기준의 이름을 입력하세요."); return; }
    setFormError("");
    onConfirm({ job_title: jobTitle, criteria: items });
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 15, fontFamily: FONT }}>평가 기준 편집</h2>
      {formError && (
        <div style={{ padding: "12px 18px", borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", marginBottom: 15, color: "#f87171", fontSize: 15, fontFamily: FONT }}>
          {formError}
        </div>
      )}
      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500, marginBottom: 6, display: "block", fontFamily: FONT }}>직무명</label>
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="예: 백엔드 개발자" style={inputBase} />
      </div>
      {items.map((it, idx) => (
        <div key={it.id} style={{ padding: 20, borderRadius: 13, background: "var(--surface)", border: "1px solid var(--border)", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 14, color: "var(--accent2)", fontWeight: 600, fontFamily: FONT }}>기준 {idx + 1}</span>
            {items.length > 1 && (
              <button onClick={() => removeItem(idx)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18 }}>×</button>
            )}
          </div>
          <input value={it.name} onChange={(e) => update(idx, "name", e.target.value)} placeholder="기준명" style={{ ...inputBase, marginBottom: 8 }} />
          <input value={it.description} onChange={(e) => update(idx, "description", e.target.value)} placeholder="상세 설명 (이력서에서 확인할 키워드)" style={inputBase} />
        </div>
      ))}
      <button onClick={addItem} style={{ width: "100%", padding: "13px", borderRadius: 10, border: "1px dashed var(--border)", background: "transparent", color: "var(--text3)", fontSize: 16, cursor: "pointer", marginBottom: 20, fontFamily: FONT }}>
        + 기준 추가
      </button>
      <div style={{ display: "flex", gap: 13 }}>
        <button onClick={onBack} style={{ padding: "18px 30px", borderRadius: 13, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 18, cursor: "pointer", fontFamily: FONT }}>← 뒤로</button>
        <button onClick={handleConfirm} style={{ flex: 1, padding: "18px", borderRadius: 13, border: "none", background: "linear-gradient(135deg, var(--accent), #7c3aed)", color: "#fff", fontSize: 19, fontWeight: 600, cursor: "pointer", fontFamily: FONT }}>
          평가 기준 확정 →
        </button>
      </div>
    </div>
  );
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────

export default function AIScreeningTool() {
  const [step, setStep] = useState(0);
  const [jobPosting, setJobPosting] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [criteria, setCriteria] = useState(null);
  const [confirmedCriteria, setConfirmedCriteria] = useState(null);
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [savedTemplates, setSavedTemplates] = useState([]);
  const [saveName, setSaveName] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [topCandidates, setTopCandidates] = useState([]);
  const timerRef = useRef(null);
  const fileRef = useRef();

  useEffect(() => {
    (async () => {
      try { const res = await window.storage.get("screening-templates"); if (res?.value) setSavedTemplates(JSON.parse(res.value)); } catch {}
      try { const res = await window.storage.get("top-candidates"); if (res?.value) setTopCandidates(JSON.parse(res.value)); } catch {}
    })();
  }, []);

  const saveTemplate = useCallback(async (name) => {
    if (!confirmedCriteria || !name?.trim()) return;
    const tpl = { id: Date.now().toString(36), name: name.trim(), job_title: confirmedCriteria.job_title, jobPosting, criteria: confirmedCriteria.criteria, savedAt: new Date().toLocaleDateString("ko-KR") };
    const next = [tpl, ...savedTemplates.filter((t) => t.name !== tpl.name)].slice(0, 20);
    try {
      await window.storage.set("screening-templates", JSON.stringify(next));
      setSavedTemplates(next); setSaveName(""); setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (e) { setError("템플릿 저장 실패: " + e.message); }
  }, [confirmedCriteria, jobPosting, savedTemplates]);

  const deleteTemplate = useCallback(async (id) => {
    const next = savedTemplates.filter((t) => t.id !== id);
    try { await window.storage.set("screening-templates", JSON.stringify(next)); setSavedTemplates(next); }
    catch (e) { setError("템플릿 삭제 실패: " + e.message); }
  }, [savedTemplates]);

  const loadTemplate = useCallback((tpl) => {
    setJobPosting(tpl.jobPosting || "");
    const restored = { job_title: tpl.job_title, criteria: tpl.criteria };
    setCriteria(restored); setConfirmedCriteria(restored); setStep(2); setError("");
  }, []);

  const saveTopCandidates = useCallback(async (next) => {
    setTopCandidates(next);
    try { await window.storage.set("top-candidates", JSON.stringify(next)); }
    catch (e) { setError("순위 저장 실패: " + e.message); }
  }, []);

  const setAsTopCandidate = useCallback((candidate, rank) => {
    const entry = { ...candidate, rank, _id: Date.now().toString(36), _savedAt: new Date().toLocaleDateString("ko-KR"), _jobTitle: confirmedCriteria?.job_title || "" };
    const next = [...topCandidates.filter((t) => t.rank !== rank), entry].sort((a, b) => a.rank - b.rank);
    saveTopCandidates(next);
  }, [topCandidates, confirmedCriteria, saveTopCandidates]);

  const removeTopCandidate = useCallback((rank) => {
    saveTopCandidates(topCandidates.filter((t) => t.rank !== rank));
  }, [topCandidates, saveTopCandidates]);

  const swapTopCandidates = useCallback(() => {
    if (topCandidates.length < 2) return;
    saveTopCandidates(topCandidates.map((t) => ({ ...t, rank: t.rank === 1 ? 2 : t.rank === 2 ? 1 : t.rank })).sort((a, b) => a.rank - b.rank));
  }, [topCandidates, saveTopCandidates]);

  const startTimer = useCallback(() => {
    setElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
  }, []);
  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);
  useEffect(() => () => stopTimer(), [stopTimer]);

  const fetchJobPosting = useCallback(async () => {
    if (!jobUrl.trim()) return;
    setFetchingUrl(true); setError("");
    try {
      const result = await callClaudeWithTools(
        [{ role: "user", content: `다음 URL의 채용 공고 내용을 검색해서 추출해 주세요: ${jobUrl}` }],
        [{ type: "web_search_20250305", name: "web_search" }],
        SYS_URL_FETCH, MODEL_FAST
      );
      if (result?.trim()) { setJobPosting(result.trim()); setJobUrl(""); }
      else { setError("공고 내용을 가져오지 못했습니다."); }
    } catch (e) { setError(classifyError(e)); }
    finally { setFetchingUrl(false); }
  }, [jobUrl]);

  const generateCriteria = useCallback(async () => {
    if (!jobPosting.trim()) return;
    setLoading(true); setError(""); setLoadingMsg("채용 공고를 분석하고 있습니다..."); startTimer();
    try {
      const raw = await callClaude([{ role: "user", content: `다음 채용 공고를 분석하세요:\n\n${jobPosting}` }], SYS_CRITERIA, MODEL_SMART);
      const parsed = extractJSON(raw);
      if (!parsed?.criteria) throw new Error("응답에서 평가 기준을 추출하지 못했습니다.");
      setCriteria(parsed); setStep(1);
    } catch (e) { setError("평가 기준 생성 실패: " + classifyError(e)); }
    finally { stopTimer(); setLoading(false); }
  }, [jobPosting, startTimer, stopTimer]);

  const handleConfirmCriteria = useCallback((final_) => {
    setConfirmedCriteria(final_); setSaveName(final_.job_title || ""); setStep(2);
  }, []);

  const handleFiles = (e) => setFiles((prev) => [...prev, ...Array.from(e.target.files).filter((f) => f.type === "application/pdf")]);
  const removeFile = (idx) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  // 🔧 수정: screenResumes 내부의 processOne에 상세 로깅 + 안전한 PDF 처리
  const screenResumes = useCallback(async () => {
    const c = confirmedCriteria;
    if (!files.length || !c) return;
    setLoading(true); setError(""); setStep(3); startTimer();
    const MAX_SIZE = 30 * 1024 * 1024;
    const CONCURRENCY = 3;
    const criteriaCompact = c.criteria.map((cr) => `[ID:${cr.id}] ${cr.name}: ${cr.description}`).join("\n");
    let completedCount = 0;

    // 🔧 수정: processOne 함수 — 핵심 변경 부분
    const processOne = async (file) => {
      const fileLabel = `[${file.name}]`;
      try {
        if (file.size > MAX_SIZE) throw new Error(`파일 크기 초과 (${(file.size / 1024 / 1024).toFixed(1)}MB > 30MB)`);

        let content;
        let extractedText = null;

        // ── PDF 텍스트 추출 시도 ──
        try {
          extractedText = await extractTextFromPDF(file);
        } catch (pdfErr) {
          console.error(`${fileLabel} PDF 텍스트 추출 실패:`, pdfErr.message);
          throw new Error(`PDF 텍스트 추출 실패: ${pdfErr.message}\n💡 이미지 스캔 PDF이거나 암호화된 파일일 수 있습니다.`);
        }

        if (extractedText) {
          // ✅ 텍스트 추출 성공 → 텍스트만 전송
          console.log(`${fileLabel} 텍스트 모드 (${extractedText.length}자)`);
          content = [{ type: "text", text: `[이력서 텍스트 시작]\n${extractedText.slice(0, 12000)}\n[이력서 텍스트 끝]\n\n직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.` }];
        } else {
          // ⚠️ 이미지 기반 PDF → base64 (크기 제한 강화)
          console.warn(`${fileLabel} 텍스트 없음 → base64 모드`);
          if (file.size > 5 * 1024 * 1024) {
            throw new Error(`이미지 기반 PDF(${(file.size / 1024 / 1024).toFixed(1)}MB)는 5MB 이하만 지원됩니다.\n💡 텍스트 기반으로 다시 저장하거나 크기를 줄여주세요.`);
          }
          const base64 = await fileToBase64(file);
          console.log(`${fileLabel} base64 변환: ${(base64.length / 1024).toFixed(0)}KB`);
          content = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: `이 PDF는 이미지 기반이므로 텍스트를 읽어서 분석하세요.\n\n직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.` },
          ];
        }

        // ── API 호출 ──
        console.log(`${fileLabel} API 호출 시작`);
        const res = await Promise.race([
          callAPI({ model: MODEL_FAST, max_tokens: 2000, system: SYS_SCREENING, messages: [{ role: "user", content }] }),
          timeoutPromise(120000),
        ]);

        // ── 응답 파싱 ──
        const parsed = extractJSON(res);
        if (!parsed?.candidate_name) {
          console.error(`${fileLabel} JSON 파싱 실패. 원본:`, res.slice(0, 500));
          throw new Error("AI 응답 파싱 실패");
        }
        console.log(`${fileLabel} ✅ ${parsed.candidate_name} → ${parsed.recommendation}`);
        parsed._fileName = file.name;
        completedCount++;
        setLoadingMsg(`이력서 분석 중 (${completedCount}/${files.length} 완료)`);
        return parsed;
      } catch (e) {
        console.error(`${fileLabel} ❌ 분석 실패:`, e.message);
        completedCount++;
        setLoadingMsg(`이력서 분석 중 (${completedCount}/${files.length} 완료)`);
        return {
          candidate_name: file.name.replace(/\.pdf$/i, ""), _fileName: file.name, summary: "분석 실패",
          evaluations: c.criteria.map((cr) => ({ criteria_id: cr.id, status: "판단 불가", reason: "분석 오류로 평가 불가" })),
          recommendation: "FAIL", strength: "-", weakness: classifyError(e), _error: true,
        };
      }
    };

    try {
      setLoadingMsg(`이력서 분석 중 (0/${files.length} 완료) — 동시 ${CONCURRENCY}건 병렬 처리`);
      const allResults = await parallelMap(files, processOne, CONCURRENCY);
      const order = { PASS: 0, MAYBE: 1, FAIL: 2 };
      allResults.sort((a, b) => (order[a.recommendation] ?? 3) - (order[b.recommendation] ?? 3));
      setResults(allResults);
    } catch (outerErr) { setError("스크리닝 중 오류: " + classifyError(outerErr)); }
    finally { stopTimer(); setLoading(false); }
  }, [files, confirmedCriteria, startTimer, stopTimer]);

  const resetAll = () => {
    setStep(0); setCriteria(null); setConfirmedCriteria(null);
    setFiles([]); setResults([]); setError(""); setJobPosting(""); setJobUrl("");
    setSaveName(""); setSaveSuccess(false);
  };

  // ─── 렌더링 ────────────────────────────────────────────

  return (
    <div style={{
      "--bg": "#0a0a0f", "--surface": "#12121a", "--surface2": "#1e1e2a", "--surface3": "#2a2a3a",
      "--border": "#2a2a3d", "--text": "#e8e8f0", "--text2": "#8888a0", "--text3": "#55556a",
      "--accent": "#6366f1", "--accent2": "#818cf8", "--green": "#22c55e", "--amber": "#f59e0b", "--red": "#ef4444",
      fontFamily: FONT,
      background: "var(--bg)", color: "var(--text)", minHeight: "100vh", padding: 0, margin: 0,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* 헤더 */}
      <div style={{ padding: "35px 40px 25px", borderBottom: "1px solid var(--border)", background: "linear-gradient(180deg, #0f0f18 0%, var(--bg) 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 15, marginBottom: 25 }}>
          <div style={{ width: 45, height: 45, borderRadius: 13, background: "linear-gradient(135deg, var(--accent), #a78bfa)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 23 }}>⚡</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: FONT }}>AI 서류 스크리닝</h1>
            <p style={{ margin: 0, fontSize: 15, color: "var(--text2)", marginTop: 3, fontFamily: FONT }}>채용 공고 기반 · 충족/미충족 자동 판정</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5 }}>
          {STEPS.map((s, i) => {
            const active = i <= step;
            const current = i === step;
            return (
              <div key={i} style={{ flex: 1 }}>
                <div style={{ height: 4, borderRadius: 3, background: active ? (current ? "var(--accent)" : "var(--accent2)") : "var(--surface2)", transition: "all 0.3s", opacity: active ? 1 : 0.4 }} />
                <p style={{ fontSize: 14, color: active ? "var(--text2)" : "var(--text3)", margin: "8px 0 0", fontWeight: current ? 600 : 400, fontFamily: FONT }}>{s}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "30px 40px", maxWidth: 1200, margin: "0 auto" }}>

        {/* 로딩 */}
        {loading && (
          <div style={{ textAlign: "center", padding: "75px 25px" }}>
            <div style={{ width: 60, height: 60, border: "3px solid var(--surface2)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 25px" }} />
            <p style={{ fontSize: 19, color: "var(--text)", fontWeight: 500, fontFamily: FONT }}>{loadingMsg}</p>
            <p style={{ fontSize: 16, color: "var(--text3)", marginTop: 8, fontFamily: FONT }}>
              {elapsed < 30 ? `분석 중 · ${elapsed}초` : elapsed < 90 ? `처리 중 · ${elapsed}초` : `응답 대기 중 · ${elapsed}초`}
            </p>
            <button
              onClick={() => { stopTimer(); setLoading(false); setStep((prev) => (prev === 3 ? 2 : prev)); setError("사용자가 취소했습니다."); }}
              style={{ marginTop: 25, padding: "10px 25px", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 16, cursor: "pointer", fontFamily: FONT }}>
              취소
            </button>
          </div>
        )}

        {/* 에러 */}
        {error && (
          <div style={{ padding: "18px 23px", borderRadius: 13, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 15 }}>
            <pre style={{ fontSize: 15, color: "#f87171", margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: FONT, flex: 1 }}>{error}</pre>
            <button onClick={() => setError("")} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 20, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>
          </div>
        )}

        {/* STEP 0 */}
        {step === 0 && !loading && (
          <div>
            {savedTemplates.length > 0 && (
              <div style={{ marginBottom: 30 }}>
                <p style={{ fontSize: 15, color: "var(--text3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 13, fontFamily: FONT }}>
                  저장된 공고 ({savedTemplates.length})
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {savedTemplates.map((tpl) => (
                    <div key={tpl.id} style={{ display: "flex", alignItems: "center", padding: "13px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", cursor: "pointer" }} onClick={() => loadTemplate(tpl)}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 16, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: FONT }}>{tpl.name}</p>
                        <p style={{ fontSize: 14, color: "var(--text3)", margin: "3px 0 0", fontFamily: FONT }}>{tpl.job_title} · {tpl.criteria?.length}개 기준 · {tpl.savedAt}</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); deleteTemplate(tpl.id); }} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18, padding: "0 5px" }}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10, fontFamily: FONT }}>채용 공고 입력</h2>
            <textarea value={jobPosting} onChange={(e) => setJobPosting(e.target.value)}
              placeholder="채용 공고 내용을 붙여넣으세요..."
              style={{ ...inputBase, minHeight: 200, resize: "vertical", lineHeight: 1.6 }} />

            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "20px 0" }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span style={{ fontSize: 15, color: "var(--text3)", fontWeight: 500, fontFamily: FONT }}>또는 URL로 가져오기</span>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, display: "flex", alignItems: "center", borderRadius: 13, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
                <span style={{ padding: "0 0 0 18px", fontSize: 18, color: "var(--text3)" }}>🔗</span>
                <input type="url" value={jobUrl} onChange={(e) => setJobUrl(e.target.value)}
                  placeholder="채용 공고 URL" disabled={fetchingUrl}
                  style={{ flex: 1, padding: "16px 18px", border: "none", background: "transparent", color: "var(--text)", fontSize: 18, outline: "none", fontFamily: FONT }}
                  onKeyDown={(e) => { if (e.key === "Enter" && jobUrl.trim()) fetchJobPosting(); }} />
              </div>
              <button onClick={fetchJobPosting} disabled={!jobUrl.trim() || fetchingUrl}
                style={{ padding: "0 25px", borderRadius: 13, border: "1px solid var(--border)", background: jobUrl.trim() && !fetchingUrl ? "var(--surface2)" : "var(--surface)", color: jobUrl.trim() && !fetchingUrl ? "var(--text)" : "var(--text3)", fontSize: 16, fontWeight: 600, cursor: jobUrl.trim() && !fetchingUrl ? "pointer" : "not-allowed", whiteSpace: "nowrap", fontFamily: FONT }}>
                {fetchingUrl ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "inline-block", width: 18, height: 18, border: "2px solid var(--surface3)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    가져오는 중
                  </span>
                ) : "가져오기"}
              </button>
            </div>

            <button onClick={generateCriteria} disabled={!jobPosting.trim()}
              style={{ marginTop: 20, width: "100%", padding: "18px", borderRadius: 13, border: "none", background: jobPosting.trim() ? "linear-gradient(135deg, var(--accent), #7c3aed)" : "var(--surface2)", color: jobPosting.trim() ? "#fff" : "var(--text3)", fontSize: 19, fontWeight: 600, cursor: jobPosting.trim() ? "pointer" : "not-allowed", fontFamily: FONT }}>
              평가 기준 생성하기 →
            </button>
          </div>
        )}

        {/* STEP 1 */}
        {step === 1 && !loading && criteria && (
          <CriteriaEditor initial={confirmedCriteria || criteria} onConfirm={handleConfirmCriteria} onBack={() => { setStep(0); setCriteria(null); }} />
        )}

        {/* STEP 2 */}
        {step === 2 && !loading && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, fontFamily: FONT }}>이력서 / 포트폴리오 업로드</h2>
              <RecBadge rec="PASS" />
            </div>
            <p style={{ fontSize: 16, color: "var(--text2)", marginBottom: 10, lineHeight: 1.5, fontFamily: FONT }}>
              <strong style={{ color: "var(--text)" }}>{confirmedCriteria?.job_title}</strong> — PDF 파일을 업로드하면 확정된 기준으로 빠르게 스크리닝합니다.
            </p>

            <div style={{ padding: "15px 20px", borderRadius: 13, background: "var(--surface)", border: "1px solid var(--border)", marginBottom: 20 }}>
              <p style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10, fontFamily: FONT }}>확정된 평가 기준 ({confirmedCriteria?.criteria.length}개)</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {confirmedCriteria?.criteria.map((c) => (
                  <span key={c.id} style={{ fontSize: 15, padding: "5px 13px", borderRadius: 8, background: "var(--surface2)", color: "var(--text2)", border: "1px solid var(--border)", fontFamily: FONT }}>
                    {c.name}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "center" }}>
              <div style={{ flex: 1, display: "flex", alignItems: "center", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
                <span style={{ padding: "0 0 0 15px", fontSize: 16, color: "var(--text3)", flexShrink: 0 }}>💾</span>
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)}
                  placeholder="저장할 이름 (예: 백엔드 시니어 2차)"
                  style={{ flex: 1, padding: "13px 15px", border: "none", background: "transparent", color: "var(--text)", fontSize: 16, outline: "none", fontFamily: FONT }}
                  onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) saveTemplate(saveName); }} />
              </div>
              <button onClick={() => saveTemplate(saveName)} disabled={!saveName.trim()}
                style={{ padding: "13px 20px", borderRadius: 10, border: "1px solid var(--border)", background: saveSuccess ? "rgba(34,197,94,0.12)" : (saveName.trim() ? "var(--surface2)" : "var(--surface)"), color: saveSuccess ? "var(--green)" : (saveName.trim() ? "var(--text)" : "var(--text3)"), fontSize: 16, fontWeight: 600, cursor: saveName.trim() ? "pointer" : "not-allowed", whiteSpace: "nowrap", transition: "all 0.2s", fontFamily: FONT }}>
                {saveSuccess ? "✓ 저장됨" : "저장"}
              </button>
            </div>

            <div onClick={() => fileRef.current?.click()}
              style={{ border: "2px dashed var(--border)", borderRadius: 15, padding: "50px 25px", textAlign: "center", cursor: "pointer", background: "var(--surface)" }}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--accent)"; }}
              onDragLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--border)"; setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files).filter((f) => f.type === "application/pdf")]); }}>
              <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFiles} style={{ display: "none" }} />
              <div style={{ fontSize: 40, marginBottom: 13, opacity: 0.5 }}>📄</div>
              <p style={{ fontSize: 18, color: "var(--text2)", margin: 0, fontFamily: FONT }}>클릭하거나 파일을 드래그하세요</p>
              <p style={{ fontSize: 15, color: "var(--text3)", margin: "8px 0 0", fontFamily: FONT }}>PDF · 30MB 이하 · 텍스트 추출 후 Haiku로 고속 분석</p>
            </div>

            {files.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <p style={{ fontSize: 15, color: "var(--text3)", marginBottom: 10, fontWeight: 500, fontFamily: FONT }}>{files.length}개 파일</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", padding: "13px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, fontFamily: FONT }}>📄 {f.name}</span>
                      <span style={{ fontSize: 14, color: f.size > 30 * 1024 * 1024 ? "var(--red)" : "var(--text3)", fontFamily: FONT, flexShrink: 0, marginRight: 10 }}>
                        {f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + "MB" : Math.round(f.size / 1024) + "KB"}
                      </span>
                      <button onClick={() => removeFile(i)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 20, padding: "0 5px" }}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {topCandidates.length > 0 && (
              <div style={{ marginTop: 25 }}>
                <div style={{ padding: "18px 20px", borderRadius: 13, background: "linear-gradient(135deg, rgba(99,102,241,0.05), rgba(168,85,247,0.05))", border: "1px solid rgba(99,102,241,0.15)", marginBottom: 13 }}>
                  <p style={{ fontSize: 14, color: "var(--accent2)", fontWeight: 600, margin: "0 0 13px", textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: FONT }}>
                    🏆 현재 추천 순위 — 새 스크리닝 결과와 비교해 보세요
                  </p>
                  <div style={{ display: "flex", gap: 10 }}>
                    {topCandidates.map((pick) => (
                      <div key={pick.rank} style={{ flex: 1, padding: "13px 15px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, padding: "3px 8px", borderRadius: 5, background: pick.rank === 1 ? "rgba(34,197,94,0.12)" : "rgba(99,102,241,0.12)", color: pick.rank === 1 ? "var(--green)" : "var(--accent2)", fontFamily: FONT }}>
                            {pick.rank}순위
                          </span>
                          <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: FONT }}>{pick.candidate_name}</span>
                        </div>
                        <p style={{ fontSize: 14, color: "var(--text3)", margin: "0 0 3px", fontFamily: FONT }}>{pick._jobTitle}</p>
                        <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, fontFamily: FONT }}>💪 {pick.strength}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 13, marginTop: 13 }}>
              <button onClick={() => setStep(1)} style={{ padding: "18px 30px", borderRadius: 13, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 18, cursor: "pointer", fontFamily: FONT }}>← 기준 수정</button>
              <button onClick={screenResumes} disabled={!files.length}
                style={{ flex: 1, padding: "18px", borderRadius: 13, border: "none", background: files.length ? "linear-gradient(135deg, var(--accent), #7c3aed)" : "var(--surface2)", color: files.length ? "#fff" : "var(--text3)", fontSize: 19, fontWeight: 600, cursor: files.length ? "pointer" : "not-allowed", fontFamily: FONT }}>
                스크리닝 시작 →
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 — 결과 */}
        {step === 3 && !loading && results.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, fontFamily: FONT }}>스크리닝 결과 ({results.length}명)</h2>
              <button onClick={resetAll} style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 15, cursor: "pointer", fontFamily: FONT }}>
                새로 시작
              </button>
            </div>

            {/* 추천 순위 슬롯 */}
            <div style={{ display: "flex", gap: 13, marginBottom: 25 }}>
              {[1, 2].map((rank) => {
                const pick = topCandidates.find((t) => t.rank === rank);
                return (
                  <div key={rank} style={{ flex: 1, padding: "18px", borderRadius: 13, background: pick ? "var(--surface)" : "var(--surface2)", border: `1px solid ${pick ? (rank === 1 ? "rgba(34,197,94,0.3)" : "rgba(99,102,241,0.3)") : "var(--border)"}`, position: "relative" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: pick ? 10 : 0 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, fontSize: 14, fontWeight: 700, fontFamily: FONT, background: rank === 1 ? "rgba(34,197,94,0.15)" : "rgba(99,102,241,0.15)", color: rank === 1 ? "var(--green)" : "var(--accent2)" }}>
                        {rank}
                      </span>
                      {pick ? (
                        <span style={{ fontSize: 16, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontFamily: FONT }}>{pick.candidate_name}</span>
                      ) : (
                        <span style={{ fontSize: 15, color: "var(--text3)", fontFamily: FONT }}>아래 결과에서 선택하세요</span>
                      )}
                    </div>
                    {pick && (
                      <>
                        <p style={{ fontSize: 14, color: "var(--text3)", margin: "0 0 3px", fontFamily: FONT }}>{pick._jobTitle}</p>
                        <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, fontFamily: FONT }}>💪 {pick.strength}</p>
                        <button onClick={() => removeTopCandidate(rank)} style={{ position: "absolute", top: 10, right: 10, background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 16 }}>×</button>
                      </>
                    )}
                  </div>
                );
              })}
              {topCandidates.length >= 2 && (
                <button onClick={swapTopCandidates} style={{ alignSelf: "center", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text2)", cursor: "pointer", fontSize: 16 }}>⇄</button>
              )}
            </div>

            {/* 결과 카드 */}
            {results.map((r, idx) => (
              <div key={idx} style={{ marginBottom: 12, borderRadius: 13, border: `1px solid ${r._error ? "rgba(239,68,68,0.3)" : "var(--border)"}`, background: "var(--surface)", overflow: "hidden" }}>
                <div onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                  style={{ display: "flex", alignItems: "center", padding: "18px 20px", cursor: "pointer", gap: 15 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                      <span style={{ fontSize: 17, fontWeight: 600, fontFamily: FONT }}>{r.candidate_name}</span>
                      <RecBadge rec={r.recommendation} />
                    </div>
                    <p style={{ fontSize: 15, color: "var(--text2)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: FONT }}>{r.summary}</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    {!r._error && [1, 2].map((rank) => (
                      <button key={rank} onClick={(e) => { e.stopPropagation(); setAsTopCandidate(r, rank); }}
                        style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: topCandidates.find((t) => t.rank === rank && t.candidate_name === r.candidate_name) ? (rank === 1 ? "rgba(34,197,94,0.15)" : "rgba(99,102,241,0.15)") : "transparent", color: rank === 1 ? "var(--green)" : "var(--accent2)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: FONT }}>
                        {rank}순위
                      </button>
                    ))}
                    <span style={{ fontSize: 18, color: "var(--text3)", cursor: "pointer" }}>{expandedIdx === idx ? "▲" : "▼"}</span>
                  </div>
                </div>

                {expandedIdx === idx && (
                  <div style={{ padding: "0 20px 20px", borderTop: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", gap: 15, margin: "15px 0" }}>
                      <div style={{ flex: 1, padding: "13px 15px", borderRadius: 10, background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.15)" }}>
                        <p style={{ fontSize: 13, color: "var(--green)", fontWeight: 600, margin: "0 0 5px", fontFamily: FONT }}>강점</p>
                        <p style={{ fontSize: 15, color: "var(--text)", margin: 0, lineHeight: 1.5, fontFamily: FONT }}>{r.strength}</p>
                      </div>
                      <div style={{ flex: 1, padding: "13px 15px", borderRadius: 10, background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.15)" }}>
                        <p style={{ fontSize: 13, color: "var(--red)", fontWeight: 600, margin: "0 0 5px", fontFamily: FONT }}>약점</p>
                        <p style={{ fontSize: 15, color: "var(--text)", margin: 0, lineHeight: 1.5, fontFamily: FONT }}>{r.weakness}</p>
                      </div>
                    </div>
                    {r.evaluations?.map((ev, eidx) => {
                      const cr = confirmedCriteria?.criteria?.find((c) => c.id === ev.criteria_id);
                      return (
                        <div key={eidx} style={{ padding: "15px", borderRadius: 10, background: "var(--surface2)", marginBottom: 8 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <span style={{ fontSize: 15, fontWeight: 600, fontFamily: FONT }}>{cr?.name || `기준 ${ev.criteria_id}`}</span>
                            <StatusBadge status={ev.status} />
                          </div>
                          <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: FONT }}>{ev.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
