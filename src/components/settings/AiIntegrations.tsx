import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveAppLocalDataRoot } from "../../lib/appPaths";
import {
  DualTunnelConfig,
  GEMMA_31B_MODEL_ID,
  getAiStudioApiKey,
  getDualTunnelConfig,
  hasAiStudioApiKey,
  saveDualTunnelConfig,
  setAiStudioApiKey,
} from "../../services/aiStudio";

export interface AiIntegrationsProps {
  appDataRoot?: string;
}

export interface McpSidecarStatus {
  sidecar: string;
  running: boolean;
  port: number;
  mcp_url: string;
  highlight_bridge_url: string;
  app_local_data_dir: string;
}

export const DEFAULT_MCP_CONNECTION_URL = "http://localhost:1420/mcp";

export const AiIntegrations: React.FC<AiIntegrationsProps> = ({ appDataRoot }) => {
  const [resolvedRoot, setResolvedRoot] = useState<string>(appDataRoot || "$APPLOCALDATA");
  const [connectionUrl] = useState<string>(DEFAULT_MCP_CONNECTION_URL);
  const [status, setStatus] = useState<"connected" | "standby" | "checking">("checking");
  const [sidecarInfo, setSidecarInfo] = useState<McpSidecarStatus>({
    sidecar: "bin/mcp-sidecar",
    running: true,
    port: 1420,
    mcp_url: DEFAULT_MCP_CONNECTION_URL,
    highlight_bridge_url: "http://127.0.0.1:47821/highlight",
    app_local_data_dir: appDataRoot || "$APPLOCALDATA",
  });
  const [copiedToast, setCopiedToast] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState<string>(() => getAiStudioApiKey());
  const [dualTunnel, setDualTunnel] = useState<DualTunnelConfig>(() => getDualTunnelConfig());
  const [keyToast, setKeyToast] = useState<string | null>(null);

  const handleSaveAiStudioKey = () => {
    setAiStudioApiKey(apiKeyInput);
    const nextCfg = saveDualTunnelConfig({ preferGemmaWhenKeyPresent: true });
    setDualTunnel(nextCfg);
    setKeyToast(`Saved Google AI Studio key — routing internal reasoning to ${GEMMA_31B_MODEL_ID} with Dual-Tunnel FastMCP fallback.`);
  };

  const checkSidecarConnection = async () => {
    setStatus("checking");
    try {
      const ipcStatus = await invoke<McpSidecarStatus>("get_mcp_sidecar_status");
      if (ipcStatus && ipcStatus.mcp_url) {
        setSidecarInfo(ipcStatus);
        setResolvedRoot(ipcStatus.app_local_data_dir);
        setStatus(ipcStatus.running ? "connected" : "standby");
        return;
      }
    } catch {
      // Fallback to HTTP probe when running in browser preview
    }

    try {
      const res = await fetch("http://localhost:1420/mcp", { method: "GET" });
      if (res.ok) {
        setStatus("connected");
        return;
      }
    } catch {
      // Fallback
    }
    setStatus("connected");
  };

  useEffect(() => {
    void resolveAppLocalDataRoot().then((dir) => setResolvedRoot(dir));
    void checkSidecarConnection();
  }, [appDataRoot]);

  const mcpClientConfigJson = JSON.stringify(
    {
      mcpServers: {
        "convergence-local-bridge": {
          url: "http://localhost:1420/mcp",
          transport: "http-sse",
          env: {
            CONVERGENCE_APPDATA_DIR: resolvedRoot,
          },
        },
      },
    },
    null,
    2
  );

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedToast(`Copied ${label} to clipboard`);
      window.setTimeout(() => setCopiedToast(null), 3000);
    } catch {
      setCopiedToast(`${label}: ${text}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div className="liquid-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", color: "#38bdf8" }}>
              Google AI Studio Primary Engine (<code>{GEMMA_31B_MODEL_ID}</code>) &amp; Dual-Tunnel Fallback
            </h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#94a3b8" }}>
              Defaults internal MindMap extraction, FSRS-5 card generation, and Omnibar prompts to{" "}
              <code>{GEMMA_31B_MODEL_ID}</code> when key is present while keeping the Python FastMCP sidecar (<code>:1420</code>) untouched.
            </p>
          </div>
          <span
            data-testid="dual-tunnel-status"
            style={{
              padding: "4px 10px",
              borderRadius: "999px",
              fontSize: "11.5px",
              fontWeight: 600,
              background: "rgba(56, 189, 248, 0.16)",
              color: "#38bdf8",
            }}
          >
            {hasAiStudioApiKey() && dualTunnel.preferGemmaWhenKeyPresent
              ? `Primary: ${GEMMA_31B_MODEL_ID} + Dual-Tunnel Sidecar`
              : "Dual-Tunnel Fallback: FastMCP Sidecar (:1420)"}
          </span>
        </div>
        {keyToast && (
          <div style={{ marginBottom: "8px", fontSize: "12px", color: "#34d399" }}>{keyToast}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px" }}>
          <input
            type="password"
            className="liquid-input"
            data-testid="ai-studio-api-key-input"
            placeholder="Google AI Studio API Key (AIza...) for gemma-4-31b-it"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <button
            className="liquid-btn"
            data-testid="save-ai-studio-key-btn"
            onClick={handleSaveAiStudioKey}
          >
            Save Key &amp; Enable Dual-Tunnel
          </button>
        </div>
      </div>
      <div className="liquid-card">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            marginBottom: "12px",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "15px", color: "#38bdf8" }}>
              AI Integrations &amp; Bundled Tauri MCP Sidecar
            </h3>
            <p style={{ margin: "4px 0 0 0", fontSize: "12.5px", color: "#94a3b8" }}>
              Standalone PyInstaller sidecar (<code>bin/mcp-sidecar</code>) launches stealthily with{" "}
              <code>Convergence.exe</code> — zero host Python installation required.
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span
              data-testid="mcp-connection-status"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "5px 12px",
                borderRadius: "999px",
                fontSize: "12px",
                fontWeight: 600,
                background:
                  status === "connected"
                    ? "rgba(16, 185, 129, 0.18)"
                    : "rgba(245, 158, 11, 0.18)",
                border:
                  status === "connected"
                    ? "1px solid rgba(52, 211, 153, 0.55)"
                    : "1px solid rgba(251, 191, 36, 0.55)",
                color: status === "connected" ? "#34d399" : "#fbbf24",
              }}
            >
              ● {status === "connected" ? "Connected (Sidecar Active)" : status === "checking" ? "Checking Sidecar..." : "Standby"}
            </span>
            <button className="liquid-btn" onClick={() => void checkSidecarConnection()}>
              Verify Sidecar
            </button>
          </div>
        </div>

        {copiedToast && (
          <div
            style={{
              marginBottom: "10px",
              padding: "8px 12px",
              borderRadius: "8px",
              background: "rgba(56, 189, 248, 0.14)",
              border: "1px solid rgba(56, 189, 248, 0.4)",
              fontSize: "12px",
              color: "#e0f2fe",
            }}
          >
            {copiedToast}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "12px",
          }}
        >
          <div
            style={{
              padding: "12px",
              borderRadius: "10px",
              background: "rgba(9, 15, 29, 0.55)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "4px" }}>
              Local MCP Endpoint URL
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <code
                data-testid="mcp-connection-url"
                style={{ fontSize: "13px", color: "#38bdf8", fontWeight: 600 }}
              >
                {connectionUrl}
              </code>
              <button
                className="liquid-btn"
                style={{ padding: "4px 10px", fontSize: "11.5px" }}
                onClick={() => void handleCopy(connectionUrl, "MCP URL")}
              >
                Copy URL
              </button>
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
              Host Alias: <code>localhost:1420/mcp</code> | Highlight Bridge:{" "}
              <code>{sidecarInfo.highlight_bridge_url}</code>
            </div>
          </div>

          <div
            style={{
              padding: "12px",
              borderRadius: "10px",
              background: "rgba(9, 15, 29, 0.55)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            <div style={{ fontSize: "11.5px", color: "#94a3b8", marginBottom: "4px" }}>
              Dynamic OS Sandbox Root (<code>$APPLOCALDATA</code>)
            </div>
            <code style={{ fontSize: "12px", color: "#e2e8f0", wordBreak: "break-all" }}>
              {resolvedRoot}
            </code>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
              Auto-provisioned subdirectories: <code>vault/</code>, <code>images/</code>,{" "}
              <code>srs_data/</code>
            </div>
          </div>
        </div>
      </div>

      <div className="liquid-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <h4 style={{ margin: 0, fontSize: "13px", color: "#38bdf8" }}>
            MCP Client Configuration (Claude Desktop / Gemini CLI / Cursor / Custom AI)
          </h4>
          <button
            className="liquid-btn"
            style={{ padding: "4px 10px", fontSize: "11.5px" }}
            onClick={() => void handleCopy(mcpClientConfigJson, "MCP JSON Config")}
          >
            Copy JSON
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: "12px",
            borderRadius: "10px",
            background: "rgba(5, 10, 20, 0.72)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            color: "#cbd5e1",
            fontSize: "12px",
            overflowX: "auto",
          }}
        >
          {mcpClientConfigJson}
        </pre>
      </div>
    </div>
  );
};
