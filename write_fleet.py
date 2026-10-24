import pathlib

part1 = '''"""
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
'''

pathlib.Path(r'E:/StudyApp/colab-fleet/fleet_server.py').write_text(part1, encoding='utf-8')
print("Part 1 written")