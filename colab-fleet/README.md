# colab-fleet

Colab Pro 3B micro-fleet (Constitution §2/§4). `fleet_server.py` is the FastAPI app; `studyapp_colab_fleet.ipynb`
is generated from it (`python build_notebook.py`) — do not edit the notebook's server cell by hand.

## Run
1. Upload/open `studyapp_colab_fleet.ipynb` in Colab.
2. Add Colab secrets `NGROK_AUTHTOKEN` and `FLEET_TOKEN` (notebook access on).
3. Run all cells; copy the printed `https://….ngrok-free.app` URL and the token into StudyApp's sidebar → **Connect**.

Switch model with `MODEL` in cell 1 (`qwen2.5:3b-instruct` or `llama3.2:3b`). Set `FLEET_BACKEND=vllm` and
`FLEET_BACKEND_URL` to use a vLLM OpenAI-compatible server instead of Ollama.

## Endpoints (all but `/health` require `X-Fleet-Token`)
| Route | Body | Returns |
|---|---|---|
| `POST /grade-written` | `{question_prompt, mark_scheme, user_answer}` | `{grade 1..5, physiological_feedback, missing_concepts[]}` |
| `POST /extract-mindmap-triples` | `{markdown, organ_system?}` | `{triples:[{source, linking_phrase (<=30 words), target}]}` |
| `POST /auto-tag` | `{text}` | `{organ_systems[], clinical_bridge_tags[]}` |
| `GET /health` | – | `{status, backend, model}` |

## Tests
`python -m pytest tests -q` (LLM mocked; no model needed).
