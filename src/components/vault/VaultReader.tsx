import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { OrganSystem } from "../../types/study";
import { SQLITE_DB_URI } from "../../services/ngrokGrader";

export interface VaultNoteFile {
  filename: string;
  organSystem: OrganSystem;
  content: string;
}

export const DEFAULT_VAULT_NOTES: VaultNoteFile[] = [
  {
    filename: "vault/Renal.md",
    organSystem: "Renal",
    content: `# Glomerular Filtration & Tubuloglomerular Feedback (TGF)

The renal corpuscle regulates glomerular filtration rate (GFR) across a wide range of systemic arterial pressures (80–180 mmHg) via myogenic autoregulation and tubuloglomerular feedback.

\`\`\`mindmap
[Macula Densa NaCl Delivery] --(triggers adenosine A1 receptor vasoconstriction of)--> [Afferent Arteriole]
[Afferent Arteriole] --(lowers hydrostatic pressure inside)--> [Glomerular Capillaries]
[Juxtaglomerular Granular Cells] --(secrete renin in response to beta-1 and low NaCl to generate)--> [Angiotensin II]
[Angiotensin II] --(preferentially constricts AT1 receptors on)--> [Efferent Arteriole]
[Angiotensin II] --(increases systemic arterial afterload and venous return in)--> [Cardiovascular::Left Ventricular Preload]
\`\`\`

<!-- thought-anchor:ta_renal_01 -->
> **[AI Margin Note #ta_renal_01]:** In bilateral renal artery stenosis, glomerular hydrostatic pressure is critically dependent on Angiotensin II-mediated efferent arteriolar tone. Starting an ACE inhibitor removes this constriction and causes an acute rise in serum creatinine.
<!-- /thought-anchor:ta_renal_01 -->`,
  },
  {
    filename: "vault/Cardiovascular.md",
    organSystem: "Cardiovascular",
    content: `# Ventricular-Vascular Coupling & Frank-Starling Law

Sarcomere length-tension dependence increases stroke volume in response to elevated end-diastolic volume via heightened troponin C calcium sensitivity.

\`\`\`mindmap
[Left Ventricular End-Diastolic Volume] --(stretches sarcomeres to increase Ca2+ sensitivity and)--> [Stroke Volume]
[Sympathetic Beta-1 Stimulation] --(accelerates SERCA2a phospholamban phosphorylation in)--> [Lusitropic Relaxation]
[Stroke Volume] --(augments mean arterial perfusion pressure delivered to)--> [Renal::Renal Artery Perfusion]
\`\`\``,
  },
];

interface VaultReaderProps {
  onPromoteToMindMapNode?: (organSystem: OrganSystem, selectedLabel: string) => void;
  onCreateFsrsCardFromHighlight?: (organSystem: OrganSystem, excerpt: string) => void;
}

export const VaultReader: React.FC<VaultReaderProps> = ({
  onPromoteToMindMapNode,
  onCreateFsrsCardFromHighlight,
}) => {
  const [notes] = useState<VaultNoteFile[]>(DEFAULT_VAULT_NOTES);
  const [activeNoteIdx, setActiveNoteIdx] = useState<number>(0);
  const [selectedText, setSelectedText] = useState<string>("");
  const [highlightSyncStatus, setHighlightSyncStatus] = useState<string>("Idle");
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);

  const activeNote = notes[activeNoteIdx];

  const handleMouseUp = async () => {
    const sel = window.getSelection()?.toString().trim() || "";
    if (!sel) return;
    setSelectedText(sel);

    const matchIdx = activeNote.content.indexOf(sel);
    const start = Math.max(0, matchIdx - 120);
    const end = Math.min(activeNote.content.length, matchIdx + sel.length + 120);
    const surrounding = activeNote.content.slice(start, end);

    try {
      await invoke("update_active_highlight", {
        activeFile: activeNote.filename,
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
    const nodeId = `node_${Date.now()}`;
    try {
      const db = await Database.load(SQLITE_DB_URI);
      await db.execute(
        `INSERT OR REPLACE INTO mindmap_nodes (id, organ_system, label, position_x, position_y)
         VALUES ($1, $2, $3, $4, $5)`,
        [nodeId, activeNote.organSystem, selectedText.slice(0, 80), 180, 160]
      );
    } catch {
      // Safe fallback in browser preview
    }
    onPromoteToMindMapNode?.(activeNote.organSystem, selectedText.slice(0, 80));
    setActionToast(`Promoted "${selectedText.slice(0, 48)}" to ${activeNote.organSystem} Mind Map`);
  };

  const createSecondOrderCard = async () => {
    setContextMenuPos(null);
    if (!selectedText) return;
    const cardId = `card_${Date.now()}`;
    try {
      const db = await Database.load(SQLITE_DB_URI);
      await db.execute(
        `INSERT INTO srs_cards
         (id, organ_system, card_type, question_order, front_prompt, mark_scheme, due_date)
         VALUES ($1, $2, 'written', 2, $3, $4, datetime('now'))`,
        [
          cardId,
          activeNote.organSystem,
          `Explain the 2nd-order physiological mechanism and downstream clinical consequence of: "${selectedText}"`,
          selectedText,
        ]
      );
    } catch {
      // Safe fallback in browser preview
    }
    onCreateFsrsCardFromHighlight?.(activeNote.organSystem, selectedText);
    setActionToast(`Created 2nd-Order FSRS Written Card (${cardId}) in SQLite`);
  };

  // Parse inline thought anchors for visual margin-note cards
  const anchorRegex =
    /<!-- thought-anchor:([^\s]+) -->\s*> \*\*\[AI Margin Note #[^\]]+\]:\*\* ([\s\S]*?)\s*<!-- \/thought-anchor:\1 -->/g;
  const extractedAnchors: Array<{ id: string; text: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(activeNote.content)) !== null) {
    extractedAnchors.push({ id: match[1], text: match[2].trim() });
  }

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "14px" }}
      onClick={() => setContextMenuPos(null)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "8px" }}>
          {notes.map((n, idx) => (
            <button
              key={n.filename}
              className={`liquid-tab-btn ${idx === activeNoteIdx ? "active" : ""}`}
              onClick={() => setActiveNoteIdx(idx)}
            >
              {n.organSystem}: {n.filename.replace("vault/", "")}
            </button>
          ))}
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

      <div
        className="liquid-card"
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={{ lineHeight: 1.7, fontSize: "14px", userSelect: "text" }}
      >
        <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "10px" }}>
          <code>E:\StudyApp\MyFiles\{activeNote.filename}</code> — Highlight text to sync with MCP{" "}
          <code>get_active_highlight()</code> or right-click for actions.
        </div>

        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontFamily: "inherit",
            margin: 0,
            color: "#f8fafc",
          }}
        >
          {activeNote.content}
        </pre>
      </div>

      {extractedAnchors.length > 0 && (
        <div className="liquid-card">
          <h4 style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#38bdf8" }}>
            Anchored AI Margin Notes (<code>thought_anchors</code>)
          </h4>
          {extractedAnchors.map((a) => (
            <div
              key={a.id}
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

      {contextMenuPos && (
        <div
          className="liquid-context-menu"
          style={{ left: `${contextMenuPos.x}px`, top: `${contextMenuPos.y}px` }}
        >
          <button className="liquid-context-item" onClick={promoteSelectionToNode}>
            🧠 Promote Selection to Mind Map Node
          </button>
          <button className="liquid-context-item" onClick={createSecondOrderCard}>
            🃏 Create 2nd-Order FSRS Card
          </button>
        </div>
      )}
    </div>
  );
};
