"""
Convergence Legacy Colab Micro-Fleet Server (Archived Secondary / Heavy-OCR Fallback)
Dynamic domain-agnostic reasoning & OCR fallback with 8-bit GGUF inference (`q8_0`) support.
All hardcoded medical dummy lists have been stripped; categories and tags are dynamically accepted via request payloads.
Exposes:
- GET  /health
- POST /grade-written
- POST /extract-mindmap-triples
- POST /auto-tag
- POST /generate-specimen-queries
- POST /generate-image-occlusion (with real OCR via EasyOCR / Tesseract)
"""
import asyncio
import base64
import io
import json
import os
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    import easyocr
    EASYOCR_AVAILABLE = True
except ImportError:
    EASYOCR_AVAILABLE = False
    easyocr = None

try:
    import pytesseract
    from PIL import Image
    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False
    pytesseract = None
    Image = None

BACKEND = os.environ.get("FLEET_BACKEND", "ollama").lower()
MODEL = os.environ.get("STUDYAPP_3B_MODEL", os.environ.get("FLEET_MODEL", "qwen2.5:3b-instruct-q8_0"))
MODEL_NAME = MODEL
GGUF_QUANTIZATION = os.environ.get("FLEET_GGUF_QUANT", "q8_0")
FLEET_ROLE = "archived_secondary_heavy_ocr_fallback"
BACKEND_URL = os.environ.get(
    "OLLAMA_BASE_URL",
    os.environ.get("FLEET_BACKEND_URL", "http://127.0.0.1:11434" if BACKEND == "ollama" else "http://127.0.0.1:8000"),
)
OLLAMA_BASE_URL = BACKEND_URL
FLEET_TOKEN = os.environ.get("FLEET_TOKEN", os.environ.get("STUDYAPP_FLEET_TOKEN", "studyapp-local-secret"))
FLEET_SHARED_TOKEN = FLEET_TOKEN

MAX_LINK_WORDS = 30
MAX_MARKDOWN_CHUNK_CHARS = 6000
LLM_TIMEOUT_S = 90

app = FastAPI(title="Convergence Colab Fleet (Secondary Heavy-OCR & 8-bit GGUF Fallback)", version="2.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_llm_slots = asyncio.Semaphore(2)
_easyocr_reader = None


def get_easyocr_reader():
    global _easyocr_reader
    if _easyocr_reader is None and EASYOCR_AVAILABLE:
        _easyocr_reader = easyocr.Reader(["en", "ar"], gpu=False)
    return _easyocr_reader


def verify_token(x_fleet_token: Optional[str] = None) -> None:
    token = FLEET_TOKEN
    if token and x_fleet_token != token:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Fleet-Token header")


def _extract_json(text: str) -> Any:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError("model returned no JSON object")
    return json.loads(m.group(0))


async def llm_json(system: str, user: str) -> Dict[str, Any]:
    async with _llm_slots, httpx.AsyncClient(timeout=LLM_TIMEOUT_S) as client:
        if BACKEND == "ollama":
            r = await client.post(
                f"{BACKEND_URL}/api/chat",
                json={
                    "model": MODEL,
                    "stream": False,
                    "format": "json",
                    "options": {"temperature": 0.1, "num_ctx": 4096, "quantization": GGUF_QUANTIZATION},
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                },
            )
            r.raise_for_status()
            content = r.json()["message"]["content"]
        else:
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


async def query_ollama_json(system_prompt: str, user_prompt: str) -> Dict[str, Any]:
    return await llm_json(system_prompt, user_prompt)


async def llm_json_retry(system: str, user: str, attempts: int = 2) -> Dict[str, Any]:
    last: Exception = RuntimeError("no attempt")
    for _ in range(attempts):
        try:
            return await llm_json(system, user)
        except (ValueError, KeyError, httpx.HTTPError) as e:
            last = e
    raise HTTPException(status_code=502, detail=f"Model backend failed: {last}")


class OcclusionBox(BaseModel):
    id: str
    label_text: str
    x_pct: float
    y_pct: float
    width_pct: float
    height_pct: float


def ocr_image_easyocr(image_bytes: bytes) -> List[dict]:
    if not EASYOCR_AVAILABLE:
        return []
    reader = get_easyocr_reader()
    if reader is None:
        return []
    try:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = tmp.name
        results = reader.readtext(tmp_path, detail=1, paragraph=False)
        os.unlink(tmp_path)
        ocr_results = []
        for bbox, text, conf in results:
            if conf < 0.3:
                continue
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            ocr_results.append({
                "text": text.strip(),
                "x": x_min,
                "y": y_min,
                "width": x_max - x_min,
                "height": y_max - y_min,
                "confidence": conf,
            })
        return ocr_results
    except Exception:
        return []


def ocr_image_tesseract(image_bytes: bytes, lang: str = "eng+ara") -> List[dict]:
    if not TESSERACT_AVAILABLE:
        return []
    try:
        img = Image.open(io.BytesIO(image_bytes))
        data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)
        ocr_results = []
        for i in range(len(data["text"])):
            text = data["text"][i].strip()
            conf = float(data["conf"][i])
            if not text or conf < 30:
                continue
            ocr_results.append({
                "text": text,
                "x": data["left"][i],
                "y": data["top"][i],
                "width": data["width"][i],
                "height": data["height"][i],
                "confidence": conf / 100.0,
            })
        return ocr_results
    except Exception:
        return []


def run_ocr_on_image(image_bytes: bytes, lang: str = "eng+ara") -> List[dict]:
    if EASYOCR_AVAILABLE:
        results = ocr_image_easyocr(image_bytes)
        if results:
            return results
    if TESSERACT_AVAILABLE:
        return ocr_image_tesseract(image_bytes, lang=lang)
    return []


def normalize_boxes_to_pct(ocr_results: List[dict], img_width: int, img_height: int) -> List[OcclusionBox]:
    boxes = []
    for idx, r in enumerate(ocr_results):
        x_pct = max(0.0, min(95.0, (r["x"] / img_width) * 100))
        y_pct = max(0.0, min(95.0, (r["y"] / img_height) * 100))
        width_pct = max(1.0, min(50.0, (r["width"] / img_width) * 100))
        height_pct = max(1.0, min(30.0, (r["height"] / img_height) * 100))
        boxes.append(
            OcclusionBox(
                id=f"occ_{idx + 1}",
                label_text=r["text"][:80],
                x_pct=round(x_pct, 1),
                y_pct=round(y_pct, 1),
                width_pct=round(width_pct, 1),
                height_pct=round(height_pct, 1),
            )
        )
    return boxes


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    return {
        "status": "ok",
        "role": FLEET_ROLE,
        "backend": BACKEND,
        "model": MODEL,
        "gguf_quantization": GGUF_QUANTIZATION,
        "ocr": {
            "easyocr": EASYOCR_AVAILABLE,
            "tesseract": TESSERACT_AVAILABLE,
        },
    }


class GradeWrittenRequest(BaseModel):
    card_id: Optional[str] = None
    question_prompt: str = Field(..., min_length=1, max_length=4000)
    mark_scheme: str = Field(..., min_length=1, max_length=8000)
    user_answer: str = Field(default="", max_length=8000)
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None


GRADE_SYSTEM = """You are a strict-but-fair examiner grading a student's written answer against a mark scheme.
Grade SEMANTIC and MECHANISTIC understanding against the mark scheme. FORGIVE wording, synonyms, spelling,
abbreviations and sentence order; PENALISE wrong mechanisms, reversed causality and missing key concepts.
Scale: 1 = blank/wrong/contradicts mark scheme, 2 = major gaps or a significant error, 3 = partly correct with
important gaps, 4 = mostly correct, minor omissions, 5 = complete and accurate.
Reply with ONLY this JSON object:
{"grade": <integer 1-5>, "physiological_feedback": "<2-4 sentences explaining the feedback>", "missing_concepts": ["<concept from the mark scheme the answer omitted>"]}
Use an empty list when nothing is missing."""


def normalize_grade(raw: Dict[str, Any], card_id: Optional[str] = None) -> Dict[str, Any]:
    if not isinstance(raw, dict) or "grade" not in raw:
        raise ValueError("grade missing")
    try:
        grade = int(round(float(raw.get("grade"))))
    except (TypeError, ValueError):
        raise ValueError("grade invalid")
    missing = raw.get("missing_concepts") or []
    if isinstance(missing, str):
        missing = [missing]
    feedback = str(raw.get("physiological_feedback") or raw.get("feedback") or "").strip() or "No feedback returned."
    result: Dict[str, Any] = {
        "grade": max(1, min(5, grade)),
        "physiological_feedback": feedback,
        "missing_concepts": [str(c).strip() for c in missing if str(c).strip()],
    }
    if card_id is not None:
        result["card_id"] = card_id
        result["evaluator_model"] = MODEL
    return result


@app.post("/grade-written")
async def grade_written(
    req: GradeWrittenRequest,
    x_fleet_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    verify_token(x_fleet_token)
    if not req.user_answer.strip():
        res: Dict[str, Any] = {
            "grade": 1,
            "physiological_feedback": "No answer was provided.",
            "missing_concepts": [],
        }
        if req.card_id is not None:
            res["card_id"] = req.card_id
            res["evaluator_model"] = MODEL
        return res

    context_prefix = ""
    if req.categories:
        context_prefix += f"CATEGORIES: {', '.join(req.categories)}\n"
    if req.tags:
        context_prefix += f"TAGS: {', '.join(req.tags)}\n"

    user = (
        f"{context_prefix}QUESTION:\n{req.question_prompt}\n\nMARK SCHEME:\n{req.mark_scheme}\n\n"
        f"STUDENT ANSWER:\n{req.user_answer}"
    )
    last: Exception = RuntimeError("no attempt")
    for _ in range(2):
        raw = await llm_json_retry(GRADE_SYSTEM, user)
        try:
            return normalize_grade(raw, req.card_id)
        except ValueError as e:
            last = e
    raise HTTPException(status_code=502, detail=f"Model returned an invalid grade payload: {last}")


class MindMapTriplesRequest(BaseModel):
    markdown: Optional[str] = None
    markdown_text: Optional[str] = None
    organ_system: Optional[str] = None
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None


EXPLICIT_TRIPLE_RE = re.compile(r"\[([^\[\]\n]+?)\]\s*--\(([^()\n]+?)\)-->\s*\[([^\[\]\n]+?)\]")

TRIPLE_SYSTEM = """You extract causal and conceptual FLOW relationships from study notes as concept-map triples.
Each triple is: source node --(linking phrase)--> target node.
Rules: nodes are short noun phrases (1-5 words). The linking phrase is a short verb phrase of at most 30 words
(prefer under 8) describing the relationship or flow. Only use facts stated in the text.
Reply with ONLY this JSON: {"triples": [{"source": "...", "linking_phrase": "...", "target": "..."}]}"""


def clean_triple(source: Any, phrase: Any, target: Any) -> Optional[Dict[str, Any]]:
    s, p, t = (re.sub(r"\s+", " ", str(x or "")).strip() for x in (source, phrase, target))
    if not (s and p and t) or s.lower() == t.lower():
        return None
    words = p.split(" ")
    if len(words) > MAX_LINK_WORDS:
        p = " ".join(words[:MAX_LINK_WORDS])
    return {"source": s, "linking_phrase": p, "target": t}


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


@app.post("/extract-mindmap-triples")
async def extract_mindmap_triples(
    req: MindMapTriplesRequest,
    x_fleet_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    verify_token(x_fleet_token)
    md = (req.markdown if req.markdown is not None else req.markdown_text) or ""
    if not md.strip():
        raise HTTPException(status_code=422, detail="markdown or markdown_text is required")

    seen, out = set(), []

    def add(t: Optional[Dict[str, Any]]) -> None:
        if t and (key := (t["source"].lower(), t["linking_phrase"].lower(), t["target"].lower())) not in seen:
            seen.add(key)
            if req.markdown_text is not None and req.markdown is None:
                target_str = t["target"]
                is_bridge = "::" in target_str
                target_sys = None
                if is_bridge:
                    prefix, rest = target_str.split("::", 1)
                    target_sys = prefix.strip()
                    target_str = rest.strip()
                out.append({
                    "source": t["source"],
                    "source_node": t["source"],
                    "linking_phrase": t["linking_phrase"],
                    "target": t["target"],
                    "target_node": target_str,
                    "is_cross_system_bridge": is_bridge,
                    "target_organ_system": target_sys,
                })
            else:
                out.append(t)

    for m in EXPLICIT_TRIPLE_RE.finditer(md):
        add(clean_triple(*m.groups()))

    active_categories = req.categories or ([req.organ_system] if req.organ_system else [])
    hint = f" Categories: {', '.join(active_categories)}." if active_categories else ""
    if req.tags:
        hint += f" Tags: {', '.join(req.tags)}."

    for chunk in chunk_markdown(md):
        try:
            raw = await llm_json_retry(TRIPLE_SYSTEM + hint, chunk)
            for item in raw.get("triples", []) if isinstance(raw, dict) else []:
                if isinstance(item, dict):
                    src = item.get("source") or item.get("source_node")
                    phr = item.get("linking_phrase")
                    tgt = item.get("target") or item.get("target_node")
                    add(clean_triple(src, phr, tgt))
        except HTTPException:
            if not out:
                raise

    return {"triples": out}


class AutoTagRequest(BaseModel):
    text: Optional[str] = None
    markdown_text: Optional[str] = None
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None


def build_dynamic_tag_system_prompt(
    allowed_categories: Optional[List[str]] = None,
    seed_tags: Optional[List[str]] = None,
) -> str:
    cat_instruction = (
        f"choose 1-3 from this allowed list only: {', '.join(allowed_categories)}."
        if allowed_categories
        else "choose 1-3 concise high-level domain categories represented in the text."
    )
    tag_instruction = (
        f"choose 2-6 short lowercase tags (incorporating relevant seed tags if applicable: {', '.join(seed_tags)})."
        if seed_tags
        else "2-6 short lowercase conceptual bridge tags."
    )
    return (
        "You tag study notes dynamically. Reply with ONLY this JSON:\n"
        '{"categories": [...], "tags": [...]}\n'
        f"categories: {cat_instruction}\n"
        f"tags: {tag_instruction}"
    )


@app.post("/auto-tag")
async def auto_tag(
    req: AutoTagRequest,
    x_fleet_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    verify_token(x_fleet_token)
    body_text = (req.text if req.text is not None else req.markdown_text) or ""
    if not body_text.strip():
        raise HTTPException(status_code=422, detail="text or markdown_text is required")

    system_prompt = build_dynamic_tag_system_prompt(req.categories, req.tags)
    raw = await llm_json_retry(system_prompt, body_text[:MAX_MARKDOWN_CHUNK_CHARS * 2])

    raw_cats = (
        raw.get("categories")
        or raw.get("organ_systems")
        or ([raw["organ_system"]] if raw.get("organ_system") else [])
    )
    normalized_categories: List[str] = []

    if req.categories:
        canon = {c.strip().lower(): c.strip() for c in req.categories if str(c).strip()}
        for s in raw_cats:
            matched = canon.get(str(s).strip().lower())
            if matched and matched not in normalized_categories:
                normalized_categories.append(matched)
    else:
        seen_lower = set()
        for s in raw_cats:
            cleaned = re.sub(r"\s+", " ", str(s)).strip()
            if not cleaned:
                continue
            low = cleaned.lower()
            if low not in seen_lower:
                seen_lower.add(low)
                formatted = cleaned.title() if cleaned.islower() or cleaned.isupper() else cleaned
                normalized_categories.append(formatted)

    raw_tags = (
        raw.get("tags")
        or raw.get("clinical_bridge_tags")
        or raw.get("keywords")
        or (req.tags or [])
    )
    normalized_tags: List[str] = []
    for t in raw_tags:
        t_clean = re.sub(r"\s+", " ", str(t)).strip().lower()
        if t_clean and t_clean not in normalized_tags:
            normalized_tags.append(t_clean)

    cats_out = normalized_categories[:3]
    tags_out = normalized_tags[:6]
    return {
        "categories": cats_out,
        "tags": tags_out,
        "organ_systems": cats_out,
        "clinical_bridge_tags": tags_out,
    }


class SpecimenQueriesRequest(BaseModel):
    organ_system: Optional[str] = None
    category: Optional[str] = None
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    topic_summary: str
    modalities: List[str] = ["diagram", "reference_image", "pathway", "model_3d"]


@app.post("/generate-specimen-queries")
async def generate_specimen_queries(
    req: SpecimenQueriesRequest,
    x_fleet_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    verify_token(x_fleet_token)
    primary_cat = (
        req.category
        or (req.categories[0] if req.categories else None)
        or req.organ_system
        or "General"
    )
    tag_suffix = f" {' '.join(req.tags)}" if req.tags else ""
    queries = [
        {
            "modality": mod,
            "search_query": f"{primary_cat} {req.topic_summary}{tag_suffix} {mod.replace('_', ' ')}".strip(),
            "expected_structure": req.topic_summary,
        }
        for mod in req.modalities
    ]
    return {
        "category": primary_cat,
        "organ_system": primary_cat,
        "categories": req.categories or [primary_cat],
        "tags": req.tags or [],
        "queries": queries,
    }


class ImageOcclusionRequest(BaseModel):
    image_filename: str
    organ_system: Optional[str] = None
    category: Optional[str] = None
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    anatomical_structure: Optional[str] = None
    target_concept: Optional[str] = None
    detected_text_hints: Optional[List[str]] = None
    image_base64: Optional[str] = None
    ocr_lang: str = "eng+ara"


@app.post("/generate-image-occlusion")
async def generate_image_occlusion(
    req: ImageOcclusionRequest,
    x_fleet_token: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    verify_token(x_fleet_token)
    primary_cat = (
        req.category
        or (req.categories[0] if req.categories else None)
        or req.organ_system
        or "General"
    )
    focus_label = req.target_concept or req.anatomical_structure or req.image_filename

    ocr_boxes: List[OcclusionBox] = []
    if req.image_base64:
        try:
            image_bytes = base64.b64decode(req.image_base64)
            img_width, img_height = (Image.open(io.BytesIO(image_bytes)).size if Image else (1024, 768))
            ocr_results = run_ocr_on_image(image_bytes, lang=req.ocr_lang)
            if ocr_results:
                ocr_boxes = normalize_boxes_to_pct(ocr_results, img_width, img_height)
        except Exception:
            pass

    if not ocr_boxes:
        dynamic_hints = req.detected_text_hints or (
            [f"{focus_label} - {tag}" for tag in req.tags] if req.tags else [
                f"{focus_label} - Region 1",
                f"{focus_label} - Region 2",
            ]
        )
        positions = [
            (14.0, 18.0, 26.0, 9.5),
            (58.0, 22.0, 28.0, 9.5),
            (16.0, 68.0, 27.0, 9.5),
            (56.0, 72.0, 29.0, 9.5),
        ]
        for idx, label in enumerate(dynamic_hints[:8]):
            px, py, pw, ph = positions[idx % len(positions)]
            row_shift = (idx // len(positions)) * 14.0
            ocr_boxes.append(
                OcclusionBox(
                    id=f"occ_{idx + 1}",
                    label_text=label,
                    x_pct=px,
                    y_pct=min(88.0, py + row_shift),
                    width_pct=pw,
                    height_pct=ph,
                )
            )

    return {
        "image_filename": req.image_filename,
        "category": primary_cat,
        "organ_system": primary_cat,
        "categories": req.categories or [primary_cat],
        "tags": req.tags or [],
        "anatomical_structure": focus_label,
        "boxes": [b.model_dump() for b in ocr_boxes],
        "ocr_used": len(ocr_boxes) > 0 and req.image_base64 is not None,
    }
