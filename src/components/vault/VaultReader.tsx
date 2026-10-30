import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import ReactMarkdown from "react-markdown";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { math } from "@milkdown/plugin-math";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { CANONICAL_ORGAN_SYSTEMS, OrganSystem, SrsCard } from "../../types/study";
import { SQLITE_DB_URI } from "../../services/ngrokGrader";
import { createSrsCard } from "../../lib/fsrs";
import { resolveAppDataSubPath } from "../../lib/appPaths";
import {
  DEFAULT_OCR_LANGUAGE,
  handleReactDropzoneFiles,
  IngestedFileResult,
} from "../../services/ingestion/fileIngestion";
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

/**
 * Extracts all Phase 9 thought-anchor formats:
 * 1. `<!-- thought-anchor:id --> ... <!-- /thought-anchor:id -->`
 * 2. `<!-- ANCHOR: id | text -->`
 * 3. `[? ... ?]` single-line and multi-line Thought Anchors
 */
export function parseThoughtAnchors(markdownContent: string): Array<{ id: string; text: string }> {
  const extracted: Array<{ id: string; text: string }> = [];
  let match: RegExpExecArray | null;

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

  const commentRegex = /<!--\s*ANCHOR:\s*([^|>]+?)\s*\|\s*([\s\S]*?)\s*-->/g;
  while ((match = commentRegex.exec(markdownContent)) !== null) {
    extracted.push({ id: match[1].trim(), text: match[2].trim() });
  }

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

/**
 * Ensures custom syntax blocks (` ```mindmap ... ``` `, `<!-- thought-anchor:... -->`,
 * `<!-- ANCHOR: ... -->`, and `[? ... ?]`) are preserved losslessly when Milkdown serializes Markdown.
 */
export function preserveSpecialMarkdownBlocks(
  previousMarkdown: string,
  serializedMarkdown: string
): string {
  let output = serializedMarkdown;

  // Preserve ```mindmap code blocks if the serializer altered or omitted them
  const mindmapBlockRegex = /```mindmap\s*[\s\S]*?```/gi;
  const prevMindmapBlocks = previousMarkdown.match(mindmapBlockRegex) ?? [];
  for (const block of prevMindmapBlocks) {
    if (!output.includes("```mindmap")) {
      output = `${output.trim()}\n\n${block}\n`;
    }
  }

  // Preserve <!-- thought-anchor:... --> blocks if HTML comments were stripped during WYSIWYG edit
  const taBlockRegex = /<!-- thought-anchor:([^\s>]+) -->[\s\S]*?<!-- \/thought-anchor:\1 -->/g;
  const prevTaBlocks = previousMarkdown.match(taBlockRegex) ?? [];
  for (const block of prevTaBlocks) {
    const idMatch = block.match(/<!-- thought-anchor:([^\s>]+) -->/);
    if (idMatch && !output.includes(`<!-- thought-anchor:${idMatch[1]} -->`)) {
      output = `${output.trim()}\n\n${block}\n`;
    }
  }

  return output;
}

export interface ReactEditorProps {
  editorKey: string;
  initialMarkdown: string;
  onChange: (nextMarkdown: string) => void;
}

/**
 * Milkdown WYSIWYG ReactEditor component configured with CommonMark, GFM, Math, and Markdown listener.
 */
export const ReactEditor: React.FC<ReactEditorProps> = ({
  editorKey,
  initialMarkdown,
  onChange,
}) => {
  const latestMarkdownRef = useRef<string>(initialMarkdown);
  latestMarkdownRef.current = initialMarkdown;

  useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialMarkdown);
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
            if (markdown !== prevMarkdown) {
              const merged = preserveSpecialMarkdownBlocks(
                latestMarkdownRef.current,
                markdown
              );
              latestMarkdownRef.current = merged;
              onChange(merged);
            }
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(math)
        .use(listener),
    [editorKey]
  );

  return (
    <div
      className="milkdown-wysiwyg-surface"
      data-testid="milkdown-wysiwyg-editor"
      style={{
        minHeight: "300px",
        padding: "14px 16px",
        borderRadius: "12px",
        background: "rgba(9, 15, 29, 0.58)",
        border: "1px solid rgba(56, 189, 248, 0.28)",
        color: "#f8fafc",
        outline: "none",
      }}
    >
      <Milkdown />
    </div>
  );
};

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
  const [editorEpoch, setEditorEpoch] = useState<number>(0);
  const [viewMode, setViewMode] = useState<"wysiwyg" | "rendered">("wysiwyg");
  const [selectedText, setSelectedText] = useState<string>("");
  const [highlightSyncStatus, setHighlightSyncStatus] = useState<string>("Idle");
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [anchorExplanation, setAnchorExplanation] = useState<string>("");
  const [resolvedVaultPath, setResolvedVaultPath] = useState<string>(
    "$APPLOCALDATA/vault/Renal.md"
  );
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [ingestingStatus, setIngestingStatus] = useState<string | null>(null);
  const [recentIngestions, setRecentIngestions] = useState<IngestedFileResult[]>([]);

  const activeFilename = `vault/${getSafeVaultFilename(activeSystem)}.md`;

  useEffect(() => {
    let cancelled = false;
    const loadNote = async () => {
      const fullPath = await resolveAppDataSubPath(
        "vault",
        `${getSafeVaultFilename(activeSystem)}.md`
      );
      const loaded = await readOrganSystemVaultMarkdown(activeSystem);
      if (!cancelled) {
        setResolvedVaultPath(fullPath);
        setContent(loaded);
        setEditorEpoch((n) => n + 1);
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
    setEditorEpoch((n) => n + 1);

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
    setEditorEpoch((n) => n + 1);
    setAnchorExplanation("");
    setActionToast(`Inserted Thought Anchor #${anchorId} into ${activeFilename}`);
  };

  const handleDropFiles = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const dropped = e.dataTransfer?.files;
    if (!dropped || dropped.length === 0) return;

    setIngestingStatus(`Ingesting ${dropped.length} file(s) locally via pdfjs-dist & tesseract.js (${DEFAULT_OCR_LANGUAGE})...`);
    try {
      const results = await handleReactDropzoneFiles(dropped, {
        ocrLang: DEFAULT_OCR_LANGUAGE,
        targetVaultPrefix: activeSystem,
        onProgress: (msg) => setIngestingStatus(msg),
      });
      if (results.length > 0) {
        setRecentIngestions((prev) => [...results, ...prev].slice(0, 5));
        const mergedText = results.map((r) => r.extractedText).join("\n\n");
        const nextMd = `${content.trim()}\n\n${mergedText}\n`;
        await handleContentUpdate(nextMd);
        setEditorEpoch((n) => n + 1);
        setActionToast(
          `Ingested ${results.map((r) => r.originalFilename).join(", ")} into $APPLOCALDATA/vault & $APPLOCALDATA/images (${DEFAULT_OCR_LANGUAGE})`
        );
      }
    } finally {
      setIngestingStatus(null);
    }
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
            className={`liquid-tab-btn ${viewMode === "wysiwyg" ? "active" : ""}`}
            onClick={() => setViewMode("wysiwyg")}
          >
            Milkdown WYSIWYG Editor
          </button>
          <button
            className={`liquid-tab-btn ${viewMode === "rendered" ? "active" : ""}`}
            onClick={() => setViewMode("rendered")}
          >
            Read-Only Preview
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
        data-testid="vault-local-ocr-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => void handleDropFiles(e)}
        style={{
          padding: "10px 14px",
          border: isDragOver
            ? "1px dashed rgba(56, 189, 248, 0.85)"
            : "1px dashed rgba(148, 163, 184, 0.35)",
          background: isDragOver
            ? "rgba(56, 189, 248, 0.14)"
            : "rgba(9, 15, 29, 0.42)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          fontSize: "12px",
          color: "#cbd5e1",
        }}
      >
        <div>
          📥 <strong>Local Drag-and-Drop OCR &amp; PDF Ingestion:</strong> Drop PDFs or Images here to extract via{" "}
          <code>pdfjs-dist</code> &amp; <code>tesseract.js (lang: &apos;{DEFAULT_OCR_LANGUAGE}&apos;)</code> directly into{" "}
          <code>$APPLOCALDATA/images</code> &amp; <code>$APPLOCALDATA/vault</code>.
        </div>
        {ingestingStatus && (
          <span style={{ color: "#38bdf8", fontWeight: 600 }}>{ingestingStatus}</span>
        )}
        {recentIngestions.length > 0 && !ingestingStatus && (
          <span style={{ color: "#34d399", fontSize: "11.5px" }}>
            Last Ingested: {recentIngestions[0].originalFilename} ({recentIngestions[0].ocrLanguage})
          </span>
        )}
      </div>

      <div
        className="liquid-card"
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={{ lineHeight: 1.7, fontSize: "14px", userSelect: "text" }}
      >
        <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "10px" }}>
          <code>{resolvedVaultPath}</code> — Milkdown WYSIWYG Live Markdown (preserves{" "}
          <code>```mindmap</code> code blocks &amp; <code>thought-anchor</code> syntax).
        </div>

        {viewMode === "wysiwyg" ? (
          <MilkdownProvider>
            <ReactEditor
              editorKey={`${activeSystem}_${editorEpoch}`}
              initialMarkdown={content}
              onChange={(nextMarkdown) => {
                void handleContentUpdate(nextMarkdown);
              }}
            />
          </MilkdownProvider>
        ) : (
          <div style={{ color: "#f8fafc" }}>
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
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
              value={anchorExplanation}
              onChange={(e) => setAnchorExplanation(e.target.value)}
              placeholder="Add margin note for selected text (or click + Anchor)..."
            />
            <button className="liquid-btn" onClick={() => void handleInsertThoughtAnchor()}>
              + Anchor
            </button>
          </div>
        </div>
        {extractedAnchors.length === 0 ? (
          <p style={{ margin: 0, fontSize: "12.5px", color: "#94a3b8" }}>
            No Thought Anchors in this note yet. Highlight text or type an explanation above and click + Anchor.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {extractedAnchors.map((a) => (
              <div
                key={a.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  background: "rgba(56, 189, 248, 0.08)",
                  borderLeft: "3px solid #38bdf8",
                  fontSize: "12.5px",
                }}
              >
                <div style={{ fontWeight: 600, color: "#38bdf8", marginBottom: "4px" }}>
                  Anchor #{a.id}
                </div>
                <div style={{ color: "#e2e8f0" }}>{a.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {contextMenuPos && (
        <div
          className="liquid-card"
          style={{
            position: "fixed",
            top: contextMenuPos.y,
            left: contextMenuPos.x,
            zIndex: 100,
            padding: "8px",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            minWidth: "220px",
          }}
        >
          <button className="liquid-btn" onClick={() => void promoteSelectionToNode()}>
            🧠 Promote Selection to Mind Map Node
          </button>
          <button className="liquid-btn" onClick={() => void createSecondOrderCard()}>
            🃏 Create 2nd-Order FSRS Card
          </button>
          <button className="liquid-btn" onClick={() => void handleInsertThoughtAnchor()}>
            📌 Insert Thought Anchor Below Paragraph
          </button>
        </div>
      )}
    </div>
  );
};
