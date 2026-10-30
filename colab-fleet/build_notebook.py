"""Regenerates studyapp_colab_fleet.ipynb, embedding fleet_server.py so they never drift.
Preserves 8-bit GGUF inference (`q8_0`) as an archived secondary / heavy-OCR fallback configuration.
Usage:  python build_notebook.py
"""
import json
from pathlib import Path

here = Path(__file__).parent
server_src = (here / "fleet_server.py").read_text(encoding="utf-8")


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src.strip().splitlines(keepends=True)}


def code(src):
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": src.strip().splitlines(keepends=True),
    }


cells = [
    md("""
# Convergence Colab Fleet (Archived Secondary / Heavy-OCR & 8-bit GGUF Fallback)
Preserves 8-bit GGUF (`q8_0`) inference and EasyOCR/Tesseract (`eng+ara`) bounding-box extraction as a secondary fallback to Google AI Studio (`gemma-4-31b-it`).
All endpoints (`/grade-written`, `/extract-mindmap-triples`, `/auto-tag`, `/generate-image-occlusion`) dynamically accept `categories` and `tags` via the request payload with zero hardcoded domain lists.
"""),
    code("""
# 1. Configuration (8-bit GGUF Secondary / Heavy-OCR Fallback)
MODEL = "qwen2.5:3b-instruct-q8_0"
GGUF_QUANT = "q8_0"
PORT = 8080
from google.colab import userdata
import os
os.environ["NGROK_AUTHTOKEN"] = userdata.get("NGROK_AUTHTOKEN")
os.environ["FLEET_TOKEN"] = userdata.get("FLEET_TOKEN")
os.environ["FLEET_MODEL"] = MODEL
os.environ["FLEET_GGUF_QUANT"] = GGUF_QUANT
os.environ["FLEET_BACKEND"] = "ollama"
"""),
    code("""
# 2. Install dependencies + Ollama + Heavy OCR (EasyOCR & Tesseract eng+ara)
!pip install -q fastapi "uvicorn[standard]" pyngrok httpx easyocr pytesseract pillow
!apt-get -qq install -y zstd pciutils tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara > /dev/null
!curl -fsSL https://ollama.com/install.sh | sh
"""),
    code("""
# 3. Start Ollama and pull the 8-bit GGUF model (q8_0)
import subprocess, time, httpx
subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    try:
        httpx.get("http://127.0.0.1:11434/api/tags").raise_for_status(); break
    except Exception:
        time.sleep(1)
!ollama pull $MODEL
"""),
    code("%%writefile fleet_server.py\n" + server_src),
    code("""
# 4. Launch FastAPI + ngrok tunnel
import threading, uvicorn, importlib, fleet_server
from pyngrok import ngrok, conf
importlib.reload(fleet_server)
conf.get_default().auth_token = os.environ["NGROK_AUTHTOKEN"]
threading.Thread(
    target=lambda: uvicorn.run(fleet_server.app, host="127.0.0.1", port=PORT, log_level="warning"),
    daemon=True).start()
time.sleep(3)
tunnel = ngrok.connect(PORT, "http")
print("Secondary Heavy-OCR / GGUF Fallback Tunnel URL:\\n", tunnel.public_url)
"""),
    code("""
# 5. Dynamic payload verification smoke test
r = httpx.post(tunnel.public_url + "/auto-tag",
               headers={"X-Fleet-Token": os.environ["FLEET_TOKEN"], "ngrok-skip-browser-warning": "1"},
               json={"text": "Tubuloglomerular feedback and afferent arteriole tone",
                     "categories": ["Physiology", "Systems Biology"],
                     "tags": ["autoregulation", "hemodynamics"]}, timeout=120)
print(r.status_code, r.json())
while True:
    time.sleep(60)
"""),
]

nb = {
    "cells": cells,
    "metadata": {
        "accelerator": "None",
        "colab": {"provenance": []},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}
(here / "studyapp_colab_fleet.ipynb").write_text(json.dumps(nb, indent=1), encoding="utf-8")
print("wrote studyapp_colab_fleet.ipynb")
