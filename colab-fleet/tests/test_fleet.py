"""Fleet API tests with the LLM seam mocked (dynamic categories & tags, 8-bit GGUF fallback)."""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fleet_server as fs  # noqa: E402


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(fs, "FLEET_TOKEN", "")
    return TestClient(fs.app)


def mock_llm(monkeypatch, *responses):
    calls = []
    queue = list(responses)

    async def fake(system, user):
        calls.append((system, user))
        r = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(fs, "llm_json", fake)
    return calls


GRADE_BODY = {
    "question_prompt": "Why does ADH raise urine osmolality?",
    "mark_scheme": "V2 -> aquaporin-2",
    "user_answer": "it inserts water channels",
    "categories": ["Renal", "Endocrine"],
    "tags": ["aquaporin-2", "osmolality"],
}


def test_health_exposes_gguf_quantization_and_secondary_role(client):
    res = client.get("/health").json()
    assert res["status"] == "ok"
    assert res["gguf_quantization"] == "q8_0"
    assert res["role"] == "archived_secondary_heavy_ocr_fallback"


def test_grade_ok_and_clamped(client, monkeypatch):
    mock_llm(monkeypatch, {"grade": 7.4, "physiological_feedback": "Good.", "missing_concepts": "V2 receptor"})
    r = client.post("/grade-written", json=GRADE_BODY)
    assert r.status_code == 200
    assert r.json() == {"grade": 5, "physiological_feedback": "Good.", "missing_concepts": ["V2 receptor"]}


def test_grade_empty_answer_skips_model(client, monkeypatch):
    calls = mock_llm(monkeypatch, {"grade": 5})
    r = client.post("/grade-written", json={**GRADE_BODY, "user_answer": "  "})
    assert r.json()["grade"] == 1 and calls == []


def test_grade_retries_then_502(client, monkeypatch):
    mock_llm(monkeypatch, {"physiological_feedback": "no grade"})
    assert client.post("/grade-written", json=GRADE_BODY).status_code == 502


def test_grade_backend_failure_is_502(client, monkeypatch):
    mock_llm(monkeypatch, ValueError("bad json"))
    assert client.post("/grade-written", json=GRADE_BODY).status_code == 502


def test_token_enforced(monkeypatch):
    monkeypatch.setattr(fs, "FLEET_TOKEN", "s3cret")
    mock_llm(monkeypatch, {"grade": 3})
    c = TestClient(fs.app)
    assert c.post("/grade-written", json=GRADE_BODY).status_code == 401
    assert c.post("/grade-written", json=GRADE_BODY, headers={"X-Fleet-Token": "s3cret"}).status_code == 200
    assert c.get("/health").status_code == 200


def test_triples_explicit_syntax_plus_model_and_word_cap(client, monkeypatch):
    long_phrase = " ".join(["word"] * 45)
    mock_llm(monkeypatch, {"triples": [
        {"source": "Glomerulus", "linking_phrase": long_phrase, "target": "Bowman space"},
        {"source": "Same", "linking_phrase": "x", "target": "same"},
    ]})
    md = "[Male Urethra] --(passes through)--> [Prostate Gland]\n\nGlomerulus text."
    r = client.post(
        "/extract-mindmap-triples",
        json={"markdown": md, "categories": ["Renal", "Anatomy"], "tags": ["filtration"]},
    ).json()["triples"]
    assert r[0] == {"source": "Male Urethra", "linking_phrase": "passes through", "target": "Prostate Gland"}
    assert len(r) == 2 and len(r[1]["linking_phrase"].split()) == 30


def test_auto_tag_accepts_dynamic_categories_and_tags(client, monkeypatch):
    mock_llm(monkeypatch, {
        "categories": ["quantum mechanics", "Bogus", "QUANTUM MECHANICS", "Linear Algebra"],
        "tags": ["  Hilbert Space ", "hilbert space", "Eigenvalues"],
    })
    r = client.post(
        "/auto-tag",
        json={
            "text": "Wavefunction collapse and operators in Hilbert space",
            "categories": ["Quantum Mechanics", "Linear Algebra", "Thermodynamics"],
            "tags": ["operators"],
        },
    ).json()
    assert r["categories"] == ["Quantum Mechanics", "Linear Algebra"]
    assert r["tags"] == ["hilbert space", "eigenvalues"]


def test_extract_json_tolerates_fences():
    assert fs._extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    with pytest.raises(ValueError):
        fs._extract_json("no json here")
