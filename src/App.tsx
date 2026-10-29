import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import "./styles/liquid-glass.css";
import {
  AiProviderConfig,
  AiProviderId,
  CANONICAL_ORGAN_SYSTEMS,
  OrganSystem,
} from "./types/study";
import { TunnelStatus } from "./components/TunnelStatus";
import { VaultReader } from "./components/vault/VaultReader";
import { FsrsRunner } from "./components/srs/FsrsRunner";
import { MindMapCanvas } from "./components/mindmap/MindMapCanvas";
import { createSrsCard } from "./lib/fsrs";
import {
  DEFAULT_CURATED_REPOSITORIES,
  SourcedMedicalAsset,
  SpecimenModality,
  specimenSourcingService,
} from "./services/ingestion/specimenSourcing";
import {
  ACTIVE_AI_PROVIDER_STORAGE_KEY,
  addOrPinAiProvider,
  loadSavedAiProviders,
  removeCustomAiProvider,
  resolveChatbotSearchCandidates,
} from "./services/aiProviderRegistry";

type WorkspaceTab = "vault" | "srs" | "mindmap" | "specimens";

export const MAX_INLINE_PINNED_AI_TABS = 4;

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("vault");
  const [mindMapSystem, setMindMapSystem] = useState<OrganSystem>("Renal");

  // Unlimited AI Chatbot Registry (4 default + unlimited user-added chatbots)
  const [aiProviders, setAiProviders] = useState<AiProviderConfig[]>(() =>
    loadSavedAiProviders()
  );
  const [activeAiProvider, setActiveAiProvider] = useState<AiProviderId>(() => {
    try {
      return localStorage.getItem(ACTIVE_AI_PROVIDER_STORAGE_KEY) || "gemini";
    } catch {
      return "gemini";
    }
  });
  const [detachedProviders, setDetachedProviders] = useState<Record<string, boolean>>({});
  const [aiPanelStatusText, setAiPanelStatusText] = useState<string>(
    "Warm-1 Native WebView Pool Ready (persist:study_session)"
  );

  // Mini-browser URL bar & "+ Add AI / Chatbot" discovery modal state
  const currentProviderObj: AiProviderConfig =
    aiProviders.find((p) => p.id === activeAiProvider) || aiProviders[0];
  const [miniBrowserUrlInput, setMiniBrowserUrlInput] = useState<string>(
    currentProviderObj?.url || "https://gemini.google.com/app"
  );
  const [showAddChatbotModal, setShowAddChatbotModal] = useState<boolean>(false);
  const [chatbotSearchQuery, setChatbotSearchQuery] = useState<string>("");
  const [customChatbotUrl, setCustomChatbotUrl] = useState<string>("");

  // Split-pane geometry state + Enlarge / Maximize AI Panel toggle
  const [leftWidthPct, setLeftWidthPct] = useState<number>(56);
  const [preMaximizeWidthPct, setPreMaximizeWidthPct] = useState<number>(56);
  const [isAiPanelEnlarged, setIsAiPanelEnlarged] = useState<boolean>(false);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  // Specimen & 3D Sourcing Tab state
  const [specimenSystem, setSpecimenSystem] = useState<OrganSystem>("Renal");
  const [specimenQuery, setSpecimenQuery] = useState<string>("Renal corpuscle PAS histology");
  const [specimenModality, setSpecimenModality] = useState<SpecimenModality>("histology_slide");
  const [sourcedAssets, setSourcedAssets] = useState<SourcedMedicalAsset[]>([]);
  const [isSourcing, setIsSourcing] = useState<boolean>(false);
  const [dbToast, setDbToast] = useState<string | null>(null);

  useEffect(() => {
    specimenSourcingService.onPersistError = (msg) => {
      setDbToast(msg);
      window.setTimeout(() => setDbToast(null), 6000);
    };
    return () => {
      specimenSourcingService.onPersistError = undefined;
    };
  }, []);

  const computeRightPaneBounds = () => {
    const el = rightPaneRef.current;
    const headerOffset = 92; // Below 48px provider bar + 44px mini-browser address bar
    if (!el) {
      const winW = window.innerWidth || 1600;
      const winH = window.innerHeight || 960;
      const x = Math.round((winW * leftWidthPct) / 100) + 6;
      return {
        x,
        y: 56 + headerOffset,
        width: Math.max(320, winW - x),
        height: Math.max(320, winH - (56 + headerOffset)),
      };
    }
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top + headerOffset),
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(320, Math.round(rect.height - headerOffset)),
    };
  };

  // Sync native docked AI WebView bounds whenever window resizes or split ratio changes
  useEffect(() => {
    const syncBounds = async () => {
      const bounds = computeRightPaneBounds();
      try {
        await invoke("resize_docked_ai_panel", bounds);
      } catch {
        // Safe preview fallback
      }
    };
    window.addEventListener("resize", syncBounds);
    return () => window.removeEventListener("resize", syncBounds);
  }, [leftWidthPct, isAiPanelEnlarged]);

  const handleSwitchAiProvider = async (providerId: AiProviderId, explicitUrl?: string) => {
    setActiveAiProvider(providerId);
    try {
      localStorage.setItem(ACTIVE_AI_PROVIDER_STORAGE_KEY, providerId);
    } catch {
      // ignore
    }
    const found = aiProviders.find((p) => p.id === providerId);
    const targetUrl = explicitUrl || found?.url || "https://gemini.google.com/app";
    setMiniBrowserUrlInput(targetUrl);

    const bounds = computeRightPaneBounds();
    try {
      await invoke("switch_active_ai_panel", {
        provider: providerId,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        targetUrl,
      });
      setAiPanelStatusText(
        `Docked ${(found?.label || providerId).toUpperCase()} in Warm-1 Pool (${bounds.width}×${bounds.height})`
      );
    } catch {
      setAiPanelStatusText(
        `Selected ${(found?.label || providerId).toUpperCase()} (${targetUrl}) — Native WebView2 binds at runtime on Windows E:\\`
      );
    }
  };

  const handleToggleEnlargeAiPanel = async () => {
    if (!isAiPanelEnlarged) {
      setPreMaximizeWidthPct(leftWidthPct);
      setLeftWidthPct(22);
      setIsAiPanelEnlarged(true);
    } else {
      setLeftWidthPct(preMaximizeWidthPct || 56);
      setIsAiPanelEnlarged(false);
    }
    window.setTimeout(async () => {
      const bounds = computeRightPaneBounds();
      try {
        await invoke("resize_docked_ai_panel", bounds);
      } catch {
        // Safe preview fallback
      }
    }, 30);
  };

  const handleToggleDetachRedock = async () => {
    const isCurrentlyDetached = Boolean(detachedProviders[activeAiProvider]);
    const targetUrl = currentProviderObj?.url || miniBrowserUrlInput;
    if (!isCurrentlyDetached) {
      try {
        await invoke("detach_ai_panel", {
          provider: activeAiProvider,
          targetUrl,
        });
      } catch {
        // Safe preview fallback
      }
      setDetachedProviders((prev) => ({ ...prev, [activeAiProvider]: true }));
      setAiPanelStatusText(
        `Detached ${(currentProviderObj?.label || activeAiProvider).toUpperCase()} into floating native window`
      );
    } else {
      const bounds = computeRightPaneBounds();
      try {
        await invoke("redock_ai_panel", {
          provider: activeAiProvider,
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          targetUrl,
        });
      } catch {
        // Safe preview fallback
      }
      setDetachedProviders((prev) => ({ ...prev, [activeAiProvider]: false }));
      setAiPanelStatusText(
        `Re-docked ${(currentProviderObj?.label || activeAiProvider).toUpperCase()} into split-pane`
      );
    }
  };

  const handleNavigateMiniBrowser = async () => {
    const raw = miniBrowserUrlInput.trim();
    if (!raw) return;
    const nextUrl =
      raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : raw.includes(".") && !raw.includes(" ")
        ? `https://${raw}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
    setMiniBrowserUrlInput(nextUrl);

    try {
      await invoke("navigate_ai_panel", {
        provider: activeAiProvider,
        url: nextUrl,
      });
      setAiPanelStatusText(`Navigated ${activeAiProvider.toUpperCase()} WebView to ${nextUrl}`);
    } catch {
      setAiPanelStatusText(`Updated ${activeAiProvider.toUpperCase()} session target to ${nextUrl}`);
    }
  };

  const handleAddAndPinChatbot = async (candidate: {
    id?: string;
    label: string;
    url: string;
  }) => {
    const { providers, added } = await addOrPinAiProvider(candidate, aiProviders);
    setAiProviders(providers);
    setShowAddChatbotModal(false);
    setChatbotSearchQuery("");
    setCustomChatbotUrl("");
    await handleSwitchAiProvider(added.id, added.url);
  };

  const handleRemoveCustomChatbot = async (providerId: string) => {
    const updated = await removeCustomAiProvider(providerId, aiProviders);
    setAiProviders(updated);
    if (activeAiProvider === providerId) {
      await handleSwitchAiProvider("gemini");
    }
  };

  // Dragging split resizer syncs native docked WebView bounds
  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const pct = Math.min(82, Math.max(18, (e.clientX / window.innerWidth) * 100));
      setLeftWidthPct(pct);
      setIsAiPanelEnlarged(pct <= 28);
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

  // Cursor-tracked Aceternity spotlight coordinates
  const handleShellMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty("--mouse-x", `${e.clientX}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${e.clientY}px`);
  };

  const inlineAiTabs = aiProviders.slice(0, MAX_INLINE_PINNED_AI_TABS);
  const overflowAiTabs = aiProviders.slice(MAX_INLINE_PINNED_AI_TABS);
  const searchCandidates = resolveChatbotSearchCandidates(chatbotSearchQuery);

  return (
    <div className="liquid-shell" onMouseMove={handleShellMouseMove}>
      {/* True Apple iOS 26 Liquid Glass SVG Optical Refraction & Fresnel Specular Filter */}
      <svg
        aria-hidden="true"
        style={{ position: "absolute", width: 0, height: 0, pointerEvents: "none" }}
      >
        <defs>
          <filter
            id="apple-liquid-glass"
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.014 0.018"
              numOctaves="2"
              seed="7"
              result="refractionNoise"
            />
            <feGaussianBlur in="refractionNoise" stdDeviation="2.5" result="smoothMap" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="smoothMap"
              scale="14"
              xChannelSelector="R"
              yChannelSelector="G"
              result="refracted"
            />
            <feSpecularLighting
              in="smoothMap"
              surfaceScale="2.2"
              specularConstant="0.65"
              specularExponent="28"
              lightingColor="#e0f2fe"
              result="specularRim"
            >
              <fePointLight x="-160" y="-220" z="260" />
            </feSpecularLighting>
            <feComposite
              in="specularRim"
              in2="SourceAlpha"
              operator="in"
              result="clippedSpecular"
            />
            <feBlend in="refracted" in2="clippedSpecular" mode="screen" />
          </filter>
        </defs>
      </svg>

      <div className="liquid-aurora-backdrop" aria-hidden="true" />
      {dbToast && (
        <div
          role="alert"
          className="liquid-card"
          style={{ position: "fixed", bottom: 16, left: 16, zIndex: 50, maxWidth: 420, fontSize: 12.5 }}
        >
          {dbToast}
        </div>
      )}

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
              onPromoteToMindMapNode={(sys) => {
                setMindMapSystem(sys);
                setActiveTab("mindmap");
              }}
              onCreateFsrsCardFromHighlight={() => setActiveTab("srs")}
            />
          )}

          {activeTab === "srs" && <FsrsRunner />}

          {activeTab === "mindmap" && (
            <MindMapCanvas
              organSystem={mindMapSystem}
              onOrganSystemChange={setMindMapSystem}
            />
          )}

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

              {isSourcing && (
                <div className="liquid-card" style={{ minHeight: "120px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", justifyContent: "center", padding: "24px" }}>
                    <div className="liquid-skeleton" style={{ width: "60%", height: "16px", borderRadius: "8px" }} />
                    <div className="liquid-skeleton" style={{ width: "40%", height: "12px", borderRadius: "6px" }} />
                    <div className="liquid-skeleton" style={{ width: "80%", height: "120px", borderRadius: "12px" }} />
                  </div>
                </div>
              )}

              {sourcedAssets.length > 0 && (
                <div className="liquid-card">
                  <h4 style={{ margin: "0 0 10px 0", fontSize: "13.5px" }}>
                    Registered Specimens in <code>medical_images</code> (SQLite)
                  </h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {sourcedAssets.map((a) => (
                      <div
                        key={a.id}
                        className="liquid-interactive-tile"
                        style={{
                          padding: "10px 12px",
                          borderRadius: "10px",
                          background: "rgba(15, 23, 42, 0.65)",
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                          fontSize: "12.5px",
                        }}
                      >
                        <strong>{a.descriptiveFilename}</strong> ({a.organSystem} — {a.modality})
                        {a.sourceUrl && (
                          <img
                            src={a.sourceUrl}
                            alt={a.descriptiveFilename}
                            style={{
                              maxWidth: "100%",
                              maxHeight: "180px",
                              marginTop: "8px",
                              borderRadius: "8px",
                              border: "1px solid rgba(255,255,255,0.1)",
                              background: "rgba(0,0,0,0.3)",
                              display: "block",
                            }}
                          />
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "#94a3b8", marginTop: "6px", gap: "8px", flexWrap: "wrap" }}>
                          <span>Credit: {a.sourceCredit} | Occlusion Masks: {a.occlusionBoxes.length}</span>
                          <button
                            className="liquid-btn"
                            style={{ padding: "4px 10px", fontSize: "11.5px" }}
                            onClick={async () => {
                              await createSrsCard({
                                id: `occ_card_${Date.now()}`,
                                organSystem: a.organSystem,
                                cardType: "image_occlusion",
                                questionOrder: 2,
                                frontPrompt: `Identify the occluded anatomical structures on ${a.descriptiveFilename} (${a.organSystem}):`,
                                markScheme: a.occlusionBoxes.map((b) => b.label_text).join(" | "),
                                imageId: a.id,
                                imagePath: `E:/StudyApp/MyFiles/images/${a.descriptiveFilename}`,
                                occlusionBoxesJson: JSON.stringify(a.occlusionBoxes),
                                stability: 0,
                                difficulty: 5.0,
                                elapsedDays: 0,
                                scheduledDays: 0,
                                reps: 0,
                                lapses: 0,
                                state: 0,
                                learningStep: 0,
                                dueDate: new Date().toISOString(),
                              });
                              setActiveTab("srs");
                            }}
                          >
                            🃏 Study in FSRS Occlusion Deck
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="liquid-card">
                <h4 style={{ margin: "0 0 10px 0", fontSize: "13px", color: "#94a3b8" }}>
                  Active Curated Repositories (<code>E:\StudyApp\MyFiles\vault\curated_medical_sources.json</code>)
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  {DEFAULT_CURATED_REPOSITORIES.map((repo) => (
                    <div
                      key={repo.id}
                      className="liquid-interactive-tile"
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

        {/* Right Pane: Native Docked AI Web-View Host & Unlimited Chatbot Sidebar */}
        <aside
          ref={rightPaneRef}
          className="liquid-right-pane"
          style={{ width: `${100 - leftWidthPct}%` }}
        >
          {/* Row 1: Pinned AI Tabs + Overflow Dropdown + "+ Add Chatbot" + Enlarge & Detach */}
          <div className="liquid-ai-toolbar" style={{ flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              {inlineAiTabs.map((p) => (
                <button
                  key={p.id}
                  className={`liquid-tab-btn ${activeAiProvider === p.id ? "active" : ""}`}
                  style={{ padding: "5px 11px", fontSize: "12px" }}
                  onClick={() => void handleSwitchAiProvider(p.id, p.url)}
                >
                  {p.label}
                </button>
              ))}

              {overflowAiTabs.length > 0 && (
                <select
                  aria-label="More pinned AI chatbots"
                  className="liquid-select"
                  style={{ width: "auto", minWidth: "135px", padding: "5px 10px", fontSize: "12px" }}
                  value={overflowAiTabs.some((p) => p.id === activeAiProvider) ? activeAiProvider : ""}
                  onChange={(e) => {
                    if (e.target.value) {
                      const target = aiProviders.find((p) => p.id === e.target.value);
                      void handleSwitchAiProvider(e.target.value, target?.url);
                    }
                  }}
                >
                  <option value="" disabled>
                    More AI ({overflowAiTabs.length})...
                  </option>
                  {overflowAiTabs.map((p) => (
                    <option key={p.id} value={p.id}>
                      📌 {p.label}
                    </option>
                  ))}
                </select>
              )}

              <button
                className="liquid-btn"
                style={{ padding: "5px 10px", fontSize: "11.5px" }}
                onClick={() => setShowAddChatbotModal((prev) => !prev)}
                title="Add and pin any AI chatbot to your persistent study_session sidebar"
              >
                + Add Chatbot
              </button>
            </div>

            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <button
                className="liquid-btn liquid-btn-secondary"
                style={{ padding: "5px 10px", fontSize: "11.5px" }}
                onClick={() => void handleToggleEnlargeAiPanel()}
                title="Enlarge or restore the AI sidebar width"
              >
                {isAiPanelEnlarged ? "⇔ Restore Split" : "⤢ Enlarge AI Pane"}
              </button>
              <button
                className="liquid-btn liquid-btn-secondary"
                style={{ padding: "5px 11px", fontSize: "11.5px" }}
                onClick={() => void handleToggleDetachRedock()}
              >
                {detachedProviders[activeAiProvider] ? "⬇ Redock Window" : "↗ Detach Floating"}
              </button>
            </div>
          </div>

          {/* Row 2: Persistent Mini-Browser Navigation Bar for Sign-In & Custom URL Navigation */}
          <div
            style={{
              height: "44px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "0 12px",
              background: "rgba(9, 15, 29, 0.72)",
              borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            <span
              className="liquid-badge"
              style={{
                background: "rgba(52, 211, 153, 0.14)",
                color: "#34d399",
                fontSize: "10.5px",
                whiteSpace: "nowrap",
              }}
              title="All OAuth logins & session cookies persist in E:\StudyApp\MyFiles\.webview_partitions\persist_study_session"
            >
              🔒 persist:study_session
            </span>
            <input
              className="liquid-input"
              style={{ padding: "5px 10px", fontSize: "12px", flex: 1 }}
              value={miniBrowserUrlInput}
              onChange={(e) => setMiniBrowserUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleNavigateMiniBrowser();
              }}
              placeholder="Enter AI URL or search query (e.g. https://perplexity.ai or DeepSeek)..."
            />
            <button
              className="liquid-btn"
              style={{ padding: "5px 11px", fontSize: "11.5px" }}
              onClick={() => void handleNavigateMiniBrowser()}
            >
              Go / Sign In
            </button>
            {currentProviderObj?.isCustom && (
              <button
                className="liquid-btn liquid-btn-secondary"
                style={{
                  padding: "5px 9px",
                  fontSize: "11px",
                  borderColor: "rgba(251, 113, 133, 0.4)",
                  color: "#fb7185",
                }}
                onClick={() => void handleRemoveCustomChatbot(currentProviderObj.id)}
                title="Unpin custom chatbot"
              >
                ✕ Unpin
              </button>
            )}
          </div>

          {/* "+ Add Chatbot" Discovery & Pinning Drawer */}
          {showAddChatbotModal && (
            <div
              className="liquid-card"
              style={{
                margin: "12px",
                padding: "14px",
                border: "1px solid rgba(56, 189, 248, 0.55)",
                zIndex: 30,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                <h4 style={{ margin: 0, fontSize: "13.5px", color: "#38bdf8" }}>
                  Add &amp; Pin Any AI Chatbot (Unlimited Persistent Sidebar)
                </h4>
                <button
                  className="liquid-btn liquid-btn-secondary"
                  style={{ padding: "3px 8px", fontSize: "11px" }}
                  onClick={() => setShowAddChatbotModal(false)}
                >
                  Close
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.4fr auto", gap: "8px", marginBottom: "10px" }}>
                <input
                  className="liquid-input"
                  placeholder="Type AI name (e.g. Perplexity, DeepSeek, Grok, OpenEvidence)..."
                  value={chatbotSearchQuery}
                  onChange={(e) => setChatbotSearchQuery(e.target.value)}
                />
                <input
                  className="liquid-input"
                  placeholder="Optional direct URL (auto-resolved if left blank)..."
                  value={customChatbotUrl}
                  onChange={(e) => setCustomChatbotUrl(e.target.value)}
                />
                <button
                  className="liquid-btn"
                  disabled={!chatbotSearchQuery.trim() && !customChatbotUrl.trim()}
                  onClick={() => {
                    const topMatch = searchCandidates[0];
                    void handleAddAndPinChatbot({
                      label: chatbotSearchQuery.trim() || topMatch?.label || "Custom AI",
                      url:
                        customChatbotUrl.trim() ||
                        topMatch?.url ||
                        `https://duckduckgo.com/?q=${encodeURIComponent(chatbotSearchQuery + " AI chat")}`,
                    });
                  }}
                >
                  📌 Search &amp; Pin AI
                </button>
              </div>

              <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "6px" }}>
                Instant One-Click AI Discovery Results (click any result to open &amp; pin permanently):
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", maxHeight: "170px", overflowY: "auto" }}>
                {searchCandidates.slice(0, 8).map((cand) => (
                  <button
                    key={cand.id}
                    className="liquid-interactive-tile"
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: "9px",
                      background: "rgba(15, 23, 42, 0.72)",
                      border: "1px solid rgba(255, 255, 255, 0.12)",
                      color: "#f8fafc",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                    onClick={() => void handleAddAndPinChatbot(cand)}
                  >
                    <div style={{ fontWeight: 600, color: "#38bdf8" }}>+ {cand.label}</div>
                    <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                      {cand.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

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
            <div className="liquid-card" style={{ maxWidth: "480px" }}>
              <h4 style={{ margin: "0 0 8px 0", color: "#38bdf8" }}>
                Native Tauri Child WebView Host ({(currentProviderObj?.label || activeAiProvider).toUpperCase()})
              </h4>
              <p style={{ fontSize: "12.5px", lineHeight: 1.6, margin: "0 0 10px 0" }}>
                {aiPanelStatusText}
              </p>
              <div style={{ fontSize: "12px", color: "#cbd5e1", marginBottom: "10px" }}>
                Active Endpoint: <code>{currentProviderObj?.url || miniBrowserUrlInput}</code>
                <br />
                Pinned Chatbots: <strong>{aiProviders.length}</strong> (Unlimited Capacity)
              </div>
              <div style={{ fontSize: "11.5px", color: "#64748b" }}>
                Partition: <code>E:\StudyApp\MyFiles\.webview_partitions\persist_study_session</code>
                <br />
                Zero <code>&lt;iframe&gt;</code> tags • Persistent OAuth Cookies • Auto-Allow MCP MutationObserver Active
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
