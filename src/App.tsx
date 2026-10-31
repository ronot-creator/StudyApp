import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import "./index.css";
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
import { AiIntegrations } from "./components/settings/AiIntegrations";
import { AddAiModal } from "./components/ui/AddAiModal";
import { Omnibar } from "./components/ui/Omnibar";
import {
  ApiKeyErrorBoundary,
  ApiKeyGuardrailModal,
} from "./components/ui/ApiKeyGuardrailModal";
import { FirstRunWizard } from "./components/setup/FirstRunWizard";
import { ensureAppDataDirectories, resolveAppLocalDataRoot } from "./lib/appPaths";
import { initializeSqlCipherDatabase } from "./lib/db";
import {
  AnkiQueueBannerState,
  getAnkiQueueBannerState,
  onAnkiSyncQueueChange,
} from "./services/ankiConnect";
import {
  DEFAULT_CURATED_REPOSITORIES,
  SourcedMedicalAsset,
  SpecimenModality,
  specimenSourcingService,
} from "./services/ingestion/specimenSourcing";
import {
  ACTIVE_AI_PROVIDER_STORAGE_KEY,
  loadSavedAiProviders,
  removeCustomAiProvider,
} from "./services/aiProviderRegistry";

type WorkspaceTab = "vault" | "srs" | "mindmap" | "specimens" | "integrations";

export const MAX_INLINE_PINNED_AI_TABS = 4;

export interface SilentUpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  body?: string;
}

/**
 * Checks the GitHub Releases endpoint silently via `@tauri-apps/plugin-updater`
 * without interrupting the user when no update is present.
 */
export async function checkForAppUpdatesSilently(options: {
  checkImpl?: typeof check;
} = {}): Promise<SilentUpdateCheckResult> {
  const checkFn = options.checkImpl ?? check;
  try {
    const update = await checkFn();
    if (update && update.available) {
      return {
        updateAvailable: true,
        version: update.version,
        body: update.body,
      };
    }
  } catch {
    // Silent fallback when offline or running outside packaged desktop binary
  }
  return { updateAvailable: false };
}

/**
 * Detaches the active AI WebView from the sidebar and spawns it as an independent floating OS window.
 */
export async function popOutAiWebViewToFloatingWindow(
  providerId: string,
  targetUrl: string,
  invokeImpl: typeof invoke = invoke
): Promise<void> {
  await invokeImpl("detach_ai_panel", {
    provider: providerId,
    targetUrl,
  });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("vault");
  const [mindMapSystem, setMindMapSystem] = useState<OrganSystem>("Renal");

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

  const currentProviderObj: AiProviderConfig =
    aiProviders.find((p) => p.id === activeAiProvider) || aiProviders[0];
  const [miniBrowserUrlInput, setMiniBrowserUrlInput] = useState<string>(
    currentProviderObj?.url || "https://gemini.google.com/app"
  );
  const [showAddChatbotModal, setShowAddChatbotModal] = useState<boolean>(false);
  const [showDriveWizard, setShowDriveWizard] = useState<boolean>(false);

  const [leftWidthPct, setLeftWidthPct] = useState<number>(56);
  const [preMaximizeWidthPct, setPreMaximizeWidthPct] = useState<number>(56);
  const [isAiPanelEnlarged, setIsAiPanelEnlarged] = useState<boolean>(false);
  const [isDraggingSplit, setIsDraggingSplit] = useState<boolean>(false);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  const [specimenSystem, setSpecimenSystem] = useState<OrganSystem>("Renal");
  const [specimenQuery, setSpecimenQuery] = useState<string>("Renal corpuscle PAS histology");
  const [specimenModality, setSpecimenModality] = useState<SpecimenModality>("histology_slide");
  const [sourcedAssets, setSourcedAssets] = useState<SourcedMedicalAsset[]>([]);
  const [isSourcing, setIsSourcing] = useState<boolean>(false);
  const [dbToast, setDbToast] = useState<string | null>(null);
  const [ankiQueueBanner, setAnkiQueueBanner] = useState<AnkiQueueBannerState>(() =>
    getAnkiQueueBannerState()
  );
  const [appDataRoot, setAppDataRoot] = useState<string>("$APPLOCALDATA");
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState<string | null>(null);

  useEffect(() => {
    void ensureAppDataDirectories().then((dir) => setAppDataRoot(dir));
    void initializeSqlCipherDatabase();
    void checkForAppUpdatesSilently().then((upd) => {
      if (upd.updateAvailable && upd.version) {
        setAvailableUpdateVersion(upd.version);
      }
    });
    void resolveAppLocalDataRoot().then((dir) => setAppDataRoot(dir));
    return onAnkiSyncQueueChange((st) => setAnkiQueueBanner(st));
  }, []);

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
    const headerOffset = 92;
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
        `Selected ${(found?.label || providerId).toUpperCase()} (${targetUrl}) — Native WebView2 binds at runtime`
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

  const handleRemoveCustomChatbot = async (providerId: string) => {
    const updated = await removeCustomAiProvider(providerId, aiProviders);
    setAiProviders(updated);
    if (activeAiProvider === providerId) {
      await handleSwitchAiProvider("gemini");
    }
  };

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

  const handleShellMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty("--mouse-x", `${e.clientX}px`);
    e.currentTarget.style.setProperty("--mouse-y", `${e.clientY}px`);
  };

  const inlineAiTabs = aiProviders.slice(0, MAX_INLINE_PINNED_AI_TABS);
  const overflowAiTabs = aiProviders.slice(MAX_INLINE_PINNED_AI_TABS);

  return (
    <ApiKeyErrorBoundary>
      <ApiKeyGuardrailModal />
      <FirstRunWizard
        isOpen={showDriveWizard}
        initialDirectory={appDataRoot}
        onClose={() => setShowDriveWizard(false)}
        onComplete={(st) => setAppDataRoot(st.targetRoot)}
      />
      <div className="liquid-shell" onMouseMove={handleShellMouseMove}>
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

      <header className="liquid-topbar">
        <div className="liquid-brand">
          <span style={{ fontWeight: 700, fontSize: "16px", color: "#f8fafc" }}>
            Convergence
          </span>
          <span className="liquid-brand-badge" title={appDataRoot}>$APPLOCALDATA Sandbox</span>
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
          <button
            className={`liquid-tab-btn ${activeTab === "integrations" ? "active" : ""}`}
            onClick={() => setActiveTab("integrations")}
          >
            5. AI Integrations (MCP)
          </button>
        </nav>

        <button className="liquid-btn liquid-btn-secondary" data-testid="open-drive-wizard-btn" style={{ padding: "5px 10px", fontSize: "11.5px" }} onClick={() => setShowDriveWizard(true)}>💽 Drive: {appDataRoot}</button>
        {availableUpdateVersion && (
          <span className="liquid-badge" data-testid="silent-update-notification" style={{ background: "rgba(16, 185, 129, 0.2)", color: "#34d399", fontSize: "11px" }}>
            ⬆ Update v{availableUpdateVersion} Ready
          </span>
        )}
        <Omnibar activeTab={activeTab} activeOrganSystem={mindMapSystem} onNavigateTab={(tab) => setActiveTab(tab)} />
        <TunnelStatus />
      </header>

      {ankiQueueBanner.queuedCount > 0 && (
        <div
          role="status"
          data-testid="anki-sync-queue-banner"
          className="liquid-card"
          style={{
            margin: "8px 16px 0 16px",
            padding: "8px 14px",
            borderColor: "rgba(251, 191, 36, 0.55)",
            background: "rgba(120, 53, 15, 0.35)",
            fontSize: "12px",
            color: "#fde68a",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            📦 <strong>Anki Offline Sync Queue:</strong> {ankiQueueBanner.queuedCount} flashcard(s) cached in SQLite <code>srs_sync_queue</code> waiting for Anki Desktop (<code>http://127.0.0.1:8765</code>).
          </span>
        </div>
      )}

      <div className="liquid-split-workspace">
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

          {activeTab === "integrations" && (
            <AiIntegrations appDataRoot={appDataRoot} />
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
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="liquid-card">
                <h4 style={{ margin: "0 0 8px 0", fontSize: "13.5px", color: "#38bdf8" }}>
                  Curated Open-Access Medical Repositories
                </h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", fontSize: "12px" }}>
                  {DEFAULT_CURATED_REPOSITORIES.map((repo) => (
                    <div
                      key={repo.name}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "8px",
                        background: "rgba(15, 23, 42, 0.5)",
                        border: "1px solid rgba(255, 255, 255, 0.08)",
                      }}
                    >
                      <strong>{repo.name}</strong> — <span style={{ color: "#94a3b8" }}>{repo.license_policy}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <div
          className="liquid-split-handle"
          onMouseDown={() => setIsDraggingSplit(true)}
          title="Drag to resize split-pane & native AI WebView"
        />

        <aside
          ref={rightPaneRef}
          className="liquid-right-pane"
          style={{ width: `${100 - leftWidthPct}%` }}
        >
          <div className="liquid-ai-provider-bar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              {inlineAiTabs.map((p) => (
                <div key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                  <button
                    className={`liquid-tab-btn ${activeAiProvider === p.id ? "active" : ""}`}
                    onClick={() => void handleSwitchAiProvider(p.id, p.url)}
                  >
                    {p.label}
                  </button>
                  {p.isCustom && (
                    <button
                      className="liquid-btn liquid-btn-secondary"
                      style={{ padding: "2px 6px", fontSize: "10px" }}
                      onClick={() => void handleRemoveCustomChatbot(p.id)}
                      title={`Remove ${p.label}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}

              {overflowAiTabs.length > 0 && (
                <select
                  className="liquid-select"
                  style={{ width: "auto", padding: "4px 8px", fontSize: "12px" }}
                  value={overflowAiTabs.some((p) => p.id === activeAiProvider) ? activeAiProvider : ""}
                  onChange={(e) => {
                    const chosen = overflowAiTabs.find((p) => p.id === e.target.value);
                    if (chosen) void handleSwitchAiProvider(chosen.id, chosen.url);
                  }}
                >
                  <option value="" disabled>
                    More AI ({overflowAiTabs.length})...
                  </option>
                  {overflowAiTabs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}

              <button
                className="liquid-btn liquid-btn-secondary"
                data-testid="spawn-custom-ai-plus-btn"
                style={{ padding: "4px 9px", fontSize: "12px", fontWeight: 700 }}
                onClick={() => setShowAddChatbotModal((prev) => !prev)}
                title="Spawn isolated custom AI WebView (persist:ai_[slug])"
              >
                +
              </button>
            </div>

            <div style={{ display: "flex", gap: "6px" }}>
              <button
                className="liquid-btn liquid-btn-secondary"
                style={{ padding: "4px 8px", fontSize: "11.5px" }}
                onClick={() => void handleToggleEnlargeAiPanel()}
              >
                {isAiPanelEnlarged ? "Restore Split" : "Enlarge AI"}
              </button>
              <button
                className="liquid-btn liquid-btn-secondary"
                data-testid="ai-panel-pop-out-btn"
                style={{ padding: "4px 8px", fontSize: "11.5px" }}
                onClick={() => void handleToggleDetachRedock()}
              >
                {detachedProviders[activeAiProvider] ? "Re-Dock" : "Pop Out"}
              </button>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: "6px",
              padding: "6px 10px",
              background: "rgba(15, 23, 42, 0.55)",
              borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            <input
              className="liquid-input"
              style={{ padding: "5px 10px", fontSize: "12px" }}
              value={miniBrowserUrlInput}
              onChange={(e) => setMiniBrowserUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleNavigateMiniBrowser();
              }}
              placeholder="Enter AI URL or search query..."
            />
            <button
              className="liquid-btn liquid-btn-secondary"
              style={{ padding: "4px 10px", fontSize: "12px" }}
              onClick={() => void handleNavigateMiniBrowser()}
            >
              Go
            </button>
          </div>

          <AddAiModal
            isOpen={showAddChatbotModal}
            existingProviders={aiProviders}
            onClose={() => setShowAddChatbotModal(false)}
            onProviderAdded={(updatedProviders, addedProvider, statusMsg) => {
              setAiProviders(updatedProviders);
              setShowAddChatbotModal(false);
              setAiPanelStatusText(statusMsg);
              void handleSwitchAiProvider(addedProvider.id, addedProvider.url);
            }}
          />

          <div
            className="liquid-webview-host"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "24px",
              textAlign: "center",
              color: "#94a3b8",
              fontSize: "13px",
            }}
          >
            <strong style={{ color: "#38bdf8", marginBottom: "6px" }}>
              {currentProviderObj?.label} Native WebView Dock ({currentProviderObj?.partition || "persist:study_session"})
            </strong>
            <span>{aiPanelStatusText}</span>
          </div>
        </aside>
      </div>
      </div>
    </ApiKeyErrorBoundary>
  );
}
