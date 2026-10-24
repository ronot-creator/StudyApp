"""
StudyApp Local MCP Server (The Local Bridge)
Implements the 5 constitutional MCP tools + localhost:47821 highlight receiver & SQLite thought_anchors persistence.
"""
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from typing import List, Dict, Any
from mcp.server.fastmcp import FastMCP
from .sandbox import resolve_sandboxed_path, check_disk_quota, SRS_DATA_DIR

mcp = FastMCP("StudyApp-Local-Bridge")

_ACTIVE_HIGHLIGHT_STATE: Dict[str, str] = {
    "active_file": "",
    "selected_text": "",
    "surrounding_context": "",
}


def compute_surgical_insertion_offset(markdown_text: str, selected_text: str) -> int:
    """
    Finds the paragraph or fenced code block containing `selected_text`
    and returns the character offset immediately after that block (or after the closing fence).
    """
    if not selected_text or selected_text not in markdown_text:
        return len(markdown_text)

    match_pos = markdown_text.find(selected_text)
    fence_pattern = re.compile(r"(^```[\s\S]*?^```)", re.MULTILINE)
    for fence_match in fence_pattern.finditer(markdown_text):
        start, end = fence_match.span()
        if start <= match_pos < end:
            return end

    para_end = markdown_text.find("\n\n", match_pos + len(selected_text))
    if para_end == -1:
        return len(markdown_text)
    return para_end


class HighlightBridgeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/highlight":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw)
            _ACTIVE_HIGHLIGHT_STATE["active_file"] = payload.get("active_file", "")
            _ACTIVE_HIGHLIGHT_STATE["selected_text"] = payload.get("selected_text", "")
            _ACTIVE_HIGHLIGHT_STATE["surrounding_context"] = payload.get("surrounding_context", "")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "state": _ACTIVE_HIGHLIGHT_STATE}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        return


def start_highlight_http_bridge(host: str = "127.0.0.1", port: int = 47821) -> HTTPServer:
    server = HTTPServer((host, port), HighlightBridgeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@mcp.tool()
def list_my_files(directory: str = "vault") -> List[str]:
    """Returns array of available local .md, image, and 3D model files inside E:\\StudyApp\\MyFiles\\."""
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
    """Pipes local file text directly into the model's context window."""
    target = resolve_sandboxed_path(filename)
    return target.read_text(encoding="utf-8")


@mcp.tool()
def write_markdown(filename: str, content: str) -> Dict[str, Any]:
    """Saves processed textbook chunks or generated SRS cards directly to the E:\\ drive."""
    encoded = content.encode("utf-8")
    quota = check_disk_quota(len(encoded))
    if not filename.endswith(".md"):
        filename = f"{filename}.md"
    target = resolve_sandboxed_path(f"vault/{filename}" if not filename.startswith("vault") else filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"status": "saved", "path": str(target), "quota": quota}


@mcp.tool()
def get_active_highlight() -> Dict[str, str]:
    """Returns the text currently selected by the user in the UI, plus surrounding context."""
    return dict(_ACTIVE_HIGHLIGHT_STATE)


@mcp.tool()
def save_thought_anchor(anchor_id: str, explanation: str) -> Dict[str, Any]:
    """Writes a customized AI margin-note back into the active Markdown file and SQLite thought_anchors table."""
    active_file = _ACTIVE_HIGHLIGHT_STATE.get("active_file")
    selected_text = _ACTIVE_HIGHLIGHT_STATE.get("selected_text", "")
    if not active_file:
        raise ValueError("No active Markdown file is currently registered in the highlight state.")

    target = resolve_sandboxed_path(active_file)
    existing = target.read_text(encoding="utf-8")
    anchor_block = (
        f"\n\n<!-- thought-anchor:{anchor_id} -->\n"
        f"> **[AI Margin Note #{anchor_id}]:** {explanation}\n"
        f"<!-- /thought-anchor:{anchor_id} -->"
    )
    check_disk_quota(len(anchor_block.encode("utf-8")))
    offset = compute_surgical_insertion_offset(existing, selected_text)
    updated = existing[:offset] + anchor_block + existing[offset:]
    target.write_text(updated, encoding="utf-8")

    db_path = SRS_DATA_DIR / "studyapp_srs.db"
    if db_path.exists():
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO thought_anchors (anchor_id, document_id, highlighted_excerpt, ai_explanation, block_offset)
                VALUES (?, COALESCE((SELECT id FROM vault_documents WHERE relative_path = ? LIMIT 1), 'default_doc'), ?, ?, ?)
                """,
                (anchor_id, active_file, selected_text, explanation, offset),
            )
            conn.commit()

    return {"status": "anchored", "anchor_id": anchor_id, "file": str(target), "offset": offset}


if __name__ == "__main__":
    start_highlight_http_bridge()
    mcp.run()
