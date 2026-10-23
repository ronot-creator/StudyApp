"""Phase 1 integration tests: loopback highlight bridge, save_thought_anchor file+SQLite path, quota."""
import json
import shutil
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from src import sandbox, server

REAL_SCHEMA = Path(r"E:\StudyApp\MyFiles\srs_data\schema.sql")

NOTE = (
    "# Renal\n\n"
    "The nephron filters blood.\nIt starts at the glomerulus.\n\n"
    "```\ncode\n\nmore code\n```\n\n"
    "Final paragraph."
)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "MyFiles"
    (root / "vault").mkdir(parents=True)
    (root / "srs_data").mkdir()
    shutil.copy(REAL_SCHEMA, root / "srs_data" / "schema.sql")
    for mod in (sandbox, server):
        monkeypatch.setattr(mod, "SANDBOX_ROOT", root, raising=False)
    for mod in (sandbox, server):
        monkeypatch.setattr(mod, "VAULT_DIR", root / "vault", raising=False)
        monkeypatch.setattr(mod, "SRS_DATA_DIR", root / "srs_data", raising=False)
        monkeypatch.setattr(mod, "DB_PATH", root / "srs_data" / "studyapp_srs.db", raising=False)
    (root / "vault" / "renal.md").write_text(NOTE, encoding="utf-8")
    server._ACTIVE_HIGHLIGHT_STATE.update(active_file="", selected_text="", surrounding_context="")
    return root


@pytest.fixture()
def bridge(monkeypatch):
    monkeypatch.setattr(server, "BRIDGE_PORT", 0)
    httpd = server.start_bridge()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _post(url, payload, raw=None):
    data = raw if raw is not None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req)


def _set_highlight(file, text):
    server._ACTIVE_HIGHLIGHT_STATE.update(active_file=file, selected_text=text, surrounding_context="")


# ---- HTTP bridge ----------------------------------------------------------
def test_bridge_health(bridge, env):
    assert json.load(urllib.request.urlopen(f"{bridge}/health")) == {"status": "ok"}


def test_bridge_updates_highlight_state(bridge, env):
    payload = {"active_file": "renal.md", "selected_text": "glomerulus", "surrounding_context": "ctx"}
    assert _post(f"{bridge}/highlight", payload).status == 200
    assert server.get_active_highlight() == payload
    assert json.load(urllib.request.urlopen(f"{bridge}/highlight")) == payload


def test_bridge_rejects_bad_json_and_unknown_paths(bridge, env):
    with pytest.raises(urllib.error.HTTPError) as e:
        _post(f"{bridge}/highlight", None, raw=b"{not json")
    assert e.value.code == 400
    with pytest.raises(urllib.error.HTTPError) as e:
        _post(f"{bridge}/nope", {"a": 1})
    assert e.value.code == 404


# ---- save_thought_anchor --------------------------------------------------
def test_anchor_injected_below_paragraph_and_recorded(env):
    _set_highlight("renal.md", "It starts at the glomerulus.")
    res = server.save_thought_anchor("a1", "Glomerulus = filtration unit.")
    assert res["status"] == "anchored"

    text = (env / "vault" / "renal.md").read_text(encoding="utf-8")
    para_end = text.index("glomerulus.") + len("glomerulus.")
    assert text[para_end:].startswith("\n\n<!-- thought-anchor:a1 -->")
    assert text.index("<!-- /thought-anchor:a1 -->") < text.index("```")
    assert "> Glomerulus = filtration unit." in text

    with sqlite3.connect(env / "srs_data" / "studyapp_srs.db") as conn:
        row = conn.execute(
            "SELECT a.highlighted_excerpt, a.ai_explanation, d.relative_path "
            "FROM thought_anchors a JOIN vault_documents d ON d.id = a.document_id WHERE a.anchor_id='a1'"
        ).fetchone()
    assert row == ("It starts at the glomerulus.", "Glomerulus = filtration unit.", "renal.md")


def test_anchor_after_fenced_block_when_selecting_inside_it(env):
    _set_highlight("vault/renal.md", "more code")
    server.save_thought_anchor("a2", "note")
    text = (env / "vault" / "renal.md").read_text(encoding="utf-8")
    assert text.index("```\ncode\n\nmore code\n```\n\n<!-- thought-anchor:a2") >= 0


def test_duplicate_anchor_rejected_and_file_unchanged(env):
    _set_highlight("renal.md", "Final paragraph.")
    server.save_thought_anchor("dup", "x")
    before = (env / "vault" / "renal.md").read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        server.save_thought_anchor("dup", "y")
    assert (env / "vault" / "renal.md").read_text(encoding="utf-8") == before


def test_db_failure_rolls_back_file(env, monkeypatch):
    _set_highlight("renal.md", "Final paragraph.")
    original = (env / "vault" / "renal.md").read_text(encoding="utf-8")

    def boom():
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(server, "_db", boom)
    with pytest.raises(sqlite3.OperationalError):
        server.save_thought_anchor("a3", "x")
    assert (env / "vault" / "renal.md").read_text(encoding="utf-8") == original


def test_anchor_requires_highlight_and_valid_id(env):
    with pytest.raises(ValueError):
        server.save_thought_anchor("a4", "x")
    _set_highlight("renal.md", "not in the file at all")
    with pytest.raises(ValueError):
        server.save_thought_anchor("a4", "x")
    with pytest.raises(ValueError):
        server.save_thought_anchor("../bad id", "x")


# ---- sandbox / quota ------------------------------------------------------
def test_sandbox_blocks_escape_and_sibling_prefix(env):
    with pytest.raises(PermissionError):
        sandbox.resolve_sandboxed_path("../MyFiles2/x.md")
    with pytest.raises(PermissionError):
        sandbox.resolve_sandboxed_path("..\\..\\Windows\\x")


def test_quota_blocks_oversized_write(env):
    with pytest.raises(sandbox.QuotaExceededError):
        sandbox.check_disk_quota(10**15)
    with pytest.raises(sandbox.QuotaExceededError):
        sandbox.check_disk_quota(600 * 1024**3)
    sandbox.safe_write_text(env / "vault" / "ok.md", "hi")
    assert (env / "vault" / "ok.md").read_text() == "hi"
