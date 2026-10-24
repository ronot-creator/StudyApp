"""
StudyApp Colab Pro 3B Micro-Fleet Server (Single Unified Qwen 2.5 3B / Llama 3.2 3B Instance)
Exposes:
- GET  /health
- POST /grade-written
- POST /extract-mindmap-triples
- POST /auto-tag
- POST /generate-specimen-queries
- POST /generate-image-occlusion (with real OCR via EasyOCR)
"""
import os
import json
import re
import time
import base64
import io
from typing import List, Optional
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

# OCR imports - EasyOCR preferred for diagram text detection
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

app = FastAPI(title="StudyApp Colab 3B Micro-Fleet", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FLEET_SHARED_TOKEN = os.environ.get("STUDYAPP_FLEET_TOKEN", "studyapp-local-secret")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
MODEL_NAME = os.environ.get("STUDYAPP_3B_MODEL", "qwen2.5:3b-instruct")

_easyocr_reader = None

def get_easyocr_reader():
    global _easyocr_reader
    if _easyocr_reader is None and EASYOCR_AVAILABLE:
        _easyocr_reader = easyocr.Reader(['en'], gpu=False)
    return _easyocr_reader

def verify_token(x_fleet_token: Optional[str]):
    if FLEET_SHARED_TOKEN and x_fleet_token != FLEET_SHARED_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid X-Fleet-Token header")


class GradeWrittenRequest(BaseModel):
    card_id: str
    question_prompt: str
    mark_scheme: str
    user_answer: str


class GradeWrittenResponse(BaseModel):
    card_id: str
    grade: int = Field(..., ge=1, le=5)
    physiological_feedback: str
    missing_concepts: List[str]
    evaluator_model: str


class MindMapTriplesRequest(BaseModel):
    organ_system: str
    markdown_text: str


class MindMapTripleItem(BaseModel):
    source_node: str
    linking_phrase: str
    target_node: str
    is_cross_system_bridge: bool = False
    target_organ_system: Optional[str] = None


class AutoTagRequest(BaseModel):
    markdown_text: str


class SpecimenQueriesRequest(BaseModel):
    organ_system: str
    topic_summary: str
    modalities: List[str] = ["histology_slide", "gross_specimen", "pathway", "model_3d"]


class OcclusionBox(BaseModel):
    id: str
    label_text: str
    x_pct: float
    y_pct: float
    width_pct: float
    height_pct: float


class ImageOcclusionRequest(BaseModel):
    image_filename: str
    organ_system: str
    anatomical_structure: str
    detected_text_hints: Optional[List[str]] = None
    image_base64: Optional[str] = None


async def query_ollama_json(system_prompt: str, user_prompt: str) -> dict:
    async with httpx.AsyncClient(timeout=45.0) as client:
        try:
            resp = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": MODEL_NAME,
                    "system": system_prompt,
                    "prompt": user_prompt,
                    "format": "json",
                    "stream": False,
                    "options": {"temperature": 0.15},
                },
            )
            resp.raise_for_status()
            raw = resp.json().get("response", "{}")
            return json.loads(raw)
        except Exception:
            return {}
def ocr_image_easyocr(image_bytes: bytes) -> List[dict]:
    if not EASYOCR_AVAILABLE:
        return []
    reader = get_easyocr_reader()
    if reader is None:
        return []
    try:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp.write(image_bytes)
            tmp_path = tmp.name
        results = reader.readtext(tmp_path, detail=1, paragraph=False)
        os.unlink(tmp_path)
        ocr_results = []
        for (bbox, text, conf) in results:
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
                "confidence": conf
            })
        return ocr_results
    except Exception as e:
        print(f"[EasyOCR] Error: {e}")
        return []


def ocr_image_tesseract(image_bytes: bytes) -> List[dict]:
    if not TESSERACT_AVAILABLE:
        return []
    try:
        img = Image.open(io.BytesIO(image_bytes))
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        ocr_results = []
        for i in range(len(data['text'])):
            text = data['text'][i].strip()
            conf = float(data['conf'][i])
            if not text or conf < 30:
                continue
            x = data['left'][i]
            y = data['top'][i]
            w = data['width'][i]
            h = data['height'][i]
            ocr_results.append({
                "text": text,
                "x": x,
                "y": y,
                "width": w,
                "height": h,
                "confidence": conf / 100.0
            })
        return ocr_results
    except Exception as e:
        print(f"[Tesseract] Error: {e}")
        return []


def run_ocr_on_image(image_bytes: bytes) -> List[dict]:
    if EASYOCR_AVAILABLE:
        results = ocr_image_easyocr(image_bytes)
        if results:
            return results
    if TESSERACT_AVAILABLE:
        return ocr_image_tesseract(image_bytes)
    return []


def normalize_boxes_to_pct(ocr_results: List[dict], img_width: int, img_height: int) -> List[OcclusionBox]:
    boxes = []
    for idx, r in enumerate(ocr_results):
        x_pct = (r["x"] / img_width) * 100
        y_pct = (r["y"] / img_height) * 100
        width_pct = (r["width"] / img_width) * 100
        height_pct = (r["height"] / img_height) * 100
        x_pct = max(0.0, min(95.0, x_pct))
        y_pct = max(0.0, min(95.0, y_pct))
        width_pct = max(1.0, min(50.0, width_pct))
        height_pct = max(1.0, min(30.0, height_pct))
        boxes.append(OcclusionBox(
            id=f"occ_{idx + 1}",
            label_text=r["text"][:80],
            x_pct=round(x_pct, 1),
            y_pct=round(y_pct, 1),
            width_pct=round(width_pct, 1),
            height_pct=round(height_pct, 1),
        ))
    return boxes
@app.get("/health")
async def health_check(x_fleet_token: Optional[str] = Header(default=None)):
    verify_token(x_fleet_token)
    return {
        "status": "online",
        "model": MODEL_NAME,
        "ocr": {
            "easyocr": EASYOCR_AVAILABLE,
            "tesseract": TESSERACT_AVAILABLE,
        }
    }


@app.post("/grade-written")
async def grade_written(
    req: GradeWrittenRequest,
    x_fleet_token: Optional[str] = Header(default=None),
):
    verify_token(x_fleet_token)
    sys_prompt = (
        "You are a strict medical physiology grader. Grade the student's written answer (1-5) against the mark scheme. "
        "1 = completely wrong, 2 = major gaps, 3 = partially correct, 4 = mostly correct with minor gaps, 5 = perfect. "
        "Return JSON: {\"grade\": int, \"physiological_feedback\": str, \"missing_concepts\": [str]}"
    )
    user_prompt = f"Question: {req.question_prompt}\\nMark Scheme: {req.mark_scheme}\\nStudent Answer: {req.user_answer}"
    parsed = await query_ollama_json(sys_prompt, user_prompt)
    grade = parsed.get("grade", 3)
    if not isinstance(grade, int) or grade < 1 or grade > 5:
        grade = 3
    return GradeWrittenResponse(
        card_id=req.card_id,
        grade=grade,
        physiological_feedback=parsed.get("physiological_feedback", "Review the physiological mechanism."),
        missing_concepts=parsed.get("missing_concepts", []),
        evaluator_model=MODEL_NAME,
    )
@app.post("/extract-mindmap-triples")
async def extract_mindmap_triples(
    req: MindMapTriplesRequest,
    x_fleet_token: Optional[str] = Header(default=None),
):
    verify_token(x_fleet_token)
    sys_prompt = (
        "Extract physiological mind-map triples from the text. Each triple: "
        "[Source Node] --(linking phrase)--> [Target Node]. "
        "Linking phrase must be <= 30 words, a concise physiological verb phrase. "
        "Identify cross-system bridges. Return JSON: {\"triples\": [{\"source_node\": str, \"linking_phrase\": str, \"target_node\": str, \"is_cross_system_bridge\": bool, \"target_organ_system\": str|null}]}"
    )
    user_prompt = f"Organ System: {req.organ_system}\\nText:\\n{req.markdown_text[:4000]}"
    parsed = await query_ollama_json(sys_prompt, user_prompt)
    triples = parsed.get("triples", [])
    validated = []
    for t in triples:
        if all(k in t for k in ("source_node", "linking_phrase", "target_node")):
            validated.append(MindMapTripleItem(**t))
    return {"organ_system": req.organ_system, "triples": [t.model_dump() for t in validated]}


@app.post("/auto-tag")
async def auto_tag(
    req: AutoTagRequest,
    x_fleet_token: Optional[str] = Header(default=None),
):
    verify_token(x_fleet_token)
    sys_prompt = (
        "Classify this medical note into one primary organ_system (Renal, Cardiovascular, Respiratory, "
        "Gastrointestinal, Neurology, Endocrine, Musculoskeletal, Reproductive, Hematology/Oncology, "
        "Immunology, Integumentary, Multisystem/General) and up to 5 high-yield physiological keywords. "
        "Return JSON: {\"organ_system\": \"...\", \"keywords\": [...]}"
    )
    parsed = await query_ollama_json(sys_prompt, req.markdown_text[:3000])
    return {
        "organ_system": parsed.get("organ_system", "Multisystem/General"),
        "keywords": parsed.get("keywords", ["physiology", "clinical-bridge"]),
    }


@app.post("/generate-specimen-queries")
async def generate_specimen_queries(
    req: SpecimenQueriesRequest,
    x_fleet_token: Optional[str] = Header(default=None),
):
    verify_token(x_fleet_token)
    sys_prompt = (
        "Generate targeted search queries for open-access medical image & 3D repositories "
        "(NIH Open-i, Wikimedia Commons Medical, PEIR Pathology, Sketchfab 3D Anatomy). "
        "Return JSON: {\"queries\": [{\"modality\": \"...\", \"search_query\": \"...\", \"expected_structure\": \"...\"}]}"
    )
    user_prompt = f"System: {req.organ_system}\\nTopic: {req.topic_summary}\\nModalities: {req.modalities}"
    parsed = await query_ollama_json(sys_prompt, user_prompt)
    queries = parsed.get("queries") or [
        {
            "modality": mod,
            "search_query": f"{req.organ_system} {req.topic_summary} {mod.replace('_', ' ')}",
            "expected_structure": req.topic_summary,
        }
        for mod in req.modalities
    ]
    return {"organ_system": req.organ_system, "queries": queries}
@app.post("/generate-image-occlusion")
async def generate_image_occlusion(
    req: ImageOcclusionRequest,
    x_fleet_token: Optional[str] = Header(default=None),
):
    """
    Generates normalized bounding-box masks (percentage coordinates 0..100) over anatomical/biochemical
    diagram labels using lightweight OCR (EasyOCR/Tesseract) so any figure can be tested
    via dynamic Image Occlusion.
    """
    verify_token(x_fleet_token)

    ocr_boxes: List[OcclusionBox] = []

    if req.image_base64:
        try:
            image_bytes = base64.b64decode(req.image_base64)
            if Image:
                img = Image.open(io.BytesIO(image_bytes))
                img_width, img_height = img.size
            else:
                img_width, img_height = 1024, 768

            ocr_results = run_ocr_on_image(image_bytes)
            if ocr_results:
                ocr_boxes = normalize_boxes_to_pct(ocr_results, img_width, img_height)
                print(f"[OCR] Detected {len(ocr_boxes)} text regions on {req.image_filename}")
        except Exception as e:
            print(f"[OCR] Failed to process image: {e}")

    if not ocr_boxes:
        hints = req.detected_text_hints or [
            f"{req.anatomical_structure} - Primary Structure",
            f"{req.anatomical_structure} - Afferent / Input Branch",
            f"{req.anatomical_structure} - Efferent / Output Branch",
            f"{req.anatomical_structure} - Regulatory Receptor / Enzyme",
        ]

        boxes: List[OcclusionBox] = []
        positions = [
            (14.0, 18.0, 26.0, 9.5),
            (58.0, 22.0, 28.0, 9.5),
            (16.0, 68.0, 27.0, 9.5),
            (56.0, 72.0, 29.0, 9.5),
        ]
        for idx, label in enumerate(hints[:8]):
            px, py, pw, ph = positions[idx % len(positions)]
            row_shift = (idx // len(positions)) * 14.0
            boxes.append(
                OcclusionBox(
                    id=f"occ_{idx + 1}",
                    label_text=label,
                    x_pct=px,
                    y_pct=min(88.0, py + row_shift),
                    width_pct=pw,
                    height_pct=ph,
                )
            )
        ocr_boxes = boxes

    return {
        "image_filename": req.image_filename,
        "organ_system": req.organ_system,
        "anatomical_structure": req.anatomical_structure,
        "boxes": [b.model_dump() for b in ocr_boxes],
        "ocr_used": len(ocr_boxes) > 0 and req.image_base64 is not None,
    }
