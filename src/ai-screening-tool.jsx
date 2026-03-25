import { useState, useRef, useCallback, useEffect } from "react";

/* ═══════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════ */
const API_BASE = "https://ai-screener-api.qkrcksgud91.workers.dev";
const API_URL = "https://ai-screener-api.qkrcksgud91.workers.dev";

const MODEL_SMART = "claude-sonnet-4-6";
const MODEL_FAST = "claude-haiku-4-5-20251001";

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPTS
   ═══════════════════════════════════════════════════════════ */
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
1. status: "충족", "미충족", "판단 불가" 중 하나만 작성하십시오. (절대 점수를 매기지 마십시오.)
2. reason: 반드시 "1. ~임. 2. ~함." 과 같이 번호를 매기고 개조식으로 작성하십시오.
3. recommendation: 평가를 종합하여 "PASS", "MAYBE", "FAIL" 중 하나를 기재하십시오.`;

const SYS_URL_FETCH = `당신은 채용 공고 추출 전문가입니다. 웹 검색 결과에서 채용 공고의 핵심 내용을 추출하여 정리합니다.
반드시 채용 공고 원문의 내용을 최대한 충실하게 한국어로 정리하세요.
포지션명, 주요 업무, 자격 요건, 우대 사항, 근무 조건 등을 포함해 정리하세요.
마크다운이나 JSON이 아닌 일반 텍스트로 작성하세요.`;

/* ═══════════════════════════════════════════════════════════
   API HELPERS
   ═══════════════════════════════════════════════════════════ */
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

function classifyError(e) {
  const msg = e?.message || String(e);
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("fetch")) {
    return `[네트워크 에러] 외부 API 연결 실패. CORS 차단 또는 네트워크 미연결 가능성.\n원본: ${msg}\n\n💡 해결: Cloudflare Worker 프록시를 배포하고 API_BASE를 Worker URL로 변경하세요.`;
  }
  if (msg.includes("CORS") || msg.includes("cors") || msg.includes("access-control")) {
    return `[CORS 에러] 브라우저가 API 서버로의 직접 요청을 차단했습니다.\n원본: ${msg}\n\n💡 해결: Cloudflare Worker 프록시를 통해 우회해야 합니다.`;
  }
  if (msg.includes("타임아웃") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `[타임아웃] API 응답이 제한 시간 내에 돌아오지 않았습니다.\n원본: ${msg}`;
  }
  if (msg.includes("API 4")) {
    return `[API 클라이언트 에러] 요청 형식 또는 인증 문제.\n원본: ${msg}`;
  }
  if (msg.includes("API 5")) {
    return `[API 서버 에러] Anthropic 서버 측 문제.\n원본: ${msg}`;
  }
  return `[알 수 없는 에러] ${msg}`;
}

async function callAPI(payload) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  if (!text.trim()) {
    throw new Error(`빈 응답 (stop_reason: ${data.stop_reason || "unknown"})`);
  }
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

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

let pdfjsLib = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(/* webpackIgnore: true */ PDFJS_CDN);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
  return pdfjsLib;
}

async function extractTextFromPDF(file) {
  const lib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str).join(" ");
    if (text.trim()) pages.push(text.trim());
  }
  const fullText = pages.join("\n\n");
  if (fullText.length < 50) return null;
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

/* ═══════════════════════════════════════════════════════════
   UI PRIMITIVES
   ═══════════════════════════════════════════════════════════ */
const STEPS = ["공고 입력", "평가 기준", "이력서 업로드", "스크리닝 결과"];

const StatusBadge = ({ status }) => {
  const map = {
    "충족": { bg: "rgba(34,197,94,0.12)", color: "#22c55e", border: "rgba(34,197,94,0.25)", icon: "✓" },
    "미충족": { bg: "rgba(239,68,68,0.10)", color: "#ef4444", border: "rgba(239,68,68,0.2)", icon: "✗" },
    "판단 불가": { bg: "rgba(245,158,11,0.10)", color: "#f59e0b", border: "rgba(245,158,11,0.2)", icon: "?" },
  };
  const c = map[status] || map["판단 불가"];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "4px 12px", borderRadius: 20, fontSize: 14, fontWeight: 600,  /* 12→14 */
      background: c.bg, color: c.color, border: `1px solid ${c.border}`,
      letterSpacing: "0.02em",
    }}>
      <span style={{ fontSize: 16 }}>{c.icon}</span>  {/* 13→16 */}
      {status}
    </span>
  );
};

const RecBadge = ({ rec }) => {
  const colors = {
    PASS: { bg: "rgba(34,197,94,0.12)", color: "#22c55e", border: "rgba(34,197,94,0.25)" },
    FAIL: { bg: "rgba(239,68,68,0.10)", color: "#ef4444", border: "rgba(239,68,68,0.2)" },
    MAYBE: { bg: "rgba(245,158,11,0.10)", color: "#f59e0b", border: "rgba(245,158,11,0.2)" },
  };
  const label = { PASS: "통과 추천", FAIL: "탈락", MAYBE: "검토 필요" };
  const c = colors[rec] || colors.MAYBE;
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: 20, fontSize: 14, fontWeight: 600,  /* 12→14 */
      background: c.bg, color: c.color, border: `1px solid ${c.border}`, letterSpacing: "0.02em",
    }}>
      {label[rec] || rec}
    </span>
  );
};

const inputBase = {
  width: "100%", padding: "10px 12px", borderRadius: 8,
  border: "1px solid var(--border)", background: "var(--surface)",
  color: "var(--text)", fontSize: 16, outline: "none",  /* 13→16 */
  fontFamily: "inherit", boxSizing: "border-box", transition: "border-color 0.2s",
};

/* ═══════════════════════════════════════════════════════════
   CRITERIA EDITOR
   ═══════════════════════════════════════════════════════════ */
function CriteriaEditor({ initial, onConfirm, onBack }) {
  const [jobTitle, setJobTitle] = useState(initial.job_title || "");
  const [items, setItems] = useState(() =>
    (initial.criteria || []).map((c, i) => ({ id: c.id || i + 1, name: c.name || "", description: c.description || "" }))
  );
  const [formError, setFormError] = useState("");

  const update = (idx, field, value) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [field]: value } : it)));
  };
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
    onConfirm({
      job_title: jobTitle.trim(),
      criteria: items.map((it) => ({ id: it.id, name: it.name.trim(), description: (it.description || "").trim() })),
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>평가 기준 편집</h2>  {/* 16→19 */}
          <p style={{ fontSize: 14, color: "var(--text2)", margin: "4px 0 0" }}>AI가 생성한 기준을 수정·추가·삭제할 수 있습니다</p>  {/* 12→14 */}
        </div>
        <button onClick={onBack} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 14, cursor: "pointer" }}>  {/* 12→14 */}
          ← 공고 다시 작성
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500, display: "block", marginBottom: 6 }}>직무명</label>  {/* 12→14 */}
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="예: 시니어 백엔드 엔지니어" style={inputBase}
          onFocus={(e) => (e.target.style.borderColor = "var(--accent)")} onBlur={(e) => (e.target.style.borderColor = "var(--border)")} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.map((item, idx) => (
          <div key={item.id} style={{ padding: "16px 18px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontFamily: "'IBM Plex Mono', monospace", color: "var(--accent2)", fontWeight: 600 }}>  {/* 12→14 */}
                기준 {String(idx + 1).padStart(2, "0")}
              </span>
              <button onClick={() => removeItem(idx)} disabled={items.length <= 1}
                style={{ background: "none", border: "none", fontSize: 22, cursor: items.length > 1 ? "pointer" : "not-allowed", color: items.length > 1 ? "var(--red)" : "var(--text3)", padding: "0 4px", lineHeight: 1 }}>×</button>  {/* 18→22 */}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, display: "block", marginBottom: 4 }}>기준명</label>  {/* 11→13 */}
              <input value={item.name} onChange={(e) => update(idx, "name", e.target.value)} placeholder="예: Python 백엔드 개발 역량" style={inputBase}
                onFocus={(e) => (e.target.style.borderColor = "var(--accent)")} onBlur={(e) => (e.target.style.borderColor = "var(--border)")} />
            </div>
            <div>
              <label style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, display: "block", marginBottom: 4 }}>설명 (이력서에서 확인할 구체적 지표)</label>  {/* 11→13 */}
              <textarea value={item.description || ""} onChange={(e) => update(idx, "description", e.target.value)}
                placeholder="이력서에서 확인해야 할 구체적인 지표나 키워드" rows={2}
                style={{ ...inputBase, resize: "vertical", lineHeight: 1.5 }}
                onFocus={(e) => (e.target.style.borderColor = "var(--accent)")} onBlur={(e) => (e.target.style.borderColor = "var(--border)")} />
            </div>
          </div>
        ))}
      </div>

      {items.length < 7 && (
        <button onClick={addItem} style={{ marginTop: 12, width: "100%", padding: "12px", borderRadius: 10, border: "1px dashed var(--border)", background: "transparent", color: "var(--text2)", fontSize: 16, cursor: "pointer" }}>  {/* 13→16 */}
          + 평가 기준 추가
        </button>
      )}

      {formError && <p style={{ fontSize: 16, color: "var(--red)", marginTop: 12 }}>{formError}</p>}  {/* 13→16 */}

      <button onClick={handleConfirm} style={{
        marginTop: 16, width: "100%", padding: "14px", borderRadius: 10, border: "none",
        background: "linear-gradient(135deg, var(--accent), #7c3aed)", color: "#fff",
        fontSize: 18, fontWeight: 600, cursor: "pointer",  /* 15→18 */
      }}>
        평가 기준 확정 →
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════ */
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
      try {
        const res = await window.storage.get("screening-templates");
        if (res?.value) setSavedTemplates(JSON.parse(res.value));
      } catch {}
      try {
        const res = await window.storage.get("top-candidates");
        if (res?.value) setTopCandidates(JSON.parse(res.value));
      } catch {}
    })();
  }, []);

  const saveTemplate = useCallback(async (name) => {
    if (!confirmedCriteria || !name?.trim()) return;
    const tpl = {
      id: Date.now().toString(36),
      name: name.trim(),
      job_title: confirmedCriteria.job_title,
      jobPosting,
      criteria: confirmedCriteria.criteria,
      savedAt: new Date().toLocaleDateString("ko-KR"),
    };
    const next = [tpl, ...savedTemplates.filter((t) => t.name !== tpl.name)].slice(0, 20);
    try {
      await window.storage.set("screening-templates", JSON.stringify(next));
      setSavedTemplates(next);
      setSaveName("");
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (e) { setError("템플릿 저장 실패: " + e.message); }
  }, [confirmedCriteria, jobPosting, savedTemplates]);

  const deleteTemplate = useCallback(async (id) => {
    const next = savedTemplates.filter((t) => t.id !== id);
    try {
      await window.storage.set("screening-templates", JSON.stringify(next));
      setSavedTemplates(next);
    } catch (e) { setError("템플릿 삭제 실패: " + e.message); }
  }, [savedTemplates]);

  const loadTemplate = useCallback((tpl) => {
    setJobPosting(tpl.jobPosting || "");
    const restored = { job_title: tpl.job_title, criteria: tpl.criteria };
    setCriteria(restored);
    setConfirmedCriteria(restored);
    setStep(2);
    setError("");
  }, []);

  const saveTopCandidates = useCallback(async (next) => {
    setTopCandidates(next);
    try { await window.storage.set("top-candidates", JSON.stringify(next)); }
    catch (e) { setError("순위 저장 실패: " + e.message); }
  }, []);

  const setAsTopCandidate = useCallback((candidate, rank) => {
    const entry = {
      ...candidate,
      rank,
      _id: Date.now().toString(36),
      _savedAt: new Date().toLocaleDateString("ko-KR"),
      _jobTitle: confirmedCriteria?.job_title || "",
    };
    const next = [...topCandidates.filter((t) => t.rank !== rank), entry].sort((a, b) => a.rank - b.rank);
    saveTopCandidates(next);
  }, [topCandidates, confirmedCriteria, saveTopCandidates]);

  const removeTopCandidate = useCallback((rank) => {
    const next = topCandidates.filter((t) => t.rank !== rank);
    saveTopCandidates(next);
  }, [topCandidates, saveTopCandidates]);

  const swapTopCandidates = useCallback(() => {
    if (topCandidates.length < 2) return;
    const next = topCandidates.map((t) => ({ ...t, rank: t.rank === 1 ? 2 : t.rank === 2 ? 1 : t.rank })).sort((a, b) => a.rank - b.rank);
    saveTopCandidates(next);
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
        SYS_URL_FETCH,
        MODEL_SMART
      );
      if (result?.trim()) { setJobPosting(result.trim()); setJobUrl(""); }
      else { setError("공고 내용을 가져오지 못했습니다."); }
    } catch (e) {
      setError(classifyError(e));
    } finally { setFetchingUrl(false); }
  }, [jobUrl]);

  const generateCriteria = useCallback(async () => {
    if (!jobPosting.trim()) return;
    setLoading(true); setError(""); setLoadingMsg("채용 공고를 분석하고 있습니다..."); startTimer();
    try {
      const raw = await callClaude(
        [{ role: "user", content: `다음 채용 공고를 분석하세요:\n\n${jobPosting}` }],
        SYS_CRITERIA,
        MODEL_SMART
      );
      const parsed = extractJSON(raw);
      if (!parsed?.criteria) throw new Error("응답에서 평가 기준을 추출하지 못했습니다.");
      setCriteria(parsed);
      setStep(1);
    } catch (e) { setError("평가 기준 생성 실패: " + classifyError(e)); }
    finally { stopTimer(); setLoading(false); }
  }, [jobPosting, startTimer, stopTimer]);

  const handleConfirmCriteria = useCallback((final_) => {
    setConfirmedCriteria(final_);
    setSaveName(final_.job_title || "");
    setStep(2);
  }, []);

  const handleFiles = (e) => {
    setFiles((prev) => [...prev, ...Array.from(e.target.files).filter((f) => f.type === "application/pdf")]);
  };
  const removeFile = (idx) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const screenResumes = useCallback(async () => {
    const c = confirmedCriteria;
    if (!files.length || !c) return;
    setLoading(true); setError(""); setStep(3); startTimer();
    const MAX_SIZE = 30 * 1024 * 1024;
    const CONCURRENCY = 3;

    const criteriaCompact = c.criteria.map((cr) => `[ID:${cr.id}] ${cr.name}: ${cr.description}`).join("\n");
    let completedCount = 0;

    const processOne = async (file, i) => {
      try {
        if (file.size > MAX_SIZE) throw new Error(`파일 크기 초과 (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

        let content;
        try {
          const text = await extractTextFromPDF(file);
          if (text) {
            content = [
              { type: "text", text: `[이력서 텍스트 시작]\n${text.slice(0, 12000)}\n[이력서 텍스트 끝]\n\n직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.` },
            ];
          } else {
            const base64 = await fileToBase64(file);
            content = [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
              { type: "text", text: `직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요. 이미지 기반 PDF이므로 텍스트를 읽어서 분석하세요.` },
            ];
          }
        } catch {
          const base64 = await fileToBase64(file);
          content = [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
            { type: "text", text: `직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.` },
          ];
        }

        const payload = {
          model: MODEL_FAST,
          max_tokens: 2000,
          system: SYS_SCREENING,
          messages: [{ role: "user", content }],
        };
        const res = await Promise.race([callAPI(payload), timeoutPromise(120000)]);
        const parsed = extractJSON(res);
        if (!parsed?.candidate_name) throw new Error("AI 응답 파싱 실패");
        parsed._fileName = file.name;
        completedCount++;
        setLoadingMsg(`이력서 분석 중 (${completedCount}/${files.length} 완료)`);
        return parsed;
      } catch (e) {
        completedCount++;
        setLoadingMsg(`이력서 분석 중 (${completedCount}/${files.length} 완료)`);
        const detail = classifyError(e);
        return {
          candidate_name: file.name.replace(/\.pdf$/i, ""),
          _fileName: file.name,
          summary: "분석 실패",
          evaluations: c.criteria.map((cr) => ({ criteria_id: cr.id, status: "판단 불가", reason: "분석 오류로 평가 불가" })),
          recommendation: "FAIL",
          strength: "-",
          weakness: detail,
          _error: true,
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

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <div style={{
      "--bg": "#0a0a0f", "--surface": "#12121a", "--surface2": "#1e1e2a", "--surface3": "#2a2a3a",
      "--border": "#2a2a3d", "--text": "#e8e8f0", "--text2": "#8888a0", "--text3": "#55556a",
      "--accent": "#6366f1", "--accent2": "#818cf8", "--green": "#22c55e", "--amber": "#f59e0b", "--red": "#ef4444",
      fontFamily: "'IBM Plex Sans', 'Pretendard', -apple-system, sans-serif",
      background: "var(--bg)", color: "var(--text)", minHeight: "100vh", padding: 0, margin: 0,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ padding: "28px 32px 20px", borderBottom: "1px solid var(--border)", background: "linear-gradient(180deg, #0f0f18 0%, var(--bg) 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, var(--accent), #a78bfa)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>⚡</div>  {/* 18→22 */}
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>AI 서류 스크리닝</h1>  {/* 20→24 */}
            <p style={{ margin: 0, fontSize: 14, color: "var(--text2)", marginTop: 2 }}>채용 공고 기반 · 충족/미충족 자동 판정</p>  {/* 12→14 */}
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {STEPS.map((s, i) => {
            const active = i <= step; const current = i === step;
            return (
              <div key={i} style={{ flex: 1 }}>
                <div style={{ height: 3, borderRadius: 2, background: active ? (current ? "var(--accent)" : "var(--accent2)") : "var(--surface2)", transition: "all 0.3s", opacity: active ? 1 : 0.4 }} />
                <p style={{ fontSize: 13, color: active ? "var(--text2)" : "var(--text3)", margin: "6px 0 0", fontWeight: current ? 600 : 400 }}>{s}</p>  {/* 11→13 */}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1200, margin: "0 auto" }}>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ width: 48, height: 48, border: "3px solid var(--surface2)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 20px" }} />
            <p style={{ fontSize: 18, color: "var(--text)", fontWeight: 500 }}>{loadingMsg}</p>  {/* 15→18 */}
            <p style={{ fontSize: 16, color: "var(--text3)", marginTop: 6 }}>  {/* 13→16 */}
              {elapsed < 30 ? `분석 중 · ${elapsed}초` : elapsed < 90 ? `처리 중 · ${elapsed}초` : `응답 대기 중 · ${elapsed}초`}
            </p>
            <button onClick={() => { stopTimer(); setLoading(false); setStep((prev) => (prev === 3 ? 2 : prev)); setError("사용자가 취소했습니다."); }}
              style={{ marginTop: 20, padding: "8px 20px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 16, cursor: "pointer" }}>  {/* 13→16 */}
              취소
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding: "14px 18px", borderRadius: 10, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <pre style={{ fontSize: 14, color: "#f87171", margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'IBM Plex Mono', monospace", flex: 1 }}>{error}</pre>  {/* 12→14 */}
            <button onClick={() => setError("")} style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", fontSize: 19, padding: 0, flexShrink: 0, lineHeight: 1 }}>×</button>  {/* 16→19 */}
          </div>
        )}

        {/* ═══ STEP 0 ═══ */}
        {step === 0 && !loading && (
          <div>
            {savedTemplates.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <p style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>  {/* 12→14 */}
                  저장된 공고 ({savedTemplates.length})
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {savedTemplates.map((tpl) => (
                    <div key={tpl.id} style={{
                      display: "flex", alignItems: "center", padding: "12px 16px", borderRadius: 10,
                      background: "var(--surface)", border: "1px solid var(--border)", cursor: "pointer",
                      transition: "border-color 0.2s",
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
                    >
                      <div style={{ flex: 1, minWidth: 0 }} onClick={() => loadTemplate(tpl)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                          <span style={{ fontSize: 17, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>  {/* 14→17 */}
                            {tpl.name}
                          </span>
                          <span style={{ fontSize: 13, color: "var(--accent2)", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0 }}>  {/* 11→13 */}
                            {tpl.criteria?.length || 0}개 기준
                          </span>
                        </div>
                        <p style={{ fontSize: 14, color: "var(--text3)", margin: 0 }}>  {/* 12→14 */}
                          {tpl.job_title} · {tpl.savedAt}
                        </p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); deleteTemplate(tpl.id); }}
                        style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18, padding: "4px 8px", flexShrink: 0, lineHeight: 1, borderRadius: 6 }}  {/* 15→18 */}
                        title="삭제">
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "20px 0 0" }}>
                  <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                  <span style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500 }}>또는 새로 입력</span>  {/* 12→14 */}
                  <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                </div>
              </div>
            )}

            <h2 style={{ fontSize: 19, fontWeight: 600, marginBottom: 6 }}>채용 공고를 입력하세요</h2>  {/* 16→19 */}
            <p style={{ fontSize: 16, color: "var(--text2)", marginBottom: 16, lineHeight: 1.5 }}>공고를 직접 붙여넣거나, URL을 입력하면 자동으로 가져옵니다.</p>  {/* 13→16 */}
            <textarea value={jobPosting} onChange={(e) => setJobPosting(e.target.value)}
              placeholder={"채용 공고 전문을 여기에 붙여넣으세요...\n\n예시:\n[포지션] 시니어 백엔드 개발자\n[주요업무] 대규모 트래픽 처리 시스템 설계 및 개발...\n[자격요건] Java/Kotlin 기반 개발 경력 5년 이상..."}
              style={{ ...inputBase, minHeight: 200, padding: 16, borderRadius: 12, fontSize: 17, lineHeight: 1.6, resize: "vertical" }}  {/* 14→17 */}
              onFocus={(e) => (e.target.style.borderColor = "var(--accent)")} onBlur={(e) => (e.target.style.borderColor = "var(--border)")} />
            <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "18px 0" }}>
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              <span style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500 }}>또는 URL로 가져오기</span>  {/* 12→14 */}
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, display: "flex", alignItems: "center", borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
                <span style={{ padding: "0 0 0 14px", fontSize: 17, color: "var(--text3)" }}>🔗</span>  {/* 14→17 */}
                <input type="url" value={jobUrl} onChange={(e) => setJobUrl(e.target.value)}
                  placeholder="채용 공고 URL" disabled={fetchingUrl}
                  style={{ flex: 1, padding: "13px 14px", border: "none", background: "transparent", color: "var(--text)", fontSize: 17, outline: "none", fontFamily: "inherit" }}  {/* 14→17 */}
                  onKeyDown={(e) => { if (e.key === "Enter" && jobUrl.trim()) fetchJobPosting(); }}
                  onFocus={(e) => (e.target.parentElement.style.borderColor = "var(--accent)")}
                  onBlur={(e) => (e.target.parentElement.style.borderColor = "var(--border)")} />
              </div>
              <button onClick={fetchJobPosting} disabled={!jobUrl.trim() || fetchingUrl}
                style={{ padding: "0 20px", borderRadius: 10, border: "1px solid var(--border)", background: jobUrl.trim() && !fetchingUrl ? "var(--surface2)" : "var(--surface)", color: jobUrl.trim() && !fetchingUrl ? "var(--text)" : "var(--text3)", fontSize: 16, fontWeight: 600, cursor: jobUrl.trim() && !fetchingUrl ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}>  {/* 13→16 */}
                {fetchingUrl ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--surface3)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                    가져오는 중
                  </span>
                ) : "가져오기"}
              </button>
            </div>
            <button onClick={generateCriteria} disabled={!jobPosting.trim()}
              style={{ marginTop: 16, width: "100%", padding: "14px", borderRadius: 10, border: "none", background: jobPosting.trim() ? "linear-gradient(135deg, var(--accent), #7c3aed)" : "var(--surface2)", color: jobPosting.trim() ? "#fff" : "var(--text3)", fontSize: 18, fontWeight: 600, cursor: jobPosting.trim() ? "pointer" : "not-allowed" }}>  {/* 15→18 */}
              평가 기준 생성하기 →
            </button>
          </div>
        )}

        {/* ═══ STEP 1 ═══ */}
        {step === 1 && !loading && criteria && (
          <CriteriaEditor
            initial={confirmedCriteria || criteria}
            onConfirm={handleConfirmCriteria}
            onBack={() => { setStep(0); setCriteria(null); }}
          />
        )}

        {/* ═══ STEP 2 ═══ */}
        {step === 2 && !loading && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>이력서 / 포트폴리오 업로드</h2>  {/* 16→19 */}
              <RecBadge rec="PASS" />
            </div>
            <p style={{ fontSize: 16, color: "var(--text2)", marginBottom: 8, lineHeight: 1.5 }}>  {/* 13→16 */}
              <strong style={{ color: "var(--text)" }}>{confirmedCriteria?.job_title}</strong> — PDF 파일을 업로드하면 확정된 기준으로 빠르게 스크리닝합니다.
            </p>
            <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)", marginBottom: 16 }}>
              <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>확정된 평가 기준 ({confirmedCriteria?.criteria.length}개)</p>  {/* 11→13 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {confirmedCriteria?.criteria.map((c) => (
                  <span key={c.id} style={{ fontSize: 14, padding: "4px 10px", borderRadius: 6, background: "var(--surface2)", color: "var(--text2)", border: "1px solid var(--border)" }}>  {/* 12→14 */}
                    {c.name}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
              <div style={{ flex: 1, display: "flex", alignItems: "center", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
                <span style={{ padding: "0 0 0 12px", fontSize: 16, color: "var(--text3)", flexShrink: 0 }}>💾</span>  {/* 13→16 */}
                <input
                  value={saveName} onChange={(e) => setSaveName(e.target.value)}
                  placeholder="저장할 이름 (예: 백엔드 시니어 2차)"
                  style={{ flex: 1, padding: "10px 12px", border: "none", background: "transparent", color: "var(--text)", fontSize: 16, outline: "none", fontFamily: "inherit" }}  {/* 13→16 */}
                  onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) saveTemplate(saveName); }}
                />
              </div>
              <button
                onClick={() => saveTemplate(saveName)}
                disabled={!saveName.trim()}
                style={{
                  padding: "10px 16px", borderRadius: 8, border: "1px solid var(--border)",
                  background: saveSuccess ? "rgba(34,197,94,0.12)" : (saveName.trim() ? "var(--surface2)" : "var(--surface)"),
                  color: saveSuccess ? "var(--green)" : (saveName.trim() ? "var(--text)" : "var(--text3)"),
                  fontSize: 16, fontWeight: 600, cursor: saveName.trim() ? "pointer" : "not-allowed",  {/* 13→16 */}
                  whiteSpace: "nowrap", transition: "all 0.2s",
                }}
              >
                {saveSuccess ? "✓ 저장됨" : "저장"}
              </button>
            </div>

            <div onClick={() => fileRef.current?.click()}
              style={{ border: "2px dashed var(--border)", borderRadius: 12, padding: "40px 20px", textAlign: "center", cursor: "pointer", background: "var(--surface)" }}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--accent)"; }}
              onDragLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
              onDrop={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--border)"; setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files).filter((f) => f.type === "application/pdf")]); }}>
              <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFiles} style={{ display: "none" }} />
              <div style={{ fontSize: 38, marginBottom: 10, opacity: 0.5 }}>📄</div>  {/* 32→38 */}
              <p style={{ fontSize: 17, color: "var(--text2)", margin: 0 }}>클릭하거나 파일을 드래그하세요</p>  {/* 14→17 */}
              <p style={{ fontSize: 14, color: "var(--text3)", margin: "6px 0 0" }}>PDF · 30MB 이하 · 텍스트 추출 후 Haiku로 고속 분석</p>  {/* 12→14 */}
            </div>
            {files.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <p style={{ fontSize: 14, color: "var(--text3)", marginBottom: 8, fontWeight: 500 }}>{files.length}개 파일</p>  {/* 12→14 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
                      <span style={{ fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>📄 {f.name}</span>  {/* 13→16 */}
                      <span style={{ fontSize: 13, color: f.size > 30 * 1024 * 1024 ? "var(--red)" : "var(--text3)", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0, marginRight: 8 }}>  {/* 11→13 */}
                        {f.size > 1024 * 1024 ? (f.size / 1024 / 1024).toFixed(1) + "MB" : Math.round(f.size / 1024) + "KB"}
                      </span>
                      <button onClick={() => removeFile(i)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 19, padding: "0 4px" }}>×</button>  {/* 16→19 */}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              {topCandidates.length > 0 && (
                <div style={{ flex: "0 0 100%", marginBottom: -6 }}>
                  <div style={{ padding: "14px 16px", borderRadius: 10, background: "linear-gradient(135deg, rgba(99,102,241,0.05), rgba(168,85,247,0.05))", border: "1px solid rgba(99,102,241,0.15)", marginBottom: 10 }}>
                    <p style={{ fontSize: 13, color: "var(--accent2)", fontWeight: 600, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>  {/* 11→13 */}
                      🏆 현재 추천 순위 — 새 스크리닝 결과와 비교해 보세요
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      {topCandidates.map((pick) => (
                        <div key={pick.rank} style={{ flex: 1, padding: "10px 12px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                            <span style={{
                              fontSize: 12, fontWeight: 700, padding: "2px 6px", borderRadius: 4,  {/* 10→12 */}
                              background: pick.rank === 1 ? "rgba(34,197,94,0.12)" : "rgba(99,102,241,0.12)",
                              color: pick.rank === 1 ? "var(--green)" : "var(--accent2)",
                            }}>{pick.rank}순위</span>
                            <span style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pick.candidate_name}</span>  {/* 12→14 */}
                          </div>
                          <p style={{ fontSize: 13, color: "var(--text3)", margin: "0 0 2px" }}>{pick._jobTitle}</p>  {/* 11→13 */}
                          <p style={{ fontSize: 13, color: "var(--text2)", margin: 0 }}>💪 {pick.strength}</p>  {/* 11→13 */}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button onClick={() => setStep(1)} style={{ padding: "14px 24px", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 17, cursor: "pointer" }}>← 기준 수정</button>  {/* 14→17 */}
              <button onClick={screenResumes} disabled={!files.length}
                style={{ flex: 1, padding: "14px", borderRadius: 10, border: "none", background: files.length ? "linear-gradient(135deg, var(--accent), #7c3aed)" : "var(--surface2)", color: files.length ? "#fff" : "var(--text3)", fontSize: 18, fontWeight: 600, cursor: files.length ? "pointer" : "not-allowed" }}>  {/* 15→18 */}
                스크리닝 시작 →
              </button>
            </div>
          </div>
        )}

        {/* ═══ STEP 3 ═══ */}
        {step === 3 && !loading && results.length > 0 && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>스크리닝 결과</h2>  {/* 16→19 */}
                <p style={{ fontSize: 16, color: "var(--text2)", margin: "4px 0 0" }}>  {/* 13→16 */}
                  {results.length}명 · 통과 {results.filter((r) => r.recommendation === "PASS").length} · 검토 {results.filter((r) => r.recommendation === "MAYBE").length} · 탈락 {results.filter((r) => r.recommendation === "FAIL").length}
                </p>
              </div>
              <button onClick={resetAll} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text2)", fontSize: 14, cursor: "pointer" }}>새로 시작</button>  {/* 12→14 */}
            </div>

            {/* 추천 순위 패널 */}
            <div style={{ marginBottom: 20, padding: "16px 18px", borderRadius: 12, background: "linear-gradient(135deg, rgba(99,102,241,0.06), rgba(168,85,247,0.06))", border: "1px solid rgba(99,102,241,0.2)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <p style={{ fontSize: 14, color: "var(--accent2)", fontWeight: 600, margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>🏆 추천 순위</p>  {/* 12→14 */}
                {topCandidates.length === 2 && (
                  <button onClick={swapTopCandidates} style={{ fontSize: 13, color: "var(--text3)", background: "none", border: "1px solid var(--border)", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>  {/* 11→13 */}
                    ↕ 순위 교체
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                {[1, 2].map((rank) => {
                  const pick = topCandidates.find((t) => t.rank === rank);
                  return (
                    <div key={rank} style={{
                      flex: 1, padding: "12px 14px", borderRadius: 10,
                      background: pick ? "var(--surface)" : "var(--surface2)",
                      border: `1px solid ${pick ? (rank === 1 ? "rgba(34,197,94,0.3)" : "rgba(99,102,241,0.3)") : "var(--border)"}`,
                      position: "relative",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: pick ? 8 : 0 }}>
                        <span style={{
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          width: 22, height: 22, borderRadius: 6, fontSize: 13, fontWeight: 700,  {/* 11→13 */}
                          fontFamily: "'IBM Plex Mono', monospace",
                          background: rank === 1 ? "rgba(34,197,94,0.15)" : "rgba(99,102,241,0.15)",
                          color: rank === 1 ? "var(--green)" : "var(--accent2)",
                        }}>
                          {rank}
                        </span>
                        {pick ? (
                          <span style={{ fontSize: 16, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pick.candidate_name}</span>  {/* 13→16 */}
                        ) : (
                          <span style={{ fontSize: 14, color: "var(--text3)" }}>아래 결과에서 선택하세요</span>  {/* 12→14 */}
                        )}
                        {pick && (
                          <button onClick={() => removeTopCandidate(rank)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 17, padding: "0 2px", lineHeight: 1 }}>×</button>  {/* 14→17 */}
                        )}
                      </div>
                      {pick && (
                        <div>
                          <p style={{ fontSize: 13, color: "var(--text2)", margin: "0 0 4px", lineHeight: 1.4 }}>{pick.summary}</p>  {/* 11→13 */}
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <RecBadge rec={pick.recommendation} />
                            <span style={{ fontSize: 13, color: "var(--text3)", padding: "3px 8px", borderRadius: 12, background: "var(--surface2)" }}>  {/* 11→13 */}
                              {pick._jobTitle} · {pick._savedAt}
                            </span>
                          </div>
                          {pick.strength && pick.strength !== "-" && (
                            <p style={{ fontSize: 13, color: "var(--green)", margin: "6px 0 0" }}>💪 {pick.strength}</p>  {/* 11→13 */}
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {results.map((r, idx) => {
                const isOpen = expandedIdx === idx;
                const evs = r.evaluations || [];
                const metCount = evs.filter((ev) => ev.status === "충족").length;
                const isTop1 = topCandidates.some((t) => t.rank === 1 && t.candidate_name === r.candidate_name && t._fileName === r._fileName);
                const isTop2 = topCandidates.some((t) => t.rank === 2 && t.candidate_name === r.candidate_name && t._fileName === r._fileName);
                return (
                  <div key={idx} style={{ borderRadius: 12, border: `1px solid ${isTop1 ? "rgba(34,197,94,0.4)" : isTop2 ? "rgba(99,102,241,0.4)" : r._error ? "rgba(239,68,68,0.3)" : "var(--border)"}`, background: "var(--surface)", overflow: "hidden" }}>
                    {/* Summary row */}
                    <div onClick={() => setExpandedIdx(isOpen ? null : idx)} style={{ padding: "16px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--surface2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: "var(--accent2)", flexShrink: 0 }}>{idx + 1}</div>  {/* 14→17 */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                          <span style={{ fontSize: 17, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.candidate_name}</span>  {/* 14→17 */}
                          <RecBadge rec={r.recommendation} />
                          {isTop1 && <span style={{ fontSize: 12, color: "var(--green)", fontWeight: 700, background: "rgba(34,197,94,0.12)", padding: "2px 6px", borderRadius: 4 }}>1순위</span>}  {/* 10→12 */}
                          {isTop2 && <span style={{ fontSize: 12, color: "var(--accent2)", fontWeight: 700, background: "rgba(99,102,241,0.12)", padding: "2px 6px", borderRadius: 4 }}>2순위</span>}  {/* 10→12 */}
                        </div>
                        <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.summary}</p>  {/* 12→14 */}
                      </div>
                      <div style={{ textAlign: "center", flexShrink: 0, marginLeft: 8 }}>
                        <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: metCount === evs.length ? "var(--green)" : metCount >= evs.length / 2 ? "var(--amber)" : "var(--red)" }}>  {/* 18→22 */}
                          {metCount}/{evs.length}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text3)" }}>충족</div>  {/* 10→12 */}
                      </div>
                      <span style={{ color: "var(--text3)", transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0)", flexShrink: 0 }}>▾</span>
                    </div>

                    {/* Detail */}
                    {isOpen && (
                      <div style={{ padding: "0 18px 18px", borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                        {!r._error && (
                          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); setAsTopCandidate(r, 1); }}
                              style={{
                                flex: 1, padding: "10px", borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: "pointer",  {/* 13→16 */}
                                border: isTop1 ? "1px solid var(--green)" : "1px solid var(--border)",
                                background: isTop1 ? "rgba(34,197,94,0.1)" : "var(--surface2)",
                                color: isTop1 ? "var(--green)" : "var(--text2)",
                              }}
                            >
                              {isTop1 ? "✓ 1순위 지정됨" : "🥇 1순위로 지정"}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setAsTopCandidate(r, 2); }}
                              style={{
                                flex: 1, padding: "10px", borderRadius: 8, fontSize: 16, fontWeight: 600, cursor: "pointer",  {/* 13→16 */}
                                border: isTop2 ? "1px solid var(--accent2)" : "1px solid var(--border)",
                                background: isTop2 ? "rgba(99,102,241,0.1)" : "var(--surface2)",
                                color: isTop2 ? "var(--accent2)" : "var(--text2)",
                              }}
                            >
                              {isTop2 ? "✓ 2순위 지정됨" : "🥈 2순위로 지정"}
                            </button>
                          </div>
                        )}

                        <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 4, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>파일</p>  {/* 11→13 */}
                        <p style={{ fontSize: 16, color: "var(--text2)", marginBottom: 16 }}>{r._fileName}</p>  {/* 13→16 */}

                        <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>기준별 평가</p>  {/* 11→13 */}
                        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
                          {evs.map((ev) => {
                            const crit = confirmedCriteria?.criteria.find((c) => c.id === ev.criteria_id);
                            return (
                              <div key={ev.criteria_id} style={{ padding: "14px 16px", borderRadius: 10, background: "var(--surface2)", border: "1px solid var(--border)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                                  <span style={{ fontSize: 16, fontWeight: 600 }}>{crit?.name || `기준 ${ev.criteria_id}`}</span>  {/* 13→16 */}
                                  <StatusBadge status={ev.status} />
                                </div>
                                <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, lineHeight: 1.7, whiteSpace: "pre-line", paddingLeft: 2 }}>{ev.reason}</p>  {/* 12→14 */}
                              </div>
                            );
                          })}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.15)" }}>
                            <p style={{ fontSize: 13, color: "var(--green)", fontWeight: 600, margin: "0 0 4px" }}>강점</p>  {/* 11→13 */}
                            <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, lineHeight: 1.4 }}>{r.strength}</p>  {/* 12→14 */}
                          </div>
                          <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)" }}>
                            <p style={{ fontSize: 13, color: "var(--red)", fontWeight: 600, margin: "0 0 4px" }}>약점 {r._error && "/ 에러 상세"}</p>  {/* 11→13 */}
                            <p style={{ fontSize: 14, color: "var(--text2)", margin: 0, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.weakness}</p>  {/* 12→14 */}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
