"""
StudyApp Local MCP Server Skeleton
Implements the 5 tool schemas specified in Constitution.md Section 6.
"""
from typing import List, Dict, Any
from mcp.server.fastmcp import FastMCP
from .sandbox import resolve_sandboxed_path, VAULT_DIR

mcp = FastMCP("StudyApp-Local-Bridge")

# In-memory cache updated by the Tauri UI when the user highlights text
_ACTIVE_HIGHLIGHT_STATE: Dict[str, str] = {
    "active_file": "",
    "selected_text": "",
    "surrounding_context": "",
}


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
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"status": "saved", "path": str(target)}


@mcp.tool()
def get_active_highlight() -> Dict[str, str]:
    """Returns the text currently selected by the user in the UI, plus surrounding context."""
    return _ACTIVE_HIGHLIGHT_STATE


@mcp.tool()
def save_thought_anchor(anchor_id: str, explanation: str) -> Dict[str, Any]:
    """Writes a customized AI margin-note back into the active Markdown file."""
    active_file = _ACTIVE_HIGHLIGHT_STATE.get("active_file")
    if not active_file:
        raise ValueError("No active Markdown file is currently registered in the highlight state.")
    target = resolve_sandboxed_path(active_file)
    existing = target.read_text(encoding="utf-8")
    anchor_block = f"\n\n<!-- thought-anchor:{anchor_id} -->\n> **[AI Margin Note #{anchor_id}]:** {explanation}\n<!-- /thought-anchor:{anchor_id} -->\n"
    target.write_text(existing + anchor_block, encoding="utf-8")
    return {"status": "anchored", "anchor_id": anchor_id, "file": str(target)}


if __name__ == "__main__":
    mcp.run()
