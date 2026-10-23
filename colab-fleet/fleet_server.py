"""
StudyApp Colab Pro 3B Micro-Fleet (Constitution Sections 2 & 4)

FastAPI service meant to run inside Google Colab behind a pyngrok tunnel. A 1.5B-3B
instruct model (Qwen-2.5-3B-Instruct / Llama-3.2-3B-Instruct) is served either by
Ollama (default, CPU friendly) or by a vLLM OpenAI-compatible server.

Endpoints
  GET  /health
  POST /grade-written           -> {grade 1..5, physiological_feedback, missing_concepts[]}
  POST /extract-mindmap-triples -> {triples: [{source, linking_phrase, target}]}
  POST /auto-tag                -> {organ_systems[], clinical_bridge_tags[]}

Env
  FLEET_BACKEND   ollama | vllm            (default ollama)
  FLEET_MODEL     model name for backend   (default qwen2.5:3b-instruct)
  FLEET_BACKEND_URL  backend base URL      (default http://127.0.0.1:11434 / :8000)
  FLEET_TOKEN     shared secret expected in the `X-Fleet-Token` header (strongly recommended,
                  the ngrok URL is public)
"""
import asyncio
import json
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

BACKEND = os.environ.get("FLEET_BACKEND", "ollama").lower()
MODEL = os.environ.get("FLEET_MODEL", "qwen2.5:3b-instruct")
BACKEND_URL = os.environ.get(
    "FLEET_BACKEND_URL", "http://127.0.0.1:11434" if BACKEND == "ollama" else "http://127.0.0.1:8000"
)
FLEET_TOKEN = os.environ.get("FLEET_TOKEN", "")
MAX_LINK_WORDS = 30
MAX_MARKDOWN_CHUNK_CHARS = 6000
LLM_TIMEOUT_S = 180

ORGAN_SYSTEMS = [
    "Renal", "Cardiovascular", "Respiratory", "Gastrointestinal", "Neurological", "Endocrine",
    "Musculoskeletal", "Reproductive", "Hematological", "Immunological", "Integumentary", "Lymphatic",
]

app = FastAPI(title="StudyApp Colab 3B Micro-Fleet")
# The Tauri webview calls the tunnel directly from a different origin.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_llm_slots = asyncio.Semaphore(2)  # small models on Colab CPU: don't over-subscribe


def require_token(x_fleet_token: Optional[str] = Header(default=None)) -> None:
    if FLEET_TOKEN and x_fleet_token != FLEET_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Fleet-Token")


# ----------------------------------------------------------------------------
# LLM backend (single seam, patched in tests)
# ----------------------------------------------------------------------------
def _extract_json(text: str) -> Any:
    """Parses model output as JSON, tolerating code fences / leading prose."""
    text = text.strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("model returned no JSON object")
    return json.loads(m.group(0))


async def llm_json(system: str, user: str) -> Dict[str, Any]:
    """Calls the local 3B model and returns a parsed JSON object."""
    async with _llm_slots, httpx.AsyncClient(timeout=LLM_TIMEOUT_S) as client:
        if BACKEND == "ollama":
            r = await client.post(
                f"{BACKEND_URL}/api/chat",
                json={
                    "model": MODEL,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.1, "num_ctx": 4096},
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                },
            )
            r.raise_for_status()
            content = r.json()["message"]["content"]
        else:  # vLLM OpenAI-compatible server
            r = await client.post(
                f"{BACKEND_URL}/v1/chat/completions",
                json={
                    "model": MODEL,
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                },
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
    return _extract_json(content)


async def llm_json_retry(system: str, user: str, attempts: int = 2) -> Dict[str, Any]:
    last: Exception = RuntimeError("no attempt")
    for _ in range(attempts):
        try:
            return await llm_json(system, user)
        except (ValueError, KeyError, httpx.HTTPError) as e:
            last = e
    raise HTTPException(status_code=502, detail=f"Model backend failed: {last}")


# ----------------------------------------------------------------------------
# /grade-written
# ----------------------------------------------------------------------------
class GradeRequest(BaseModel):
    question_prompt: str = Field(min_length=1, max_length=4000)
    mark_scheme: str = Field(min_length=1, max_length=8000)
    user_answer: str = Field(max_length=8000)


class GradeResponse(BaseModel):
    grade: int = Field(ge=1, le=5)
    physiological_feedback: str
    missing_concepts: List[str]


GRADE_SYSTEM = """You are a strict-but-fair medical physiology examiner grading a student's written answer.
Grade SEMANTIC and PHYSIOLOGICAL understanding against the mark scheme. FORGIVE wording, synonyms, spelling,
abbreviations and sentence order; PENALISE wrong mechanisms, reversed causality and missing key concepts.
Scale: 1 = blank/wrong/contradicts physiology, 2 = major gaps or a significant error, 3 = partly correct with
important gaps, 4 = mostly correct, minor omissions, 5 = complete and physiologically accurate.
Reply with ONLY this JSON object:
{"grade": <integer 1-5>, "physiological_feedback": "<2-4 sentences explaining the physiology>", "missing_concepts": ["<concept from the mark scheme the answer omitted>"]}
Use an empty list when nothing is missing."""


def normalize_grade(raw: Dict[str, Any]) -> GradeResponse:
    try:
        grade = int(round(float(raw.get("grade"))))
    except (TypeError, ValueError):
        raise ValueError("grade missing")
    missing = raw.get("missing_concepts") or []
    if isinstance(missing, str):
        missing = [missing]
    return GradeResponse(
        grade=max(1, min(5, grade)),
        physiological_feedback=str(raw.get("physiological_feedback") or "").strip() or "No feedback returned.",
        missing_concepts=[str(c).strip() for c in missing if str(c).strip()],
    )


@app.post("/grade-written", response_model=GradeResponse, dependencies=[Depends(require_token)])
async def grade_written(req: GradeRequest) -> GradeResponse:
    if not req.user_answer.strip():
        return GradeResponse(
            grade=1, physiological_feedback="No answer was provided.", missing_concepts=[]
        )
    user = (
        f"QUESTION:\n{req.question_prompt}\n\nMARK SCHEME:\n{req.mark_scheme}\n\n"
        f"STUDENT ANSWER:\n{req.user_answer}"
    )
    last: Exception = RuntimeError("no attempt")
    for _ in range(2):
        raw = await llm_json_retry(GRADE_SYSTEM, user)
        try:
            return normalize_grade(raw)
        except ValueError as e:
            last = e
    raise HTTPException(status_code=502, detail=f"Model returned an invalid grade payload: {last}")


# ----------------------------------------------------------------------------
# /extract-mindmap-triples
# ----------------------------------------------------------------------------
class TripleRequest(BaseModel):
    markdown: str = Field(min_length=1)
    organ_system: Optional[str] = None


class Triple(BaseModel):
    source: str
    linking_phrase: str
    target: str


class TripleResponse(BaseModel):
    triples: List[Triple]


# [Source Node] --(linking phrase)--> [Target Node]
EXPLICIT_TRIPLE_RE = re.compile(r"\[([^\[\]\n]+?)\]\s*--\(([^()\n]+?)\)-->\s*\[([^\[\]\n]+?)\]")

TRIPLE_SYSTEM = """You extract physiological FLOW relationships from medical lecture notes as concept-map triples.
Each triple is: source node --(linking phrase)--> target node.
Rules: nodes are short noun phrases (1-5 words). The linking phrase is a short verb phrase of at most 30 words
(prefer under 8) describing the physiological relationship or flow. Only use facts stated in the text.
Reply with ONLY this JSON: {"triples": [{"source": "...", "linking_phrase": "...", "target": "..."}]}"""


def clean_triple(source: Any, phrase: Any, target: Any) -> Optional[Triple]:
    s, p, t = (re.sub(r"\s+", " ", str(x or "")).strip() for x in (source, phrase, target))
    if not (s and p and t) or s.lower() == t.lower():
        return None
    words = p.split(" ")
    if len(words) > MAX_LINK_WORDS:
        p = " ".join(words[:MAX_LINK_WORDS])
    return Triple(source=s, linking_phrase=p, target=t)


def chunk_markdown(md: str, limit: int = MAX_MARKDOWN_CHUNK_CHARS) -> List[str]:
    chunks, cur = [], ""
    for para in re.split(r"\n\s*\n", md):
        if cur and len(cur) + len(para) > limit:
            chunks.append(cur)
            cur = ""
        cur += para + "\n\n"
    if cur.strip():
        chunks.append(cur)
    return chunks


@app.post("/extract-mindmap-triples", response_model=TripleResponse, dependencies=[Depends(require_token)])
async def extract_mindmap_triples(req: TripleRequest) -> TripleResponse:
    seen, out = set(), []

    def add(t: Optional[Triple]) -> None:
        if t and (key := (t.source.lower(), t.linking_phrase.lower(), t.target.lower())) not in seen:
            seen.add(key)
            out.append(t)

    # 1) Deterministic: explicit Markdown syntax needs no model
    for m in EXPLICIT_TRIPLE_RE.finditer(req.markdown):
        add(clean_triple(*m.groups()))
    # 2) Model-extracted triples from prose
    hint = f" The notes belong to the {req.organ_system} system." if req.organ_system else ""
    for chunk in chunk_markdown(req.markdown):
        raw = await llm_json_retry(TRIPLE_SYSTEM + hint, chunk)
        for item in raw.get("triples", []) if isinstance(raw, dict) else []:
            if isinstance(item, dict):
                add(clean_triple(item.get("source"), item.get("linking_phrase"), item.get("target")))
    return TripleResponse(triples=out)


# ----------------------------------------------------------------------------
# /auto-tag
# ----------------------------------------------------------------------------
class TagRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MARKDOWN_CHUNK_CHARS * 2)


class TagResponse(BaseModel):
    organ_systems: List[str]
    clinical_bridge_tags: List[str]


TAG_SYSTEM = f"""You tag medical study notes. Reply with ONLY this JSON:
{{"organ_systems": [...], "clinical_bridge_tags": [...]}}
organ_systems: choose 1-3 from this list only: {", ".join(ORGAN_SYSTEMS)}.
clinical_bridge_tags: 2-6 short lowercase tags linking the physiology to clinical reasoning or to OTHER systems
(e.g. "acid-base balance", "raas", "heart failure", "nephrotic syndrome")."""


@app.post("/auto-tag", response_model=TagResponse, dependencies=[Depends(require_token)])
async def auto_tag(req: TagRequest) -> TagResponse:
    raw = await llm_json_retry(TAG_SYSTEM, req.text)
    canon = {s.lower(): s for s in ORGAN_SYSTEMS}
    systems = []
    for s in raw.get("organ_systems") or []:
        c = canon.get(str(s).strip().lower())
        if c and c not in systems:
            systems.append(c)
    tags: List[str] = []
    for t in raw.get("clinical_bridge_tags") or []:
        t = re.sub(r"\s+", " ", str(t)).strip().lower()
        if t and t not in tags:
            tags.append(t)
    return TagResponse(organ_systems=systems[:3], clinical_bridge_tags=tags[:6])


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok", "backend": BACKEND, "model": MODEL}
