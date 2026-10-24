import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./styles/liquid-glass.css";
import { AiProviderId, CANONICAL_ORGAN_SYSTEMS, OrganSystem } from "./types/study";
import { TunnelStatus } from "./components/TunnelStatus";
import { VaultReader } from "./components/vault/VaultReader";
import { FsrsRunner } from "./components/srs/FsrsRunner";
import { MindMapCanvas } from "./components/mindmap/MindMapCanvas";
import {
  DEFAULT_CURATED_REPOSITORIES,
  SourcedMedicalAsset,
  SpecimenModality,
  specimenSourcingService,
} from "./services/ingestion/specimenSourcing";

type WorkspaceTab = "vault" | "srs" | "mindmap" | "specimens";

const AI_PROVIDERS: Array<{ id: AiProviderId; label: string }> = [
  { id: "gemini", label: "Gemini" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "notebooklm", label: "NotebookLM" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("vault");
  const [activeAiProvider, setActiveAiProvider] = useState<AiProviderId>("gemini");
  const [detachedProviders, setDetachedProviders] = useState<Record<string, boolean>>({});
  const [aiPanelStatusText, setAiPanelStatusText] = useState<string>(
    "Warm-1 Native WebView Pool Ready (persist:study_session)"
  );

  // Split-pane geometry state (percentage of viewport width for Left Study Workspace)
  const [leftWidthPct, setLeftWidthPct] = useState<number>(56);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  // Specimen & 3D Sourcing Tab state
  const [specimenSystem, setSpecimenSystem] = useState<OrganSystem>("Renal");
  const [specimenQuery, setSpecimenQuery] = useState<string>("Renal corpuscle PAS histology");
  const [specimenModality, setSpecimenModality] = useState<SpecimenModality>("histology_slide");
  const [sourcedAssets, setSourcedAssets] = useState<SourcedMedicalAsset[]>([]);
  const [isSourcing, setIsSourcing] = useState<boolean>(false);

  const computeRightPaneBounds = () => {
    const el = rightPaneRef.current;
    if (!el) {
      const winW = window.innerWidth || 1600;
      const winH = window.innerHeight || 960;
      const x = Math.round((winW * leftWidthPct) / 100) + 6;
      return { x, y: 104, width: Math.max(360, winW - x), height: Math.max(400, winH - 104) };
    }
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + 48), // Below the 48px docked AI toolbar
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(320, Math.round(rect.height - 48)),
    };
  };

  const handleSwitchAiProvider = async (provider: AiProviderId) => {
    setActiveAiProvider(provider);
    const bounds = computeRightPaneBounds();
    try {
      await invoke("switch_active_ai_panel", {
        provider,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      setAiPanelStatusText(
        `Docked ${provider.toUpperCase()} in Warm-1 Pool (${bounds.width}×${bounds.height})`
      );
    } catch {
      setAiPanelStatusText(
        `Selected ${provider.toUpperCase()} (Native WebView2 binds at runtime on Windows E:\)`
      );
    }
  };

  const handleToggleDetachRedock = async () => {
    const isCurrentlyDetached = Boolean(detachedProviders[activeAiProvider]);
    if (!isCurrentlyDetached) {
      try {
        await invoke("detach_ai_panel", { provider: activeAiProvider });
      } catch {
        // Safe preview fallback
      }
      setDetachedProviders((prev) => ({ ...prev, [activeAiProvider]: true }));
      setAiPanelStatusText(`Detached ${activeAiProvider.toUpperCase()} into floating native window`);
    } else {
      const bounds = computeRightPaneBounds();
      try {
        await invoke("redock_ai_panel", {
          provider: activeAiProvider,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        });
      } catch {
        // Safe preview fallback
      }
      setDetachedProviders((prev) => ({ ...prev, [activeAiProvider]: false }));
      setAiPanelStatusText(`Re-docked ${activeAiProvider.toUpperCase()} into split-pane`);
    }
  };

  // Dragging split resizer syncs native docked WebView bounds
  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const pct = Math.min(78, Math.max(32, (e.clientX / window.innerWidth) * 100));
      setLeftWidthPct(pct);
    };
    const onUp = async () => {
      setIsDraggingSplit(false);
      const bounds = computeRightPaneBounds();
      try {
        await invoke("resize_docked_ai_panel", bounds);
      } catch {
        // Safe preview fallback
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDraggingSplit, leftWidthPct]);

  const handleRunSpecimenSourcing = async () => {
    if (!specimenQuery.trim()) return;
    setIsSourcing(true);
    try {
      const found = await specimenSourcingService.searchAndRegisterSpecimens(
        specimenSystem,
        specimenQuery,
        specimenModality
      );
      setSourcedAssets((prev) => [...found, ...prev]);
    } finally {
      setIsSourcing(false);
    }
  };

  return (
    <div className="liquid-shell">
      {/* Top Navigation & Tunnel Telemetry Bar */}
      <header className="liquid-topbar">
        <div className="liquid-brand">
          <span style={{ fontWeight: 700, fontSize: "16px", color: "#f8fafc" }}>
            StudyApp
          </span>
          <span className="liquid-brand-badge">E:\StudyApp\MyFiles Sandbox</span>
        </div>

        <nav className="liquid-nav-tabs">
          <button
            className={`liquid-tab-btn ${activeTab === "vault" ? "active" : ""}`}
            onClick={() => setActiveTab("vault")}
          >
            1. Vault &amp; Thought Anchors
          </button>
          <button
            className={`liquid-tab-btn ${activeTab === "srs" ? "active" : ""}`}
            onClick={() => setActiveTab("srs")}
          >
            2. Tolerant FSRS &amp; Occlusion
          </button>
          <button
            className={`liquid-tab-btn ${activeTab === "mindmap" ? "active" : ""}`}
            onClick={() => setActiveTab("mindmap")}
          >
            3. Organ-System Mind Maps
          </button>
          <button
            className={`liquid-tab-btn ${activeTab === "specimens" ? "active" : ""}`}
            onClick={() => setActiveTab("specimens")}
          >
            4. Specimen &amp; 3D Sourcing
          </button>
        </nav>

        <TunnelStatus />
      </header>

      {/* Split-Pane Main Workspace */}
      <div className="liquid-split-workspace">
        {/* Left Pane: Local-First Study Modules */}
        <section className="liquid-left-pane" style={{ width: `${leftWidthPct}%` }}>
          {activeTab === "vault" && (
            <VaultReader
              onPromoteToMindMapNode={() => setActiveTab("mindmap")}
              onCreateFsrsCardFromHighlight={() => setActiveTab("srs")}
            />
          )}

          {activeTab === "srs" && <FsrsRunner />}

          {activeTab === "mindmap" && <MindMapCanvas />}

          {activeTab === "specimens" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div className="liquid-card">
                <h3 style={{ margin: "0 0 12px 0", fontSize: "15px", color: "#38bdf8" }}>
                  Curated Open-Access Medical Image, Occlusion &amp; 3D glTF Sourcing
                </h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr auto", gap: "10px" }}>
                  <select
                    className="liquid-select"
                    value={specimenSystem}
                    onChange={(e) => setSpecimenSystem(e.target.value as OrganSystem)}
                  >
                    {CANONICAL_ORGAN_SYSTEMS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    className="liquid-input"
                    value={specimenQuery}
                    onChange={(e) => setSpecimenQuery(e.target.value)}
                    placeholder="e.g. Renal corpuscle PAS stain, Femur head trabeculae..."
                  />
                  <select
                    className="liquid-select"
                    value={specimenModality}
                    onChange={(e) => setSpecimenModality(e.target.value as SpecimenModality)}
                  >
                    <option value="histology_slide">Histology Slide</option>
                    <option value="gross_specimen">Gross Specimen</option>
                    <option value="pathway">Biochemical Pathway</option>
                    <option value="radiology">Radiology / CT / MRI</option>
                    <option value="model_3d">3D Anatomy (glTF/GLB)</option>
                  </select>
                  <button
                    className="liquid-btn"
                    onClick={handleRunSpecimenSourcing}
                    disabled={isSourcing}
                  >
                    {isSourcing ? "Sourcing..." : "Fetch & Occlude"}
                  </button>
                </div>
              </div>

              {sourcedAssets.length > 0 && (
                <div className="liquid-card">
                  <h4 style={{ margin: "0 0 10px 0", fontSize: "13.5px" }}>
                    Registered Specimens in <code>medical_images</code> (SQLite)
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {sourcedAssets.map((a) => (
                      <div
                        key={a.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "10px",
                          background: "rgba(15, 23, 42, 0.65)",
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                          fontSize: "12.5px",
                        }}
                      >
                        <strong>{a.descriptiveFilename}</strong> ({a.organSystem} — {a.modality})
                        <div style={{ color: "#94a3b8", marginTop: "4px" }}>
                          Credit: {a.sourceCredit} | Occlusion Masks: {a.occlusionBoxes.length}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="liquid-card">
                <h4 style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#94a3b8" }}>
                  Active Curated Repositories (<code>E:\StudyApp\MyFilesault\curated_medical_sources.json</code>)
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {DEFAULT_CURATED_REPOSITORIES.map((repo) => (
                    <div
                      key={repo.id}
                      style={{
                        padding: "10px 12px",
                        borderRadius: "10px",
                        background: "rgba(15, 23, 42, 0.55)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                        fontSize: "12px",
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "#38bdf8" }}>{repo.name}</div>
                      <div style={{ color: "#94a3b8", marginTop: "4px" }}>{repo.license_policy}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Draggable Split Resizer */}
        <div
          className={`liquid-resizer ${isDraggingSplit ? "dragging" : ""}`}
          onMouseDown={() => setIsDraggingSplit(true)}
          title="Drag to resize split workspace and native docked AI WebView"
        />

        {/* Right Pane: Native Docked AI Web-View Host (Zero Iframe; Warm-1 Pool) */}
        <aside
          ref={rightPaneRef}
          className="liquid-right-pane"
          style={{ width: `${100 - leftWidthPct}%` }}
        >
          <div className="liquid-ai-toolbar">
            <div style={{ display: "flex", gap: "6px" }}>
              {AI_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`liquid-tab-btn ${activeAiProvider === p.id ? "active" : ""}`}
                  style={{ padding: "5px 11px", fontSize: "12px" }}
                  onClick={() => handleSwitchAiProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <button
              className="liquid-btn liquid-btn-secondary"
              style={{ padding: "5px 11px", fontSize: "11.5px" }}
              onClick={handleToggleDetachRedock}
            >
              {detachedProviders[activeAiProvider] ? "⬇ Redock Window" : "↗ Detach Floating"}
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px",
              textAlign: "center",
              color: "#94a3b8",
            }}
          >
            <div className="liquid-card" style={{ maxWidth: "460px" }}>
              <h4 style={{ margin: "0 0 8px 0", color: "#38bdf8" }}>
                Native Tauri Child WebView Host ({activeAiProvider.toUpperCase()})
              </h4>
              <p style={{ fontSize: "12.5px", lineHeight: 1.6, margin: "0 0 12px 0" }}>
                {aiPanelStatusText}
              </p>
              <div style={{ fontSize: "11.5px", color: "#64748b" }}>
                Partition: <code>E:\StudyApp\MyFiles\.webview_partitions\persist_study_session</code>
                <br />
                Zero <code>&lt;iframe&gt;</code> tags • Auto-Allow MCP MutationObserver Active
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
