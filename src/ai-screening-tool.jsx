import { useState, useRef, useCallback, useEffect } from "react";

// ─── 설정 ──────────────────────────────────────────────────
const API_URL = "/api/screen";
const MODEL_SMART = "claude-sonnet-4-6";
const MODEL_FAST = "claude-haiku-4-5-20251001";
const LS_TEMPLATES = "screening-templates";
const LS_CANDIDATES = "top-candidates";
const MAX_TEMPLATES = 20;

// ─── 시스템 프롬프트 ────────────────────────────────────────

const SYS_CRITERIA = `당신은 세계 최고의 HR 전문가이자 직무 분석가입니다. 
채용 공고(JD)를 분석하여 서류 스크리닝에 사용할 핵심 평가 기준 3~5가지를 생성하십시오.
반드시 아래 JSON 형식으로만 응답하십시오.
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
  "total_experience": "전체 경력 N년 (추정 불가 시 '확인 불가')",
  "relevant_experience": "JD 관련 실 경력 M년 (추정 불가 시 '확인 불가')",
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
3. recommendation: 평가를 종합하여 "PASS", "MAYBE", "FAIL" 중 하나를 기재하십시오.
4. total_experience: 이력서에서 첫 직장 시작일~현재까지의 기간을 추정하여 "전체 경력 N년" 형태로 기재하십시오.
5. relevant_experience: 이력서에서 제공된 직무(JD)와 직접 관련 있는 경력만 합산하여 "JD 관련 실 경력 M년" 형태로 기재하십시오.`;

const SYS_URL_FETCH = `당신은 채용 공고 추출 전문가입니다. 웹 검색 결과에서 채용 공고의 핵심 내용을 추출하여 정리합니다.
반드시 채용 공고 원문의 내용을 최대한 충실하게 한국어로 정리하세요.
포지션명, 주요 업무, 자격 요건, 우대 사항, 근무 조건 등을 포함해 정리하세요.
마크다운이나 JSON이 아닌 일반 텍스트로 작성하세요.`;

// ─── localStorage 헬퍼 ─────────────────────────────────────

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.error("[localStorage]", e.message); }
}

// ─── 유틸리티 함수 ─────────────────────────────────────────

function extractJSON(text) {
  const stripped = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const s = text.indexOf("{"); const e = text.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return null;
}

function timeoutPromise(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`타임아웃 (${Math.round(ms / 1000)}초 초과)`)), ms));
}

function classifyError(e) {
  const msg = e?.message || String(e);
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("네트워크")) return `[네트워크 에러] Worker 연결 실패.\n${msg}`;
  if (msg.includes("CORS") || msg.includes("cors")) return `[CORS 에러] 요청 차단.\n${msg}`;
  if (msg.includes("타임아웃") || msg.includes("timeout")) return `[타임아웃] 응답 시간 초과.\n${msg}`;
  if (msg.includes("페이로드") || msg.includes("413")) return `[페이로드 초과]\n${msg}`;
  if (msg.includes("텍스트 추출 실패") || msg.includes("pdf.js")) return `[PDF 에러]\n${msg}`;
  if (msg.includes("파싱 실패") || msg.includes("candidate_name")) return `[파싱 에러]\n${msg}`;
  if (msg.includes("API 4")) return `[API 클라이언트 에러]\n${msg}`;
  if (msg.includes("API 5")) return `[API 서버 에러]\n${msg}`;
  return `[에러] ${msg}`;
}

// ─── API 호출 ───────────────────────────────────────────────

async function callAPI(payload) {
  console.log(`[callAPI] 모델:${payload.model}`);
  let res;
  try { res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); }
  catch (e) { throw new Error(`[네트워크] Worker 연결 실패: ${e.message}`); }
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    console.error(`[callAPI] 에러 ${res.status}:`, b.slice(0, 500));
    try { const p = JSON.parse(b); throw new Error(`API ${res.status} [${p.stage||""}]: ${p.error||b.slice(0,400)}`); }
    catch (pe) { if (pe.message.startsWith("API ")) throw pe; throw new Error(`API ${res.status}: ${b.slice(0,400)}`); }
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  if (!text.trim()) throw new Error(`빈 응답 (stop_reason: ${data.stop_reason || "unknown"})`);
  return text;
}

async function callClaude(messages, system = "", model = MODEL_SMART) {
  const p = { model, max_tokens: 4000, messages }; if (system) p.system = system;
  return Promise.race([callAPI(p), timeoutPromise(180000)]);
}
async function callClaudeWithTools(messages, tools, system = "", model = MODEL_SMART) {
  const p = { model, max_tokens: 4000, messages, tools }; if (system) p.system = system;
  return Promise.race([callAPI(p), timeoutPromise(180000)]);
}

// ─── PDF 처리 ───────────────────────────────────────────────

async function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("파일 읽기 실패")); r.readAsDataURL(file); });
}
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs";
const PDFJS_WORKER_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
let pdfjsLib = null;
async function loadPdfJs() {
  if (pdfjsLib) return pdfjsLib;
  try { pdfjsLib = await import(/* @vite-ignore */ PDFJS_CDN); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN; return pdfjsLib; }
  catch { return new Promise((res, rej) => {
    if (window.pdfjsLib) { pdfjsLib = window.pdfjsLib; pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN; return res(pdfjsLib); }
    const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.js";
    s.onload = () => { if (window.pdfjsLib) { pdfjsLib = window.pdfjsLib; pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN; res(pdfjsLib); } else rej(new Error("pdf.js 로딩 실패")); };
    s.onerror = () => rej(new Error("pdf.js CDN 실패")); document.head.appendChild(s);
  }); }
}
async function extractTextFromPDF(file) {
  const lib = await loadPdfJs(); const buf = await file.arrayBuffer(); const pdf = await lib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) { const pg = await pdf.getPage(i); const ct = await pg.getTextContent(); const t = ct.items.map(x => x.str).join(" "); if (t.trim()) pages.push(t.trim()); }
  const full = pages.join("\n\n"); return full.length < 50 ? null : full;
}
async function parallelMap(items, fn, concurrency = 3) {
  const results = new Array(items.length); let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker())); return results;
}

// ─── 클립보드 복사 ──────────────────────────────────────────

function buildCopyText(r) {
  const lines = [`- 후보자명 : ${r.candidate_name}`];
  lines.push(`- 경력 : ${r.total_experience || "확인 불가"}(${r.relevant_experience || "확인 불가"})`);
  lines.push(`- 스크리닝 결과 :`);
  (r.evaluations || []).forEach((ev, i) => { lines.push(`${i + 1}. [${ev.status}] ${ev.reason?.replace(/\n/g, " ")}`); });
  return lines.join("\n");
}

async function copyResults(results) {
  const text = results.map(buildCopyText).join("\n\n---\n\n");
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;left:-9999px"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); return true; }
}

// ─── 스타일 상수 ────────────────────────────────────────────

const F = "'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif";
const STEPS = ["공고 입력", "평가 기준", "이력서 업로드", "스크리닝 결과"];
const CSS_VARS = { "--bg":"#0a0a0f","--surface":"#12121a","--surface2":"#1e1e2a","--surface3":"#2a2a3a","--border":"#2a2a3d","--text":"#e8e8f0","--text2":"#8888a0","--text3":"#55556a","--accent":"#6366f1","--accent2":"#818cf8","--green":"#22c55e","--amber":"#f59e0b","--red":"#ef4444" };
const inputBase = { width:"100%",padding:"13px 15px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--text)",fontSize:16,outline:"none",fontFamily:F,boxSizing:"border-box" };

// ─── 작은 UI 컴포넌트 ──────────────────────────────────────

const StatusBadge = ({ status }) => {
  const map = { "충족":{bg:"rgba(34,197,94,0.12)",color:"#22c55e",border:"rgba(34,197,94,0.25)",icon:"✓"}, "미충족":{bg:"rgba(239,68,68,0.10)",color:"#ef4444",border:"rgba(239,68,68,0.2)",icon:"✗"}, "판단 불가":{bg:"rgba(245,158,11,0.10)",color:"#f59e0b",border:"rgba(245,158,11,0.2)",icon:"?"} };
  const c = map[status] || map["판단 불가"];
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 12px",borderRadius:20,fontSize:13,fontWeight:600,background:c.bg,color:c.color,border:`1px solid ${c.border}`,fontFamily:F}}><span style={{fontSize:13}}>{c.icon}</span>{status}</span>;
};

const RecBadge = ({ rec, size = "md" }) => {
  const colors = { PASS:{bg:"rgba(34,197,94,0.12)",color:"#22c55e",border:"rgba(34,197,94,0.25)"},FAIL:{bg:"rgba(239,68,68,0.10)",color:"#ef4444",border:"rgba(239,68,68,0.2)"},MAYBE:{bg:"rgba(245,158,11,0.10)",color:"#f59e0b",border:"rgba(245,158,11,0.2)"} };
  const label = { PASS:"통과 추천",FAIL:"탈락",MAYBE:"검토 필요" }; const c = colors[rec] || colors.MAYBE;
  return <span style={{display:"inline-block",padding:size==="lg"?"6px 16px":"4px 12px",borderRadius:20,fontSize:size==="lg"?15:13,fontWeight:600,background:c.bg,color:c.color,border:`1px solid ${c.border}`,fontFamily:F}}>{label[rec]||rec}</span>;
};

// ─── 사이드바 ───────────────────────────────────────────────

function Sidebar({ templates, onSelect, onDelete, open, onToggle }) {
  return (<>
    <button onClick={onToggle} style={{ position:"fixed",left:open?279:0,top:80,zIndex:1001,width:28,height:56,borderRadius:"0 8px 8px 0",border:"1px solid var(--border)",borderLeft:"none",background:"var(--surface2)",color:"var(--text2)",cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center",transition:"left 0.25s ease" }}>{open?"◂":"▸"}</button>
    <div style={{ position:"fixed",left:open?0:-280,top:0,bottom:0,width:280,zIndex:1000,background:"var(--surface)",borderRight:"1px solid var(--border)",display:"flex",flexDirection:"column",transition:"left 0.25s ease",fontFamily:F }}>
      <div style={{padding:"24px 20px 16px",borderBottom:"1px solid var(--border)"}}>
        <p style={{fontSize:14,fontWeight:600,color:"var(--accent2)",margin:0,textTransform:"uppercase",letterSpacing:"0.06em"}}>저장된 공고 · {templates.length}</p>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"12px"}}>
        {templates.length===0 && <p style={{fontSize:14,color:"var(--text3)",textAlign:"center",marginTop:40,lineHeight:1.6}}>아직 저장된 공고가 없습니다.<br/>평가 기준 확정 시 자동 저장됩니다.</p>}
        {templates.map(tpl => (
          <div key={tpl.id} onClick={() => onSelect(tpl)} style={{padding:"14px",marginBottom:8,borderRadius:10,background:"var(--surface2)",border:"1px solid var(--border)",cursor:"pointer",transition:"border-color 0.15s"}}
            onMouseEnter={e => e.currentTarget.style.borderColor="var(--accent)"} onMouseLeave={e => e.currentTarget.style.borderColor="var(--border)"}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <p style={{fontSize:15,fontWeight:600,margin:0,color:"var(--text)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tpl.name}</p>
                <p style={{fontSize:13,color:"var(--text3)",margin:"4px 0 0"}}>{tpl.job_title} · {tpl.criteria?.length}개 기준</p>
                <p style={{fontSize:12,color:"var(--text3)",margin:"2px 0 0"}}>{tpl.savedAt}</p>
              </div>
              <button onClick={e => {e.stopPropagation();onDelete(tpl.id);}} style={{background:"none",border:"none",color:"var(--text3)",cursor:"pointer",fontSize:16,padding:"2px 4px",lineHeight:1,flexShrink:0}}>×</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  </>);
}

// ─── 모달 ───────────────────────────────────────────────────

function TemplateModal({ template, onClose, onScreenNow, onEdit }) {
  if (!template) return null;
  return (
    <div style={{position:"fixed",inset:0,zIndex:2000,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{width:"100%",maxWidth:640,maxHeight:"85vh",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,overflow:"hidden",display:"flex",flexDirection:"column",fontFamily:F}}>
        <div style={{padding:"20px 24px",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><h3 style={{margin:0,fontSize:18,fontWeight:700,color:"var(--text)"}}>{template.name}</h3><p style={{margin:"4px 0 0",fontSize:14,color:"var(--text3)"}}>{template.job_title} · {template.savedAt}</p></div>
          <button onClick={onClose} style={{width:32,height:32,borderRadius:8,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text2)",cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
          {template.jobPosting && (<div style={{marginBottom:20}}>
            <p style={{fontSize:13,fontWeight:600,color:"var(--accent2)",textTransform:"uppercase",letterSpacing:"0.05em",margin:"0 0 8px"}}>채용 공고 원문</p>
            <div style={{padding:16,borderRadius:10,background:"var(--surface2)",border:"1px solid var(--border)",fontSize:14,color:"var(--text2)",lineHeight:1.7,whiteSpace:"pre-wrap",maxHeight:200,overflowY:"auto"}}>{template.jobPosting}</div>
          </div>)}
          <p style={{fontSize:13,fontWeight:600,color:"var(--accent2)",textTransform:"uppercase",letterSpacing:"0.05em",margin:"0 0 10px"}}>평가 기준 ({template.criteria?.length}개)</p>
          {template.criteria?.map((cr,i) => (<div key={cr.id||i} style={{padding:"14px 16px",borderRadius:10,background:"var(--surface2)",border:"1px solid var(--border)",marginBottom:8}}>
            <p style={{fontSize:15,fontWeight:600,margin:0,color:"var(--text)"}}>{cr.name}</p>
            {cr.description && <p style={{fontSize:14,color:"var(--text2)",margin:"5px 0 0",lineHeight:1.5}}>{cr.description}</p>}
          </div>))}
        </div>
        <div style={{padding:"16px 24px",borderTop:"1px solid var(--border)",display:"flex",gap:10}}>
          <button onClick={() => {onEdit(template);onClose();}} style={{flex:1,padding:"14px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:F}}>평가 기준 수정</button>
          <button onClick={() => {onScreenNow(template);onClose();}} style={{flex:2,padding:"14px",borderRadius:10,border:"none",background:"linear-gradient(135deg, var(--accent), #7c3aed)",color:"#fff",fontSize:15,fontWeight:600,cursor:"pointer",fontFamily:F}}>이 기준으로 바로 스크리닝</button>
        </div>
      </div>
    </div>
  );
}

// ─── 평가 기준 편집기 ───────────────────────────────────────

function CriteriaEditor({ initial, onConfirm, onBack }) {
  const [jobTitle, setJobTitle] = useState(initial.job_title || "");
  const [items, setItems] = useState(() => (initial.criteria || []).map((c, i) => ({ id: c.id || i + 1, name: c.name || "", description: c.description || "" })));
  const [formError, setFormError] = useState("");
  const update = (idx, field, value) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  const addItem = () => { const mx = items.reduce((m, it) => Math.max(m, it.id), 0); setItems(prev => [...prev, { id: mx + 1, name: "", description: "" }]); };
  const removeItem = idx => { if (items.length <= 1) return; setItems(prev => prev.filter((_, i) => i !== idx)); };
  const handleConfirm = () => {
    if (!jobTitle.trim()) { setFormError("직무명을 입력하세요."); return; }
    if (items.some(it => !it.name.trim())) { setFormError("모든 기준의 이름을 입력하세요."); return; }
    setFormError(""); onConfirm({ job_title: jobTitle, criteria: items });
  };
  return (
    <div>
      <h2 style={{fontSize:20,fontWeight:600,marginBottom:15,fontFamily:F}}>평가 기준 편집</h2>
      {formError && <div style={{padding:"12px 18px",borderRadius:10,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",marginBottom:15,color:"#f87171",fontSize:15,fontFamily:F}}>{formError}</div>}
      <div style={{marginBottom:20}}><label style={{fontSize:14,color:"var(--text2)",fontWeight:500,marginBottom:6,display:"block",fontFamily:F}}>직무명</label><input value={jobTitle} onChange={e => setJobTitle(e.target.value)} placeholder="예: 백엔드 개발자" style={inputBase}/></div>
      {items.map((it, idx) => (<div key={it.id} style={{padding:20,borderRadius:13,background:"var(--surface)",border:"1px solid var(--border)",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><span style={{fontSize:14,color:"var(--accent2)",fontWeight:600,fontFamily:F}}>기준 {idx+1}</span>{items.length>1 && <button onClick={() => removeItem(idx)} style={{background:"none",border:"none",color:"var(--text3)",cursor:"pointer",fontSize:18}}>×</button>}</div>
        <input value={it.name} onChange={e => update(idx,"name",e.target.value)} placeholder="기준명" style={{...inputBase,marginBottom:8}}/><input value={it.description} onChange={e => update(idx,"description",e.target.value)} placeholder="상세 설명" style={inputBase}/>
      </div>))}
      <button onClick={addItem} style={{width:"100%",padding:"13px",borderRadius:10,border:"1px dashed var(--border)",background:"transparent",color:"var(--text3)",fontSize:16,cursor:"pointer",marginBottom:20,fontFamily:F}}>+ 기준 추가</button>
      <div style={{display:"flex",gap:13}}>
        <button onClick={onBack} style={{padding:"18px 30px",borderRadius:13,border:"1px solid var(--border)",background:"transparent",color:"var(--text2)",fontSize:18,cursor:"pointer",fontFamily:F}}>← 뒤로</button>
        <button onClick={handleConfirm} style={{flex:1,padding:"18px",borderRadius:13,border:"none",background:"linear-gradient(135deg, var(--accent), #7c3aed)",color:"#fff",fontSize:19,fontWeight:600,cursor:"pointer",fontFamily:F}}>평가 기준 확정 →</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// 메인 컴포넌트
// ═══════════════════════════════════════════════════════════

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
  const [topCandidates, setTopCandidates] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modalTemplate, setModalTemplate] = useState(null);
  const [copyDone, setCopyDone] = useState(false);
  const timerRef = useRef(null);
  const fileRef = useRef();

  // ── localStorage 초기 복원 (API 호출 없음, 토큰 미소진) ──
  useEffect(() => { setSavedTemplates(lsGet(LS_TEMPLATES, [])); setTopCandidates(lsGet(LS_CANDIDATES, [])); }, []);

  // ── 템플릿 자동 저장: "평가 기준 확정" 시 localStorage에 저장 ──
  const autoSaveTemplate = useCallback((confirmedData, jd) => {
    const name = confirmedData.job_title || "무제 공고";
    const tpl = { id: Date.now().toString(36), name, job_title: confirmedData.job_title, jobPosting: jd, criteria: confirmedData.criteria, savedAt: new Date().toLocaleDateString("ko-KR") };
    const next = [tpl, ...lsGet(LS_TEMPLATES, []).filter(t => t.name !== name)].slice(0, MAX_TEMPLATES);
    lsSet(LS_TEMPLATES, next); setSavedTemplates(next);
    console.log(`[localStorage] 템플릿 자동 저장: "${name}" (${confirmedData.criteria.length}개 기준)`);
  }, []);

  const deleteTemplate = useCallback(id => { const next = savedTemplates.filter(t => t.id !== id); lsSet(LS_TEMPLATES, next); setSavedTemplates(next); }, [savedTemplates]);

  // ── 모달 액션: 저장된 공고 불러오기 (API 호출 없음, 토큰 미소진) ──
  const jumpToScreen = useCallback(tpl => {
    setJobPosting(tpl.jobPosting || ""); const r = { job_title: tpl.job_title, criteria: tpl.criteria };
    setCriteria(r); setConfirmedCriteria(r); setFiles([]); setResults([]); setStep(2); setError(""); setSidebarOpen(false);
  }, []);
  const jumpToEdit = useCallback(tpl => {
    setJobPosting(tpl.jobPosting || ""); const r = { job_title: tpl.job_title, criteria: tpl.criteria };
    setCriteria(r); setConfirmedCriteria(null); setStep(1); setError(""); setSidebarOpen(false);
  }, []);

  // ── 추천 순위 ──
  const saveTopCandidates = useCallback(next => { setTopCandidates(next); lsSet(LS_CANDIDATES, next); }, []);
  const setAsTopCandidate = useCallback((candidate, rank) => {
    const entry = { ...candidate, rank, _id: Date.now().toString(36), _savedAt: new Date().toLocaleDateString("ko-KR"), _jobTitle: confirmedCriteria?.job_title || "" };
    saveTopCandidates([...topCandidates.filter(t => t.rank !== rank), entry].sort((a, b) => a.rank - b.rank));
  }, [topCandidates, confirmedCriteria, saveTopCandidates]);
  const removeTopCandidate = useCallback(rank => saveTopCandidates(topCandidates.filter(t => t.rank !== rank)), [topCandidates, saveTopCandidates]);
  const swapTopCandidates = useCallback(() => { if (topCandidates.length < 2) return; saveTopCandidates(topCandidates.map(t => ({...t, rank: t.rank===1?2:t.rank===2?1:t.rank})).sort((a,b)=>a.rank-b.rank)); }, [topCandidates, saveTopCandidates]);

  // ── 타이머 ──
  const startTimer = useCallback(() => { setElapsed(0); if (timerRef.current) clearInterval(timerRef.current); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000); }, []);
  const stopTimer = useCallback(() => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } }, []);
  useEffect(() => () => stopTimer(), [stopTimer]);

  // ── URL 가져오기 (API 호출 O — 토큰 소진) ──
  const fetchJobPosting = useCallback(async () => {
    if (!jobUrl.trim()) return; setFetchingUrl(true); setError("");
    try { const r = await callClaudeWithTools([{role:"user",content:`다음 URL의 채용 공고 내용을 검색해서 추출해 주세요: ${jobUrl}`}],[{type:"web_search_20250305",name:"web_search"}],SYS_URL_FETCH,MODEL_FAST); if (r?.trim()) { setJobPosting(r.trim()); setJobUrl(""); } else setError("공고 내용을 가져오지 못했습니다."); }
    catch (e) { setError(classifyError(e)); } finally { setFetchingUrl(false); }
  }, [jobUrl]);

  // ── 평가 기준 생성 (API 호출 O — 토큰 소진) ──
  const generateCriteria = useCallback(async () => {
    if (!jobPosting.trim()) return; setLoading(true); setError(""); setLoadingMsg("채용 공고를 분석하고 있습니다..."); startTimer();
    try { const raw = await callClaude([{role:"user",content:`다음 채용 공고를 분석하세요:\n\n${jobPosting}`}],SYS_CRITERIA,MODEL_SMART); const p = extractJSON(raw); if (!p?.criteria) throw new Error("평가 기준 추출 실패"); setCriteria(p); setStep(1); }
    catch (e) { setError("기준 생성 실패: " + classifyError(e)); } finally { stopTimer(); setLoading(false); }
  }, [jobPosting, startTimer, stopTimer]);

  // ── 🔧 평가 기준 확정 → 자동 저장 + 다음 단계 ──
  const handleConfirmCriteria = useCallback(f => {
    setConfirmedCriteria(f);
    autoSaveTemplate(f, jobPosting); // ← 확정 시 자동 저장
    setStep(2);
  }, [jobPosting, autoSaveTemplate]);

  const handleFiles = e => setFiles(prev => [...prev, ...Array.from(e.target.files).filter(f => f.type === "application/pdf")]);
  const removeFile = idx => setFiles(prev => prev.filter((_, i) => i !== idx));

  // ── 스크리닝 (API 호출 O — 토큰 소진) ──
  const screenResumes = useCallback(async () => {
    const c = confirmedCriteria; if (!files.length || !c) return;
    setLoading(true); setError(""); setStep(3); startTimer();
    const MAX_SIZE = 30*1024*1024, CONCURRENCY = 3;
    const criteriaCompact = c.criteria.map(cr => `[ID:${cr.id}] ${cr.name}: ${cr.description}`).join("\n");
    let done = 0;
    const processOne = async file => {
      try {
        if (file.size > MAX_SIZE) throw new Error(`파일 크기 초과 (${(file.size/1024/1024).toFixed(1)}MB)`);
        let content, text = null;
        try { text = await extractTextFromPDF(file); } catch (pe) { throw new Error(`PDF 추출 실패: ${pe.message}`); }
        if (text) { content = [{type:"text",text:`[이력서 텍스트 시작]\n${text.slice(0,12000)}\n[이력서 텍스트 끝]\n\n직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.`}]; }
        else { if (file.size > 5*1024*1024) throw new Error(`이미지 PDF(${(file.size/1024/1024).toFixed(1)}MB)는 5MB 이하만 지원`); const b64 = await fileToBase64(file); content = [{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:`이미지 기반 PDF를 읽어 분석하세요.\n\n직무: ${c.job_title}\n\n평가 기준:\n${criteriaCompact}\n\n위 기준에 따라 이 이력서를 심사하세요.`}]; }
        const res = await Promise.race([callAPI({model:MODEL_FAST,max_tokens:2000,system:SYS_SCREENING,messages:[{role:"user",content}]}),timeoutPromise(120000)]);
        const parsed = extractJSON(res); if (!parsed?.candidate_name) throw new Error("AI 응답 파싱 실패");
        parsed._fileName = file.name; done++; setLoadingMsg(`이력서 분석 중 (${done}/${files.length} 완료)`); return parsed;
      } catch (e) { console.error(`[${file.name}]`, e.message); done++; setLoadingMsg(`이력서 분석 중 (${done}/${files.length} 완료)`);
        return { candidate_name:file.name.replace(/\.pdf$/i,""),_fileName:file.name,summary:"분석 실패",total_experience:"확인 불가",relevant_experience:"확인 불가",evaluations:c.criteria.map(cr=>({criteria_id:cr.id,status:"판단 불가",reason:"분석 오류"})),recommendation:"FAIL",strength:"-",weakness:classifyError(e),_error:true }; }
    };
    try { setLoadingMsg(`이력서 분석 중 (0/${files.length} 완료)`); const all = await parallelMap(files,processOne,CONCURRENCY); const ord={PASS:0,MAYBE:1,FAIL:2}; all.sort((a,b)=>(ord[a.recommendation]??3)-(ord[b.recommendation]??3)); setResults(all); }
    catch (e) { setError("스크리닝 오류: " + classifyError(e)); } finally { stopTimer(); setLoading(false); }
  }, [files, confirmedCriteria, startTimer, stopTimer]);

  const resetAll = () => { setStep(0); setCriteria(null); setConfirmedCriteria(null); setFiles([]); setResults([]); setError(""); setJobPosting(""); setJobUrl(""); };
  const handleCopy = async () => { await copyResults(results); setCopyDone(true); setTimeout(() => setCopyDone(false), 2000); };

  // ═══════════════════════════════════════════════════════════
  // 렌더링
  // ═══════════════════════════════════════════════════════════
  return (
    <div style={{...CSS_VARS,fontFamily:F,background:"var(--bg)",color:"var(--text)",minHeight:"100vh"}}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} .fade-in{animation:fadeIn .3s ease}`}</style>

      <Sidebar templates={savedTemplates} open={sidebarOpen} onToggle={() => setSidebarOpen(p=>!p)} onSelect={tpl => setModalTemplate(tpl)} onDelete={deleteTemplate} />
      <TemplateModal template={modalTemplate} onClose={() => setModalTemplate(null)} onScreenNow={jumpToScreen} onEdit={jumpToEdit} />

      <div style={{marginLeft:sidebarOpen?280:0,transition:"margin-left 0.25s ease",minHeight:"100vh"}}>
        {/* 헤더 */}
        <div style={{padding:"30px 40px 20px",borderBottom:"1px solid var(--border)",background:"linear-gradient(180deg,#0f0f18 0%,var(--bg) 100%)"}}>
          <div style={{display:"flex",alignItems:"center",gap:15,marginBottom:20}}>
            <div style={{width:42,height:42,borderRadius:12,background:"linear-gradient(135deg,var(--accent),#a78bfa)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:21}}>⚡</div>
            <div><h1 style={{margin:0,fontSize:23,fontWeight:700,fontFamily:F}}>AI 서류 스크리닝</h1><p style={{margin:0,fontSize:14,color:"var(--text2)",marginTop:2}}>채용 공고 기반 · 충족/미충족 자동 판정</p></div>
          </div>
          <div style={{display:"flex",gap:4}}>
            {STEPS.map((s, i) => { const active=i<=step,current=i===step; return (<div key={i} style={{flex:1}}>
              <div style={{height:3,borderRadius:2,background:active?(current?"var(--accent)":"var(--accent2)"):"var(--surface2)",opacity:active?1:0.4,transition:"all 0.3s"}}/>
              <p style={{fontSize:13,color:active?"var(--text2)":"var(--text3)",margin:"6px 0 0",fontWeight:current?600:400,fontFamily:F}}>{s}</p>
            </div>); })}
          </div>
        </div>

        <div style={{padding:"25px 40px",maxWidth:1100,margin:"0 auto"}}>
          {loading && (<div style={{textAlign:"center",padding:"70px 20px"}}>
            <div style={{width:56,height:56,border:"3px solid var(--surface2)",borderTopColor:"var(--accent)",borderRadius:"50%",animation:"spin 0.8s linear infinite",margin:"0 auto 22px"}}/>
            <p style={{fontSize:18,color:"var(--text)",fontWeight:500,fontFamily:F}}>{loadingMsg}</p>
            <p style={{fontSize:15,color:"var(--text3)",marginTop:6}}>{elapsed}초</p>
            <button onClick={() => {stopTimer();setLoading(false);setStep(p=>p===3?2:p);setError("취소됨");}} style={{marginTop:20,padding:"10px 24px",borderRadius:10,border:"1px solid var(--border)",background:"transparent",color:"var(--text2)",fontSize:15,cursor:"pointer",fontFamily:F}}>취소</button>
          </div>)}

          {error && (<div className="fade-in" style={{padding:"16px 20px",borderRadius:12,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",marginBottom:18,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12}}>
            <pre style={{fontSize:14,color:"#f87171",margin:0,lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-word",fontFamily:F,flex:1}}>{error}</pre>
            <button onClick={() => setError("")} style={{background:"none",border:"none",color:"#f87171",cursor:"pointer",fontSize:18,padding:0,flexShrink:0}}>×</button>
          </div>)}

          {/* STEP 0 */}
          {step===0 && !loading && (<div className="fade-in">
            <h2 style={{fontSize:20,fontWeight:600,marginBottom:10,fontFamily:F}}>채용 공고 입력</h2>
            {savedTemplates.length>0 && <button onClick={() => setSidebarOpen(true)} style={{marginBottom:16,padding:"10px 18px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--accent2)",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:F}}>📋 저장된 공고 {savedTemplates.length}개 보기</button>}
            <textarea value={jobPosting} onChange={e => setJobPosting(e.target.value)} placeholder="채용 공고 내용을 붙여넣으세요..." style={{...inputBase,minHeight:200,resize:"vertical",lineHeight:1.6}}/>
            <div style={{display:"flex",alignItems:"center",gap:12,margin:"18px 0"}}><div style={{flex:1,height:1,background:"var(--border)"}}/><span style={{fontSize:14,color:"var(--text3)",fontFamily:F}}>또는 URL</span><div style={{flex:1,height:1,background:"var(--border)"}}/></div>
            <div style={{display:"flex",gap:10}}>
              <div style={{flex:1,display:"flex",alignItems:"center",borderRadius:12,border:"1px solid var(--border)",background:"var(--surface)",overflow:"hidden"}}>
                <span style={{padding:"0 0 0 16px",fontSize:16,color:"var(--text3)"}}>🔗</span>
                <input type="url" value={jobUrl} onChange={e => setJobUrl(e.target.value)} placeholder="채용 공고 URL" disabled={fetchingUrl} style={{flex:1,padding:"14px 16px",border:"none",background:"transparent",color:"var(--text)",fontSize:16,outline:"none",fontFamily:F}} onKeyDown={e => {if(e.key==="Enter"&&jobUrl.trim()) fetchJobPosting();}}/>
              </div>
              <button onClick={fetchJobPosting} disabled={!jobUrl.trim()||fetchingUrl} style={{padding:"0 22px",borderRadius:12,border:"1px solid var(--border)",background:jobUrl.trim()&&!fetchingUrl?"var(--surface2)":"var(--surface)",color:jobUrl.trim()&&!fetchingUrl?"var(--text)":"var(--text3)",fontSize:15,fontWeight:600,cursor:jobUrl.trim()&&!fetchingUrl?"pointer":"not-allowed",fontFamily:F}}>{fetchingUrl?"...":"가져오기"}</button>
            </div>
            <button onClick={generateCriteria} disabled={!jobPosting.trim()} style={{marginTop:18,width:"100%",padding:"16px",borderRadius:12,border:"none",background:jobPosting.trim()?"linear-gradient(135deg, var(--accent), #7c3aed)":"var(--surface2)",color:jobPosting.trim()?"#fff":"var(--text3)",fontSize:18,fontWeight:600,cursor:jobPosting.trim()?"pointer":"not-allowed",fontFamily:F}}>평가 기준 생성하기 →</button>
          </div>)}

          {/* STEP 1 */}
          {step===1 && !loading && criteria && <div className="fade-in"><CriteriaEditor initial={confirmedCriteria||criteria} onConfirm={handleConfirmCriteria} onBack={() => {setStep(0);setCriteria(null);}}/></div>}

          {/* STEP 2 */}
          {step===2 && !loading && (<div className="fade-in">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><h2 style={{fontSize:20,fontWeight:600,margin:0,fontFamily:F}}>이력서 업로드</h2><RecBadge rec="PASS"/></div>
            <p style={{fontSize:15,color:"var(--text2)",marginBottom:10,lineHeight:1.5,fontFamily:F}}><strong style={{color:"var(--text)"}}>{confirmedCriteria?.job_title}</strong> — PDF를 업로드하면 확정 기준으로 스크리닝합니다.</p>
            <div style={{padding:"14px 18px",borderRadius:12,background:"var(--surface)",border:"1px solid var(--border)",marginBottom:18}}>
              <p style={{fontSize:13,color:"var(--text3)",fontWeight:500,textTransform:"uppercase",letterSpacing:"0.05em",margin:"0 0 8px",fontFamily:F}}>확정된 평가 기준 ({confirmedCriteria?.criteria.length}개) — 자동 저장됨 ✓</p>
              <div style={{display:"flex",flexWrap:"wrap",gap:7}}>{confirmedCriteria?.criteria.map(c => <span key={c.id} style={{fontSize:14,padding:"4px 12px",borderRadius:7,background:"var(--surface2)",color:"var(--text2)",border:"1px solid var(--border)",fontFamily:F}}>{c.name}</span>)}</div>
            </div>
            <div onClick={() => fileRef.current?.click()} style={{border:"2px dashed var(--border)",borderRadius:14,padding:"45px 20px",textAlign:"center",cursor:"pointer",background:"var(--surface)"}}
              onDragOver={e => {e.preventDefault();e.currentTarget.style.borderColor="var(--accent)";}} onDragLeave={e => {e.currentTarget.style.borderColor="var(--border)";}}
              onDrop={e => {e.preventDefault();e.currentTarget.style.borderColor="var(--border)";setFiles(prev => [...prev,...Array.from(e.dataTransfer.files).filter(f=>f.type==="application/pdf")]);}}>
              <input ref={fileRef} type="file" accept=".pdf" multiple onChange={handleFiles} style={{display:"none"}}/>
              <div style={{fontSize:36,marginBottom:10,opacity:0.5}}>📄</div>
              <p style={{fontSize:17,color:"var(--text2)",margin:0,fontFamily:F}}>클릭하거나 파일을 드래그하세요</p>
              <p style={{fontSize:14,color:"var(--text3)",margin:"6px 0 0",fontFamily:F}}>PDF · 30MB 이하</p>
            </div>
            {files.length>0 && <div style={{marginTop:16}}><p style={{fontSize:14,color:"var(--text3)",marginBottom:8,fontFamily:F}}>{files.length}개 파일</p>
              {files.map((f,i) => <div key={i} style={{display:"flex",alignItems:"center",padding:"12px 16px",borderRadius:9,background:"var(--surface)",border:"1px solid var(--border)",marginBottom:6}}>
                <span style={{fontSize:15,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,fontFamily:F}}>📄 {f.name}</span>
                <span style={{fontSize:13,color:f.size>30*1024*1024?"var(--red)":"var(--text3)",fontFamily:F,marginRight:10,flexShrink:0}}>{f.size>1024*1024?(f.size/1024/1024).toFixed(1)+"MB":Math.round(f.size/1024)+"KB"}</span>
                <button onClick={() => removeFile(i)} style={{background:"none",border:"none",color:"var(--text3)",cursor:"pointer",fontSize:18,padding:"0 4px"}}>×</button>
              </div>)}
            </div>}
            <div style={{display:"flex",gap:12,marginTop:14}}>
              <button onClick={() => setStep(1)} style={{padding:"16px 28px",borderRadius:12,border:"1px solid var(--border)",background:"transparent",color:"var(--text2)",fontSize:17,cursor:"pointer",fontFamily:F}}>← 기준 수정</button>
              <button onClick={screenResumes} disabled={!files.length} style={{flex:1,padding:"16px",borderRadius:12,border:"none",background:files.length?"linear-gradient(135deg, var(--accent), #7c3aed)":"var(--surface2)",color:files.length?"#fff":"var(--text3)",fontSize:18,fontWeight:600,cursor:files.length?"pointer":"not-allowed",fontFamily:F}}>스크리닝 시작 →</button>
            </div>
          </div>)}

          {/* STEP 3 — 결과 */}
          {step===3 && !loading && results.length>0 && (<div className="fade-in">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <h2 style={{fontSize:20,fontWeight:600,margin:0,fontFamily:F}}>스크리닝 결과 ({results.length}명)</h2>
              <div style={{display:"flex",gap:8}}>
                <button onClick={handleCopy} style={{padding:"9px 16px",borderRadius:9,border:"1px solid var(--border)",background:copyDone?"rgba(34,197,94,0.12)":"var(--surface)",color:copyDone?"var(--green)":"var(--text2)",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:F}}>{copyDone?"✓ 복사됨":"📋 결과 복사"}</button>
                <button onClick={resetAll} style={{padding:"9px 16px",borderRadius:9,border:"1px solid var(--border)",background:"transparent",color:"var(--text2)",fontSize:14,cursor:"pointer",fontFamily:F}}>새로 시작</button>
              </div>
            </div>

            {/* 추천 순위 슬롯 */}
            <div style={{display:"flex",gap:12,marginBottom:22}}>
              {[1,2].map(rank => { const pick = topCandidates.find(t=>t.rank===rank); return (
                <div key={rank} style={{flex:1,padding:"16px",borderRadius:12,background:pick?"var(--surface)":"var(--surface2)",border:`1px solid ${pick?(rank===1?"rgba(34,197,94,0.3)":"rgba(99,102,241,0.3)"):"var(--border)"}`,position:"relative"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:pick?8:0}}>
                    <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:26,height:26,borderRadius:7,fontSize:13,fontWeight:700,fontFamily:F,background:rank===1?"rgba(34,197,94,0.15)":"rgba(99,102,241,0.15)",color:rank===1?"var(--green)":"var(--accent2)"}}>{rank}</span>
                    {pick ? <span style={{fontSize:15,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,fontFamily:F}}>{pick.candidate_name}</span> : <span style={{fontSize:14,color:"var(--text3)",fontFamily:F}}>아래에서 선택</span>}
                  </div>
                  {pick && <><p style={{fontSize:13,color:"var(--text2)",margin:0,fontFamily:F}}>💪 {pick.strength}</p><button onClick={() => removeTopCandidate(rank)} style={{position:"absolute",top:8,right:8,background:"none",border:"none",color:"var(--text3)",cursor:"pointer",fontSize:15}}>×</button></>}
                </div>
              ); })}
              {topCandidates.length>=2 && <button onClick={swapTopCandidates} style={{alignSelf:"center",padding:"7px 10px",borderRadius:7,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--text2)",cursor:"pointer",fontSize:15}}>⇄</button>}
            </div>

            {/* 결과 카드 */}
            {results.map((r, idx) => (<div key={idx} className="fade-in" style={{marginBottom:10,borderRadius:12,border:`1px solid ${r._error?"rgba(239,68,68,0.3)":"var(--border)"}`,background:"var(--surface)",overflow:"hidden"}}>
              <div onClick={() => setExpandedIdx(expandedIdx===idx?null:idx)} style={{display:"flex",alignItems:"center",padding:"16px 18px",cursor:"pointer",gap:12}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                    <span style={{fontSize:16,fontWeight:700,fontFamily:F}}>{r.candidate_name}</span>
                    <RecBadge rec={r.recommendation}/>
                  </div>
                  {/* 경력 강조 */}
                  <div style={{display:"flex",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                    {r.total_experience && r.total_experience!=="확인 불가" && <span style={{fontSize:13,padding:"3px 10px",borderRadius:6,background:"rgba(99,102,241,0.1)",color:"var(--accent2)",fontWeight:600,fontFamily:F}}>{r.total_experience}</span>}
                    {r.relevant_experience && r.relevant_experience!=="확인 불가" && <span style={{fontSize:13,padding:"3px 10px",borderRadius:6,background:"rgba(34,197,94,0.1)",color:"var(--green)",fontWeight:600,fontFamily:F}}>{r.relevant_experience}</span>}
                  </div>
                  <p style={{fontSize:14,color:"var(--text2)",margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:F}}>{r.summary}</p>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0,alignItems:"center"}}>
                  {!r._error && [1,2].map(rank => <button key={rank} onClick={e => {e.stopPropagation();setAsTopCandidate(r,rank);}} style={{padding:"5px 10px",borderRadius:7,border:"1px solid var(--border)",background:topCandidates.find(t=>t.rank===rank&&t.candidate_name===r.candidate_name)?(rank===1?"rgba(34,197,94,0.15)":"rgba(99,102,241,0.15)"):"transparent",color:rank===1?"var(--green)":"var(--accent2)",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:F}}>{rank}순위</button>)}
                  <span style={{fontSize:16,color:"var(--text3)"}}>{expandedIdx===idx?"▲":"▼"}</span>
                </div>
              </div>
              {expandedIdx===idx && (<div style={{padding:"0 18px 18px",borderTop:"1px solid var(--border)"}}>
                <div style={{display:"flex",gap:12,margin:"14px 0"}}>
                  <div style={{flex:1,padding:"12px 14px",borderRadius:9,background:"rgba(34,197,94,0.05)",border:"1px solid rgba(34,197,94,0.15)"}}><p style={{fontSize:12,color:"var(--green)",fontWeight:600,margin:"0 0 4px",fontFamily:F}}>강점</p><p style={{fontSize:14,color:"var(--text)",margin:0,lineHeight:1.5,fontFamily:F}}>{r.strength}</p></div>
                  <div style={{flex:1,padding:"12px 14px",borderRadius:9,background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.15)"}}><p style={{fontSize:12,color:"var(--red)",fontWeight:600,margin:"0 0 4px",fontFamily:F}}>약점</p><p style={{fontSize:14,color:"var(--text)",margin:0,lineHeight:1.5,fontFamily:F}}>{r.weakness}</p></div>
                </div>
                {r.evaluations?.map((ev, eidx) => { const cr = confirmedCriteria?.criteria?.find(c=>c.id===ev.criteria_id); return (
                  <div key={eidx} style={{padding:"14px",borderRadius:9,background:"var(--surface2)",marginBottom:7}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}><span style={{fontSize:14,fontWeight:600,fontFamily:F}}>{cr?.name||`기준 ${ev.criteria_id}`}</span><StatusBadge status={ev.status}/></div>
                    <p style={{fontSize:13,color:"var(--text2)",margin:0,lineHeight:1.6,whiteSpace:"pre-wrap",fontFamily:F}}>{ev.reason}</p>
                  </div>
                ); })}
                <button onClick={async () => {await navigator.clipboard.writeText(buildCopyText(r));}} style={{marginTop:8,padding:"8px 14px",borderRadius:8,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--text2)",fontSize:13,cursor:"pointer",fontFamily:F}}>📋 이 후보자 복사</button>
              </div>)}
            </div>))}

            {/* 하단 전체 복사 */}
            <div style={{marginTop:16,display:"flex",justifyContent:"center"}}>
              <button onClick={handleCopy} style={{padding:"14px 28px",borderRadius:12,border:"none",background:copyDone?"rgba(34,197,94,0.15)":"var(--surface2)",color:copyDone?"var(--green)":"var(--text)",fontSize:16,fontWeight:600,cursor:"pointer",fontFamily:F,transition:"all 0.2s"}}>{copyDone?"✓ 클립보드에 복사됨":"📋 전체 결과 복사 (슬랙·이메일용)"}</button>
            </div>
          </div>)}
        </div>
      </div>
    </div>
  );
}
