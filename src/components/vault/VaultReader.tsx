import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import ReactMarkdown from "react-markdown";
import { CANONICAL_ORGAN_SYSTEMS, OrganSystem, SrsCard } from "../../types/study";
import { SQLITE_DB_URI } from "../../services/ngrokGrader";
import { createSrsCard } from "../../lib/fsrs";
import {
  appendTripleToVaultMarkdown,
  DEFAULT_SYSTEM_VAULT_MARKDOWN,
  getSafeVaultFilename,
  readOrganSystemVaultMarkdown,
  writeOrganSystemVaultMarkdown,
} from "../mindmap/MindMapCanvas";

export interface VaultNoteFile {
  filename: string;
  organSystem: OrganSystem;
  content: string;
}

export const DEFAULT_VAULT_NOTES: VaultNoteFile[] = CANONICAL_ORGAN_SYSTEMS.map((sys) => ({
  filename: `vault/${getSafeVaultFilename(sys)}.md`,
  organSystem: sys,
  content: DEFAULT_SYSTEM_VAULT_MARKDOWN[sys],
}));

export function parseThoughtAnchors(markdownContent: string): Array<{ id: string; text: string }> {
  const extracted: Array<{ id: string; text: string }> = [];
  let match: RegExpExecArray | null;

  // 1. Original margin-note block format: <!-- thought-anchor:id --> ... <!-- /thought-anchor:id -->
  const anchorRegex =
    /<!-- thought-anchor:([^\s>]+) -->\s*> \*\*\[AI Margin Note #[^\]]+\]:?\*\*:?\s*([\s\S]*?)\s*<!-- \/thought-anchor:\1 -->/g;
  while ((match = anchorRegex.exec(markdownContent)) !== null) {
    const cleanText = match[2]
      .split("\n")
      .map((line) => line.replace(/^>\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
    extracted.push({ id: match[1], text: cleanText });
  }

  // 2. Inline HTML comment format: <!-- ANCHOR: id | text -->
  const commentRegex = /<!--\s*ANCHOR:\s*([^|>]+?)\s*\|\s*([\s\S]*?)\s*-->/g;
  while ((match = commentRegex.exec(markdownContent)) !== null) {
    extracted.push({ id: match[1].trim(), text: match[2].trim() });
  }

  // 3. Constitution [? ... ?] single and multi-line Thought Anchors
  const bracketRegex = /\[\?\s*([\s\S]*?)\s*\?\]/g;
  let idx = 0;
  while ((match = bracketRegex.exec(markdownContent)) !== null) {
    idx++;
    const text = match[1].trim();
    if (text && !extracted.some((r) => r.text === text)) {
      extracted.push({ id: `anchor_${idx}`, text });
    }
  }

  return extracted;
}

interface VaultReaderProps {
  onPromoteToMindMapNode?: (organSystem: OrganSystem, selectedLabel: string) => void;
  onCreateFsrsCardFromHighlight?: (organSystem: OrganSystem, excerpt: string) => void;
}

export const VaultReader: React.FC<VaultReaderProps> = ({
  onPromoteToMindMapNode,
  onCreateFsrsCardFromHighlight,
}) => {
  const [activeSystem, setActiveSystem] = useState<OrganSystem>("Renal");
  const [content, setContent] = useState<string>(DEFAULT_SYSTEM_VAULT_MARKDOWN.Renal);
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [selectedText, setSelectedText] = useState<string>("");
  const [highlightSyncStatus, setHighlightSyncStatus] = useState<string>("Idle");
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [anchorExplanation, setAnchorExplanation] = useState<string>("");

  const activeFilename = `vault/${getSafeVaultFilename(activeSystem)}.md`;

  useEffect(() => {
    let cancelled = false;
    const loadNote = async () => {
      const loaded = await readOrganSystemVaultMarkdown(activeSystem);
      if (!cancelled) {
        setContent(loaded);
      }
    };
    void loadNote();
    return () => {
      cancelled = true;
    };
  }, [activeSystem]);

  const handleContentUpdate = async (nextContent: string) => {
    setContent(nextContent);
    await writeOrganSystemVaultMarkdown(activeSystem, nextContent);
  };

  const handleMouseUp = async () => {
    const sel = window.getSelection()?.toString().trim() || "";
    if (!sel) return;
    setSelectedText(sel);

    const matchIdx = content.indexOf(sel);
    const start = Math.max(0, matchIdx - 120);
    const end = Math.min(content.length, matchIdx + sel.length + 120);
    const surrounding = content.slice(start, end);

    try {
      await invoke("update_active_highlight", {
        activeFile: activeFilename,
        selectedText: sel,
        surroundingContext: surrounding,
      });
      setHighlightSyncStatus(`Synced selection (${sel.length} chars) to MCP Bridge :47821`);
    } catch {
      setHighlightSyncStatus(`Selection captured locally (${sel.length} chars)`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString().trim() || selectedText;
    if (!sel) return;
    e.preventDefault();
    setSelectedText(sel);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };

  const promoteSelectionToNode = async () => {
    setContextMenuPos(null);
    if (!selectedText) return;
    const cleanNode = selectedText.replace(/[\[\]\r\n]+/g, " ").trim().slice(0, 64);
    const nodeId = `node_${Date.now()}`;
    const tripleLine = `[${activeSystem} Core Concept] --(regulates physiological mechanism of)--> [${cleanNode}]`;
    const updatedMarkdown = appendTripleToVaultMarkdown(content, tripleLine);
    await handleContentUpdate(updatedMarkdown);

    try {
      const db = await Database.load(SQLITE_DB_URI);
      await db.execute(
        `INSERT OR REPLACE INTO mindmap_nodes (id, organ_system, label, position_x, position_y)
         VALUES ($1, $2, $3, $4, $5)`,
        [nodeId, activeSystem, cleanNode, 180, 160]
      );
    } catch {
      // Safe fallback in browser preview
    }
    onPromoteToMindMapNode?.(activeSystem, cleanNode);
    setActionToast(`Promoted "${cleanNode.slice(0, 48)}" to ${activeSystem} Mind Map`);
  };

  const createSecondOrderCard = async () => {
    setContextMenuPos(null);
    if (!selectedText) return;
    const cardId = `card_${Date.now()}`;
    const newCard: SrsCard = {
      id: cardId,
      organSystem: activeSystem,
      cardType: "written",
      questionOrder: 2,
      frontPrompt: `Explain the 2nd-order physiological mechanism and downstream clinical consequence of: "${selectedText}"`,
      markScheme: selectedText,
      stability: 0,
      difficulty: 5.0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      learningStep: 0,
      dueDate: new Date().toISOString(),
    };
    await createSrsCard(newCard);
    onCreateFsrsCardFromHighlight?.(activeSystem, selectedText);
    setActionToast(`Created 2nd-Order FSRS Written Card (${cardId})`);
  };

  const handleInsertThoughtAnchor = async () => {
    if (!selectedText.trim() && !anchorExplanation.trim()) return;
    const anchorId = `ta_${activeSystem.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Date.now().toString(36).slice(-4)}`;
    const bodyText =
      anchorExplanation.trim() ||
      `High-yield clinical correlation for "${selectedText.slice(0, 60) || activeSystem}": verify autoregulatory feedback and downstream end-organ perfusion.`;
    const anchorBlock = `\n\n<!-- thought-anchor:${anchorId} -->\n> **[AI Margin Note #${anchorId}]:** ${bodyText}\n<!-- /thought-anchor:${anchorId} -->`;
    await handleContentUpdate(`${content.trim()}${anchorBlock}\n`);
    setAnchorExplanation("");
    setActionToast(`Inserted Thought Anchor #${anchorId} into ${activeFilename}`);
  };

  const extractedAnchors = parseThoughtAnchors(content);

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "14px" }}
      onClick={() => setContextMenuPos(null)}
    >
      <div
        className="liquid-card"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <label style={{ fontSize: "12.5px", color: "#94a3b8" }}>Vault Organ System:</label>
          <select
            className="liquid-select"
            style={{ width: "210px" }}
            value={activeSystem}
            onChange={(e) => setActiveSystem(e.target.value as OrganSystem)}
          >
            {CANONICAL_ORGAN_SYSTEMS.map((sys) => (
              <option key={sys} value={sys}>
                {sys} ({getSafeVaultFilename(sys)}.md)
              </option>
            ))}
          </select>

          <button
            className={`liquid-tab-btn ${viewMode === "rendered" ? "active" : ""}`}
            onClick={() => setViewMode("rendered")}
          >
            Rendered Reader
          </button>
          <button
            className={`liquid-tab-btn ${viewMode === "raw" ? "active" : ""}`}
            onClick={() => setViewMode("raw")}
          >
            Dual-Syntax Editor
          </button>
        </div>
        <span style={{ fontSize: "11.5px", color: "#38bdf8" }}>{highlightSyncStatus}</span>
      </div>

      {actionToast && (
        <div
          className="liquid-card"
          style={{
            padding: "9px 14px",
            fontSize: "12.5px",
            borderColor: "rgba(56, 189, 248, 0.45)",
            background: "rgba(56, 189, 248, 0.12)",
          }}
        >
          {actionToast}
        </div>
      )}

      {selectedText && (
        <div
          className="liquid-card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: "12px", color: "#cbd5e1", flex: 1 }}>
            Active Highlight: <strong>&ldquo;{selectedText.slice(0, 90)}&rdquo;</strong>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="liquid-btn" onClick={() => void promoteSelectionToNode()}>
              🧠 Promote to Mind Map
            </button>
            <button className="liquid-btn" onClick={() => void createSecondOrderCard()}>
              🃏 Create 2nd-Order FSRS Card
            </button>
          </div>
        </div>
      )}

      <div
        className="liquid-card"
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={{ lineHeight: 1.7, fontSize: "14px", userSelect: "text" }}
      >
        <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "10px" }}>
          <code>E:\StudyApp\MyFiles\{activeFilename}</code> — Highlight text to sync with MCP{" "}
          <code>get_active_highlight()</code> or right-click for instant promotion.
        </div>

        {viewMode === "rendered" ? (
          <div style={{ color: "#f8fafc" }}>
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            className="liquid-textarea"
            rows={12}
            value={content}
            onChange={(e) => void handleContentUpdate(e.target.value)}
          />
        )}
      </div>

      <div className="liquid-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", gap: "8px", flexWrap: "wrap" }}>
          <h4 style={{ margin: 0, fontSize: "13px", color: "#38bdf8" }}>
            Anchored AI Margin Notes (<code>thought_anchors</code>)
          </h4>
          <div style={{ display: "flex", gap: "8px", flex: 1, maxWidth: "520px" }}>
            <input
              className="liquid-input"
              placeholder="Add clinical margin note for current selection or note..."
              value={anchorExplanation}
              onChange={(e) => setAnchorExplanation(e.target.value)}
            />
            <button className="liquid-btn" onClick={() => void handleInsertThoughtAnchor()}>
              + Anchor Note
            </button>
          </div>
        </div>
        {extractedAnchors.length === 0 ? (
          <div style={{ fontSize: "12px", color: "#64748b" }}>
            No inline thought anchors in this document yet. Add one above or via MCP{" "}
            <code>save_thought_anchor()</code>.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {extractedAnchors.map((a) => (
              <div
                key={a.id}
                className="liquid-interactive-tile"
                style={{
                  padding: "10px 12px",
                  borderRadius: "9px",
                  background: "rgba(56, 189, 248, 0.1)",
                  borderLeft: "3px solid #38bdf8",
                  fontSize: "13px",
                }}
              >
                <strong>#{a.id}:</strong> {a.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenuPos && (
        <div
          className="liquid-context-menu"
          style={{ left: `${contextMenuPos.x}px`, top: `${contextMenuPos.y}px` }}
        >
          <button className="liquid-context-item" onClick={() => void promoteSelectionToNode()}>
            🧠 Promote Selection to Mind Map Node
          </button>
          <button className="liquid-context-item" onClick={() => void createSecondOrderCard()}>
            🃏 Create 2nd-Order FSRS Card
          </button>
        </div>
      )}
    </div>
  );
};
