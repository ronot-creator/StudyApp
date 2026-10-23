"""Regenerates studyapp_colab_fleet.ipynb, embedding fleet_server.py so they never drift.
Usage:  python build_notebook.py
"""
import json
from pathlib import Path

here = Path(__file__).parent
server_src = (here / "fleet_server.py").read_text(encoding="utf-8")


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src.strip().splitlines(keepends=True)}


def code(src):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
            "source": src.strip().splitlines(keepends=True)}


cells = [
    md("""
# StudyApp Colab Pro 3B Micro-Fleet
Runs a 3B instruct model (Qwen-2.5-3B or Llama-3.2-3B) behind FastAPI + a pyngrok tunnel
(`/grade-written`, `/extract-mindmap-triples`, `/auto-tag`). Run all cells top to bottom and leave the last cell running.

**Before running:** in Colab's left sidebar -> Secrets (key icon) add `NGROK_AUTHTOKEN` (ngrok dashboard) and
`FLEET_TOKEN` (any long random string; paste the same value into StudyApp). Enable *Notebook access* for both.
"""),
    code("""
# 1. Configuration
MODEL = "qwen2.5:3b-instruct"      # or "llama3.2:3b"
PORT = 8080
from google.colab import userdata
import os
os.environ["NGROK_AUTHTOKEN"] = userdata.get("NGROK_AUTHTOKEN")
os.environ["FLEET_TOKEN"] = userdata.get("FLEET_TOKEN")
os.environ["FLEET_MODEL"] = MODEL
os.environ["FLEET_BACKEND"] = "ollama"
"""),
    code("""
# 2. Install dependencies + Ollama (CPU-friendly 3B serving)
!pip install -q fastapi "uvicorn[standard]" pyngrok httpx
!apt-get -qq install -y zstd pciutils > /dev/null
!curl -fsSL https://ollama.com/install.sh | sh
"""),
    code("""
# 3. Start Ollama and pull the model
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
print("Paste into StudyApp -> Colab 3B Ngrok Tunnel URL:\\n", tunnel.public_url)
"""),
    code("""
# 5. Smoke test, then keep the runtime alive 24/7
r = httpx.post(tunnel.public_url + "/grade-written",
               headers={"X-Fleet-Token": os.environ["FLEET_TOKEN"], "ngrok-skip-browser-warning": "1"},
               json={"question_prompt": "Why does ADH concentrate urine?",
                     "mark_scheme": "ADH binds V2 receptors, inserting aquaporin-2 in collecting duct so water is reabsorbed.",
                     "user_answer": "It makes the collecting duct leaky to water so water goes back to blood"}, timeout=120)
print(r.status_code, r.json())
while True:   # a tunnel URL change after a runtime restart is handled by StudyApp's offline queue
    time.sleep(60)
"""),
]

nb = {"cells": cells, "metadata": {"accelerator": "None", "colab": {"provenance": []},
      "kernelspec": {"display_name": "Python 3", "name": "python3"}}, "nbformat": 4, "nbformat_minor": 5}
(here / "studyapp_colab_fleet.ipynb").write_text(json.dumps(nb, indent=1), encoding="utf-8")
print("wrote studyapp_colab_fleet.ipynb")
