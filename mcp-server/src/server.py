"""
StudyApp Local MCP Server
Implements the 5 tool schemas specified in Constitution.md Section 6, plus a
loopback-only HTTP bridge (127.0.0.1) the Tauri shell uses to push highlight state.
"""
import hashlib
import json
import os
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Tuple

from mcp.server.fastmcp import FastMCP
from .sandbox import (
    DB_PATH,
    SRS_DATA_DIR,
    VAULT_DIR,
    resolve_sandboxed_path,
    safe_write_text,
)

mcp = FastMCP("StudyApp-Local-Bridge")

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = int(os.environ.get("STUDYAPP_BRIDGE_PORT", "47821"))
_MAX_BODY_BYTES = 1024 * 1024

# In-memory cache updated by the Tauri UI when the user highlights text
_STATE_LOCK = threading.Lock()
_ACTIVE_HIGHLIGHT_STATE: Dict[str, str] = {
    "active_file": "",
    "selected_text": "",
    "surrounding_context": "",
}
_HIGHLIGHT_KEYS = tuple(_ACTIVE_HIGHLIGHT_STATE)


# ----------------------------------------------------------------------------
# SQLite helpers
# ----------------------------------------------------------------------------
def _db() -> sqlite3.Connection:
    """Opens studyapp_srs.db, creating it from schema.sql on first use."""
    SRS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    has_schema = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='thought_anchors'"
    ).fetchone()
    if not has_schema:
        schema = SRS_DATA_DIR / "schema.sql"
        if schema.exists():
            conn.executescript(schema.read_text(encoding="utf-8"))
    return conn


def _resolve_markdown(active_file: str) -> Path:
    """Resolves a file name from the UI (with or without 'vault/' prefix) inside the sandbox."""
    candidate = resolve_sandboxed_path(active_file)
    if not candidate.exists() and not active_file.replace("\\", "/").startswith("vault/"):
        candidate = resolve_sandboxed_path(f"vault/{active_file}")
    if not candidate.is_file():
        raise FileNotFoundError(f"Active Markdown file not found: {active_file}")
    return candidate


# ----------------------------------------------------------------------------
# Deterministic Markdown block offsets
# ----------------------------------------------------------------------------
_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")


def markdown_blocks(text: str) -> List[Tuple[int, int]]:
    """Splits Markdown into blocks (paragraphs, lists, fenced code, ...) separated by
    blank lines. Returns [(start, end)] character offsets; `end` excludes the trailing
    newline. Blank lines inside fenced code do not split a block. Fully deterministic."""
    blocks: List[Tuple[int, int]] = []
    pos = 0
    start = None
    end = 0
    in_fence = False
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        if stripped == "" and not in_fence:
            if start is not None:
                blocks.append((start, end))
                start = None
        else:
            if start is None:
                start = pos
            end = pos + len(line.rstrip("\r\n"))
        pos += len(line)
    if start is not None:
        blocks.append((start, end))
    return blocks


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def find_anchor_insert_offset(text: str, excerpt: str) -> int:
    """Returns the offset right after the Markdown block containing the END of `excerpt`."""
    blocks = markdown_blocks(text)
    idx = text.find(excerpt)
    if idx >= 0:
        last_char = idx + len(excerpt) - 1
        for s, e in blocks:
            if s <= last_char <= e:
                return e
    # Fallback: whitespace-insensitive match (rendered selections lose newlines/markup spacing)
    target = _norm(excerpt)
    if target:
        for s, e in blocks:
            if target in _norm(text[s:e]):
                return e
    raise ValueError("Highlighted text could not be located in the active Markdown file.")


# ----------------------------------------------------------------------------
# MCP tools
# ----------------------------------------------------------------------------
@mcp.tool()
def list_my_files(directory: str = "vault") -> List[str]:
    """Returns array of available local .md and image files inside E:\\StudyApp\\MyFiles\\."""
    target_dir = resolve_sandboxed_path(directory)
    if not target_dir.exists():
        return []
    allowed_exts = {".md", ".png", ".jpg", ".jpeg", ".webp", ".svg"}
    return [
        str(p.relative_to(target_dir))
        for p in target_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in allowed_exts
    ]


@mcp.tool()
def read_file(filename: str) -> str:
    """Pipes local file text directly into the model's context window."""
    target = resolve_sandboxed_path(filename)
    return target.read_text(encoding="utf-8")


@mcp.tool()
def write_markdown(filename: str, content: str) -> Dict[str, Any]:
    """Saves processed textbook chunks or generated SRS cards directly to the E:\\ drive."""
    if not filename.endswith(".md"):
        filename = f"{filename}.md"
    target = resolve_sandboxed_path(f"vault/{filename}" if not filename.startswith("vault") else filename)
    safe_write_text(target, content)  # enforces 500 GB E:\ quota guardrails
    return {"status": "saved", "path": str(target)}


@mcp.tool()
def get_active_highlight() -> Dict[str, str]:
    """Returns the text currently selected by the user in the UI, plus surrounding context."""
    with _STATE_LOCK:
        return dict(_ACTIVE_HIGHLIGHT_STATE)


@mcp.tool()
def save_thought_anchor(anchor_id: str, explanation: str) -> Dict[str, Any]:
    """Writes a customized AI margin-note into the active Markdown file, injected inline
    directly below the highlighted paragraph, and records it in the thought_anchors table."""
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", anchor_id):
        raise ValueError("anchor_id must be 1-64 chars of [A-Za-z0-9_-].")
    with _STATE_LOCK:
        active_file = _ACTIVE_HIGHLIGHT_STATE.get("active_file")
        excerpt = _ACTIVE_HIGHLIGHT_STATE.get("selected_text", "")
    if not active_file:
        raise ValueError("No active Markdown file is currently registered in the highlight state.")
    if not excerpt.strip():
        raise ValueError("No highlighted text is registered; select a passage first.")

    target = _resolve_markdown(active_file)
    original = target.read_text(encoding="utf-8")
    if f"<!-- thought-anchor:{anchor_id} -->" in original:
        raise ValueError(f"Thought anchor '{anchor_id}' already exists in {target.name}.")

    offset = find_anchor_insert_offset(original, excerpt)
    note = "\n".join(f"> {ln}" if ln.strip() else ">" for ln in explanation.strip().splitlines())
    anchor_block = (
        f"\n\n<!-- thought-anchor:{anchor_id} -->\n"
        f"> **[AI Margin Note #{anchor_id}]**\n>\n{note}\n"
        f"<!-- /thought-anchor:{anchor_id} -->"
    )
    updated = original[:offset] + anchor_block + original[offset:]

    try:
        rel = target.relative_to(VAULT_DIR).as_posix()
    except ValueError:
        rel = target.name
    document_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]

    safe_write_text(target, updated)  # quota-checked
    try:
        with _db() as conn:  # commits / rolls back transaction
            conn.execute(
                "INSERT OR IGNORE INTO vault_documents (id, organ_system, relative_path) VALUES (?, 'Unclassified', ?)",
                (document_id, rel),
            )
            # Resolve the real id in case the path was registered earlier by another ingester
            row = conn.execute("SELECT id FROM vault_documents WHERE relative_path = ?", (rel,)).fetchone()
            conn.execute(
                "INSERT INTO thought_anchors (anchor_id, document_id, highlighted_excerpt, ai_explanation) "
                "VALUES (?, ?, ?, ?)",
                (anchor_id, row[0], excerpt, explanation),
            )
    except Exception:
        target.write_text(original, encoding="utf-8")  # roll the file back to keep both stores consistent
        raise
    return {"status": "anchored", "anchor_id": anchor_id, "file": str(target), "inserted_at_offset": offset}


# ----------------------------------------------------------------------------
# Loopback bridge: Tauri `update_active_highlight` -> POST /highlight
# ----------------------------------------------------------------------------
class _BridgeHandler(BaseHTTPRequestHandler):
    def _reply(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
        elif self.path == "/highlight":
            self._reply(200, get_active_highlight())
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/highlight":
            return self._reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > _MAX_BODY_BYTES:
                return self._reply(413, {"error": "invalid body size"})
            data = json.loads(self.rfile.read(length))
            update = {k: str(data.get(k, "")) for k in _HIGHLIGHT_KEYS}
        except (ValueError, TypeError, AttributeError):
            return self._reply(400, {"error": "invalid JSON"})
        with _STATE_LOCK:
            _ACTIVE_HIGHLIGHT_STATE.update(update)
        self._reply(200, {"status": "updated"})

    def log_message(self, *args: Any) -> None:  # keep stdout clean for MCP stdio framing
        pass


def start_bridge() -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), _BridgeHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="studyapp-bridge").start()
    return httpd


if __name__ == "__main__":
    start_bridge()
    mcp.run()
