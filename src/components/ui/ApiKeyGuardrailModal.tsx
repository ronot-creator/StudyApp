import React, { Component, ErrorInfo, ReactNode, useEffect, useState } from "react";
import {
  API_NOT_FOUND_CODE,
  API_NOT_FOUND_EVENT,
  GEMMA_31B_MODEL_ID,
  getAiStudioApiKey,
  setAiStudioApiKey,
} from "../../services/aiStudio";
import {
  resolveAppLocalDataRoot,
  setCustomStorageTargetDir,
} from "../../lib/appPaths";

export interface ApiKeyGuardrailModalProps {
  isOpen?: boolean;
  initialReason?: string;
  onDismiss?: () => void;
  onKeySaved?: (key: string) => void;
}

export const ApiKeyGuardrailModal: React.FC<ApiKeyGuardrailModalProps> = ({
  isOpen: controlledOpen,
  initialReason,
  onDismiss,
  onKeySaved,
}) => {
  const [internalOpen, setInternalOpen] = useState<boolean>(false);
  const [reason, setReason] = useState<string>(
    initialReason || "API_NOT_FOUND: Google AI Studio API key is required for Gemma 4 31B IT."
  );
  const [keyInput, setKeyInput] = useState<string>(() => getAiStudioApiKey());

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;

  useEffect(() => {
    const handleApiNotFound = (event: Event) => {
      const custom = event as CustomEvent<{ code?: string; message?: string }>;
      setReason(
        custom.detail?.message ||
          "API_NOT_FOUND: Google AI Studio API key is missing. Loading spinners have been terminated."
      );
      setInternalOpen(true);
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const r = event.reason;
      if (
        r &&
        (r.code === API_NOT_FOUND_CODE ||
          r.name === API_NOT_FOUND_CODE ||
          String(r.message || r).includes(API_NOT_FOUND_CODE))
      ) {
        event.preventDefault();
        setReason(String(r.message || r));
        setInternalOpen(true);
      }
    };

    window.addEventListener(API_NOT_FOUND_EVENT, handleApiNotFound);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener(API_NOT_FOUND_EVENT, handleApiNotFound);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  if (!open) return null;

  const handleClose = () => {
    setInternalOpen(false);
    onDismiss?.();
  };

  const handleSave = () => {
    if (!keyInput.trim()) return;
    setAiStudioApiKey(keyInput.trim());
    onKeySaved?.(keyInput.trim());
    handleClose();
  };

  return (
    <div
      data-testid="api-key-guardrail-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 220,
        background: "rgba(2, 6, 23, 0.78)",
        backdropFilter: "blur(12px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={handleClose}
    >
      <div
        className="liquid-card"
        data-testid="api-key-guardrail-modal"
        style={{
          width: "100%",
          maxWidth: "500px",
          padding: "18px 20px",
          border: "1px solid rgba(248, 113, 113, 0.55)",
          boxShadow: "0 24px 64px rgba(2, 6, 23, 0.92)",
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
            <span style={{ fontSize: "14px", fontWeight: 700, color: "#f87171" }}>
              🛡️ Circuit Breaker: {API_NOT_FOUND_CODE}
            </span>
          </div>
          <button
            className="liquid-btn liquid-btn-secondary"
            data-testid="api-guardrail-dismiss-x"
            aria-label="Dismiss API Key Dialog"
            style={{ padding: "3px 9px", fontSize: "12px", fontWeight: 700 }}
            onClick={handleClose}
          >
            X
          </button>
        </div>

        <p style={{ fontSize: "12.5px", color: "#cbd5e1", lineHeight: 1.55, margin: "0 0 12px 0" }}>
          {reason} Enter your zero-cost Google AI Studio API key below to enable{" "}
          <code>{GEMMA_31B_MODEL_ID}</code> reasoning, or click <strong>X</strong> to dismiss and
          continue in offline local mode.
        </p>

        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="password"
            className="liquid-input"
            data-testid="guardrail-api-key-input"
            placeholder="Paste Google AI Studio API Key (AIza...)"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSave();
              }
            }}
          />
          <button
            className="liquid-btn"
            data-testid="guardrail-save-key-btn"
            disabled={!keyInput.trim()}
            onClick={handleSave}
          >
            Save Key
          </button>
        </div>
      </div>
    </div>
  );
};

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  caughtApiNotFound: boolean;
  errorMessage: string;
}

/**
 * Global React Error Boundary that intercepts `API_NOT_FOUND` circuit-breaker throws,
 * kills any hung loading states, and renders the dismissible `"X"` modal without unmounting the workspace.
 */
export class ApiKeyErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  public state: BoundaryState = {
    caughtApiNotFound: false,
    errorMessage: "",
  };

  public static getDerivedStateFromError(error: Error & { code?: string }): Partial<BoundaryState> | null {
    if (
      error?.code === API_NOT_FOUND_CODE ||
      error?.name === API_NOT_FOUND_CODE ||
      String(error?.message || "").includes(API_NOT_FOUND_CODE)
    ) {
      return {
        caughtApiNotFound: true,
        errorMessage: error.message || API_NOT_FOUND_CODE,
      };
    }
    return null;
  }

  public componentDidCatch(error: Error & { code?: string }, _info: ErrorInfo): void {
    if (
      error?.code === API_NOT_FOUND_CODE ||
      error?.name === API_NOT_FOUND_CODE ||
      String(error?.message || "").includes(API_NOT_FOUND_CODE)
    ) {
      this.setState({
        caughtApiNotFound: true,
        errorMessage: error.message || API_NOT_FOUND_CODE,
      });
    }
  }

  public render(): ReactNode {
    return (
      <>
        {this.props.children}
        {this.state.caughtApiNotFound && (
          <ApiKeyGuardrailModal
            isOpen={true}
            initialReason={this.state.errorMessage}
            onDismiss={() => this.setState({ caughtApiNotFound: false, errorMessage: "" })}
            onKeySaved={() => this.setState({ caughtApiNotFound: false, errorMessage: "" })}
          />
        )}
      </>
    );
  }
}

export interface FirstRunDriveWizardProps {
  isOpen: boolean;
  currentRoot: string;
  onClose: () => void;
  onDriveUpdated: (newRoot: string) => void;
}

/**
 * First-Run Wizard & Custom Drive Selector allowing users to move `$APPLOCALDATA`
 * (Vault, Images, SRS, Tesseract cache, WebView Partitions) to a custom drive (e.g., `D:\Convergence`).
 */
export const FirstRunDriveWizard: React.FC<FirstRunDriveWizardProps> = ({
  isOpen,
  currentRoot,
  onClose,
  onDriveUpdated,
}) => {
  const [targetDir, setTargetDir] = useState<string>(currentRoot || "D:\\Convergence");
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (currentRoot) {
      setTargetDir(currentRoot);
    }
  }, [currentRoot]);

  if (!isOpen) return null;

  const handleApplyDrive = async (dirToApply: string) => {
    setSaving(true);
    try {
      const cfg = await setCustomStorageTargetDir(dirToApply);
      const resolved = await resolveAppLocalDataRoot();
      onDriveUpdated(cfg.customTargetDir || resolved);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="first-run-drive-wizard-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 210,
        background: "rgba(2, 6, 23, 0.74)",
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
        data-testid="first-run-drive-wizard"
        style={{
          width: "100%",
          maxWidth: "540px",
          padding: "18px 20px",
          border: "1px solid rgba(56, 189, 248, 0.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "15px", color: "#38bdf8" }}>
            💽 First-Run Storage Wizard &amp; Custom Drive Routing
          </h3>
          <button
            className="liquid-btn liquid-btn-secondary"
            style={{ padding: "3px 9px", fontSize: "12px" }}
            onClick={onClose}
          >
            X
          </button>
        </div>

        <p style={{ fontSize: "12px", color: "#94a3b8", lineHeight: 1.5, margin: "0 0 12px 0" }}>
          Convergence stores a 1KB bootstrap pointer (<code>storage_config.json</code>) in standard
          OS AppData and routes all heavy Vault notes, Images, FSRS SQLite databases, Tesseract{" "}
          <code>.traineddata</code> models, and WebView partitions to your chosen drive.
        </p>

        <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <input
            className="liquid-input"
            data-testid="custom-drive-input"
            placeholder="e.g. D:\Convergence or E:\StudyVault"
            value={targetDir}
            onChange={(e) => setTargetDir(e.target.value)}
          />
          <button
            className="liquid-btn"
            data-testid="apply-custom-drive-btn"
            disabled={saving || !targetDir.trim()}
            onClick={() => void handleApplyDrive(targetDir)}
          >
            {saving ? "Routing..." : "Set Target Drive"}
          </button>
        </div>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {["D:\\Convergence", "E:\\Convergence", "$APPLOCALDATA"].map((preset) => (
            <button
              key={preset}
              className="liquid-btn liquid-btn-secondary"
              style={{ padding: "4px 10px", fontSize: "11px" }}
              onClick={() => setTargetDir(preset)}
            >
              Use {preset}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
