"""
Convergence Local MCP Sidecar Server (The Local Bridge)
Dynamically targets OS $APPLOCALDATA (vault, images, srs_data) and exposes the 5 MCP tools
plus HTTP/MCP endpoints on localhost:1420/mcp and 127.0.0.1:47821/highlight.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    try:
        from mcp.server.mcpserver import MCPServer as FastMCP
    except ImportError:
        class FastMCP:  # type: ignore[no-redef]
            def __init__(self, name: str):
                self.name = name
            def tool(self):
                def decorator(fn):
                    return fn
                return decorator
            def run(self):
                pass

try:
    from . import sandbox as _sandbox
    from .sandbox import (
        resolve_sandboxed_path,
        check_disk_quota,
        safe_write_text,
        ensure_appdata_directories,
    )
except ImportError:
    import src.sandbox as _sandbox  # type: ignore[no-redef]
    from src.sandbox import (  # type: ignore[no-redef]
        resolve_sandboxed_path,
        check_disk_quota,
        safe_write_text,
        ensure_appdata_directories,
    )

mcp = FastMCP("Convergence-Local-Bridge")

BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = int(os.environ.get("STUDYAPP_BRIDGE_PORT", "47821"))
SIDECAR_PORT = int(os.environ.get("MCP_SIDECAR_PORT", "1420"))
_MAX_BODY_BYTES = 1024 * 1024

_STATE_LOCK = threading.Lock()
_ACTIVE_HIGHLIGHT_STATE: Dict[str, str] = {
    "active_file": "",
    "selected_text": "",
    "surrounding_context": "",
}
_HIGHLIGHT_KEYS = tuple(_ACTIVE_HIGHLIGHT_STATE)


def _db() -> sqlite3.Connection:
    """Opens studyapp_srs.db inside $APPLOCALDATA/srs_data, creating it from schema.sql on first use."""
    ensure_appdata_directories(_sandbox.SANDBOX_ROOT)
    srs_dir = Path(getattr(_sandbox, "SRS_DATA_DIR", Path(_sandbox.SANDBOX_ROOT) / "srs_data"))
    db_path = Path(getattr(_sandbox, "DB_PATH", srs_dir / "studyapp_srs.db"))
    srs_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    has_schema = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='thought_anchors'"
    ).fetchone()
    if not has_schema:
        schema = srs_dir / "schema.sql"
        if schema.exists():
            conn.executescript(schema.read_text(encoding="utf-8"))
    return conn


def _resolve_markdown(active_file: str) -> Path:
    """Resolves a file name from the UI (with or without 'vault/' prefix) inside the dynamic AppData sandbox."""
    candidate = resolve_sandboxed_path(active_file)
    if not candidate.exists() and not active_file.replace("\\", "/").startswith("vault/"):
        candidate = resolve_sandboxed_path(f"vault/{active_file}")
    if not candidate.is_file():
        raise FileNotFoundError(f"Active Markdown file not found: {active_file}")
    return candidate


_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")


def markdown_blocks(text: str) -> List[Tuple[int, int]]:
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
    blocks = markdown_blocks(text)
    idx = text.find(excerpt)
    if idx >= 0:
        last_char = idx + len(excerpt) - 1
        for s, e in blocks:
            if s <= last_char <= e:
                return e
    target = _norm(excerpt)
    if target:
        for s, e in blocks:
            if target in _norm(text[s:e]):
                return e
    raise ValueError("Highlighted text could not be located in the active Markdown file.")


def compute_surgical_insertion_offset(markdown_text: str, selected_text: str) -> int:
    try:
        return find_anchor_insert_offset(markdown_text, selected_text)
    except ValueError:
        return len(markdown_text)


@mcp.tool()
def list_my_files(directory: str = "vault") -> List[str]:
    """Returns array of available local .md, image, and 3D model files inside $APPLOCALDATA."""
    target_dir = resolve_sandboxed_path(directory)
    if not target_dir.exists():
        return []
    allowed_exts = {".md", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".glb", ".gltf", ".json"}
    return [
        str(p.relative_to(target_dir))
        for p in target_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in allowed_exts
    ]


@mcp.tool()
def read_file(filename: str) -> str:
    """Pipes local file text from $APPLOCALDATA directly into the model's context window."""
    target = _resolve_markdown(filename) if filename.endswith(".md") else resolve_sandboxed_path(filename)
    return target.read_text(encoding="utf-8")


@mcp.tool()
def write_markdown(filename: str, content: str, organ_system: str = "General") -> Dict[str, Any]:
    """Saves processed textbook chunks or generated SRS cards directly to $APPLOCALDATA/vault."""
    if not filename.endswith(".md"):
        filename = f"{filename}.md"
    rel_arg = f"vault/{filename}" if not filename.replace("\\", "/").startswith("vault") else filename
    target = safe_write_text(rel_arg, content)
    quota = check_disk_quota(0)

    try:
        vault_dir = Path(getattr(_sandbox, "VAULT_DIR", Path(_sandbox.SANDBOX_ROOT) / "vault"))
        rel = target.relative_to(vault_dir).as_posix()
    except ValueError:
        rel = target.name
    document_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]
    checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()

    try:
        with _db() as conn:
            conn.execute(
                """
                INSERT INTO vault_documents (id, organ_system, relative_path, checksum_sha256)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(relative_path) DO UPDATE SET
                    organ_system = excluded.organ_system,
                    checksum_sha256 = excluded.checksum_sha256,
                    updated_at = datetime('now')
                """,
                (document_id, organ_system, rel, checksum),
            )
    except Exception:
        pass

    return {"status": "saved", "path": str(target), "quota": quota}


@mcp.tool()
def get_active_highlight() -> Dict[str, str]:
    """Returns the text currently selected by the user in the UI, plus surrounding context."""
    with _STATE_LOCK:
        return dict(_ACTIVE_HIGHLIGHT_STATE)


@mcp.tool()
def save_thought_anchor(anchor_id: str, explanation: str) -> Dict[str, Any]:
    """Writes a customized AI margin-note into the active Markdown file in $APPLOCALDATA/vault."""
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", anchor_id):
        raise ValueError("anchor_id must be 1-64 chars of [A-Za-z0-9_-].")
    with _STATE_LOCK:
        active_file = _ACTIVE_HIGHLIGHT_STATE.get("active_file", "")
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
        f"> **[AI Margin Note #{anchor_id}]:** {explanation.strip()}\n"
        f"{note}\n"
        f"<!-- /thought-anchor:{anchor_id} -->"
    )
    updated = original[:offset] + anchor_block + original[offset:]

    vault_dir = Path(getattr(_sandbox, "VAULT_DIR", Path(_sandbox.SANDBOX_ROOT) / "vault"))
    try:
        rel = target.relative_to(vault_dir).as_posix()
    except ValueError:
        rel = target.name
    document_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]

    safe_write_text(target, updated)
    try:
        with _db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO vault_documents (id, organ_system, relative_path) VALUES (?, 'Unclassified', ?)",
                (document_id, rel),
            )
            row = conn.execute("SELECT id FROM vault_documents WHERE relative_path = ?", (rel,)).fetchone()
            conn.execute(
                "INSERT INTO thought_anchors (anchor_id, document_id, highlighted_excerpt, ai_explanation, block_offset) "
                "VALUES (?, ?, ?, ?, ?)",
                (anchor_id, row[0], excerpt, explanation, offset),
            )
    except Exception:
        target.write_text(original, encoding="utf-8")
        raise
    return {
        "status": "anchored",
        "anchor_id": anchor_id,
        "file": str(target),
        "offset": offset,
        "inserted_at_offset": offset,
    }


class _BridgeHandler(BaseHTTPRequestHandler):
    def _reply(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
        elif self.path == "/mcp":
            self._reply(200, {
                "status": "ok",
                "server": "Convergence-Local-Bridge",
                "endpoint": "http://localhost:1420/mcp",
                "app_local_data_dir": str(_sandbox.SANDBOX_ROOT),
                "tools": [
                    "list_my_files",
                    "read_file",
                    "write_markdown",
                    "get_active_highlight",
                    "save_thought_anchor",
                ],
            })
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
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("Payload must be a JSON object")
            update = {k: str(data.get(k, "")) for k in _HIGHLIGHT_KEYS}
        except (ValueError, TypeError, AttributeError):
            return self._reply(400, {"error": "invalid JSON"})
        with _STATE_LOCK:
            _ACTIVE_HIGHLIGHT_STATE.update(update)
        self._reply(200, {"status": "updated", "state": dict(_ACTIVE_HIGHLIGHT_STATE)})

    def log_message(self, *args: Any) -> None:
        pass


HighlightBridgeHandler = _BridgeHandler


def start_bridge(host: str = BRIDGE_HOST, port: Optional[int] = None) -> ThreadingHTTPServer:
    actual_port = BRIDGE_PORT if port is None else port
    httpd = ThreadingHTTPServer((host, actual_port), _BridgeHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="convergence-bridge").start()
    return httpd


start_highlight_http_bridge = start_bridge


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Convergence Local MCP Sidecar")
    parser.add_argument("--sidecar", action="store_true", help="Run as bundled Tauri sidecar")
    parser.add_argument("--port", type=int, default=SIDECAR_PORT, help="Port to bind MCP HTTP endpoint")
    args, _ = parser.parse_known_args()

    ensure_appdata_directories(_sandbox.SANDBOX_ROOT)
    start_bridge()
    if args.sidecar:
        try:
            sidecar_httpd = start_bridge(host=BRIDGE_HOST, port=args.port)
        except OSError:
            pass
    mcp.run()
