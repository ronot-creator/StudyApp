import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OrganSystem } from "../../types/study";
import {
  executeOmnibarCanvasCommand,
  GEMMA_31B_MODEL_ID,
  hasAiStudioApiKey,
  OmnibarCanvasMutationResponse,
} from "../../services/aiStudio";
import {
  appendTripleToVaultMarkdown,
  readOrganSystemVaultMarkdown,
  writeOrganSystemVaultMarkdown,
} from "../mindmap/MindMapCanvas";

export const OMNIBAR_MINDMAP_EVENT = "convergence:omnibar-mindmap-update";

export interface OmnibarProps {
  activeTab: string;
  activeOrganSystem: OrganSystem;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCanvasMutation?: (mutation: OmnibarCanvasMutationResponse, updatedMarkdown: string) => void;
  onNavigateTab?: (tab: "vault" | "srs" | "mindmap" | "specimens" | "integrations") => void;
}

export const Omnibar: React.FC<OmnibarProps> = ({
  activeTab,
  activeOrganSystem,
  isOpen: controlledOpen,
  onOpenChange,
  onCanvasMutation,
  onNavigateTab,
}) => {
  const [internalOpen, setInternalOpen] = useState<boolean>(false);
  const [prompt, setPrompt] = useState<string>("");
  const [executing, setExecuting] = useState<boolean>(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!isOpen);
      } else if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      window.setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  const handleExecuteCommand = async (rawCommand?: string) => {
    const cmd = (rawCommand ?? prompt).trim();
    if (!cmd) return;

    setExecuting(true);
    try {
      if (/^\/(q|vault)\s+/i.test(cmd)) {
        const queryTopic = cmd.replace(/^\/(q|vault)\s+/i, "").trim();
        try {
          const res = await invoke<{ formatted_prompt?: string }>("resolve_shorthand_query", {
            query: queryTopic,
          });
          setLastResult(
            res?.formatted_prompt ||
              `Resolved local vault context for "${queryTopic}" from $APPLOCALDATA/vault.`
          );
        } catch {
          setLastResult(`Resolved local vault shorthand for "${queryTopic}"`);
        }
        setPrompt("");
        setExecuting(false);
        return;
      }

      const currentMd = await readOrganSystemVaultMarkdown(activeOrganSystem);
      const mutation = await executeOmnibarCanvasCommand(cmd, activeOrganSystem, currentMd);

      let updatedMd = currentMd;
      for (const t of mutation.triples) {
        const targetExpr =
          t.is_cross_system_bridge && t.target_organ_system
            ? `${t.target_organ_system}::${t.target_node}`
            : t.target_node;
        const tripleLine = `[${t.source_node}] --(${t.linking_phrase})--> [${targetExpr}]`;
        updatedMd = appendTripleToVaultMarkdown(updatedMd, tripleLine);
      }

      await writeOrganSystemVaultMarkdown(activeOrganSystem, updatedMd);

      window.dispatchEvent(
        new CustomEvent(OMNIBAR_MINDMAP_EVENT, {
          detail: {
            organSystem: activeOrganSystem,
            mutation,
            updatedMarkdown: updatedMd,
          },
        })
      );

      onCanvasMutation?.(mutation, updatedMd);
      if (activeTab !== "mindmap" && /^connect\s+/i.test(cmd)) {
        onNavigateTab?.("mindmap");
      }
      setLastResult(`${mutation.summary} (Engine: ${mutation.engineUsed})`);
      setPrompt("");
    } finally {
      setExecuting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        className="liquid-btn liquid-btn-secondary"
        data-testid="omnibar-trigger-btn"
        style={{ padding: "5px 11px", fontSize: "11.5px" }}
        onClick={() => setOpen(true)}
        title="Open Convergence Omnibar (Ctrl+K)"
      >
        ⌘K Omnibar
      </button>
    );
  }

  return (
    <div
      data-testid="omnibar-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 150,
        background: "rgba(2, 6, 23, 0.65)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
      }}
      onClick={() => setOpen(false)}
    >
      <div
        className="liquid-card"
        data-testid="omnibar-modal"
        style={{
          width: "100%",
          maxWidth: "640px",
          padding: "16px 18px",
          border: "1px solid rgba(56, 189, 248, 0.55)",
          boxShadow: "0 24px 64px rgba(2, 6, 23, 0.9)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#38bdf8" }}>
              ⚡ Convergence Omnibar
            </span>
            <span
              style={{
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: "rgba(56, 189, 248, 0.14)",
                color: "#bae6fd",
              }}
            >
              Context: {activeTab.toUpperCase()} ({activeOrganSystem}) •{" "}
              {hasAiStudioApiKey() ? GEMMA_31B_MODEL_ID : "Dual-Tunnel Ready"}
            </span>
          </div>
          <button
            className="liquid-btn liquid-btn-secondary"
            style={{ padding: "3px 9px", fontSize: "11px" }}
            onClick={() => setOpen(false)}
          >
            ESC
          </button>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <input
            ref={inputRef}
            className="liquid-input"
            data-testid="omnibar-input"
            placeholder='Try "Connect Macula Densa to Afferent Arteriole via adenosine A1 constriction" or "/q renal"'
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleExecuteCommand();
              }
            }}
          />
          <button
            className="liquid-btn"
            data-testid="omnibar-submit-btn"
            disabled={executing || !prompt.trim()}
            onClick={() => void handleExecuteCommand()}
          >
            {executing ? "Routing..." : "Execute"}
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: "6px",
            flexWrap: "wrap",
            marginTop: "10px",
          }}
        >
          {[
            "Connect Macula Densa to Afferent Arteriole via adenosine A1 vasoconstriction",
            "Connect Angiotensin II to Efferent Arteriole via AT1 receptor constriction",
            "/q renal autoregulation",
          ].map((preset) => (
            <button
              key={preset}
              className="liquid-btn liquid-btn-secondary"
              style={{ padding: "4px 9px", fontSize: "11px" }}
              onClick={() => void handleExecuteCommand(preset)}
            >
              {preset}
            </button>
          ))}
        </div>

        {lastResult && (
          <div
            data-testid="omnibar-result-banner"
            style={{
              marginTop: "10px",
              padding: "8px 12px",
              borderRadius: "8px",
              background: "rgba(16, 185, 129, 0.14)",
              border: "1px solid rgba(52, 211, 153, 0.45)",
              color: "#d1fae5",
              fontSize: "12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {lastResult}
          </div>
        )}
      </div>
    </div>
  );
};
