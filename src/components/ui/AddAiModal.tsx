import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AiProviderConfig } from "../../types/study";
import {
  addOrPinAiProvider,
  getProviderPartition,
  resolveChatbotSearchCandidates,
  sanitizeProviderId,
} from "../../services/aiProviderRegistry";

export interface AddAiModalProps {
  isOpen: boolean;
  existingProviders: AiProviderConfig[];
  onClose: () => void;
  onProviderAdded: (
    updatedProviders: AiProviderConfig[],
    addedProvider: AiProviderConfig,
    spawnStatusText: string
  ) => void;
}

export const AddAiModal: React.FC<AddAiModalProps> = ({
  isOpen,
  existingProviders,
  onClose,
  onProviderAdded,
}) => {
  const [displayName, setDisplayName] = useState<string>("");
  const [webUrl, setWebUrl] = useState<string>("");
  const [spawning, setSpawning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const previewSlug = sanitizeProviderId(displayName || "custom_ai");
  const previewPartition = getProviderPartition(previewSlug);
  const quickCandidates = resolveChatbotSearchCandidates(displayName).slice(0, 6);

  const handleSpawnCustomAi = async (nameInput: string, urlInput: string) => {
    const cleanName = nameInput.trim();
    const cleanUrl = urlInput.trim();
    if (!cleanName || !cleanUrl) {
      setErrorMsg("Both Display Name and Web URL are required.");
      return;
    }

    setSpawning(true);
    setErrorMsg(null);
    const normalizedUrl =
      cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")
        ? cleanUrl
        : `https://${cleanUrl}`;
    const slug = sanitizeProviderId(cleanName);
    const partition = getProviderPartition(slug);

    const { providers, added } = await addOrPinAiProvider(
      {
        id: slug,
        label: cleanName,
        url: normalizedUrl,
        partition,
      },
      existingProviders
    );

    let statusMessage = `Spawned ${added.label} in isolated WebView (${partition}) with preload.js bridge`;
    try {
      const ipcResult = await invoke<{
        provider: string;
        label: string;
        partition_dir: string;
      }>("spawn_custom_ai_panel", {
        name: added.label,
        url: added.url,
      });
      if (ipcResult && ipcResult.label) {
        statusMessage = `Spawned ${added.label} [${ipcResult.label}] in ${partition} (${ipcResult.partition_dir})`;
      }
    } catch {
      // Safe fallback in browser preview
    }

    setSpawning(false);
    setDisplayName("");
    setWebUrl("");
    onProviderAdded(providers, added, statusMessage);
    onClose();
  };

  return (
    <div
      data-testid="add-ai-modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        background: "rgba(2, 6, 23, 0.72)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={onClose}
    >
      <div
        className="liquid-card"
        data-testid="add-ai-modal"
        style={{
          width: "100%",
          maxWidth: "540px",
          padding: "18px 20px",
          border: "1px solid rgba(56, 189, 248, 0.45)",
          boxShadow: "0 24px 60px rgba(2, 6, 23, 0.88)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "12px",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", color: "#38bdf8" }}>
              + Spawn Custom AI WebView Panel
            </h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#94a3b8" }}>
              Instantiates an isolated, persistent Tauri WebView (<code>{previewPartition}</code>)
              equipped with the <code>preload.js</code> shorthand bridge (<code>/q</code>).
            </p>
          </div>
          <button
            className="liquid-btn liquid-btn-secondary"
            style={{ padding: "4px 10px", fontSize: "11.5px" }}
            onClick={onClose}
          >
            ✕ Close
          </button>
        </div>

        {errorMsg && (
          <div
            style={{
              marginBottom: "10px",
              padding: "8px 12px",
              borderRadius: "8px",
              background: "rgba(239, 68, 68, 0.16)",
              border: "1px solid rgba(248, 113, 113, 0.45)",
              color: "#fecaca",
              fontSize: "12px",
            }}
          >
            {errorMsg}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "14px" }}>
          <div>
            <label
              style={{ display: "block", fontSize: "11.5px", color: "#94a3b8", marginBottom: "4px" }}
            >
              Display Name (e.g., ChatGPT, Custom Colab Endpoint, DeepSeek, NotebookLM)
            </label>
            <input
              className="liquid-input"
              data-testid="add-ai-name-input"
              placeholder="e.g. DeepSeek R1 or Colab Heavy OCR"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label
              style={{ display: "block", fontSize: "11.5px", color: "#94a3b8", marginBottom: "4px" }}
            >
              Web URL (HTTPS or Ngrok / Localhost Endpoint)
            </label>
            <input
              className="liquid-input"
              data-testid="add-ai-url-input"
              placeholder="e.g. https://chat.deepseek.com/ or https://xxxx.ngrok-free.app"
              value={webUrl}
              onChange={(e) => setWebUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleSpawnCustomAi(displayName, webUrl);
                }
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 12px",
              borderRadius: "8px",
              background: "rgba(9, 15, 29, 0.6)",
              fontSize: "11.5px",
              color: "#94a3b8",
            }}
          >
            <span>
              Isolated Partition: <code style={{ color: "#38bdf8" }}>{previewPartition}</code>
            </span>
            <span>
              Preload Bridge: <code style={{ color: "#34d399" }}>src-tauri/src/preload.js</code>
            </span>
          </div>

          <button
            className="liquid-btn"
            data-testid="spawn-custom-ai-submit-btn"
            disabled={spawning || !displayName.trim() || !webUrl.trim()}
            onClick={() => void handleSpawnCustomAi(displayName, webUrl)}
          >
            {spawning ? "Spawning WebView..." : "Spawn & Pin Custom AI Panel"}
          </button>
        </div>

        <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "6px" }}>
          Quick-Pin Presets:
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))",
            gap: "6px",
          }}
        >
          {quickCandidates.map((cand) => (
            <button
              key={cand.id}
              className="liquid-interactive-tile"
              style={{
                textAlign: "left",
                padding: "7px 10px",
                borderRadius: "8px",
                background: "rgba(15, 23, 42, 0.72)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                color: "#f8fafc",
                cursor: "pointer",
                fontSize: "11.5px",
              }}
              onClick={() => void handleSpawnCustomAi(cand.label, cand.url)}
            >
              <div style={{ fontWeight: 600, color: "#38bdf8" }}>+ {cand.label}</div>
              <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "2px" }}>
                persist:ai_{cand.id}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
